---
title: Agent Architectures
summary: The tool-calling loop, why unbounded autonomy fails, and how to build agents as state machines with checkpoints rather than hopeful while-loops.
difficulty: Hard
scope: HLD
tags: [ai, agents, tool-use, orchestration]
prereqs: [decoding-strategies, idempotency]
unlocks: Designing agents that finish, cost a bounded amount, and can be debugged.
---

## What an agent actually is

Strip away the framing and an agent is a loop:

```diagram
   while not done:
       response = model(context)
       if response.has_tool_call:
           result = execute(response.tool_call)
           context += [response, result]
       else:
           return response.text
```

Twelve lines. Everything hard about agents is in what that loop omits: what happens when the tool fails, when the model loops, when the context overflows, when the process crashes on step 14 of 20, when the cost passes a hundred dollars, and when a tool call has an irreversible side effect.

**An agent is a distributed system with a nondeterministic scheduler.** Treating it as a prompt engineering problem is why so many agent projects stall at the demo.

## Tool definitions are an API contract

The model chooses tools based entirely on their descriptions. That makes tool definitions the highest-leverage text in the whole system.

```diagram
   ✗ WEAK
     name: search
     description: Searches for things

   ✓ STRONG
     name: search_customer_orders
     description: |
       Find orders for a specific customer by email or
       customer ID. Returns up to 50 orders, most recent
       first. Use this when the user asks about order
       history, status, or past purchases.

       Does NOT search products — use search_catalog for that.
       Does NOT return payment details.
     parameters:
       customer_identifier: email or customer ID (required)
       status: filter by pending|shipped|delivered (optional)
       since: ISO date, only orders after this (optional)
```

The principles that matter, in order of impact:

1. **Say when to use it, and when not to.** Negative guidance ("does NOT search products") prevents more mistakes than positive guidance adds.
2. **Fewer tools, better described.** Past roughly 20 tools, selection accuracy degrades noticeably. Group related operations behind one tool with a mode parameter, or use a two-stage approach: retrieve relevant tools, then present only those.
3. **Return errors the model can act on.** `{"error": "customer_not_found", "hint": "try search_customer_by_name"}` lets it recover. `500 Internal Server Error` produces a retry loop.
4. **Make results compact.** A tool returning 8,000 tokens of JSON consumes the context budget and buries the signal. Summarise or paginate at the tool boundary.
5. **Constrain the schema.** [Constrained decoding](../05-ai-foundations/decoding-strategies.html) makes malformed tool calls impossible rather than rare.

## Patterns

| Pattern | Shape | Best for |
|---|---|---|
| **Chain** | Fixed sequence of steps | Known workflows. Not really an agent, and often the right answer |
| **Router** | Classify, then dispatch to a specialised handler | Multi-intent products |
| **ReAct** | Reason → act → observe, repeated | General tool use; the common default |
| **Plan-and-execute** | Produce a full plan, then execute steps | Complex tasks; plan is inspectable before running |
| **Reflection** | Generate, critique, revise | Quality-critical output; costs 2–3× |
| **Multi-agent** | Specialised agents with a coordinator | Genuinely separable subtasks |

:::goat Prefer the most constrained pattern that solves the problem
There is a strong pull toward maximum autonomy — one agent, all the tools, let it figure it out. It demos beautifully and operates badly.

Constrained patterns are better on every production axis:
- **Predictable cost.** A chain has a known number of model calls; a loop does not.
- **Debuggable.** When step 3 of a 5-step chain fails you know exactly where. When an autonomous loop produces the wrong answer on turn 12, you have a transcript to read.
- **Testable.** You can unit-test a step. You cannot unit-test emergent behaviour.
- **Better quality**, usually — structure that encodes what you know about the task beats rediscovering it every run.

The honest heuristic: **if you can write the workflow down, write it down.** Use an agent loop for the parts that genuinely require adaptation — which, in most products, is a smaller portion than the initial design assumed.
:::

## Multi-agent, and when it isn't worth it

```diagram
   COORDINATOR / WORKER

     Coordinator: decomposes, dispatches, synthesises
        ├── Researcher   (search tools)
        ├── Analyst      (data tools)
        └── Writer       (no tools)

   Genuine benefits:
     · each agent has a small, focused tool set
     · subtasks run in PARALLEL — real latency win
     · separate context windows avoid one giant prompt

   Genuine costs:
     · coordination overhead: every handoff is model calls
     · information loss at each boundary — summarised
       context loses detail the next agent needed
     · errors compound across agents
     · debugging spans multiple trajectories
     · cost multiplies
```

**Parallelism is the strongest argument.** Three independent research subtasks running concurrently is a real three-fold latency improvement that a single sequential agent cannot achieve.

**Specialisation is the weakest argument.** "A writer agent and an editor agent" is usually two prompts to the same model with extra plumbing and lossy handoffs between them. If the subtasks aren't independent enough to parallelise, they probably belong in one agent.

## Termination

The loop must end. Every one of these needs an explicit limit:

```diagram
   · max iterations           (typically 10-50)
   · max total tokens         (a hard cost ceiling)
   · max wall-clock time
   · max cost in currency
   · no-progress detection    (repeating the same tool call
                               with the same arguments)
   · explicit completion      (the model calls a `finish` tool)

   When any limit trips:
     return partial results with a clear explanation —
     never fail silently, and never keep going
```

**No-progress detection** catches the most common real failure. An agent calls `search("customer orders")`, gets nothing useful, and calls `search("customer orders")` again. Hash the last few (tool, arguments) pairs; if a repeat appears, inject an explicit observation — "you have already tried this and it returned nothing; try a different approach" — or terminate. This one check eliminates a large fraction of runaway loops.

## Failure and recovery

Agents fail mid-trajectory, and the interesting question is what state you're left in.

| Failure | Handling |
|---|---|
| Tool returns an error | Feed it back as an observation; the model can often recover |
| Tool times out | Retry with backoff, then report failure as an observation |
| Model produces invalid tool call | Constrained decoding makes this impossible; otherwise, repair and retry once |
| Context overflows | Compact history, or fail cleanly — don't silently truncate |
| Process crashes | **Requires durable state.** See below |
| Infinite loop | Iteration and no-progress limits |
| Model gives up early | Prompt for persistence; check completion criteria before accepting |

:::trap Side effects are not replayable, and this is the real architectural problem
An agent that has sent an email, charged a card, or deleted a file cannot simply be restarted from the beginning. Replaying the trajectory replays the side effects.

Three things are needed, and they're all familiar from [distributed transactions](../03-distributed/distributed-transactions.html):

1. **Idempotency keys on every mutating tool.** The same logical call executed twice does the work once. This is the single most important property and it must be enforced in the tool, not hoped for in the prompt.
2. **A durable trajectory log.** Every step — model call, tool call, result — persisted before the next step begins, so a restart resumes rather than restarts.
3. **Explicit compensation** for irreversible actions, or a human approval gate in front of them.

Note that this makes the tool boundary the transaction boundary, and the design question becomes: which of my tools are safe to retry? Answer it per tool, and mark them.
:::

## Human in the loop

Some actions should not be autonomous. The design is a policy, not a feature:

```diagram
   AUTO-APPROVE     read-only: search, fetch, analyse
   NOTIFY           low-risk writes: create a draft, add a comment
   APPROVE FIRST    external effects: send an email, make a payment,
                    modify production, delete anything
   NEVER            outside the agent's remit entirely

   The approval gate must:
     · pause DURABLY — the agent may wait hours for a human
     · show what will happen, in terms a human can evaluate
     · allow modify-and-continue, not just yes/no
     · time out with a defined default (usually: don't do it)
```

Durable pausing is the requirement that forces the architecture. An agent waiting for approval cannot be an in-memory loop in a request handler — it needs persisted state and a resumption path, which is the subject of [agent infrastructure](agent-infrastructure.html).

## Evaluating agents

Harder than evaluating a single response, because the trajectory matters as much as the answer:

- **Task success rate** — did it accomplish the goal? Needs a checkable definition of success per task.
- **Trajectory efficiency** — how many steps and tokens versus optimal?
- **Tool selection accuracy** — right tool, right arguments, measurable per call.
- **Recovery rate** — when a tool failed, did it recover or spiral?
- **Cost distribution** — the p99 matters more than the mean; that's where the runaway loops live.

**Build a fixed set of tasks with verifiable outcomes.** Not "did it write a good summary" but "did the file get created with the right content", "did the test pass", "was the correct customer record updated". Verifiable outcomes make regression testing possible, and without them agent development is anecdote-driven.

:::exercise Design an agent
A DevOps assistant: investigate alerts, query metrics and logs, read runbooks, and optionally restart services or scale deployments.

1. Define the tool set. For each: name, description with negative guidance, parameters, and whether it's read-only, reversible, or irreversible.
2. Which pattern — chain, ReAct, plan-and-execute? Justify against predictability and the fact that incidents vary.
3. Define the approval policy per tool. What can it do at 3am unattended?
4. Write the termination conditions with specific numbers, including no-progress detection.
5. The agent restarts a service, then crashes. What must be true for recovery to be safe? Design the idempotency key for `restart_service`.
6. Design the evaluation set: five scenarios with verifiable success criteria. How do you test the recovery path specifically?
:::

:::paper Sources
*ReAct: Synergizing Reasoning and Acting in Language Models* (Yao et al., ICLR 2023) is the interleaved reasoning-action loop. *Toolformer* (Schick et al., NeurIPS 2023) is tool use learned rather than prompted.

*Reflexion* (Shinn et al., NeurIPS 2023) is the self-critique pattern. Anthropic's "Building Effective Agents" (2024) is the best practitioner guide and argues for the constrained-pattern preference above; *τ-bench* (Yao et al., 2024) is a realistic agent benchmark with verifiable outcomes.
:::

## What to carry forward

- An agent is **a distributed system with a nondeterministic scheduler**, not a prompt.
- **Tool descriptions are the highest-leverage text**; negative guidance prevents more errors than positive guidance fixes.
- **Prefer the most constrained pattern that works.** If you can write the workflow down, write it down.
- **Multi-agent earns its cost through parallelism**, rarely through specialisation.
- **Every loop needs explicit limits**, including no-progress detection.
- **Side effects are not replayable** — idempotency keys, a durable trajectory log, and approval gates.
- **Evaluate on verifiable outcomes**, and watch the cost p99, not the mean.
