---
title: Design a Video Streaming Platform (YouTube / Netflix)
summary: The upload-and-transcode pipeline, adaptive bitrate streaming, and why the CDN isn't an optimization here — it's the architecture.
difficulty: Hard
scope: HLD
tags: [case-study, cdn, video, pipeline]
prereqs: [cdn, object-storage, load-balancing]
---

:::interview Why this question
It's really two systems joined at the hip: an asynchronous processing pipeline (upload → transcode) and a read path that is almost entirely CDN. Candidates who treat it as "a website with big files" miss the point. The estimation drives everything here more than in any other case study — do the bandwidth math early and loudly.
:::

## 1. Requirements

**Functional**
- Upload video; it becomes watchable after processing.
- Stream with quality adapting to the viewer's bandwidth.
- Seek within a video; resume where you left off.
- Search and browse; view counts.

**Non-functional**
- Playback starts fast (< ~2 s) and doesn't buffer.
- Enormous read bandwidth; heavily skewed popularity.
- Upload path can be slow — processing minutes after upload is acceptable.
- High availability for playback; upload can degrade.

**Cut:** recommendations (mention it's a separate ML system), live streaming (different architecture — say so), monetization, comments, DRM specifics.

**Clarifying questions:** User-generated (YouTube: many uploads, long tail) or curated catalog (Netflix: few titles, all popular)? These are genuinely different systems. Live or VOD? Global audience?

## 2. Estimation — do this first

**500M DAU**, 5 videos watched/day, 10 min average, 1080p at ~5 Mbps. Uploads: 500 hours/minute.

```diagram
   VIEWING BANDWIDTH — the number that defines the design
     Concurrent viewers ≈ 500M × 5 × 10 min / 1440 min/day
                        ≈ 17M concurrent
     Peak (×2)          ≈ 35M concurrent
     35M × 5 Mbps       = 175 Tbps

   → 175 Tbps CANNOT come from origin servers. At ~100 Gbps per
     server that's 1,750 servers doing nothing but pushing bytes,
     in one place, with no locality. This MUST be CDN-served.

   STORAGE
     500 h/min × 1440 min/day = 720,000 hours uploaded/day
     Source at ~4 GB/hour     = 2.9 PB/day of source
     Transcoded (5 renditions, ~1.5× source total)
                              ≈ 4.3 PB/day
     Per year                 ≈ 1.5 EB/year

   TRANSCODING COMPUTE
     720,000 h/day of video, ~2× realtime per rendition per core,
     5 renditions → ~1.8M core-hours/day → ~75,000 cores steady
```

**What the numbers decided:**
1. **175 Tbps → CDN is the architecture**, not a layer on it. Everything else serves that.
2. **1.5 EB/year → tiered storage is mandatory.** The long tail must move to cold storage or it bankrupts you.
3. **75,000 cores → transcoding is a massive, elastic batch system** and a major cost center worth optimizing.

State these conclusions explicitly. This is the case study where estimation most obviously earns its place.

## 3. High-level design

```diagram
   UPLOAD PATH (async, slow, batch)
   ┌────────┐ presigned  ┌──────────────┐
   │ client │───────────►│ Object store │ raw source
   └────────┘  direct    └──────┬───────┘
                                │ event
                                ▼
                         ┌────────────┐
                         │   Queue    │
                         └─────┬──────┘
                               ▼
                  ┌────────────────────────┐
                  │   Transcoding fleet    │ split → parallel
                  │  (DAG of jobs)         │ encode → assemble
                  └────────┬───────────────┘
                           ▼
                  ┌────────────────────┐
                  │ Object store:      │  segments + manifests
                  │ renditions         │
                  └─────────┬──────────┘
                            │ metadata update: status = ready
                            ▼
                       ┌─────────┐
                       │  DB     │
                       └─────────┘

   PLAYBACK PATH (fast, cached, enormous)
   ┌────────┐   ┌────────────┐   ┌──────┐   ┌──────────────┐
   │ client │──►│ API: get   │──►│ CDN  │──►│ origin (rare)│
   │        │   │ manifest   │   │ edge │   └──────────────┘
   │        │◄──┤ + CDN URLs │   └──────┘
   └───┬────┘   └────────────┘       ▲
       └──────── segment requests ───┘
```

Note the asymmetry: the upload path touches your services heavily and runs rarely; the playback path barely touches your services and runs constantly. **Your API tier is sized for manifest requests, not for bytes.**

## 4. Deep dive — the transcoding pipeline

A single source file must become many renditions, each chopped into segments.

```diagram
   source.mp4 (4K, 20 GB)
        │
        ├─ 1. VALIDATE: probe format, reject corrupt/unsupported
        │
        ├─ 2. SPLIT into chunks at keyframe boundaries
        │      (this is what enables parallelism)
        │
        ├─ 3. PARALLEL ENCODE: each chunk × each rendition
        │      2160p · 1080p · 720p · 480p · 360p · audio
        │      → thousands of independent, retriable tasks
        │
        ├─ 4. ASSEMBLE per rendition, package into segments
        │      (HLS .ts / CMAF .m4s, 2-6 s each)
        │
        ├─ 5. GENERATE manifests (master + per-rendition)
        │
        └─ 6. THUMBNAILS, preview sprites, subtitles
```

**Why chunk-level parallelism matters:** a 2-hour film encoded serially takes hours. Split into 500 chunks encoded across 500 workers, it takes minutes. The split must happen at **keyframes** so each chunk decodes independently.

**Design properties to call out:**
- **The pipeline is a DAG**, with steps depending on others. A workflow engine (or a [job scheduler](job-scheduler.html)) tracks state per task.
- **Every task is idempotent and retriable** — keyed by `(video_id, rendition, chunk_index)`. Workers are spot/preemptible instances, so tasks *will* die mid-run. Designing for that is the point, and it's a large cost saving worth mentioning.
- **Prioritize by predicted popularity.** A major creator's upload should transcode before an unknown user's. Also: publish the 720p rendition as soon as it's ready rather than waiting for 4K, so the video is watchable sooner.

:::goat A cost observation few candidates make
"Transcoding every upload to every rendition is wasteful — most user-generated videos are watched a handful of times. I'd transcode a base set eagerly (say 360p and 720p) so the video is immediately playable, and generate higher renditions lazily on first request or once view velocity crosses a threshold. For a platform where most content has almost no views, that's a very large compute saving."

At this scale, cost is a first-order design constraint rather than an afterthought.
:::

## 5. Deep dive — adaptive bitrate streaming

The playback mechanism, and the reason the CDN works so well.

```diagram
   master.m3u8
     ├── 1080p/  seg001.ts seg002.ts seg003.ts ...
     ├── 720p/   seg001.ts seg002.ts seg003.ts ...
     ├── 480p/   seg001.ts seg002.ts seg003.ts ...
     └── 360p/   seg001.ts seg002.ts seg003.ts ...

   Client: measures download throughput and buffer level,
           then picks the quality for the NEXT segment.
```

**Why this design is so effective:**

- **Segments are static files.** Perfectly cacheable, no server-side state, no per-viewer session on the origin. This is what lets a CDN serve 175 Tbps.
- **Adaptation happens on the client.** The server does nothing — no negotiation, no transcoding on the fly.
- **Bandwidth drops degrade quality instead of buffering.** The user sees a softer picture rather than a spinner, which is a far better experience.
- **Seeking is a byte-range request** for the segment containing the target timestamp, not a stream restart.

**Segment length is a real tradeoff:** short segments (2 s) adapt quickly and start fast, but produce more requests and more per-segment overhead. Long segments (10 s) are more efficient and adapt sluggishly. ~4 s is a common compromise.

**Start-up latency trick:** begin playback at a low rendition and step up once the buffer fills. Time-to-first-frame matters more to user retention than initial quality.

## 6. Deep dive — CDN strategy

```diagram
   Popularity is extremely skewed (power law):
     top 1% of videos ≈ 80%+ of views
     the long tail is enormous and rarely watched
```

This shape dictates the caching strategy:

- **Hot content** is pushed proactively to edge PoPs before demand (a new release from a major creator). Pre-warming avoids a stampede at release time.
- **Warm content** is pulled on demand and cached normally.
- **Cold content** falls through to origin. Slower first play, and it's a tiny fraction of requests.

**Origin shield** — a mid-tier cache between edges and origin. Without it, 200 PoPs missing simultaneously means 200 origin fetches for the same object. With it, one.

**ISP-embedded caches** are how the largest platforms actually work: appliances placed *inside* ISP networks, so popular content is served from within the viewer's own ISP. Traffic never crosses the public internet. Mentioning this shows you understand delivery at real scale.

**Cache keys must be immutable** — include the rendition and segment index in the path, never invalidate, and version the whole video if it's re-encoded.

## 7. Storage tiering

```diagram
   Age / popularity            Tier              Relative cost
   ─────────────────────────────────────────────────────────
   Hot (recent, popular)       Standard + CDN         1×
   Warm (months old)           Infrequent access     ~0.5×
   Cold (years, rare views)    Archive               ~0.1×
   Source masters              Deep archive          ~0.03×

   Lifecycle rules automate the transitions.
```

**Keep the source master** in deep archive — you'll need it when a new codec (AV1, or whatever follows) makes re-encoding worthwhile. Deleting sources to save money is a decision people regret.

At 1.5 EB/year, tiering isn't an optimization; it's the difference between a viable business and an unviable one.

## 8. Metadata and the read path

```diagram
   videos    (SQL or KV, sharded by video_id)
     video_id · uploader · title · description · duration
     status (uploading/processing/ready/failed) · manifest_url

   view_counts    — NEVER a synchronous counter update
     playback events → Kafka → stream aggregation → rollups
     (a viral video would otherwise be a single hot row
      taking 100K writes/s)

   watch_progress (KV, per user+video)
     written periodically during playback, not per second
```

The view-count point generalizes: **never put a hot counter on the request path.** Publish events, aggregate asynchronously, serve approximate counts.

## 9. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Transcoding worker dies | Task retried elsewhere; idempotent by `(video, rendition, chunk)`. Spot instances are expected to die. |
| Transcoding backlog | Videos stay "processing" longer. Prioritize by predicted popularity. Alert on queue age. |
| CDN PoP fails | Anycast/DNS routes to the next PoP. Users see a brief quality dip while the new cache warms. |
| Origin down | Cached content keeps serving — the vast majority of traffic. Only cold content fails. Graceful degradation by design. |
| Upload fails mid-transfer | Multipart/resumable upload retries the failed part only. |

**Follow-ups:**
- *"Live streaming?"* — a different architecture: ingest (RTMP/SRT) → real-time transcode → segment → CDN, with 2–10 s of latency, or WebRTC for sub-second. No pre-processing possible, so encoding must keep up with realtime and you can't retry a failed chunk. Naming the constraint difference is enough.
- *"DRM?"* — encrypt segments, deliver keys via a license server, per-session key rotation. Note it hurts cacheability if done naively — keys must be per-user, segments must not be.
- *"How do you handle a video going viral?"* — it's a cache hit by definition, so the CDN absorbs it. The risk is the *first* minutes before it's cached everywhere; pre-warm on view-velocity signals.
- *"Cheaper encoding?"* — per-title encoding (analyze complexity and choose bitrates per video rather than a fixed ladder) meaningfully cuts bandwidth for the same perceived quality. A great cost-conscious answer.
