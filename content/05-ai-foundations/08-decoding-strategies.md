---
title: Decoding & Sampling
summary: How logits become tokens, why temperature and top-p behave the way they do, constrained decoding for structured output, and speculative decoding — the trick that gets latency for free.
difficulty: Medium
scope: Core
tags: [ai, decoding, sampling, speculative]
prereqs: [transformer-as-a-system, inference-arithmetic]
unlocks: Controlling output shape and cutting latency without touching the model.
---

:::predict Guess first
1. If you set temperature to 0, will a model always give exactly the same answer to the same prompt?
2. A model sometimes returns broken JSON. Is there a way to make invalid JSON literally impossible, not just unlikely?
3. Could a small model's guesses ever make a large model produce text faster without changing what it would say?
:::

## The last step of every forward pass

A forward pass doesn't end with a word. It ends with a score for *every* token in the vocabulary — one number each, maybe 100,000 of them, called **logits**. Something then has to convert those scores into a single chosen token, and that choice is the **decoding strategy**.

It's the cheapest place in the entire stack to change how a model behaves: no retraining, no redeployment, one configuration value.

```diagram
   hidden state  ──►  unembedding  ──►  logits (one per vocab token)
                                             ↓
                                        softmax / sampling
                                             ↓
                                        one token ID
                                             ↓
                                     appended, loop again
```

## Temperature

The scores are turned into probabilities by a step called **softmax**, which squashes them so they're all positive and add up to one. **Temperature** is a single number that divides the scores *before* that step: low temperature exaggerates the gaps between them and makes the top choice near-certain; high temperature flattens them and gives unlikely tokens a real chance.

:::derive What temperature does to a distribution
```
   p_i = exp(logit_i / T) / Σ exp(logit_j / T)

   Logits: [3.0, 2.0, 1.0]

     T = 0.5   →  [0.87, 0.12, 0.02]    sharper, more confident
     T = 1.0   →  [0.67, 0.24, 0.09]    the model's own distribution
     T = 2.0   →  [0.51, 0.31, 0.19]    flatter, more random
     T → 0     →  [1.00, 0.00, 0.00]    argmax (greedy)
     T → ∞     →  [0.33, 0.33, 0.33]    uniform

   T < 1 amplifies existing preferences.
   T > 1 flattens them, giving unlikely tokens a real chance.
```
:::

**Temperature 0 is greedy decoding**, and it is not the same as "the best answer." Greedy picks the highest-probability token at every step, which frequently walks into a locally attractive path with no good continuation. It also produces repetition loops, because the highest-probability continuation of a repeated phrase is often to repeat it again.

## Truncation: top-k and top-p

The problem with pure sampling is the tail. A vocabulary of 100,000 tokens where 99,000 have tiny probabilities still has meaningful total mass down there — and sampling from it occasionally produces a genuinely incoherent token that then conditions everything after it.

```diagram
   TOP-K (k = 40)              TOP-P / NUCLEUS (p = 0.9)

   keep the 40 most likely     keep the smallest set whose
   renormalise, sample         cumulative probability ≥ 0.9

   Fixed count, regardless     Adaptive:
   of how confident:             confident step → maybe 2 tokens
     confident step → still      uncertain step → maybe 300
     considers 40 options
                               → matches the model's own
   → too permissive when         uncertainty
     confident, too narrow
     when uncertain
```

**Top-p (nucleus) is the better default**, precisely because it adapts. When the model is sure the next token is `"` it considers almost nothing; when it's writing creative prose it considers a wide set. Typical production settings: `temperature 0.7, top_p 0.95` for general use; `temperature 0` for extraction, classification, and anything where you want reproducibility.

Two more knobs you'll see:

- **Min-p** — keep tokens with probability at least `min_p × max_prob`. Behaves better than top-p at high temperature.
- **Repetition / frequency / presence penalties** — subtract from the logits of tokens already emitted. Blunt instruments; they suppress legitimate repetition too (a variable name in code, a word in a list). Prefer fixing the prompt.

:::trap "Temperature 0 makes output deterministic"
It makes *sampling* deterministic. The output can still vary, for reasons that live entirely in the infrastructure:

- **Batch composition.** Floating-point reductions aren't associative, and kernels choose different reduction orders depending on batch shape. Different batch → different rounding → occasionally a different argmax when two logits are nearly tied.
- **MoE routing.** Capacity-based token dropping depends on what else is in the batch.
- **Hardware and kernel versions.** A different GPU or an upgraded inference engine changes numerics.

Genuine reproducibility requires pinning the model version, the engine version, the hardware, and often the batch size. Batch-invariant kernels — which fix the reduction order regardless of batch size, an approach Thinking Machines described in 2025 — remove the batch-composition source, at some cost in speed. If you need determinism for testing, assert on structure and semantics, not on exact strings.
:::

## Constrained decoding

If the output must be valid JSON matching a schema, you can *guarantee* it rather than hope for it — by masking out every token that would make the output invalid, before sampling.

```diagram
   Target schema:  { "name": string, "age": integer }

   Generated so far:  {"name": "Ada", "age":

   Valid next tokens: digits, whitespace, minus
   Everything else:  logit = −∞  →  probability 0

   → the model CANNOT emit an invalid token.
     Not "usually doesn't". Cannot.
```

Implementations compile the schema (JSON Schema, a regex, or a context-free grammar) into a state machine, and at each step compute the set of vocabulary tokens that keep the output on a valid path.

| Approach | Guarantee | Cost |
|---|---|---|
| Prompt "return JSON" | None | Free, fails a few percent of the time |
| Retry on parse failure | Eventual, probabilistic | Extra full generations |
| **Constrained decoding** | **Absolute** | Mask computation per step; can be near-zero with precomputed automata |
| Fine-tuning for format | High, not absolute | Training cost |

The efficient implementations (Outlines, XGrammar, llama.cpp's GBNF) precompute the token masks per automaton state, so the per-step cost is a lookup rather than a schema evaluation.

:::goat Constrained decoding is a reliability change, not a convenience
Any system that parses model output has a failure rate. At 2% parse failure and 20 tool calls in an agent trajectory, the probability of a clean run is `0.98²⁰ ≈ 67%` — a third of your runs fail on formatting alone.

Constrained decoding takes that term to exactly zero. For [agent infrastructure](../07-ai-systems/agent-infrastructure.html) and any structured-extraction pipeline, this converts a probabilistic system into a deterministic one at the interface, which is what makes the rest of the error handling tractable.

The remaining caveat worth naming: constraining the *format* does not constrain the *content*. The model will produce schema-valid nonsense if it doesn't know the answer — you've eliminated parse errors, not hallucination.
:::

## Speculative decoding

The most elegant idea in inference optimisation, and it follows directly from [inference arithmetic](inference-arithmetic.html).

Decode is memory-bandwidth-bound: producing one token requires reading all the weights. But that same weight read could process *several* token positions in one pass at almost no additional cost — the arithmetic is nearly free, the memory read is the expense.

So: have a small, fast model guess the next few tokens, then have the large model verify all of them in a single forward pass.

```diagram
   1. DRAFT — small model generates k = 4 candidate tokens
                (cheap: it's maybe 1/20th the size)

        "The capital of France is" → "Paris and it"

   2. VERIFY — large model runs ONE forward pass over all
                4 positions in parallel, producing what IT
                would have said at each position

   3. ACCEPT — compare, keep the longest matching prefix

        draft:   Paris   and    it     is
        target:  Paris   and    is     ...
                  ✓       ✓      ✗
        → accept 2 tokens, plus the target's own correction
          at the mismatch = 3 tokens from one large-model pass

   Cost:  one large forward pass + 4 small ones
   Yield: 3 tokens instead of 1
```

:::derive The speedup
```
   Acceptance rate α = fraction of drafted tokens accepted
   Draft cost ratio c = small model cost / large model cost
   Draft length k

   Expected tokens per large-model pass:
     E[accepted] = (1 − α^(k+1)) / (1 − α)

   With α = 0.8, k = 4:
     E = (1 − 0.8⁵) / 0.2  =  (1 − 0.328) / 0.2  ≈  3.36 tokens

   Overhead: 4 draft passes × c. With c = 0.05, that's 0.2
   large-model-equivalents.

   Speedup ≈ 3.36 / 1.2  ≈  2.8×
```
:::

The critical property: **rejection sampling makes the output distribution mathematically identical to decoding from the large model alone.** This is not an approximation and not a quality tradeoff — accept a draft token with probability `min(1, p_target/p_draft)`, and on rejection sample from the adjusted residual distribution. You get the same distribution, faster.

Variants that avoid needing a separate draft model:

- **Medusa** — extra prediction heads on the target model itself, each guessing a future position.
- **EAGLE** — draft at the feature level rather than the token level; higher acceptance rates.
- **EAGLE-3** (2025) — drops EAGLE's feature-prediction constraint and fuses features from several layers of the target model; acceptance rises further, and it's widely supported in serving engines.
- **Multi-token prediction heads** — trained alongside the model itself (DeepSeek-V3 does this), so the model ships with its own drafter.
- **Lookahead / n-gram** — draft by copying from the prompt. Extremely effective for code editing and summarisation, where much of the output is verbatim from the input.
- **Self-speculative** — skip layers to form a cheap draft from the same weights.

:::trap Speculative decoding does not increase throughput
It reduces **latency for a single request** by using idle compute. At batch 1, compute is idle and this is nearly free.

At **high batch sizes**, the GPU is no longer idle — arithmetic intensity is already high — so the extra verification work competes with real work. Speculative decoding can *reduce* total throughput under heavy load.

The right deployment is adaptive: speculate when the batch is small, disable it when the batch is large. Several serving engines now do this automatically, and it's a good example of an optimisation whose sign flips with load.
:::

## Beam search, and why it fell out of favour

Beam search maintains *b* candidate sequences and expands all of them, keeping the highest total log-probability. It remains standard for translation and other tasks with one correct answer.

For open-ended generation it is worse than sampling, and the reason is interesting: **the highest-probability sequence is not the best text.** Optimising for total likelihood produces short, generic, repetitive output — the model's idea of the safest possible thing to say. Human text is *surprising* in a measurable way, and sampling reproduces that; maximising likelihood specifically removes it.

Beam search also costs *b* times the memory and compute, which for an LLM means *b* times the KV cache. Rarely worth it.

:::exercise Configure and measure
1. For each, choose temperature and top-p and justify: extracting a date from an email; writing marketing copy; generating Python; a conversational assistant.
2. Your JSON extraction fails to parse 3% of the time. You make 12 calls per user request. What fraction of user requests fail? What does constrained decoding change that number to?
3. Speculative decoding with a draft model 1/15th the size, acceptance 0.7, k=5. Compute the expected speedup. At what acceptance rate does it stop being worth it?
4. Your acceptance rate on code generation is 0.85 but only 0.55 on creative writing. Explain the difference — and say what it implies about which workloads to enable it for.
:::

:::paper Sources
*The Curious Case of Neural Text Degeneration* (Holtzman et al., ICLR 2020) introduced nucleus sampling and is the source of the likelihood-is-not-quality argument.

*Fast Inference from Transformers via Speculative Decoding* (Leviathan, Kalman & Matias, ICML 2023) and *Accelerating Large Language Model Decoding with Speculative Sampling* (Chen et al., 2023) are the two simultaneous originals, including the proof that the output distribution is preserved. *Medusa* (Cai et al., 2024) and *EAGLE* (Li et al., 2024) are the draft-model-free variants.
:::

## Check yourself

```recall
Q: What does temperature do?
A: It divides logits before softmax: below 1 sharpens the distribution, above 1 flattens it, 0 is greedy argmax — which is not "best" and tends to loop.

Q: Why is top-p a better default than top-k?
A: Top-p keeps the smallest set reaching cumulative probability p, adapting to confidence (2 tokens when sure, hundreds when uncertain); top-k keeps a fixed count either way.

Q: Why isn't temperature 0 deterministic?
A: Batch composition changes floating-point reduction order, MoE routing depends on the batch, and hardware or kernel versions change numerics. Pin versions or use batch-invariant kernels; test on structure, not exact strings.

Q: How does constrained decoding work, and what does it guarantee?
A: A schema or grammar compiles to a state machine; at each step tokens that would break validity get −∞ logits. Format is guaranteed (0.98²⁰ ≈ 67% clean agent runs becomes 100%) — content is not.

Q: How does speculative decoding work?
A: A cheap drafter proposes k tokens; the large model verifies all in one pass (nearly free, since decode is bandwidth-bound); keep the longest matching prefix plus its correction.

Q: Does speculative decoding change the output?
A: No — rejection sampling (accept with probability min(1, p_target/p_draft), else resample from the residual) keeps the distribution identical to the large model alone.

Q: Why disable speculative decoding at high batch?
A: It uses idle compute to cut single-request latency. At high batch the GPU isn't idle, so verification competes with real work and can reduce throughput — enable it adaptively.

Q: Why did beam search lose for open-ended text?
A: Maximising total likelihood produces short, generic, repetitive text — human writing is measurably surprising — and it costs b× the KV cache.
```

## What to carry forward

- **Temperature scales logits; top-p adapts to the model's own uncertainty.** Top-p is the better default.
- **Temperature 0 is not determinism** — batch composition, MoE routing, and kernel versions all leak in.
- **Constrained decoding guarantees format**, turning a probabilistic interface into a deterministic one. It does not guarantee content.
- **Speculative decoding is free latency at low batch** because decode is bandwidth-bound — and preserves the output distribution exactly.
- It **costs throughput at high batch.** Enable it adaptively.
- **Highest-probability text is not best text**, which is why beam search lost for open-ended generation.
