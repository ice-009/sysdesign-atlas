# SysDesign Atlas

A systems curriculum that goes from the physics upward: hardware and queueing, the components you assemble out of them, distributed correctness, storage internals, and then the same treatment applied to AI infrastructure — GPUs, distributed training, inference serving, retrieval, and agents.

It is built to be *learned*, not skimmed before an interview. Every topic declares what it assumes, so the material arrives in an order where nothing appears out of nowhere. Interview-specific advice exists, but it lives in an appendix at the end where it belongs.

## Run it

```bash
npm install
npm run db:deploy    # creates dev.db and seeds it
npm run dev          # http://localhost:4321
```

Other scripts:

```bash
npm run check        # content integrity: links, prereqs, frontmatter, callouts, viz specs
npm run build        # check + prisma generate + next build
npm start            # serve the production build
```

## Deployment

Live at <https://sysdesign-atlas.vercel.app> — Vercel (Next.js) with Neon Postgres.
Every push to `main` auto-deploys to production; branches get preview URLs.

Full walkthrough, including the Fly.io + SQLite alternative, in
[`DEPLOY.md`](DEPLOY.md). Running the app — stack, accounts, the admin console,
Docker and Kubernetes — is documented in [`DEVELOPMENT.md`](DEVELOPMENT.md).

## The curriculum

Topics live in `content/<NN-section>/<NN-slug>.md` and are grouped into four tiers.

| Group | Track | Covers |
|---|---|---|
| **Core Systems** | Orientation | What this covers, how the tracks depend on each other, how to study |
| | Foundations | Scalability, hardware limits, latency & tail, queueing theory, networking, concurrency, CAP/PACELC, consistency, availability math, estimation, failure modes |
| | Building Blocks | Load balancing, caching, CDN, SQL vs NoSQL, indexing, replication, sharding, consistent hashing, queues, rate limiting, realtime, search, IDs, Bloom filters, gateways, object storage, pub/sub, geospatial, locks |
| | Distributed Systems | Consensus, quorums, idempotency, sagas & 2PC, clocks, leader election, CRDTs, backpressure, gossip, multi-region, verification |
| | Data & Storage | Storage engines, durability & the WAL, transactions & MVCC, query execution, CDC & outbox, stream processing, columnar/OLAP, lakehouse |
| **AI Systems** | AI Foundations | Tokenization, the transformer as a system, attention & the KV cache, inference arithmetic, context windows, quantization, MoE, decoding, embeddings, fine-tuning |
| | AI Infrastructure | GPUs, interconnects & collectives, data/model parallelism, training at scale, data pipelines, inference engines, KV cache management, cluster scheduling, cost models, deployment, observability |
| | Applied AI Systems | Vector search & databases, retrieval architecture, context engineering, agent architecture & infrastructure, structured output, evaluation, guardrails, ML platform, ranking, realtime AI |
| **Applied Design** | Case Studies | Finished end-to-end designs |
| | Guided Builds | The same systems constructed phase by phase, each transition triggered by a concrete number |
| | Low-Level Design | Objects, SOLID, patterns, concurrency, and worked LLD problems — an SDE-2 revision track with a compressed HLD refresher |
| **Appendix** | Interviews | Optional: the framework, rubrics, mock transcript, question bank |

## Authoring content

Each file opens with frontmatter:

```markdown
---
title: Design a URL Shortener
summary: One-line description shown on cards and in search.
difficulty: Easy | Medium | Hard
tags: [case-study, ids, cache]
prereqs: [back-of-envelope, caching, unique-id-generation]
level: 3          # guided builds only — position on the 1–6 ladder
unlocks: What you can do after this.
---
```

`prereqs` are topic slugs (the filename minus its number prefix). They are advisory: the reader sees a readiness banner, never a lock. `npm run check` fails the build if a prereq points at a topic that doesn't exist or introduces a cycle.

Section order comes from the directory number prefix; topic order from the file number prefix. Both are stripped from the URL, so renumbering never breaks a link or a saved progress row. Sections themselves — title, URL slug, group, accent colour, icon — are declared in `lib/content.ts`.

Beyond standard Markdown the renderer supports:

- ` ```diagram ` — ASCII architecture diagrams with glyph-level syntax colouring
- ` ```viz ` — a JSON spec rendered to animated SVG (`flow`, `stack`, `axes`, `ring`, `fanout`, `compare`, `steps`); see `lib/viz.ts`
- `:::kind … :::` callouts — `note`, `tip`, `warn`, `trap`, `math`, `goat`, `interview`, plus `derive` (show the arithmetic), `paper` (cite the primary source), and `exercise` (make the reader do something)
- Cross-links written as `../<section-dir>/<slug>.html`, rewritten to real routes at render time

## Layout

```
app/          Next.js routes (learn, path, practice, dashboard, auth, billing, admin)
components/   UI
content/      the curriculum — markdown, one file per topic
lib/
  content.ts    sections, topic loading, prereq resolution
  markdown.ts   renderer: callouts, diagrams, link rewriting
  viz.ts        JSON → SVG figures
prisma/       schema + seed (progress, notes, bookmarks, accounts)
scripts/
  check-content.mjs
k8s/          deployment manifests
```

## A note on the content

Everything here is written from scratch. Systems knowledge is public — it lives in papers, engineering blogs, and conference talks — so nothing needed to be copied. What's scarce is a coherent path through it, which is what this is trying to be.

The AI tracks move faster than anything else here. Architectural principles (batching to amortise a fixed cost, caching to avoid recomputation, queueing to smooth load) are stable; specific figures for model sizes, GPU memory, and throughput are illustrative of the shape of the problem rather than current fact. Verify anything you plan to state as a precise number.
