---
title: Build an Image Host
summary: Where the write path starts doing real work — direct uploads, async processing, and derivative generation without blocking the user.
difficulty: Easy
scope: HLD
level: 1
prereqs: [object-storage, cdn, message-queues, back-of-envelope]
tags: [level-1, media, async]
unlocks: The upload-process-serve pipeline that every media system reuses.
---

## The product

Upload an image, get a URL. The image is served fast, worldwide, at whatever size the page needs.

Simple to state, and it introduces the pattern behind every media system in this atlas: **the write path does work asynchronously, the read path does nothing at all.**

## Estimation first

```diagram
   1M uploads/day, average 3 MB original

   Writes:  10⁶ / 10⁵ s = 10 uploads/s avg → ~30 peak
   Storage: 1M × 3 MB   = 3 TB/day of originals
            + derivatives (~1 MB total across sizes)
            ≈ 4 TB/day → 1.5 PB/year

   Reads:   say 50 views per upload
            50M views/day / 10⁵ = 500 QPS avg → 1,500 peak
            at 200 KB served = 300 MB/s egress
```

**What those numbers decided:** 1.5 PB/year rules out the database immediately and makes storage tiering mandatory. 300 MB/s of egress is affordable from a CDN and expensive from your own origin. And the 50:1 read:write ratio says: spend effort on the write path so the read path can be trivial.

## Phase 1 — Don't proxy the bytes

The instinct is to POST the file to your API. Don't.

```diagram
   NAIVE
   client ──3MB──► app server ──3MB──► object storage
                    ▲
              your bandwidth, your memory, a request thread
              held for the entire upload

   PRESIGNED (correct)
   1. client ──► app: "I want to upload"
   2. app ──► client: signed URL + key (15 min, size/type capped)
   3. client ──3MB──────────────────► object storage  (direct)
   4. client ──► app: "done, key=X"
   5. app: VERIFY the object exists and matches, then write metadata
```

Your application tier never touches image bytes. It stays small, stateless, and unaffected by someone uploading over a slow mobile connection.

:::trap Always verify step 5
Never write the metadata row just because the client said "done." A client can claim a file it never uploaded, or point at someone else's key. Check the object exists, check its size and content type, and ideally check a checksum the client committed to in step 1. This is a real vulnerability class, not a theoretical one.
:::

## Phase 2 — Derivatives, asynchronously

A page needs a thumbnail, not a 3 MB original. You need multiple sizes.

**Do not generate them on upload synchronously** — that makes the user wait several seconds for work they don't need finished. And do not generate them on read — that makes the first viewer of every image wait.

```diagram
   upload complete
        │ event
        ▼
   ┌─────────┐    ┌──────────────────┐
   │  Queue  │───►│  Worker fleet    │
   └─────────┘    │  · validate      │
                  │  · strip EXIF    │  ← privacy: EXIF carries GPS
                  │  · resize (4)    │
                  │  · re-encode     │
                  │  · scan          │
                  └────────┬─────────┘
                           ▼
                  derivatives → object storage
                  status = ready → database
```

The user gets an immediate response with `status: processing`, and the UI shows a placeholder. This is the [queue](../building-blocks/message-queues.html) pattern doing exactly what it's for: converting a latency problem into a throughput problem.

**Workers must be idempotent.** The queue is at-least-once, so the same image *will* be processed twice. Key the output on `(image_id, size, version)` so a reprocess overwrites rather than duplicating. See [Idempotency](../distributed/idempotency.html).

## Phase 3 — Serving

```diagram
   client ──► CDN ──miss──► object storage
              │
              └── 95%+ hit rate for popular images
```

Two rules that make this work:

**Immutable URLs.** Include a content hash in the key: `/img/a3f9c2b1/800x600.webp`. Now you can cache for a year with `immutable`, never invalidate anything, and a re-upload just creates a new URL. This is the single highest-leverage decision in the read path.

**Serve modern formats with fallback.** WebP/AVIF cut bytes substantially versus JPEG at equal quality. Negotiate on `Accept`, but be careful — varying on the full `Accept` header fragments your cache badly. Normalize it to a small set of buckets first.

## Phase 4 — Cost

**The trigger:** you're storing 1.5 PB/year and the bill is the largest line item in engineering.

Access is extremely skewed over time — an image is viewed heavily for a week, occasionally for a month, essentially never after a year.

```diagram
   Age            Tier                  Relative cost
   0-30 days      Standard + CDN            1×
   30-180 days    Infrequent access        ~0.5×
   180+ days      Archive                  ~0.1×
   Originals      Deep archive             ~0.03×
```

Lifecycle rules automate the transitions. **Keep the originals** — you'll want them when a better codec arrives and re-encoding the library becomes worthwhile.

:::goat Cost is a design constraint
Cost is almost always left out of the design entirely. Saying *"at petabyte scale, storage tiering isn't an optimization — it's the difference between a viable product and an unviable one, so I'd set lifecycle rules from day one rather than retrofitting them"* is a distinctly senior observation, and it costs one sentence.
:::

## Phase 5 — On-the-fly resizing

**The trigger:** product wants arbitrary sizes, and pre-generating every variant means storing dozens of derivatives for images nobody views at that size.

Flip to generating on first request, at the edge, then caching:

```diagram
   /img/a3f9c2b1?w=640 ──► CDN (miss) ──► resize service ──► origin
                            │                                  │
                            └──────── cached forever ◄─────────┘
```

**The tradeoff:** you trade storage for compute, plus a slow first request per variant. Right when the variant space is large or unpredictable; wrong when there are four known sizes and every one gets used.

**Guard the parameter space.** An open `?w=` parameter is a denial-of-service vector — an attacker requests 10,000 distinct widths and you generate 10,000 derivatives. Allow-list the dimensions or sign the parameters.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Presigned direct upload | Proxy through the API | Keeps bytes off the app tier; slow clients don't hold threads |
| Verify object after upload | Trust the client's callback | Clients can claim files they never uploaded |
| Async derivative generation | Synchronous on upload | User shouldn't wait for work they don't need finished |
| Content-hash URLs, cached forever | Mutable paths + invalidation | Invalidation is unnecessary if URLs never change meaning |
| Strip EXIF | Preserve it | GPS coordinates in user photos is a privacy leak |
| Lifecycle tiering | Everything in standard | At PB scale this decides whether the product is affordable |

## What you'd cut for v1

Multiple formats, on-the-fly resizing, tiering, and a CDN. Ship: presigned upload, one thumbnail size generated async, served from object storage. Add the rest when the numbers demand it.

## Explaining the design

> "The write path does the work and the read path does none. Uploads go directly to object storage via a presigned URL so my app tier never handles bytes — then an event triggers async workers to strip EXIF and generate derivatives. Reads are pure CDN, with content-hash URLs so I can cache immutably and never invalidate. At petabyte scale, lifecycle tiering to archive storage is what makes the economics work."

## Next

[Build Instagram](instagram.html) — the same media pipeline, now with a social graph and a feed on top.
