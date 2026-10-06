---
title: Build an Evaluation Platform
summary: The system that tells you whether an AI change helped — golden sets, judge orchestration, CI gates, and the statistics that stop you shipping noise.
difficulty: Hard
scope: HLD
level: 5
prereqs: [evaluation-systems, lakehouse-and-batch, job-scheduler, ai-observability]
tags: [level-5, ai, evaluation, testing]
unlocks: Turning "it feels better" into a number you can gate a deploy on.
---

:::predict Guess first
1. A prompt change moves a test score from 74% to 78% on 150 cases. Is that proof it helped?
2. Many good answers exist to "summarise this ticket". How could you score answers automatically when exact match won't work?
3. An evaluation run takes eight minutes and costs real money. How often will developers run it?
:::

## The product

An internal platform where anyone shipping an AI change — a prompt edit, a model upgrade, a retrieval tweak — can find out whether it helped, in minutes, before it reaches users.

**This is the least glamorous Level 5 build and arguably the most valuable.** Every other AI system in this atlas degrades silently. This is the one that notices.

## Phase 1 — A script and a spreadsheet

The version that genuinely works, and that most teams should start with.

```diagram
   cases.jsonl          200 inputs with expected outputs
        ↓
   run.py               for each case: call the system, save output
        ↓
   score.py             exact match / regex / a few assertions
        ↓
   report.md            pass rate, list of failures
```

**Survives to:** one team, a few dozen changes a month, tasks with checkable answers.

**What breaks first:** somebody changes a prompt and the outputs are all *different but arguably fine*. Exact match reports 40% and tells you nothing. You need to score open-ended text.

## Phase 2 — Judge orchestration

Most AI outputs can't be checked with an exact match — there are many good answers to "summarise this ticket". So you use a second model as the marker: show it the input, the output, and a rubric, and ask it to score. That's an **LLM judge**.

Now you have a distributed system, because 200 cases × 2 versions × 1 judge call each is 600 model calls, and they fail, get rate-limited, and cost money.

```viz
{
  "type": "flow",
  "caption": "The judge turns evaluation into a batch inference problem.",
  "nodes": [
    { "id": "s", "label": "Eval run", "sub": "suite + 2 system versions", "col": 0, "accent": "#38bdf8" },
    { "id": "q", "label": "Work queue", "sub": "one task per case per system", "col": 1, "accent": "#a78bfa" },
    { "id": "w", "label": "Workers", "sub": "call system · call judge · retry", "col": 2, "accent": "#4ade80" },
    { "id": "r", "label": "Results store", "sub": "per-case outputs and scores", "col": 3, "accent": "#fbbf24" },
    { "id": "a", "label": "Aggregate", "sub": "by category, with CIs", "col": 4, "accent": "#fb7185" }
  ],
  "edges": [
    { "from": "s", "to": "q" }, { "from": "q", "to": "w" },
    { "from": "w", "to": "r" }, { "from": "r", "to": "a" }
  ]
}
```

Design decisions that matter here:

**Pairwise, not pointwise.** From [evaluation systems](../07-ai-systems/evaluation-systems.html): ask "which is better, A or B" rather than "rate this 1–5". More reliable, and it directly answers the question being asked. Run both orderings and average to cancel position bias.

**Cache on `(input, system_version, prompt_version)`.** Most changes touch one component. A prompt change to step 3 of a pipeline shouldn't re-run steps 1 and 2, and shouldn't re-run the baseline at all.

:::derive Why caching is the difference between usable and ignored
```
   Suite: 500 cases. Pipeline: 4 model calls per case.
   Comparison run = baseline + candidate = 4,000 calls
   plus 500 judge calls.

   No caching:  4,500 calls per PR
                ~8 minutes, and real money per run
                → developers stop running it

   With caching on (input, component_version):
     baseline results: cached from main, 0 calls
     candidate: only the changed component re-runs
     → 500 calls for the changed step + 500 judge
     → ~1.5 minutes
                → developers run it on every push
```
:::

**Idempotent, resumable runs.** A run of 4,500 model calls will have failures. Persist per-case results as they complete, key tasks by `(run_id, case_id, system)`, and make a retry pick up where it stopped. This is the [job scheduler](../08-case-studies/job-scheduler.html) pattern applied to evaluation.

**For agents, score the outcome, not the transcript.** Run each case in a fresh sandbox and check the end state — did the test pass, was the record created, is the file correct? A checkable outcome beats a judged transcript whenever you can get one, and agent benchmarks such as SWE-bench work exactly this way. Run each case a few times too: agents are less deterministic than single calls, so report the pass rate across attempts.

**Survives to:** a few teams, hundreds of runs a week.

**What breaks first:** someone ships a change that scored +3 points and it turns out to be noise. You need statistics.

## Phase 3 — Statistics and honest reporting

Two ideas make the difference. A **confidence interval** is the range the true result plausibly sits in given how few cases you tested — "+4 points, but anywhere from −2 to +10" means you genuinely don't know whether it helped. And the **minimum detectable effect** is how large an improvement would have to be before your suite could distinguish it from luck: with 150 cases, anything under about 12 points is invisible.

```diagram
   REPORT WITHOUT STATISTICS       REPORT WITH STATISTICS

   Baseline:  74%                  Baseline:  74%
   Candidate: 78%                  Candidate: 78%  (+4, 95% CI: −2 to +10)
   ✓ SHIP IT                       ⚠ NOT SIGNIFICANT at n=150
                                     minimum detectable effect: 12 points
                                     → need 900 cases, or a bigger change
```

Three things to build:

- **Paired comparison.** Both systems run on the same cases; compare per-case. This removes case difficulty as a variance source and roughly halves the sample size needed.
- **Report the minimum detectable effect** next to every result, computed from the suite size. A result smaller than the MDE is not a result.
- **Per-category breakdown, always.** An aggregate that improves 4 points while one category drops 15 is a regression that shipped. Show the categories sorted by change, worst first.

:::goat The reporting decision that changes behaviour
Show **diffs, not scores.** "Score fell from 0.81 to 0.78" produces a shrug. "These 14 cases regressed — here are the inputs and both outputs side by side" produces a fix.

The platform's real job is not producing a number; it's putting the specific failures in front of the person who caused them, in a form they can read in ninety seconds. Build the diff viewer before you build the dashboard.
:::

## Phase 4 — CI integration

```diagram
   PR touches prompts/, models/, or retrieval/
        ↓
   ┌──────────────────────────────────────────┐
   │ 1. assertions        30 s   must pass    │
   │ 2. smoke suite       90 s   no category  │
   │      (100 cases)            drop > 5%    │
   │ 3. judge vs main    3 min   win ≥ 45%    │
   │ 4. cost + latency    30 s   within 20%   │
   └──────────────────────────────────────────┘
        ↓
   PR comment: pass/fail + the regressed cases inline

   NIGHTLY on main:
     full suite (2,000 cases), full judge, all categories
     tracked as a time series
```

The engineering constraints that make or break adoption:

- **Under five minutes**, or people merge without waiting.
- **Deterministic where possible** — temperature 0, pinned model versions — so the same PR gives the same result twice.
- **Cost-capped per run**, with the cost shown in the PR comment. Visible cost keeps suites honest.
- **Skippable with a reason**, recorded. A hard gate people cannot bypass gets disabled entirely the first time it blocks an urgent fix.

## Phase 5 — Closing the loop with production

The suite is only as good as its cases, and the best cases come from real failures.

```diagram
   PRODUCTION                          EVAL PLATFORM

   user thumbs-down          ────────►  candidate case
   escalation to human       ────────►  candidate case
   tool-call failure         ────────►  candidate case
   output flagged by a       ────────►  candidate case
     safety classifier
                                             ↓
                                     human triage queue
                                       · is this a real failure?
                                       · what's the expected output?
                                       · which category?
                                             ↓
                                        golden set

   Plus: sample 1% of production traffic through the judge
   continuously → quality as a live time series, not a
   per-release snapshot.
```

**The triage queue is the part that needs a human and cannot be skipped.** Auto-adding every thumbs-down produces a suite full of user error and ambiguous cases, which then reports regressions that aren't real. One person spending twenty minutes a day on triage keeps the suite trustworthy.

## Phase 6 — Judge calibration as a first-class feature

The judge is a measurement instrument, and an uncalibrated instrument is worse than none.

```diagram
   CALIBRATION RUN (monthly, and on any judge/rubric change)

     sample 150 cases where the judge made a call
     have humans label the same cases blind
     compute agreement and Cohen's kappa

       kappa > 0.6   → trustworthy for gating
       0.4 - 0.6     → advisory only, do not gate
       < 0.4         → the rubric is broken; fix before use

   Track agreement over time. A drop means the traffic
   distribution moved and the rubric no longer fits it.
```

Also worth building: **bias diagnostics.** Correlate judge scores against output length — if the correlation is strong, the judge is rewarding verbosity, and you're optimising for it without knowing.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Pairwise judging | Pointwise 1–5 scores | Relative judgments are far more consistent; scores drift between runs |
| Cache on component version | Re-run everything | 3× faster and cheaper; caching is what makes it run on every push |
| Paired comparison | Independent samples | Removes case difficulty as a variance source; halves the required n |
| Report MDE with every result | Report the delta alone | Stops teams shipping noise as an improvement |
| Per-category breakdown | Aggregate score | Aggregates hide the regression that matters |
| Diff viewer before dashboard | Score dashboard | A number produces a shrug; the failing cases produce a fix |
| Human triage of new cases | Auto-add production failures | An unvetted suite reports regressions that aren't real |
| Judge calibration against humans | Trust the judge | An uncalibrated judge is a confident random number generator |
| Skippable gate with recorded reason | Hard block | Unbypassable gates get disabled the first time they block a hotfix |

## What you'd cut for v1

Everything past Phase 2. A hundred curated cases, a pairwise judge, results cached by component version, and a PR comment showing which cases regressed. That covers most of the value; the statistics and production loop can wait until people are actually using it.

**Do not cut:** the per-category breakdown, and showing the actual failing outputs. Those are what make the platform useful rather than decorative.

## Explaining the design

> "The core problem is that AI changes have no reliable feedback signal, so teams ship on impression and discover regressions weeks later. The platform's job is to make 'did this help?' answerable in under five minutes.
>
> Structurally it's a batch inference system: a run fans out to one task per case per system version, workers execute and score, results persist per case so runs are resumable. The scheduler and idempotency machinery is the same as any job platform.
>
> The two decisions that matter most are pairwise judging — relative comparisons are much more consistent than absolute scores — and caching on component version, which is what takes a run from eight minutes to ninety seconds and therefore from 'run before release' to 'runs on every push'.
>
> The statistics matter more than people expect. With 150 cases you can only detect roughly a 12-point difference, so a 4-point improvement is noise. Reporting the minimum detectable effect alongside every result is what stops teams shipping noise.
>
> And the judge needs calibrating against human labels before it can gate anything. An uncalibrated judge optimises for verbosity and formatting, and you find out months later that users disagree with every improvement you shipped."

## Next

[Build a Fine-Tuning Platform](fine-tuning-platform.html) — where the evaluation harness becomes the thing that decides whether a training run was worth it.

## Check yourself

```recall
Q: Why is the eval platform arguably the most valuable AI build?
A: Every other AI system degrades silently; this is the one that notices, turning "it feels better" into a number you can gate a deploy on.

Q: Why judge pairwise rather than pointwise?
A: "Which is better, A or B?" is far more consistent than 1–5 scores and answers the real question. Run both orderings to cancel position bias.

Q: What makes evals fast enough to run on every push?
A: Caching on (input, component version, prompt version): the baseline comes from main and only the changed component re-runs — about 8 minutes down to 90 seconds.

Q: What are a confidence interval and the minimum detectable effect?
A: The plausible range of the true result, and the smallest change the suite can distinguish from luck. At 150 cases a 4-point gain is noise when the MDE is ~12 points.

Q: Name three reporting rules.
A: Paired comparison on the same cases, the MDE next to every result, a per-category breakdown sorted worst-first — and show the regressed cases' diffs, not just scores.

Q: What makes a CI eval gate adoptable?
A: Under five minutes, deterministic (temperature 0, pinned models), cost-capped with cost shown in the PR, and skippable with a recorded reason so it isn't disabled outright.

Q: How do production failures become eval cases?
A: Thumbs-down, escalations, tool failures and safety flags feed a human triage queue that confirms the failure, writes the expected output and assigns a category.

Q: How do you know the judge can be trusted?
A: Calibrate monthly against blind human labels: kappa above ~0.6 can gate, 0.4–0.6 is advisory, below 0.4 means the rubric is broken. Check for length bias too.
```

## What to carry forward

- Start with a script and a spreadsheet; add a pairwise judge when outputs are open-ended.
- Cache by component version so evals run on every push.
- Report confidence intervals, the MDE and per-category diffs — never a bare delta.
- Feed triaged production failures back into the golden set.
- Calibrate the judge against humans before letting it gate anything.
