---
title: Quantization & Numeric Formats
summary: Why FP32 was always overkill, what BF16, FP8 and INT4 actually change, and why halving the bits nearly halves your latency as well as your memory.
difficulty: Medium
scope: Core
tags: [ai, quantization, precision, memory]
prereqs: [inference-arithmetic]
unlocks: The highest-leverage single knob in inference deployment.
---

## Why precision is an infrastructure decision

**Quantization** means storing each of the model's numbers in fewer bits — 8 instead of 16, or even 4 — accepting a little imprecision in exchange for a much smaller model. The names below are just bit widths: FP32 is 32 bits per number, BF16 is 16, INT4 is 4.

Why that's an infrastructure decision rather than a research one comes straight from [inference arithmetic](inference-arithmetic.html): the time to produce a token is the bytes of weights you must read divided by memory bandwidth. Halve the bytes, halve the time.

```diagram
   70B model, 3 TB/s memory bandwidth, single GPU:

     FP32  280 GB  → doesn't fit; needs 4 GPUs
     BF16  140 GB  → needs 2 GPUs;   47 ms/token if it fit on one
     FP8    70 GB  → fits one 80 GB GPU (barely);  23 ms/token
     INT4   35 GB  → fits comfortably;             12 ms/token

   → Quantization changes how many GPUs you need, how fast you
     decode, and how much KV cache fits. Three wins from one knob.
```

That third win is easy to miss. Smaller weights leave more memory for KV cache, which raises concurrency, which raises the batch size, which raises arithmetic intensity, which raises throughput. The effects compound.

## The formats

```diagram
   FP32   [S][ 8 exponent ][      23 mantissa      ]   4 bytes
   FP16   [S][5 exp][  10 mantissa  ]                  2 bytes
   BF16   [S][ 8 exponent ][7 mant]                    2 bytes
   FP8-E4M3 [S][4ex][3m]                               1 byte
   FP8-E5M2 [S][ 5ex ][2]                              1 byte
   INT8   [        8-bit integer      ]                1 byte
   INT4   [ 4-bit ]                                    0.5 byte
```

| Format | Bytes | Range | Precision | Where used |
|---|---:|---|---|---|
| FP32 | 4 | Huge | High | Legacy; optimizer states |
| **BF16** | 2 | Same as FP32 | Low (7-bit mantissa) | **Default for training** |
| FP16 | 2 | Narrow | Better than BF16 | Older training; overflow-prone |
| **FP8 (E4M3)** | 1 | Moderate | Coarse | **Modern inference; some training** |
| INT8 | 1 | Fixed-point, needs scale | Coarse | Mature inference quantization |
| INT4 | 0.5 | Very coarse, needs group scales | Very coarse | Memory-constrained inference |

:::goat Why BF16 beat FP16, despite worse precision
BF16 keeps FP32's 8-bit exponent and sacrifices mantissa bits. FP16 does the opposite: more precision, far narrower range.

Neural network training cares much more about **range** than **precision**. Gradients span many orders of magnitude, and a value that overflows or underflows FP16's narrow range becomes `inf` or `0` — which poisons the update. A value that loses a few mantissa bits is just slightly noisy, and SGD is extremely tolerant of noise.

FP16 training therefore needs loss scaling — multiply the loss to push gradients into representable range, then divide back — with all the tuning failure that implies. BF16 needs none of it, because it can represent whatever FP32 could. **Same size, much less operational pain**, which is why it won.
:::

## What actually gets quantized

Three separate things, with different sensitivities:

```viz
{
  "type": "stack",
  "caption": "Weights quantize easily. Activations don't. KV cache is in between and is often the best target.",
  "layers": [
    { "label": "Weights", "sub": "static, quantize offline, biggest memory win", "accent": "#4ade80" },
    { "label": "KV cache", "sub": "grows with every token — FP8 here doubles concurrency", "accent": "#38bdf8" },
    { "label": "Activations", "sub": "dynamic, outlier-prone, hardest to quantize", "accent": "#fb7185" },
    { "label": "Compute", "sub": "separate question: what precision do the tensor cores use?", "accent": "#a78bfa" }
  ]
}
```

**Weight-only quantization** is the common starting point: store weights at INT4, dequantize to BF16 in the kernel, compute in BF16. You get the full memory and bandwidth win — which is what decode is limited by — without needing low-precision arithmetic to be accurate. For decode this is nearly ideal.

**Weight-and-activation quantization** additionally runs the matrix multiplies at low precision, which speeds up *compute*-bound work too, i.e. prefill and training. Harder, because activations have outliers.

## The outlier problem

Quantizing means mapping a range of floats onto a small set of levels. If one value in a tensor is 100× larger than the rest, the scale must accommodate it, and everything else collapses into a few levels.

```diagram
   Typical activation values:  [-2.1, 0.4, 1.8, -0.9, 143.0, 0.2, ...]
                                                     ↑ outlier

   INT8 scale must cover ±143  →  step size ≈ 1.1
   → the values near ±1 quantize to 0, ±1, or ±2
   → almost all information destroyed
```

Transformer activations reliably develop these outliers — a small number of dimensions carrying very large magnitudes, appearing consistently in the same channels. This is why naive INT8 activation quantization badly damages large models while working fine on small ones.

Three families of fix:

- **Mixed precision (LLM.int8()).** Detect outlier dimensions and keep them in FP16; quantize the rest to INT8. Correct, and slow because of the mixed kernels.
- **Smoothing (SmoothQuant).** Migrate the difficulty from activations to weights by scaling channels — divide the activation channel by *s* and multiply the corresponding weight column by *s*. Mathematically equivalent, and weights are much easier to quantize.
- **Rotation (QuaRot, SpinQuant).** Apply a rotation matrix that spreads outlier energy across dimensions before quantizing. Removes outliers rather than working around them.

## Calibration-based methods

For aggressive weight quantization (INT4 and below), the good methods use a small calibration dataset — a few hundred samples — to decide *how* to round.

| Method | Idea |
|---|---|
| **Round-to-nearest** | The naive baseline. Fine at INT8, poor at INT4 |
| **GPTQ** | Quantize column by column, adjusting remaining weights to compensate for the error just introduced |
| **AWQ** | Identify the ~1% of weight channels that matter most (by activation magnitude) and protect them with per-channel scaling |
| **QAT** | Fine-tune with quantization simulated in the forward pass, so the model learns weights that survive it |

**Group-wise scales** are the other essential ingredient: instead of one scale per tensor, use one per group of 64 or 128 weights. The scale metadata costs a few percent of the memory saved and dramatically improves accuracy, because it localises the range each scale must cover.

:::derive What INT4 actually costs in memory
```
   Naive claim:  INT4 is 4× smaller than BF16.

   Reality, with group size 128 and FP16 scales + zero points:

     128 weights × 4 bits          =  512 bits
     1 scale (FP16)                =   16 bits
     1 zero point (FP16)           =   16 bits
                                     ─────────
     total                         =  544 bits for 128 weights
                                     = 4.25 bits per weight

   vs BF16's 16 bits  →  3.76× smaller, not 4×.

   Smaller groups (32) give better accuracy and worse ratio
   (~4.5 bits/weight). This is the real knob.
```
:::

## Quality: what you actually lose

Rough guidance, with the strong caveat that it varies by model and task:

| Precision | Typical quality impact |
|---|---|
| BF16 | Reference; indistinguishable from FP32 |
| FP8 | Very small; commonly deployed with no measurable regression |
| INT8 (with SmoothQuant or similar) | Small |
| INT4 (GPTQ/AWQ, group 128) | Noticeable on hard reasoning; often fine for chat |
| INT3 and below | Substantial degradation |

:::trap Perplexity is not a quality measure for quantization
Quantized models routinely show near-identical perplexity while being measurably worse at what you care about. Perplexity averages over all tokens, and it is dominated by the easy, high-confidence ones — the exact tokens quantization noise doesn't affect.

The capabilities that degrade first are the ones that depend on long chains of precise computation: multi-step reasoning, code generation, structured output adherence, and instruction-following at the edges.

**Evaluate on your task**, with your prompts, on outputs you care about. A 0.1 perplexity delta can hide a 5-point drop on code correctness.
:::

:::goat Bigger-and-quantized usually beats smaller-and-precise
Given a fixed memory budget, a 70B model at INT4 (~35 GB) generally outperforms a 13B model at BF16 (~26 GB), on most tasks, by a clear margin.

The reason is that quantization noise degrades a model gracefully, while removing parameters removes capability outright. Larger models are also *more* robust to quantization, because knowledge is distributed redundantly across more weights.

The practical rule: **choose the largest model that fits after quantization**, rather than the largest model that fits at full precision. This inverts the instinct most people start with.
:::

## Deployment shape

A reasonable default for a serving deployment today:

1. **Weights at FP8** — near-zero quality cost, halves memory and decode latency versus BF16, hardware-supported on current accelerators.
2. **KV cache at FP8** — roughly doubles concurrency; tends to matter more than the weight saving once you're serving many users.
3. **Compute at FP8** for prefill where the hardware supports it; BF16 accumulate.
4. **INT4 weights** when you are memory-constrained and have measured that your task tolerates it.
5. **Keep sensitive layers higher precision** — the embedding, the unembedding, and often the first and last transformer blocks. They're a small fraction of parameters and disproportionately sensitive.

:::exercise Choose a configuration
You must serve a 70B model on a single 80 GB GPU (3 TB/s bandwidth), targeting 100 concurrent users with ~4,000-token conversations. GQA, 8 KV heads, 80 layers, head_dim 128.

1. At BF16 weights, do you fit at all? At FP8? At INT4 with group 128 (use 4.25 bits/weight)?
2. For each that fits, compute remaining memory and KV cache tokens available at BF16 cache and at FP8 cache.
3. Which configurations reach 100 concurrent users at 4,000 tokens each?
4. Estimate TPOT for each. What's the throughput/quality frontier here?
5. Which single change buys the most: FP8 weights, FP8 KV cache, or INT4 weights? Why is the answer different at 10 users than at 500?
:::

:::paper Sources
*LLM.int8()* (Dettmers et al., NeurIPS 2022) identified the outlier problem. *SmoothQuant* (Xiao et al., ICML 2023) is the migration trick; *GPTQ* (Frantar et al., ICLR 2023) and *AWQ* (Lin et al., MLSys 2024) are the standard weight-quantization methods.

*A Study of BFLOAT16 for Deep Learning Training* (Kalamkar et al., 2019) is the range-versus-precision argument in full.
:::

## What to carry forward

- **Halving bits nearly halves decode latency**, because decode is bandwidth-bound. Memory, latency, and concurrency all improve together.
- **BF16 beat FP16 on range, not precision** — networks need range far more.
- **Weights quantize easily; activations have outliers.** Smoothing or rotation is how you handle them.
- **Group-wise scales** are what make INT4 viable; the real cost is ~4.25 bits/weight, not 4.
- **Perplexity hides quantization damage.** Evaluate on your task.
- **Largest model that fits after quantization** beats smaller model at full precision.
