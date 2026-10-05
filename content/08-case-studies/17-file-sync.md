---
title: Design Dropbox / Google Drive
summary: Files that follow you to every device — split into chunks named by their content, so only changed parts travel and identical data is stored once; a per-folder change log every device replays; and an honest answer for two people editing the same file offline.
difficulty: Hard
scope: HLD
tags: [case-study, storage, sync, deduplication]
prereqs: [object-storage, sharding, realtime]
---

:::interview Why this question
It separates two kinds of data that beginners lump together — small, transactional *metadata* (names, folders, versions) and huge, immutable *file contents* — and each needs a different store. Then it asks how many devices stay in step, which is a log-replay problem in disguise. The one idea that makes everything else work is chunking by content.
:::

## 1. Requirements

**Functional**
- Upload and download files of any size, up to tens of gigabytes.
- Edits on one device appear on the user's other devices automatically.
- Work offline; changes sync when back online.
- Share files and folders with other people.
- Keep previous versions and allow restoring them.

**Non-functional**
- **Never lose a file.** Durability matters more than anything else here.
- **Don't waste bandwidth.** Changing one paragraph of a 200 MB file must not upload 200 MB.
- **A folder listing is correct.** Two devices must never disagree for long about what's in a folder.
- Huge scale: hundreds of millions of users, exabytes stored.

**Clarifying questions:** Maximum file size? Do we need real-time co-editing of documents, or just file sync? (Co-editing is a different problem — see [Collaborative Editor](collaborative-editor.html).) How long are old versions kept?

## 2. Estimation

**500M users, 100M active daily, each saving ~10 file changes a day.**

```diagram
   File changes:  100M × 10 / 86,400 s        ≈ 12,000/s   (peak ~3× ≈ 35,000/s)

   Bytes per change, if whole files moved:      ~2 MB
   Bytes per change, sending only changed parts: ~200 KB
   New data per day:  1B changes × 200 KB      ≈ 200 TB/day

   Stored: 500M users × ~4 GB average           ≈ 2 EB
   …but much of it is the same bytes stored again:
     old versions, the same video in a thousand accounts, copied folders.

   Metadata: 500M users × ~2,000 files × ~500 B ≈ 500 TB, in rows, many small writes
```

**What this decided:** contents and metadata are completely different workloads — petabytes of large immutable blobs versus a few hundred terabytes of small transactional rows. They get separate systems. And bandwidth and storage both depend on **not moving or storing the same bytes twice**.

## 3. The key idea — chunks named by their content

Split every file into chunks (around 4 MB), and name each chunk by a hash of its bytes (SHA-256).

```diagram
   report.pdf (10 MB)  →  chunk 1 [4 MB]  hash a3f9…
                          chunk 2 [4 MB]  hash 77c1…
                          chunk 3 [2 MB]  hash e04b…

   The file, in metadata:       report.pdf v7 = [a3f9…, 77c1…, e04b…]
   The chunks, in blob storage: a3f9… → bytes,  77c1… → bytes,  e04b… → bytes
```

That one decision pays off four times:

- **Only changed chunks travel.** Edit page 9 and only the chunk containing it gets a new hash; the other two are already on the server.
- **Identical data is stored once.** The same chunk in two versions, two folders or two accounts has the same hash, so it's stored once. This is *deduplication*.
- **Uploads resume.** A dropped connection loses at most the chunk in flight.
- **Integrity is free.** Recompute the hash after download; if it doesn't match, the chunk is corrupt.

:::goat Fixed-size chunks have a weakness — name it
Insert one byte at the start of a file split into fixed 4 MB pieces and *every* chunk boundary shifts, so every hash changes and the whole file uploads again.

The fix is **content-defined chunking**: slide a small window over the bytes, compute a cheap rolling hash, and cut a chunk wherever that hash matches a pattern (say, its last 22 bits are zero, giving ~4 MB chunks on average). Boundaries now depend on the *content*, so an insertion only changes the chunk it lands in.

*"Chunk boundaries come from a rolling hash of the content, not fixed offsets, so inserting data near the start of a file doesn't change every chunk after it."* — one sentence, and it shows you've thought past the obvious design.
:::

## 4. High-level design

```diagram
   ┌───────────── client ──────────────┐   notifications
   │ file watcher → chunker → local DB │   (long poll / WebSocket)
   └──────┬───────────────────┬────────┘ ◀─────────────────────────┐
          │ 1. which chunks   │ 3. commit file version             │
          │    are missing?   │    (list of hashes)                │
          ▼                   ▼                                    │
   ┌──────────────┐    ┌────────────────────┐  appends   ┌─────────┴─────────┐
   │ block service│    │ metadata service   │ ─────────▶ │ change log per    │
   │ (chunks)     │    │ files, folders,    │            │ folder tree       │
   └──────┬───────┘    │ versions, sharing  │            └───────────────────┘
          │ 2. upload   └─────────┬──────────┘
          │    missing only       │ sharded SQL
          ▼                       ▼
   ┌──────────────────┐    ┌──────────────┐
   │ object storage   │    │ metadata DB  │
   │ hash → bytes     │    │ (rows)       │
   └──────────────────┘    └──────────────┘
```

- **Block service + [object storage](../02-building-blocks/object-storage.html):** stores chunks by hash. Chunks never change, so they're easy to cache, copy and spread across regions.
- **Metadata service + a SQL database:** which files exist, in which folders, which version is current, who can see them. Small rows, needing transactions — a relational database is the right tool.
- **Change log + notifications:** how every device learns that something changed.

## 5. Uploading a change

```diagram
   1. Client chunks the file, hashes each chunk.
   2. Ask the block service: "which of [a3f9, 9d02, e04b] do you have?"
        → "missing 9d02"
   3. Upload chunk 9d02 only.
   4. Commit to the metadata service:
        "report.pdf, based on v7, is now [a3f9, 9d02, e04b]"
        – it checks v7 is still the current version (section 7)
        – it writes v8 and appends to the folder's change log, in one transaction
   5. Notification: "folder 'Work' changed" → the user's other devices
```

**Chunks first, metadata second.** The commit only happens once every chunk it names is stored, so a version can never point at missing data. If the client crashes after step 3, the uploaded chunk is simply unreferenced — a cleanup job removes it later (section 9).

## 6. Syncing other devices — replay a log

Each folder tree (a user's own files, or a shared folder) has an append-only **change log** with increasing sequence numbers. Each device remembers how far it has read — its **cursor**.

```diagram
   change log for "Work":   …  #1041 report.pdf → v8
                                #1042 notes.txt deleted
                                #1043 slides.key → v3

   laptop cursor:  #1043   (up to date)
   phone cursor:   #1040   → asks "what's after 1040?" → gets 1041–1043
```

Sync is then simple and robust:

1. A notification arrives (or a periodic poll fires): "Work changed".
2. The device asks for log entries after its cursor.
3. For each changed file, it compares the chunk list with what it has locally, and downloads only missing chunks.
4. It assembles the file and moves its cursor forward.

Replaying the same entry twice does nothing new, so a device that crashes midway just asks again from its old cursor. A phone that was off for a week catches up the same way. The notification only says *"look"* — it carries no data — so a lost notification costs a delay, never a wrong result. Notifications travel over long polling or WebSockets, from [Real-Time Communication](../02-building-blocks/realtime.html).

## 7. Two people, one file, both offline

Asha and Ravi share a spreadsheet. Both edit it on a plane. Both land and sync. What happens?

Every commit says which version it was **based on**. The metadata service accepts a commit only if that base is still the current version:

```diagram
   v7 is current.
   Asha commits "based on v7" → accepted, becomes v8.
   Ravi commits "based on v7" → rejected: current is v8, not v7.
   Ravi's client keeps both:
     budget.xlsx                            Asha's v8, downloaded
     budget (Ravi's conflicted copy).xlsx   his edit, uploaded as a new file
```

**Why not just keep the last one?** Last-writer-wins silently throws away someone's work — the worst outcome for a product whose promise is "never lose a file".

**Why not merge?** For arbitrary files there's no safe merge — you can't combine two edited Photoshop files byte by byte. A conflicted copy is honest: nothing is lost, and a person decides.

**Say this:** *"Commits are compare-and-set on the version. A stale base is rejected and the client saves a conflicted copy, so concurrent edits never overwrite each other. Real-time merging is a different product — that's the collaborative editor problem, with operational transforms or CRDTs."*

## 8. Metadata at scale

The metadata database is sharded, and the shard key matters:

- **Shard by folder tree (namespace)** — a user's root, or a shared folder. Everything in one tree, including its change log, lives on one shard, so a commit and its log entry go in one local transaction.
- **Shared folders are their own namespaces,** "mounted" into each member's tree. Sharing a folder with 50 people doesn't copy anything; their trees just point at it.
- **Hot namespaces** — a company drive with thousands of active users — are the hard case. Split very large ones into sub-trees with their own logs, and cache listings aggressively.

More on choosing shard keys in [Sharding](../02-building-blocks/sharding.html).

## 9. Storage cost, cleanup and privacy

**Garbage collection.** When versions expire or files are deleted, some chunks are no longer used by anything. Deleting them is the dangerous part: a chunk that looks unused may be in the middle of being committed. Safe approach: periodically mark every chunk referenced by any live version, then delete unmarked chunks that are also **older than a grace period** (say, a few days) — long enough for any in-flight upload to have committed.

**Durability.** Object storage keeps several copies or uses erasure coding across machines and data centres; the chunk hash lets a background job check every stored chunk and repair bad copies.

**Encryption versus dedup.** Encrypting each user's chunks with their own key means identical files no longer look identical, so cross-user deduplication stops working. Know the trade-off: most services encrypt at rest with keys the service controls (dedup still works); "only you can read it" products give up cross-user dedup.

## 10. Failure modes & follow-ups

**The notification service is down.** Clients fall back to polling the change log every few minutes. Slower, still correct — the log, not the notification, is the source of truth.

**A 50 GB video upload.** Chunks upload in parallel and resume after any drop. The commit happens once at the end, so the file appears to other devices only when it's complete.

**"Share with a link."** A link is a token mapped to a file or folder with permissions; downloads through it read the same chunks. Permissions live with the metadata, never in the chunk store, which knows nothing but hashes.

**"Sync between two laptops on the same Wi-Fi faster."** Devices on the same network can fetch chunks from each other by hash instead of from the cloud — the hash proves they got the right bytes.

:::exercise Work it through
1. A 120 MB file in 4 MB fixed chunks; the user inserts one sentence on page 1. How many chunks upload? Now with content-defined chunking?
2. Three users store the same 1 GB video. How much space does it use, and what changes if each user's data is encrypted with their own key?
3. Asha's laptop has cursor #500 on a shared folder now at #620. Entries 501–620 include a file created then deleted. Does her laptop download it? (Think about what replaying the log in order produces.)
4. Ravi deletes a folder while Asha, offline, edits a file inside it. Both sync. What should the outcome be, and which rule in section 7 produces it?
:::
