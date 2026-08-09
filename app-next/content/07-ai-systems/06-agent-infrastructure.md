---
title: Agent Infrastructure
summary: Durable execution, sandboxing, concurrency, and cost ceilings — the platform an agent needs to survive a process restart, a hostile input, and a runaway loop.
difficulty: Hard
tags: [ai, agents, durable-execution, sandboxing, platform]
prereqs: [agent-architectures, job-scheduler, backpressure]
unlocks: Running agents in production rather than in a notebook.
---

## The workload shape

Agents break the assumptions a normal request handler is built on:

```diagram
   HTTP REQUEST                  AGENT EXECUTION

   milliseconds to seconds       seconds to HOURS
   stateless                     accumulating state across steps
   in-memory is fine             must survive restarts
   bounded, predictable cost     unbounded without limits
   fails cleanly                 may fail after side effects
   one process                   may pause for human approval
   retry = re-run                retry may double-charge someone
```

Every row is a platform requirement. An agent running inside a request handler works until the first deploy restarts the pod mid-trajectory, at which point you discover you needed durable execution.

## Durable execution

The core requirement: **the trajectory survives process death.** Persist state before each step, so a crash resumes rather than restarts.

```diagram
   EPHEMERAL                        DURABLE

   loop in memory                   each step:
     step 1 ✓                         1. persist the intent
     step 2 ✓                         2. execute
     step 3 ✓ (sent an email)         3. persist the result
     ── CRASH ──                      4. commit the new state
     everything lost;                 ── CRASH ──
     restart re-sends the email       reload state, resume at
                                      the step after the last
                                      committed one
```

Three ways to build it:

| Approach | Mechanism | Trade |
|---|---|---|
| **Workflow engine** (Temporal, Restate, DBOS) | Code looks sequential; the engine records every side effect and replays deterministically on recovery | Best ergonomics; a significant dependency |
| **Explicit state machine** | Persist a state row; each step is a transition; a worker picks up pending work | Full control, more code, easy to reason about |
| **Event-sourced trajectory** | Append every event to a log; rebuild state by replay | Excellent auditability; replay must be pure |

For most teams the state-machine approach on top of an existing [job scheduler](../08-case-studies/job-scheduler.html) is the pragmatic choice: an agent run is a row with a status, a step index, and a serialised trajectory, and workers lease runs and advance them one step at a time.

:::goat The replay rule that makes durability work
Whatever the mechanism, one invariant governs everything: **replaying a trajectory must not repeat side effects.**

That means each step's result is written to the log *before* the loop advances, and on recovery the loop reads the recorded result rather than re-executing. A tool call that already happened must never happen again just because the process died after it.

The corollary is that anything nondeterministic — the current time, a random ID, the model's own output — must be **recorded, not recomputed**. This is exactly the requirement in [deterministic simulation](../03-distributed/verification.html): route every source of nondeterminism through something you can capture and replay. Teams that skip it get agents that behave differently after every restart, and cannot reproduce a failure.
:::

## Sandboxing

Agents that execute code, run shell commands, or browse the web are executing untrusted input — because the model's output is derived from user input, and a [prompt injection](guardrails-and-abuse.html) turns the model into a confused deputy.

```diagram
   ESCALATING ISOLATION

   In-process eval          ✗ never. Trivially escapable.
   Container (Docker)       ⚠ shared kernel; escapes exist
   gVisor / Kata            ✓ syscall interception or a
                              lightweight VM
   Firecracker microVM      ✓ real VM boundary, ~125 ms boot
   Separate machine         ✓ strongest, slowest

   REGARDLESS of the mechanism:
     · no network, or a strict egress allowlist
     · read-only filesystem plus one writable scratch mount
     · CPU, memory, and PID limits
     · hard wall-clock timeout
     · no credentials in the environment — ever
     · destroy after use; never reuse a sandbox across users
```

**Network egress is the control that matters most.** A sandbox with unrestricted outbound access can exfiltrate anything it can read, including data the agent legitimately retrieved for the user. Default-deny with an allowlist of specific hosts is the only defensible posture.

**Startup latency drives the design.** A Firecracker microVM boots in ~125 ms; a container in tens of milliseconds; a fresh VM in seconds. For interactive agents, maintaining a **warm pool** of pre-booted sandboxes turns a visible delay into an invisible one — the same pooling logic as database connections, with a stronger reason.

## Concurrency and resource control

An agent platform is a scheduler for long-running, resource-hungry, variable-duration work.

```diagram
   LIMITS AT EVERY LEVEL

   per run:     max steps · max tokens · max cost · max wall time
   per user:    max concurrent runs · tokens/hour · spend/day
   per tenant:  aggregate quota, fair share against other tenants
   global:      total concurrent runs · model API rate limit budget

   Without ALL of these, one user with a script can consume
   the entire platform, and one buggy loop can produce a
   five-figure bill.
```

**The model API is a shared, rate-limited resource**, and it is usually the real bottleneck. Fifty concurrent agents each making a call is fifty concurrent requests against a quota shared with the rest of your product. This needs a token-bucket budget with per-tenant fair queueing, and it needs [backpressure](../03-distributed/backpressure.html) — when the budget is exhausted, queue or shed, never retry blindly into a rate limit.

**Long-running work must not hold a request thread.** The correct shape is: accept the request, persist the run, return an ID immediately, and stream or poll for progress. An agent that pauses for human approval may wait hours; no connection should be held open for that.

## Observability for agents

Tracing matters more here than anywhere else, because a failure is a *trajectory*, not an exception.

| What to capture | Why |
|---|---|
| Every step: model call, tool call, result | The trajectory *is* the debug log |
| Token counts and cost per step | Where the money went; cost p99 |
| Tool latency and error rate, per tool | The slow tool is usually the problem, not the model |
| Step count distribution | A rising tail means agents are struggling |
| Termination reason | Success, iteration limit, cost limit, error — the ratio is your health metric |
| Approval wait time | Human-in-the-loop bottlenecks |

**Termination-reason distribution is the single best health metric.** A shift from "completed" toward "hit iteration limit" is a quality regression, visible immediately, with no ground truth required. It's the agent equivalent of tool-call validity from [AI observability](../06-ai-infrastructure/ai-observability.html).

Make trajectories **replayable in a viewer**. When someone reports "the agent did something weird," the fix starts with reading exactly what it saw and did, step by step. A trajectory viewer is a small tool with a very high return.

## Cost control

:::derive Why unbounded agents are dangerous
```
   One agent run:
     20 steps, context growing 3,000 tokens/step

     step 1:   3,000 input
     step 10: 30,000
     step 20: 60,000
     total input ≈ 630,000 tokens
     output    ≈  10,000 tokens

   At representative pricing: roughly $2-6 per run.

   Now: a bug causes a no-progress loop that runs to the
   iteration cap, on every request, and 1,000 users hit it.

     1,000 × $4 = $4,000 in an hour, with no user value.

   Without a per-run cost ceiling and a global spend alarm,
   the first signal is the invoice.
```
:::

The controls, all of which are cheap to add and expensive to omit:

1. **Hard per-run cost ceiling.** Terminate and return partial results. Not a warning — a stop.
2. **Per-user and per-tenant daily budgets**, enforced at admission.
3. **Global spend rate alarm** on a short window, not a daily total.
4. **Cost estimate before starting**, from the task shape, so an obviously expensive run can be rejected or confirmed.
5. **Cheaper models for cheap steps.** Classification, routing, and simple extraction do not need the frontier model. This often halves the cost of a trajectory.

## Multi-agent coordination

When runs spawn sub-runs, you have a distributed system with a dependency graph.

- **Parent/child runs with propagated budgets.** A child's cost counts against the parent's ceiling, or the ceiling means nothing.
- **Cancellation must propagate.** Cancelling a parent must terminate its children, or you leak expensive orphans.
- **Deadlines propagate too** — the same [deadline propagation](../01-foundations/networking.html) as any RPC chain.
- **Fan-out limits.** An agent that can spawn agents needs a depth limit and a total-descendant limit, or a single request can recursively consume the platform.

That last one is not hypothetical. An agent whose plan includes "spawn a sub-agent per file" applied to a large repository is a fork bomb with a language model attached.

:::exercise Design the platform
A platform running customer-facing agents: 10,000 runs/day, 5–60 steps each, some executing user-supplied code, some requiring human approval before external actions.

1. Choose the durable execution mechanism and justify it. What exactly is persisted per step?
2. Design the sandbox: isolation level, network policy, resource limits, and pool warm-up. What's your startup latency budget?
3. Write the limit hierarchy — per run, user, tenant, global — with actual numbers for a product at this scale.
4. An agent pauses for approval at step 12. Describe the state, where it lives, and what happens if nobody responds for 48 hours.
5. Your model API quota is 500 requests/second shared with the rest of the product. Design the admission control and fair queueing across tenants.
6. A run crashed after calling `charge_customer` but before recording the result. Walk through recovery. What made it safe — and what would you have had to build in advance?
:::

:::paper Sources
No canonical academic paper. The most useful sources are systems documentation: Temporal's docs on deterministic replay explain the durable-execution model clearly, and the Firecracker paper (*Firecracker: Lightweight Virtualization for Serverless Applications*, Agache et al., NSDI 2020) is the reference for sandbox isolation with fast boot.

Anthropic's "Building Effective Agents" and the engineering write-ups from teams running code-execution agents (E2B, Modal) are the closest thing to a practitioner literature.
:::

## What to carry forward

- Agents are **long-running, stateful, expensive, and side-effecting** — every one of those is a platform requirement.
- **Durable execution**: persist before and after each step; **replay must never repeat side effects**.
- Record nondeterminism rather than recomputing it.
- **Sandbox with default-deny egress**; keep a warm pool to hide boot latency.
- **Limits at every level** — run, user, tenant, global — including a hard cost ceiling.
- **Termination-reason distribution** is the best agent health metric.
- **Propagate budgets, deadlines, and cancellation** to child runs, and cap fan-out depth.
