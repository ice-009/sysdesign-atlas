---
title: Structured Output & Tool Contracts
summary: Getting reliable machine-readable output from a probabilistic system — schema design, constrained decoding, validation and repair, and idempotent tool execution.
difficulty: Medium
scope: HLD
tags: [ai, structured-output, json-schema, tools]
prereqs: [decoding-strategies, idempotency]
unlocks: A deterministic interface between a probabilistic model and the rest of your system.
---

## The interface problem

The moment a model's output feeds a program rather than a human, you need a contract. And you're asking a system that samples from a probability distribution to satisfy a schema exactly, every time.

:::derive Why a small failure rate isn't small
```
   Per-call parse failure rate:  2%

   One call:            98.0% success
   5-call pipeline:     0.98⁵  =  90.4%
   20-step agent:       0.98²⁰ =  66.8%
   50-step agent:       0.98⁵⁰ =  36.4%

   → A third of 20-step agent runs fail on FORMATTING alone,
     before any question of whether the answers were correct.

   At 0.1% per call:
   20-step agent:       0.999²⁰ = 98.0%

   → The per-call rate matters enormously, and the fix that
     takes it to exactly zero is worth more than any amount
     of retry logic.
```
:::

## Four levels of guarantee

| Approach | Guarantee | Cost |
|---|---|---|
| Ask nicely in the prompt | None; ~1–5% failure | Free |
| Few-shot examples | Better; still probabilistic | Prompt tokens |
| Retry on parse failure | Eventually succeeds, usually | Full extra generations; unbounded tail latency |
| **Constrained decoding** | **Absolute — invalid output is unrepresentable** | Small per-step masking cost |
| Fine-tuning for format | High, not absolute | Training cost |

**Constrained decoding is the right default** whenever the runtime supports it, and the mechanism is worth understanding because it explains why the guarantee is absolute rather than statistical.

Recall from [decoding strategies](../05-ai-foundations/decoding-strategies.html) that each step produces a score for every possible token, and one is then chosen. Constrained decoding works out which tokens would make the output invalid *given what has been generated so far*, and sets their scores to negative infinity before the choice happens. The malformed option isn't unlikely — it isn't on the menu.

```diagram
   Schema: { "status": "ok"|"error", "count": integer }

   Generated:  {"status": "

   Valid next tokens:  o | e     (only "ok" or "error" can follow)
   Everything else:    masked to −∞

   → the state machine, not the model, enforces the grammar
```

Efficient implementations (XGrammar, Outlines, llama.cpp GBNF) precompute the allowed-token mask per automaton state, so the per-step cost is a bitmask lookup rather than a schema evaluation — near-zero overhead in practice.

:::trap Constraining the format does not constrain the content
Guaranteed-valid JSON containing a fabricated order ID is still wrong. Constrained decoding eliminates parse errors, which is a large and specific win; it says nothing about correctness.

The failure mode it can *introduce*: when a model doesn't know the answer, an unconstrained model might say "I'm not sure." A constrained one must produce something schema-valid, so it produces a plausible-looking value.

The fix is to **put uncertainty in the schema**: make fields nullable, add an explicit `confidence`, or include a `{"status": "insufficient_information"}` variant. If the schema has no way to express "I don't know", you've forced the model to guess.
:::

## Schema design

Schemas written for a model differ from schemas written for a programmer.

```diagram
   ✗ HARD FOR A MODEL

     { "d": "string",              // what is d?
       "t": 0,                     // what unit? what scale?
       "f": ["a", "b"],            // what do these mean?
       "meta": {}                  // unconstrained free-for-all
     }

   ✓ EASY FOR A MODEL

     { "due_date": "YYYY-MM-DD or null if not stated",
       "priority": "low" | "medium" | "high",
       "estimated_hours": number between 0.5 and 40,
       "tags": array of up to 5 strings from the allowed list,
       "confidence": "high" | "medium" | "low"
     }
```

Rules that measurably improve accuracy:

- **Descriptive names.** The field name is a prompt. `customer_email_address` beats `email` beats `e`.
- **Enums over free strings.** A closed set is both easier for the model and enforceable in the schema.
- **Descriptions on every field**, including the format and what to do when the information is absent.
- **Flat over nested.** Deep nesting increases error rates; three levels is a reasonable ceiling.
- **Order fields by dependency.** Models generate left to right, so a field that depends on reasoning should come *after* a field that holds the reasoning. Put `reasoning` before `answer` and the answer improves — the model has conditioned on its own analysis.

That last one is worth emphasising: **field order is a chain-of-thought lever.** `{"answer": ..., "reasoning": ...}` produces a guess followed by a rationalisation. `{"reasoning": ..., "answer": ...}` produces analysis followed by a conclusion. Same schema, materially different accuracy.

## Validation and repair

Even with constrained decoding you need semantic validation, because the schema only enforces shape.

```diagram
   LAYERS OF VALIDATION

   1. Syntactic     is it parseable?
                    → constrained decoding makes this always yes

   2. Schema        do types and required fields match?
                    → also guaranteed by constrained decoding

   3. Semantic      are the VALUES sensible?
                    · does that customer ID exist?
                    · is the date in the future when it must be?
                    · does the total equal the sum of line items?
                    → NOT guaranteed. This is your job.

   4. Business      is this action permitted for this user
                    in this context?
                    → definitely your job, and a security boundary
```

**Repair loops** handle semantic failures: return the specific error to the model and ask for a correction.

```
   attempt 1 → {"customer_id": "CUST-99999"}
   validate  → error: customer CUST-99999 not found
   attempt 2 → feed the error back as an observation
             → {"customer_id": "CUST-10432"}   ✓

   Cap repairs at 1-2 attempts. Beyond that the model is
   usually stuck and you're paying for a loop that won't
   converge — fall back to a human or an error.
```

The error message quality matters as much as in any API: `"customer_id: no customer found with ID CUST-99999. Use search_customer to find the correct ID."` produces a recovery; `"validation failed"` produces another wrong guess.

## Tool contracts

Tool calls are structured output with a side effect attached, which raises the stakes considerably.

:::goat Idempotency is not optional at the tool boundary
Retries happen: the model repeats a call, a repair loop re-issues it, an [agent](agent-infrastructure.html) restarts from a checkpoint, or a network timeout leaves the outcome unknown. Any mutating tool will eventually be invoked twice for the same logical operation.

The requirement is the same as any [idempotent API](../03-distributed/idempotency.html): a deterministic key, derived from the operation's *content* rather than generated fresh per attempt, and a server-side record of completed operations.

```
   ✗ key = uuid4()              new every retry → duplicate charge
   ✓ key = hash(run_id, step_index, tool_name, arguments)
                                stable across retries → safe
```

Deriving the key from the trajectory position and arguments means a replay produces the same key, and the second execution is a no-op returning the first result. **This single decision is what makes durable agent execution safe**, and it has to be built into the tool, not requested in the prompt.
:::

Other properties a good tool contract has:

- **Explicit reversibility.** Mark each tool read-only, reversible, or irreversible. The approval policy and the retry policy both key off this.
- **Bounded results.** A tool returning unbounded data blows the context budget. Paginate, and say so in the response.
- **Actionable errors.** Structured, with a hint about what to do instead.
- **Timeouts everywhere**, with the remaining budget propagated from the caller.

## Streaming structured output

Streaming a JSON object is awkward: it isn't parseable until the closing brace, so the user watches a spinner while the model writes.

Options:

- **Partial JSON parsing.** Incrementally parse the prefix, completing open structures speculatively. Lets you render fields as they arrive. Libraries exist; the edge cases are fiddly.
- **Field-by-field streaming.** Emit each completed field as a separate event. Cleaner, requires a custom protocol.
- **Split the call.** Stream the prose for the user, then make a separate constrained call for the structured part. Two calls, much simpler, and often the best user experience.
- **Order for perceived latency.** Put the fields the UI shows first *first*, so something appears quickly.

## When not to use structured output

Constrained generation has a real cost beyond compute: forcing a model into a rigid schema can reduce quality on tasks that need open reasoning. The model spends capacity satisfying the grammar rather than thinking.

The reliable mitigation is a **reasoning field first**, as above — give it room to think inside the structure. Where that isn't enough, a two-call approach (reason freely, then extract) usually beats a single heavily-constrained call.

:::exercise Design the contract
An email triage system: classify incoming email, extract action items, and optionally draft a reply or create a ticket.

1. Write the output schema. Include field descriptions, enums, and a way to express uncertainty.
2. Order the fields deliberately. Explain what each position buys you.
3. `create_ticket` is a mutating tool. Design the idempotency key so a retry after an unknown-outcome timeout is safe.
4. The extracted `assignee_email` doesn't exist in your directory. Design the repair loop — error message, retry cap, and fallback.
5. At 20,000 emails/day with a 1.5% parse failure rate, how many failures daily? What does constrained decoding change, and what failures remain?
6. The UI shows a category badge immediately and the draft reply after. Design the streaming approach.
:::

:::paper Sources
*Efficient Guided Generation for Large Language Models* (Willard & Louf, 2023) is the Outlines paper — finite-state-machine-guided decoding. *XGrammar* (Dong et al., 2024) is the current fast implementation with precomputed masks.

For the reasoning-order effect, *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models* (Wei et al., NeurIPS 2022) is the underlying result; putting the reasoning field first is that finding applied to a schema.
:::

## What to carry forward

- **Per-call failure rates compound.** 2% per call is a third of 20-step runs failing.
- **Constrained decoding makes invalid output unrepresentable** — the only approach with a real guarantee.
- **It constrains format, not content.** Put uncertainty in the schema, or you force a guess.
- **Field order is a chain-of-thought lever.** Reasoning before answer.
- **Semantic and business validation are still yours.** Repair loops need actionable errors and a cap.
- **Derive idempotency keys from trajectory position and arguments**, never fresh per attempt.
- **Mark every tool read-only, reversible, or irreversible** — retry and approval policy both depend on it.
