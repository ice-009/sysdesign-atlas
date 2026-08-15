---
title: Object Storage & Blob Handling
summary: Why files never belong in your database, presigned uploads, multipart and resumable transfers, storage tiers, and the metadata pattern every media system uses.
difficulty: Easy
scope: HLD
tags: [s3, storage, blob, media]
prereqs: [replication, cdn]
---

## The rule

**Never store large binary files in your relational database.** This comes up in nearly every media-related design, and stating it early with reasons is quick, easy signal.

First, the term: **object storage** is a service that holds whole files — photos, video, backups — under a key, and hands them back over HTTP. S3 is the canonical example. It doesn't do queries or updates-in-place; you put a file, you get a file.

Why not keep them in the database:
- **Backups become impossible.** A 5 TB database of photos takes hours to back up and longer to restore. Your recovery time is now measured in hours for reasons that have nothing to do with your actual data.
- **Replication cost.** Every byte gets shipped to every copy.
- **It poisons your cache.** Databases keep hot pages in memory; giant files push out the index pages and popular rows that genuinely needed to be there, so *unrelated* queries slow down.
- **It's the wrong price.** Object storage costs roughly an order of magnitude less per GB than provisioned database storage, and scales without your involvement.
- **Serving.** You cannot put a CDN in front of a database row, but object storage integrates with CDNs natively.

**The pattern instead — metadata in the database, bytes in object storage:**

```diagram
   photos table (Postgres)
   ┌──────────┬─────────┬──────────────────────┬───────────┬─────┐
   │ photo_id │ user_id │ storage_key          │ width     │ ... │
   ├──────────┼─────────┼──────────────────────┼───────────┼─────┤
   │ 8821     │ 42      │ photos/2026/8821.jpg │ 1920      │     │
   └──────────┴─────────┴──────────────────────┴───────────┴─────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Object storage    │ ──► CDN ──► users
                    │  (S3 / GCS / R2)   │
                    └────────────────────┘
```

The database stays small, fast, and cheap to back up. The bytes live somewhere built for bytes.

## What object storage actually is

A flat key-value store for immutable blobs, addressed by key, accessed over HTTP. Not a filesystem — there are no real directories (prefixes only look like paths), no partial in-place updates, and no rename (a rename is a copy plus a delete).

**Properties:**
- **Extreme durability** — typically ~11 nines, achieved with erasure coding across multiple AZs. Effectively, you will not lose an object.
- **Lower availability than durability** — around 99.9–99.99%. The bytes are safe; occasionally you can't reach them. Design for retries.
- **Effectively unlimited capacity**, no provisioning.
- **Strong read-after-write consistency** for new objects in modern implementations (this was famously eventual for years — worth knowing, since older material still says otherwise).
- **Object-level operations only** — replace the whole object; you can't edit a byte in place.

## Upload: use presigned URLs

A **presigned URL** is a link your server generates that grants permission to upload (or download) one specific file, for a short window. The client uploads straight to the storage service using it, so the bytes never pass through your servers — but you still control who gets a link.

The naive design routes uploads through your application servers instead. Don't.

```diagram
   NAIVE (bad)
   client ──10MB──► app server ──10MB──► object storage
                    ▲
              your bandwidth, your memory, your timeouts,
              your servers tied up for the whole transfer


   PRESIGNED (correct)
   client ──► app server: "I want to upload"
   client ◄── signed URL + key (valid 15 min, size/type limited)
   client ──10MB──────────────────► object storage  (direct)
   client ──► app server: "done, key=X"
   app: verify object exists & size, write metadata row
```

**Why this matters:** your application tier never touches the bytes. It stays small and stateless; upload bandwidth doesn't scale with your fleet; a 10-minute upload on a bad mobile connection doesn't occupy a request thread. The signed URL encodes permissions, expiry, and constraints (max size, content type) cryptographically.

**The important detail:** never trust the client's "done" call blindly. **Verify** the object exists and matches expectations (size, content type, and ideally a checksum) before writing the metadata row — otherwise a client can create metadata pointing at nothing, or claim a file it never uploaded.

Downloads work the same way in reverse: for private content, issue a short-lived presigned download URL rather than proxying bytes.

## Multipart and resumable uploads

For large files, a single HTTP PUT is fragile — a dropped connection at 90% means starting over.

**Multipart upload** splits the object into parts (typically 5–100 MB), each uploaded independently and retried independently, then assembled server-side:

```diagram
   1. initiate  → upload_id
   2. upload part 1, 2, 3 ... N   (parallel, independently retried)
   3. complete(upload_id, [etags]) → object assembled
```

Benefits: parallel uploads saturate available bandwidth, failures retry one part instead of the whole file, and you can upload while still generating data.

**Operational detail worth knowing:** the parts of an abandoned upload sit there costing money even though no finished file ever appeared, and they're invisible in a normal file listing. Set a rule that automatically bins incomplete uploads after a few days — a genuinely common source of surprise bills.

## Storage tiers

Access patterns are wildly skewed over time: a photo is viewed heavily for a week, occasionally for a month, and essentially never after a year. Paying hot-storage prices for cold data is the biggest avoidable cost in media systems.

| Tier | Access | Retrieval | Relative cost |
|---|---|---|---|
| Standard | Frequent | Immediate | 1× |
| Infrequent access | Monthly | Immediate | ~0.5×, + per-GB retrieval fee |
| Archive | Rarely | Minutes to hours | ~0.1× |
| Deep archive | Almost never | Hours | ~0.03× |

**Lifecycle policies** automate the transitions: "move to IA after 30 days, archive after 180, delete after 7 years." At petabyte scale this is often the largest single line item in the bill, and it is routinely left out of designs entirely.

The trap: infrequent-access tiers charge *per retrieval*. Data that's genuinely cold saves money; data you misjudged as cold and still read regularly costs **more** than standard storage.

## Durability: replication vs erasure coding

Worth knowing for a deep dive.

**Replication** — store 3 full copies. Tolerates 2 failures, costs 3× storage, and recovery is a simple copy.

**Erasure coding** — split the object into *k* data shards, compute *m* parity shards, distribute all *k+m*. Any *k* shards reconstruct the object.

```diagram
   Reed-Solomon (10, 4):
     10 data shards + 4 parity shards = 14 total
     Tolerates any 4 failures
     Storage overhead: 1.4×  (vs 3× for triple replication)
```

Same or better fault tolerance at less than half the storage cost. The tradeoff: reconstruction requires reading *k* shards from *k* different nodes and doing CPU work, so a degraded read is slower and more network-intensive.

This is why object storage uses erasure coding (cheap, durable, and reads are rarely degraded) while databases use replication (a replica can serve reads immediately with no reconstruction).

## Serving media

- **Always front it with a [CDN](cdn.html).** Object storage egress is expensive and its latency is a full round trip to the region.
- **Immutable keys.** Include a content hash or version in the key so objects can be cached forever and updates create new keys — no invalidation needed.
- **Generate derivatives on upload.** Thumbnails and resized variants should be produced asynchronously by a worker after upload, not on every read. Store each as its own object.
- **Or resize on the fly at the edge**, cached — better when the set of variants is large or unpredictable, since you don't pre-generate variants nobody requests.
- **Signed URLs with short expiry** for private content, and a CDN configured to respect them.

## The processing pipeline

The standard shape for any upload-and-process system ([video](../05-case-studies/video-streaming.html), images, documents):

```diagram
   client → presigned upload → object storage
                                    │ event notification
                                    ▼
                              queue → workers
                                        │  transcode / resize /
                                        │  scan / extract metadata
                                        ▼
                              derived objects + DB update
                                        │
                                        ▼
                                 mark ready, notify user
```

Key properties: the upload completes fast and independently of processing; processing is retriable and scales separately; and the user gets a "processing" state rather than a blocked request. Making the workers **idempotent** (keyed on the object version) matters, because the queue is at-least-once and you *will* process the same object twice.

:::exercise Design the storage tier
1. 500M images averaging 800 KB, 3× replication versus (10,4) erasure coding. Compute stored bytes, durability, and the cost of reconstructing one lost object.
2. Why is object storage eventually consistent for overwrites in some systems and strongly consistent in others? What does the strong version cost?
3. Design the upload path for a 5 GB file from a browser. Multipart, presigned URLs, resumability — what does each solve?
4. Objects are 90% cold after 30 days. Design the lifecycle policy and compute the savings. What is the retrieval latency you have accepted?
5. A legal hold requires that a specific object cannot be deleted for 7 years, including by an administrator. What feature does that require, and what does it break operationally?
:::

:::paper How blob stores are built
*Finding a Needle in Haystack: Facebook's Photo Storage* (Beaver et al., OSDI 2010) is the classic on why a general filesystem is the wrong substrate for billions of small immutable objects.

*Windows Azure Storage* (Calder et al., SOSP 2011) is the most complete published description of a production object store, including the erasure coding and the stream layer. For durability arithmetic, read any provider's description of how they get to eleven nines.
:::
