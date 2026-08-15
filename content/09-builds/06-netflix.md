---
title: Build Netflix
summary: When bandwidth is the binding constraint. The transcoding pipeline, adaptive bitrate, and why the CDN isn't a layer — it's the whole design.
difficulty: Hard
scope: HLD
level: 3
prereqs: [cdn, object-storage, video-streaming, message-queues, back-of-envelope]
tags: [level-3, media, cdn, pipeline]
unlocks: Designing for bandwidth as the primary constraint, and async processing pipelines.
---

## The product

Browse a catalogue, press play, watch without buffering, resume where you left off, on any device and any connection.

**The whole design follows from one number**, so compute it first.

## Estimation

```diagram
   200M subscribers · 2h viewing/day · 1080p ≈ 5 Mbps

   Concurrent viewers ≈ 200M × 2h / 24h = 16.7M
   Peak (×2)                            ≈ 33M

   BANDWIDTH: 33M × 5 Mbps = 165 Tbps
```

**165 Tbps cannot come from your own servers.** At ~100 Gbps per machine that's 1,650 machines doing nothing but pushing bytes, from one location, with no locality. This is not a number you optimize your way around — it dictates that the CDN *is* the architecture and everything else exists to feed it.

```diagram
   CATALOGUE (small!)
     ~20,000 titles × 2h × ~4 GB/h source     = 160 TB of source
     × 6 renditions ≈ 1.5× source              ≈ 400 TB total

   TRANSCODING
     20,000 titles × 2h × 6 renditions
     at ~2× realtime per rendition per core   ≈ 480K core-hours
     → a large batch job, not a steady-state service
```

:::goat The catalogue insight
Netflix's catalogue is *tiny* — hundreds of terabytes, not petabytes. Compare YouTube, which ingests hundreds of hours per minute. That difference changes everything: a curated catalogue can be **fully pre-transcoded and pre-positioned** at the edge before anyone watches it, which is impossible for user-generated content.

Asking "curated catalogue or user-generated?" in the first two minutes is the highest-value clarifying question in this design.
:::

## Phase 1 — The ingest pipeline

Runs once per title, offline, with no latency pressure.

```diagram
   master file (ProRes, 100s of GB)
        │
        ├─ 1. VALIDATE   probe format, verify integrity
        │
        ├─ 2. SPLIT      chunk at keyframe boundaries
        │                 ← this is what enables parallelism
        │
        ├─ 3. ENCODE     each chunk × each rendition, in parallel
        │                 4K · 1080p · 720p · 480p · 360p · audio
        │                 → thousands of independent retriable tasks
        │
        ├─ 4. PACKAGE    assemble, segment into 4s chunks (CMAF/HLS)
        │
        ├─ 5. MANIFEST   master + per-rendition playlists
        │
        └─ 6. ARTIFACTS  thumbnails, preview sprites, subtitles
```

**Chunk-level parallelism is the whole trick.** A 2-hour film encoded serially takes many hours; split into 500 chunks across 500 workers it takes minutes. Splitting must happen at keyframes so each chunk decodes independently.

**Every task is idempotent and retriable**, keyed on `(title_id, rendition, chunk_index)`. Workers run on preemptible instances that *will* die mid-job — designing for that is a large cost saving and exactly the kind of operational detail that reads as experience.

**Per-title encoding** is the cost-conscious refinement worth naming: analyze each title's complexity and choose bitrates per title rather than applying a fixed ladder. An animated film needs far fewer bits than a grainy action sequence for the same perceived quality. This meaningfully cuts delivery bandwidth — which, at 165 Tbps, is the biggest line item you have.

## Phase 2 — Adaptive bitrate

The playback mechanism, and the reason the CDN works so well.

```diagram
   master.m3u8
     ├── 1080p/  seg001 seg002 seg003 ...   (4s each)
     ├── 720p/   seg001 seg002 seg003 ...
     └── 480p/   seg001 seg002 seg003 ...

   Client measures its own throughput and buffer level,
   then picks the quality for the NEXT segment.
```

Why this design is so effective:

- **Segments are static files.** Perfectly cacheable, no server-side session state. This is what makes 165 Tbps servable from cache.
- **Adaptation is client-side.** The server does nothing — no negotiation, no per-viewer state.
- **Bandwidth drops degrade quality rather than buffering.** A softer picture beats a spinner.
- **Seeking is a byte-range request**, not a stream restart.

**Segment length is a real tradeoff:** short (2s) adapts fast and starts quickly but multiplies request count; long (10s) is efficient and sluggish to adapt. ~4s is the usual compromise.

**Start low, step up.** Begin playback at a modest rendition and increase once the buffer fills. Time-to-first-frame matters more to retention than opening quality.

## Phase 3 — Getting bytes near users

```diagram
   Popularity is extremely skewed:
     a small fraction of titles drive most viewing

   HOT      pre-positioned at the edge BEFORE release
   WARM     pulled on demand, cached normally
   COLD     falls through to origin (rare, tiny fraction)
```

**Pre-positioning is the move a curated catalogue enables.** You know a major release drops Friday at 00:00 and you know roughly where the audience is. Push it to edges on Thursday. No cold-miss stampede at launch — the single largest traffic event of the week is served entirely from cache.

**Origin shield:** one extra cache sitting between all the edge locations and your origin servers. Without it, 200 edges missing the same file at the same moment means 200 identical requests to origin. With it, the first edge's miss fetches the file, the shield keeps it, and the other 199 are served from there.

**ISP-embedded caches** are how this actually works at the top end: your own cache appliances installed *inside* internet providers' own networks, so a popular episode travels from a box in the subscriber's own city rather than across the public internet. Mentioning this shows you understand delivery at real scale.

## Phase 4 — The control plane

Two terms worth separating, because this build turns on the split. The **data plane** is the part that moves the actual video — enormous traffic, almost no logic. The **control plane** is everything that decides things: what's in the catalogue, whether you're allowed to watch, where you got to. Note how *small* it is by comparison:

```diagram
   Catalogue metadata   ~20K titles → fits in memory, cache everything
   Playback authz       is this account entitled? device limits?
   Watch progress       (user, title) → position; written every ~30s
   Recommendations      precomputed offline → served from a KV store
```

**Watch progress is the only meaningfully write-heavy piece:** 33M concurrent viewers writing position every 30s is ~1.1M writes/s. Make it cheap — a key-value store, last-write-wins, and no durability drama. Losing 30 seconds of resume position is invisible; treat it as ephemeral-ish data rather than transactional.

**Never compute recommendations on the request path.** Precompute offline, store per user, serve as a lookup. The model runs in batch; the API does a get.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| CDN as the architecture | Origin fleet | 165 Tbps is not servable from your own machines |
| Pre-transcode everything | On-the-fly transcode | Catalogue is small and known; encoding is expensive |
| Chunk-parallel encoding | Serial per title | Hours → minutes; enables preemptible workers |
| Per-title encoding ladders | Fixed bitrate ladder | Big bandwidth saving at equal perceived quality |
| Client-side ABR | Server-driven quality | Keeps segments static and cacheable |
| Pre-position hot titles | Pull-on-demand only | Avoids a stampede at the largest traffic event of the week |
| Watch progress in a KV store | Transactional DB | 1.1M writes/s of data where losing 30s is invisible |
| Precomputed recommendations | Online inference | Latency budget; the model belongs in batch |

## What you'd cut for v1

Multiple renditions (ship 720p only), 4K, offline download, per-title encoding, recommendations. Ship: upload → transcode to one rendition → segment → CDN → play. The pipeline shape is what matters; the ladder is an optimization.

## Explaining the design

> "I'd start with the bandwidth number because it decides the architecture: 33M concurrent at 5 Mbps is 165 Tbps, which is not servable from an origin fleet. So this is a CDN system, and everything else exists to feed it.
>
> First I'd ask whether the catalogue is curated or user-generated — it's the fork in this design. Curated means a small, known catalogue I can fully pre-transcode and pre-position at the edge before release, which turns the biggest traffic event of the week into a pure cache hit.
>
> Ingest is an offline pipeline: split at keyframes, encode chunks in parallel across preemptible workers with idempotent tasks, package into 4-second segments. Playback is adaptive bitrate — the client picks quality per segment, so segments stay static and perfectly cacheable and a bandwidth drop degrades quality instead of buffering.
>
> The control plane is small. The one write-heavy piece is watch progress at about a million writes a second, and since losing 30 seconds of resume position is invisible, that's a KV store rather than anything transactional."

## Next

[Build Uber](uber.html) — Level 4, where a million moving objects need matching in real time.
