---
title: Evaluation Systems
summary: Golden sets, LLM-as-judge, statistical power, and CI gates — building the measurement infrastructure without which every AI change is a guess.
difficulty: Hard
scope: HLD
tags: [ai, evaluation, testing, llm-judge]
prereqs: [ai-observability, lakehouse-and-batch]
unlocks: Knowing whether a change made your system better, rather than believing it did.
---

## Why this is infrastructure

Software has a clean feedback loop: write a test, it passes or fails, you know. AI systems have no such thing. Outputs are open-ended, correctness is often a judgment call, and the same input can produce different outputs.

The consequence is that without deliberate evaluation infrastructure, teams ship on **vibes** — someone tries ten prompts, feels the new version is better, deploys. Sometimes it is. Regressions ship regularly and are discovered weeks later, if at all.

```diagram
   THE THINGS YOU CANNOT ANSWER WITHOUT EVALS

     · is the new prompt better than the old one?
     · did upgrading the model break anything?
     · is the cheaper model good enough for this step?
     · which of these three retrieval changes helped?
     · has quality drifted over the last three months?
     · is this failure a regression or has it always failed?
```

Every one of those is a routine question, and every one is unanswerable by inspection.

## The layers

```viz
{
  "type": "stack",
  "caption": "Fast and cheap at the top, slow and truthful at the bottom. You need all four.",
  "layers": [
    { "label": "Unit — assertions", "sub": "deterministic checks · seconds · every commit", "accent": "#4ade80" },
    { "label": "Golden set — offline", "sub": "fixed cases with expected outputs · minutes · every PR", "accent": "#38bdf8" },
    { "label": "Judge — scaled scoring", "sub": "LLM grades open-ended output · minutes · every PR", "accent": "#a78bfa" },
    { "label": "Human review", "sub": "the ground truth · days · periodic and for calibration", "accent": "#fbbf24" },
    { "label": "Online A/B", "sub": "real users, real outcomes · weeks · the real answer", "accent": "#fb7185" }
  ]
}
```

**Start at the top.** Deterministic assertions are cheap and catch more than expected: is the output valid JSON, does it cite a source that exists, is it under the length limit, does it avoid banned phrases, did the tool call have valid arguments. These are ordinary tests, they run in CI, and they catch a large fraction of real regressions.

## Golden sets

A **golden set** is a fixed collection of inputs paired with known-good outputs — the AI equivalent of a test suite, and the backbone of **offline** evaluation, meaning evaluation you run before shipping rather than on live traffic.

**Where the cases come from**, in rough order of value:

1. **Production failures.** Every bug becomes a permanent test case. This is the highest-value source by a wide margin, and it makes the suite grow in exactly the directions that matter.
2. **Real traffic samples**, stratified so rare-but-important categories are represented rather than swamped by the common case.
3. **Edge cases by construction** — empty input, adversarial input, extremely long input, wrong language, ambiguous requests.
4. **Synthetic generation** for coverage, clearly labelled as such and always human-reviewed before entering the set.

:::goat A hundred well-chosen cases beat a thousand random ones
The value of a golden set is in **discrimination** — its ability to distinguish a better system from a worse one. Cases everything passes contribute nothing. Cases everything fails contribute nothing until you're close.

So curate for difficulty and diversity:
- Keep cases where systems *disagree*; those carry the signal.
- Retire cases that everything has passed for six months, or move them to a cheap smoke suite.
- Stratify by category and track per-category scores — an aggregate that hides "we got 20% worse at refunds and 5% better everywhere else" is worse than no aggregate.

The counter-intuitive practice: **when a change improves the aggregate, look at what got worse.** Aggregates almost always hide a regression somewhere, and finding it is the point of having the set.
:::

## LLM-as-judge

For open-ended output there is no exact match to check, so a model grades it. This is what makes evaluation scale, and it needs to be treated as a measurement instrument that requires calibration.

```diagram
   THREE FORMS

   POINTWISE     "Rate this answer 1-5 for helpfulness"
                 ✗ scores drift between runs and versions
                 ✗ clusters around 4; poor discrimination

   PAIRWISE      "Which answer is better, A or B?"
                 ✓ much more reliable — relative judgments
                   are easier than absolute ones
                 ✓ directly answers "did my change help?"
                 ✗ O(n²) comparisons if you want a full ranking

   REFERENCE     "Does this answer contain the key facts
                  from the reference?"
                 ✓ most reliable of the three
                 ✗ needs a reference answer per case
```

**Pairwise is the default** for comparing two systems, because that's the actual question and relative judgments are substantially more consistent than absolute ones.

The biases that will distort your results if unhandled:

| Bias | Effect | Mitigation |
|---|---|---|
| **Position** | Prefers whichever answer is shown first | Run both orders, average |
| **Verbosity** | Prefers longer answers regardless of quality | Length-control the rubric; check length correlation |
| **Self-preference** | Prefers output from the same model family | Judge with a different model than the one being tested |
| **Style over substance** | Prefers confident, well-formatted, wrong answers | Rubric must require factual grounding explicitly |

:::trap An uncalibrated judge is a random number generator with a confident interface
Before you trust a judge, **measure its agreement with humans** on a sample of 100–200 cases. Report Cohen's kappa or simple agreement rate.

- Agreement above ~80% (kappa > 0.6): usable for relative comparisons.
- Agreement 60–80%: usable as a noisy signal; do not gate on it.
- Below 60%: it is measuring something else. Fix the rubric or the judge model.

Recalibrate whenever the judge model, the rubric, or the task distribution changes. A judge validated a year ago on a different model is not validated.

The failure this prevents is real and common: a team optimises against a judge for months, ships confidently, and discovers users disagree — because the judge was rewarding verbosity and formatting the whole time.
:::

## Statistical power

The question "is 78% better than 74%?" has a statistical answer, and ignoring it means shipping noise.

:::derive How many cases you need
```
   Comparing two systems, paired (both run on the same cases):

     n ≈ 16 × σ² / δ²        for 80% power at α = 0.05

   Binary success/failure around p = 0.75, δ = 5 points:
     σ² = p(1−p) = 0.1875
     n ≈ 16 × 0.1875 / 0.0025  =  1,200 cases

   To detect a 10-point difference:
     n ≈ 16 × 0.1875 / 0.01    =    300 cases

   To detect a 2-point difference:
     n ≈ 16 × 0.1875 / 0.0004  =  7,500 cases

   → With 100 cases you can reliably detect only large
     differences (~15+ points). A 3-point "improvement"
     on 100 cases is noise, and treating it as real is
     how teams ship regressions.
```
:::

Two practical consequences:

- **Pair your comparisons.** Running both systems on the same cases and comparing per-case removes case difficulty as a variance source, and cuts the required sample size substantially.
- **State the minimum detectable effect** alongside every result. "System B scored 3 points higher on 120 cases" should be reported as "3 points, which is within noise for this sample size."

## Evaluation in CI

Offline evals belong in the pipeline, gating changes the way tests do.

```diagram
   ON EVERY PULL REQUEST touching prompts, models, or retrieval:

     1. deterministic assertions          ~30 s   must pass
     2. golden set, small (100 cases)     ~3 min  no category
                                                  regression > 5%
     3. judge comparison vs main          ~5 min  win rate ≥ 45%
                                                  (not 50 — noise)
     4. cost and latency check            ~1 min  within 20% of main

   NIGHTLY:
     · full golden set (2,000 cases)
     · full judge evaluation
     · per-category breakdown, tracked over time

   Anything that fails posts the specific failing cases as
   a diff in the PR — not a score, the actual outputs.
```

Two design points that determine whether this gets used or disabled:

- **Cache aggressively.** Re-running 2,000 model calls per commit is slow and expensive. Key results on `(input, model version, prompt version)` — most PRs change one component and most results are reusable.
- **Show diffs, not scores.** "Score dropped from 0.81 to 0.78" is unactionable. "These 12 cases regressed, here are the before/after outputs" is a review.

## Online evaluation

Offline evals measure a proxy. Only production measures the thing.

- **A/B test by user**, not by request, and run long enough for slow metrics.
- **Instrument implicit feedback** — did they copy the code, accept the suggestion, resolve the ticket, avoid escalating? Available on every interaction and usually more informative than thumbs.
- **Sample production traffic into the judge** continuously, so quality is a live time series rather than a per-release snapshot.
- **Route production failures back into the golden set** automatically. This closes the loop and is the mechanism by which the suite gets better at the things you actually get wrong.

## Evaluating retrieval and agents separately

From [retrieval architecture](retrieval-architecture.html): measure recall@k independently, or you cannot tell a retrieval failure from a generation failure.

For [agents](agent-architectures.html), evaluate the trajectory as well as the outcome: task success on verifiable criteria, step count versus optimal, tool selection accuracy, and recovery rate after a tool failure. An agent that reaches the right answer in 40 steps is worse than one that takes 6, and outcome-only evaluation cannot see the difference.

:::exercise Build the harness
A support assistant answering from a knowledge base, with escalation to a human.

1. Write five deterministic assertions that need no ground truth and would catch real regressions.
2. Design the golden set: how many cases, sourced from where, stratified along which dimensions?
3. Write a judge rubric for "is this answer helpful and grounded". How do you prevent the verbosity bias?
4. Validate the judge: how many human labels do you need, and what agreement threshold makes it trustworthy?
5. Your golden set has 150 cases. What's the minimum detectable difference? Is that enough to gate a PR on?
6. Design the CI gate: what runs, what thresholds, what it shows a reviewer on failure, and what it costs per PR.
7. Escalation rate rises from 12% to 15% in production. Trace how you'd determine whether that's a quality regression or a traffic-mix change.
:::

:::paper Sources
*Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena* (Zheng et al., NeurIPS 2023) is the foundational study — it documents the position, verbosity, and self-preference biases and measures judge–human agreement.

*G-Eval* (Liu et al., EMNLP 2023) is the chain-of-thought judging approach. *RAGAS* (Es et al., 2023) is the RAG-specific metric set. For statistical practice, *The Practical Guide to Statistical Power* material in A/B testing literature transfers directly.
:::

## What to carry forward

- **Without evals you ship on vibes**, and regressions go unnoticed for weeks.
- **Five layers**: assertions, golden set, judge, human, online. Start with assertions — they're cheap and catch a lot.
- **Production failures are the best source of golden cases.** Route them back automatically.
- **Pairwise judging beats pointwise.** Validate the judge against humans before trusting it.
- **Compute your minimum detectable effect.** A 3-point gain on 100 cases is noise.
- **Gate CI on category regressions and show diffs**, not aggregate scores.
- **Evaluate retrieval and agent trajectories separately** from final answers.
