---
title: CDNs & Edge Delivery
summary: How content lands close to users, push vs pull, cache keys and invalidation, and why the CDN is often the single largest scaling decision in a media-heavy design.
difficulty: Easy
tags: [cdn, edge, latency]
prereqs: [caching, networking]
---

## The problem it solves

Physics. A user in Mumbai fetching from a Virginia datacenter pays ~200 ms round trip *minimum*, before any server does work. TCP handshake plus TLS handshake plus the request is 3–4 round trips — nearly a second before the first byte, and no amount of server optimization touches it.

A CDN is a network of caching servers ("points of presence" / PoPs) distributed globally. Content is served from the PoP nearest the user, turning a 200 ms trip into a 10 ms one.

Two benefits, and candidates usually name only the first:

1. **Latency** — content is physically closer.
2. **Origin offload** — a 95% edge hit rate means your origin serves 1/20th of the traffic. For a media-heavy product this is not an optimization, it's the only reason the design is affordable. Serving 1 Tbps from your own fleet is a completely different business than serving it from a CDN.

## How a request reaches the nearest PoP

Two mechanisms, and knowing the difference is a good depth signal:

**DNS-based.** `cdn.example.com` resolves differently depending on where the query comes from. Simple, works everywhere. Weaknesses: it sees the *resolver's* location, not the user's (someone on a public DNS resolver may be routed poorly — partially fixed by EDNS Client Subnet), and failover is bounded by TTL caching.

**Anycast.** The same IP is advertised from every PoP via BGP; internet routing delivers packets to the topologically nearest one. Failover is a route withdrawal — fast, no DNS caching problem. Downside: route changes can move a client mid-connection, which matters for long-lived TCP.

Most large CDNs use both — anycast for the entry point, DNS/application logic for finer control.

## Push vs pull

**Pull (origin pull)** — the default. The edge fetches from your origin on first miss and caches per TTL.

```diagram
  user → PoP (miss) → origin → PoP caches → user
  user → PoP (hit)  → user                    (fast)
```

Nothing to manage; only requested content is stored. Cost: the first user in each region pays the full origin latency, and a burst of misses can hammer the origin — CDNs mitigate this with **origin shield**, a mid-tier cache that collapses many PoP misses into one origin fetch.

**Push** — you upload content to the CDN ahead of demand.

Right when you know exactly what will be hot and when: a game patch, a product launch, a video release with a known drop time. Avoids the cold-miss stampede entirely. Cost: you manage distribution and storage for content nobody may request.

Most systems are pull with selective pre-warming for known events.

## Cache keys — where the bugs live

The cache key determines what counts as "the same" object. By default it's the URL, but you often need more:

- **Query strings** — `?utm_source=…` shouldn't create a separate cached copy. Strip or allow-list parameters, or you fragment your cache and destroy the hit rate.
- **Vary headers** — `Vary: Accept-Encoding` gives separate gzip/brotli copies (correct). `Vary: User-Agent` gives you thousands of copies and effectively no caching (almost always a mistake).
- **Cookies** — if the cache key includes cookies, every user gets their own copy. Strip cookies for static assets.
- **Device class / geo** — deliberate segmentation, e.g. mobile vs desktop variants.

:::trap The hit-rate killer
Cache fragmentation is the most common reason a CDN "isn't helping." One unnecessary dimension in the key can turn a 95% hit rate into 20%. When a design discussion goes deep on CDNs, saying "I'd normalize the cache key — strip tracking parameters and cookies on static paths — because key fragmentation is usually what kills hit rate" is a strong, specific observation.
:::

## Invalidation

The hard part, as always. Options in increasing order of preference:

**1. TTL expiry.** Set `Cache-Control: max-age=3600` and accept up to an hour of staleness. Simple, requires no coordination.

**2. Purge / invalidate.** Explicitly tell the CDN to drop an object. Propagation takes seconds to minutes across all PoPs, and purging is rate-limited by most providers, so it doesn't scale to high-frequency changes.

**3. Versioned URLs (cache busting).** **The right answer for static assets.** Include a content hash in the filename:

```diagram
   /static/app.a3f9c2b1.js     Cache-Control: max-age=31536000, immutable
```

Because the URL changes when the content changes, you never invalidate anything — you just reference a new URL. Old versions age out naturally. This lets you cache forever, which maximizes hit rate and eliminates revalidation traffic entirely.

**4. Stale-while-revalidate.** `Cache-Control: max-age=60, stale-while-revalidate=600` — serve the cached copy instantly after expiry while refreshing in the background. Users never wait for a revalidation. Excellent for content that should be fresh-ish but must always be fast.

## What to cache

**Always:** images, video segments, CSS, JS, fonts, downloads. Immutable, versioned, cached for a year.

**Often, and underused:** API responses that are identical across users — product catalogs, public profiles, search results for common queries, configuration. A short TTL (10–60 s) on a hot endpoint can remove the large majority of origin traffic. Candidates rarely propose this and it's frequently the biggest available win.

**Never:** anything personalized or authenticated, unless you're using signed URLs or edge-side personalization. Serving user A's data to user B from a shared cache is a real and recurring class of security incident — driven by exactly the cache-key mistakes above.

## Video: the segment model

For [video streaming](../05-case-studies/video-streaming.html), CDNs are the whole architecture. Video is transcoded into multiple bitrates and chopped into 2–10 second segments, each an independently cacheable file, described by a manifest:

```diagram
   manifest.m3u8
     ├── 1080p/seg_001.ts, seg_002.ts, ...
     ├── 720p/ seg_001.ts, seg_002.ts, ...
     └── 480p/ seg_001.ts, seg_002.ts, ...

   Client measures its own bandwidth and picks the next
   segment's quality → adaptive bitrate (ABR)
```

Why this design wins: segments are static files (perfectly cacheable), quality adaptation happens on the client with no server state, and a bandwidth drop degrades quality rather than buffering. Popular content is served almost entirely from edge cache.

## Edge compute

Modern CDNs run code at the PoP (Cloudflare Workers, Lambda@Edge, Fastly Compute). Useful for:

- **Auth and token validation** at the edge — reject unauthorized requests before they cross an ocean.
- **A/B routing and personalization** without breaking cacheability of the underlying content.
- **Header rewriting, redirects, bot filtering.**
- **Assembling a page** from cached fragments plus one small dynamic call.

The pattern worth naming: cache the expensive, shared 95% at the edge and fetch only the small personalized fragment from origin. It's how you make a "personalized" page mostly cacheable.

## Security at the edge

The CDN is your first line of defense, and this is worth a sentence in any design:

- **DDoS absorption** — a distributed edge with terabits of capacity absorbs volumetric attacks your origin never could. This is a primary reason to use a CDN even if you don't need the caching.
- **WAF** — filter injection and known-bad patterns before they reach you.
- **TLS termination** and modern cipher support without touching your origin.
- **Origin shielding** — lock the origin to accept traffic only from the CDN, so attackers can't bypass it by hitting your IP directly.
- **Signed URLs** — time-limited, per-user access to otherwise-cacheable private content.

## In an interview

For any design serving images, video, or static assets, propose the CDN early and **quantify it**:

> "Peak egress is ~150 GB/s. That's not something we serve from origin — it has to be CDN. At a 95% hit rate the origin sees ~7.5 GB/s, which is a manageable fleet. That makes CDN hit rate a primary metric for us, so I'd version asset URLs for immutable caching and normalize cache keys to avoid fragmentation."

That's the CDN treated as an architectural decision with a number attached, rather than a box drawn out of habit.

:::exercise Budget a CDN
1. Users in Singapore, origin in Virginia (230 ms RTT). A page needs 8 sequential requests. What is the floor latency without a CDN, and with an edge that terminates TLS but still fetches from origin?
2. Your assets are 4 MB per page view, 50M views/month. Compute monthly egress and the cost difference between serving from origin and from a CDN at typical rates.
3. Cache hit ratio at the edge is 78%. Where do the 22% go, and name three changes that would improve it.
4. You need to purge a file globally in under 60 seconds after a legal takedown. What has to be true of your invalidation design — and why is versioned URLs usually the better answer?
:::

:::paper Edge caching at scale
*Akamai's Overlay Networks* and Akamai's published work on consistent hashing for edge selection are the origin of most CDN architecture. *Taking the Edge off with Espresso* (Yap et al., SIGCOMM 2017) is Google's edge peering system.

For the theory of why caching close to users works, the same Zipf analysis as any cache applies — but propagation delay, not database load, is the cost being avoided. See [the hardware numbers](../01-foundations/hardware-numbers.html).
:::
