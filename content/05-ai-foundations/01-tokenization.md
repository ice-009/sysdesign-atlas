---
title: Tokens — the Unit of Everything
summary: Why models see subword fragments rather than characters or words, how BPE builds a vocabulary, and why the token is simultaneously the unit of cost, latency, memory, and context.
difficulty: Easy
tags: [ai, tokenization, llm, cost]
prereqs: [back-of-envelope]
unlocks: Reasoning about model cost and context limits in the units the system actually uses.
---

## Why this is the first page

A language model does not process text. It processes a sequence of integers, and everything downstream — how much GPU memory a request consumes, how long it takes, what it costs, whether it fits in the context window — is measured in those integers.

Get the token count wrong by 3× and every capacity estimate you make is wrong by 3×. This page exists so that doesn't happen.

## Why not characters or words?

Both obvious options fail, in opposite directions.

```viz
{
  "type": "compare",
  "caption": "Both extremes fail. Subwords are the compromise that stuck.",
  "left": {
    "title": "Characters (~100 symbols)",
    "items": [
      "Tiny vocabulary, no unknown inputs ever",
      "Sequences 4-5× longer",
      "Attention is quadratic → 16-25× the cost",
      "Model wastes capacity relearning spelling"
    ]
  },
  "right": {
    "title": "Whole words (500K+)",
    "items": [
      "Short sequences, semantically clean units",
      "Enormous embedding and output layers",
      "Any unseen word becomes <UNK> — data loss",
      "Typos, code, and morphology all break it"
    ]
  }
}
```

**Subword tokenization** takes the middle: common words stay whole, rare words split into fragments, and any input can be represented as *some* sequence of pieces. Nothing is ever unrepresentable, and the sequences stay short.

```diagram
   "The unhappiest tokenization"

   character:  T h e   u n h a p p i e s t   t o k e n i z a t i o n
               → 28 tokens

   subword:    "The" " un" "happiest" " token" "ization"
               → 5 tokens

   word:       "The" "unhappiest" "tokenization"
               → 3 tokens, but "unhappiest" is probably <UNK>
```

## How BPE builds the vocabulary

Byte-Pair Encoding is the dominant algorithm. It is trained on a corpus, once, before the model is trained, and produces a fixed merge list.

```diagram
   1. Start with every byte as its own token (256 base tokens)
      → guarantees ANY input is representable, in any language,
        including emoji and malformed UTF-8

   2. Count every adjacent pair in the training corpus

   3. Merge the most frequent pair into a new token
        "t" + "h"  →  "th"        (very common in English)

   4. Repeat until you hit the target vocabulary size
        typically 32,000 - 200,000 tokens

   Result: an ordered list of merges. Encoding replays them
   greedily; decoding is a lookup. Both are deterministic.
```

The consequence: **the vocabulary reflects the training corpus.** A tokenizer trained mostly on English web text spends most of its vocabulary on English fragments, and everything else pays for it.

:::derive The tokens-per-word ratio, and why it varies
```
   English prose        ~1.3 tokens/word    ~4 characters/token
   Code                 ~2.0 tokens/word    whitespace and
                                            punctuation fragment
   JSON                 ~2.5 tokens/word    braces, quotes, colons
   Non-Latin scripts    2-4× worse          often 1 token per
                                            character or less
   Random / base64      ~1 token per 2 chars  no learned merges

   Working estimate for English:  1 token ≈ 4 characters ≈ 0.75 words
                                  1,000 tokens ≈ 750 words ≈ 1.5 pages
```
:::

:::goat The fairness consequence people don't see
The same sentence in English and in Hindi, Thai, or Burmese can differ by **3–5× in token count**. Because APIs bill per token and context windows are measured in tokens, this means:

- Non-English users pay several times more for the same content
- They get a fraction of the effective context window
- They hit rate limits sooner

This isn't a policy decision anyone made; it falls out of a vocabulary trained on a corpus that was mostly English. It's worth naming when designing a multilingual product, because your cost model and your context budget are both language-dependent in a way that a per-request estimate will hide.
:::

## Where tokenization leaks into behaviour

Tokenization explains a surprising number of otherwise-baffling model behaviours.

**Arithmetic and digits.** If `1234` tokenizes as `123` + `4` while `1235` tokenizes as `1` + `235`, the model sees inconsistent structure for adjacent numbers. Newer tokenizers deliberately split digits individually to fix this, at the cost of longer sequences.

**Character-level tasks.** "How many r's in strawberry?" is hard because the model sees `str` + `aw` + `berry`, not letters. It has to have memorised the spelling rather than being able to look.

**Trailing whitespace.** `"Hello"` and `"Hello "` are different tokens with different continuations. A prompt ending in a space can measurably degrade output, because the natural next token was the one that started with a space.

**Glitch tokens.** Tokens that appeared in the tokenizer's training corpus but were rare or absent in the model's training data end up with essentially untrained embeddings. Feeding one produces bizarre, sometimes deranged output. The famous examples from GPT-2/3 era vocabularies came from Reddit usernames and scraping artifacts.

:::trap "I'll just estimate 4 characters per token"
Fine for English prose, and wrong everywhere else in ways that matter:

- A JSON payload can be **2× worse** than the estimate
- Code is roughly **1.5× worse**
- Non-Latin scripts can be **4× worse**
- Base64 or a UUID is close to worst case

If your product handles structured data, code, or non-English text, **measure with the actual tokenizer** rather than estimating. The tokenizer is a downloadable artifact, and counting is cheap. Getting this wrong means your context-window checks pass in testing and fail in production for a subset of users.
:::

## Why the token is the unit of everything

Once text becomes tokens, every quantity in the system is denominated in them.

| Quantity | Relationship to tokens |
|---|---|
| **Cost** | Billed per input and output token, usually at different rates |
| **Latency** | Output time ≈ tokens × time-per-token; output length dominates |
| **GPU memory** | KV cache grows linearly with every token of every live request |
| **Context limit** | A hard cap measured in tokens |
| **Rate limits** | Meaningfully expressed as tokens/minute, not requests/minute |
| **Attention cost** | Quadratic in sequence length — 2× the tokens is 4× the attention work |

:::derive Sizing a chat product
```
   50,000 daily active users, 8 conversation turns each

   Per turn:
     system prompt            600 tokens
     conversation history     grows: 0, 400, 800, ... ≈ 1,400 avg
     new user message         100 tokens
     ────────────────────────────────
     input  ≈ 2,100 tokens
     output ≈   350 tokens

   Daily:
     50,000 × 8 = 400,000 turns
     input:  400,000 × 2,100 =  840M tokens/day
     output: 400,000 ×   350 =  140M tokens/day

   Two observations that change the design:

   1. Input is 6× output. Anything that reduces input volume —
      prefix caching, history summarisation — is the biggest
      available lever on cost.

   2. History grows every turn, so turn 8 costs far more than
      turn 1. Cost per conversation is superlinear in length.
```
:::

That second point is why chat products cap history length, summarise older turns, or charge by conversation rather than message. It is a direct consequence of tokens accumulating.

## The practical rules

**Count with the real tokenizer.** Every provider publishes theirs. Estimating is fine for a napkin, never for a limit check.

**Budget the context window explicitly.** System prompt + retrieved documents + history + user message + *room for the response*. That last term is the one people forget, and running out of room mid-generation truncates the answer.

**Put the stable content first.** Prefix caching means an unchanged prefix can be reused rather than recomputed. Putting the system prompt first and volatile content last turns most of every request into a cache hit — worth a large fraction of both cost and time-to-first-token. This gets developed properly in the KV cache material.

**Rate limit on tokens, not requests.** A request generating 4,000 tokens costs two hundred times one generating 20. An RPS limit does not describe this workload at all.

:::exercise Measure, don't estimate
1. Take a 500-word English article, a 500-word code file, and a 500-word JSON document. Estimate tokens for each at 0.75 words/token, then count with a real tokenizer. How far off were you on each?
2. Take one paragraph and translate it into a non-Latin-script language. Compare token counts. What does the ratio do to your cost model?
3. For the chat product above, compute the cost of turn 1 versus turn 8 at any current input/output pricing. What's the ratio, and at what turn number would you start summarising?
4. Your context limit is 128K tokens and you retrieve 20 documents averaging 2,000 tokens. What's left for history and the response? What's your policy when retrieval returns more than fits?
:::

:::paper Sources
*Neural Machine Translation of Rare Words with Subword Units* (Sennrich, Haddow & Birch, ACL 2016) introduced BPE for NLP. *SentencePiece* (Kudo & Richardson, EMNLP 2018) made it language-agnostic by dropping the assumption that whitespace separates words.

Andrej Karpathy's "Let's build the GPT Tokenizer" video builds BPE from scratch and is the clearest available explanation of the failure modes above.
:::

## What to carry forward

- **Subword tokenization** is the compromise between unrepresentable words and unmanageable vocabularies.
- **English prose ≈ 4 chars/token.** Code, JSON, and non-Latin scripts are all worse, sometimes several times worse.
- The vocabulary reflects its training corpus, which makes **cost and context language-dependent**.
- Tokenization explains arithmetic weirdness, character-counting failures, and glitch tokens.
- **Tokens are the unit of cost, latency, memory, context, and rate limiting.** Denominate every estimate in them.
- **Stable content first** in a prompt, so the prefix can be cached.
