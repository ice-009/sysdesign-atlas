---
title: Consistent Hashing
summary: Why modulo hashing breaks on rescale, how the ring fixes it, virtual nodes, and the modern alternatives — rendezvous hashing and bounded loads.
difficulty: Medium
scope: HLD
tags: [hashing, sharding, distribution]
prereqs: [sharding]
---

:::predict Guess first
1. Ten cache servers use `hash(key) % N`, and you add an eleventh. Roughly what share of keys now map to a different server?
2. A server on a consistent-hashing ring dies. Where do its keys go — and why might that knock over a second server?
3. One key gets 40% of all traffic. Does consistent hashing help?
:::

## The problem

Distribute keys across N nodes. The obvious approach:

```diagram
   node = hash(key) mod N
```

Perfect distribution, O(1) lookup, no state. And it fails catastrophically the moment N changes.

```diagram
   N = 4:   hash("user:42") = 1001 → 1001 mod 4 = 1  → node 1
   N = 5:   hash("user:42") = 1001 → 1001 mod 5 = 1  → node 1  (lucky)
   N = 5:   hash("user:99") = 1002 → 1002 mod 5 = 2  → node 2
            (was 1002 mod 4 = 2 → node 2 ... also lucky)
```

In general, adding one node remaps roughly **(N−1)/N of all keys** — about 80% at N=5, ~99% at N=100.

For a cache, that means a near-total cache miss storm: every remapped key is now looked up on a node that doesn't have it, so the entire load hits your database at once. For a sharded datastore it's worse — nearly all your data must physically move.

## The ring

Consistent hashing puts **both the keys and the machines** on the same circle of numbers — imagine a clock face running from 0 to about four billion, with the end joined back to the start. Hash a machine's name to get its position; hash a key to get its position. A key belongs to the first machine you meet walking clockwise from where it landed.

The trick is what that buys you: when a machine leaves the circle, only the keys sitting between it and the previous machine need a new home. Everyone else is unaffected.

```viz
{
  "type": "ring",
  "nodes": [
    "A",
    "B",
    "C",
    "D"
  ],
  "keys": [
    "k1",
    "k2",
    "k3",
    "k4"
  ],
  "caption": "Keys map to the first node clockwise. Adding a node moves only ~1/N of them."
}
```

**Now add node E between B and C:**

Only the keys between B and E move — from C to E. Every other key stays exactly where it was. Removing a node is symmetric: its keys go to the next node clockwise, and nothing else is disturbed.

**The result:** adding or removing a node remaps ~**1/N** of keys instead of ~all of them. At 100 nodes, adding one moves 1% of the data rather than 99%.

## Virtual nodes (the necessary fix)

Plain consistent hashing has a real problem: with few nodes, the ring positions are uneven, so the load is uneven. With 3 randomly placed nodes, one might own 60% of the ring. And when a node dies, **all** of its load goes to exactly one successor — which may then also fail, cascading around the ring.

**Solution:** put each real machine on the ring at many positions instead of one, by hashing its name together with a counter. Those positions are called **virtual nodes** — there's still one machine, it just appears in 150 places around the circle.

```diagram
   Physical node A → A#1, A#2, A#3, ... A#150
   Physical node B → B#1, B#2, B#3, ... B#150

   Ring: A#7 B#22 B#3 C#91 A#44 D#12 B#67 C#5 A#88 ...
         (interleaved; each physical node covers many small arcs)
```

With ~100–200 virtual nodes each, load variance drops to a few percent. Critically, when a node fails, its many small arcs are inherited by **many different** successors — the load spreads instead of concentrating, which is what prevents the cascade.

Virtual nodes also give you a free way to handle machines of different sizes: give the one with twice the memory twice as many positions, and it naturally receives twice the keys.

:::interview Don't stop at "the ring"
It is common to describe the ring and stop there. Adding "and I'd use virtual nodes — 150 or so per physical node — because with few nodes the ring is uneven, and more importantly a failure would dump all of one node's load onto a single successor and risk cascading" is the difference between a textbook answer and a working knowledge of the technique.
:::

## Lookup implementation

Keep the virtual node positions in a sorted structure and binary search for the first position ≥ hash(key):

```diagram
   ring = sorted array of (position, node)
   lookup(key):
       h = hash(key)
       i = binary_search_first_ge(ring, h)
       return ring[i % len(ring)].node        # wrap around
```

O(log V) where V is the virtual node count — a few microseconds. With 10 nodes × 150 vnodes = 1,500 entries, that's ~11 comparisons.

For replication (Dynamo-style), walk clockwise and take the next **R distinct physical** nodes — skipping virtual nodes belonging to a physical node already chosen, which is a detail people get wrong.

## Where it's used

- **Distributed caches** — Memcached clients, Redis Cluster (which uses 16,384 fixed hash slots, a close relative of the pre-split approach).
- **Dynamo-family databases** — Cassandra, Riak, DynamoDB, ScyllaDB for partition assignment and replica placement.
- **Load balancers** — session affinity that survives fleet changes.
- **CDNs** — mapping content to edge cache servers.
- **Sharded application state** — WebSocket connection ownership, rate limiter counters.

## The limits, and what to say about them

**1. It doesn't fix hot keys.** Consistent hashing distributes *keys* evenly, not *load*. One key receiving 40% of traffic saturates its node no matter how good the ring is. Fixes: replicate the hot key across several nodes, or front it with a local cache. This is the [celebrity problem](sharding.html) again.

**2. Load can still be uneven under skew.** Which motivates:

**Consistent hashing with bounded loads.** Set a capacity cap (e.g. no node may exceed 1.25× the mean). If a key's target node is at capacity, walk clockwise to the next one with room. You keep most of the stability of the ring while guaranteeing a bound on imbalance. Used in practice by large load-balancing systems.

**3. Rebalancing still moves real data.** Moving 1/N of a petabyte is still a lot of bytes. Production systems throttle migration to protect foreground traffic.

## Rendezvous hashing (HRW) — the simpler alternative

Often a better choice than the ring, and naming it is a nice signal of breadth.

For each key, compute a score against **every** node and pick the highest:

```diagram
   node = argmax over all nodes n of  hash(key, n)
```

**Advantages over the ring:**
- No virtual nodes needed — distribution is uniform by construction.
- Trivially supports weights.
- Gives you a natural ordered *preference list* (2nd highest = first replica, 3rd = second replica), which is exactly what replica placement wants.
- Much simpler to implement and reason about; no ring state to keep in sync.

**Disadvantage:** O(N) per lookup rather than O(log V). Irrelevant for tens or hundreds of nodes; a problem for thousands.

**Guarantee:** it has the same minimal-disruption property — removing a node only moves keys that mapped to it.

For most systems under a few hundred nodes, rendezvous hashing is the pragmatically better answer, and saying "I'd actually use rendezvous hashing here — same disruption guarantee, no virtual node tuning, and it gives me the replica preference list for free" is a strong, specific opinion.

## Jump consistent hash

A third option worth knowing: a tiny algorithm that maps a key to one of N buckets with optimal balance and minimal disruption, using no memory at all.

**Limitation:** buckets are numbered 0…N−1 and you can only add or remove from the *end*. That makes it excellent for sharding into a numbered set of shards you grow sequentially, and unsuitable when arbitrary nodes come and go.

## Choosing

| Situation | Choice |
|---|---|
| Cache cluster, nodes come and go | Consistent hashing + virtual nodes |
| Replica placement, ≤ few hundred nodes | Rendezvous hashing |
| Fixed shard count you grow sequentially | Jump consistent hash |
| Known skew, need a load guarantee | Consistent hashing with bounded loads |
| Need to relocate individual hot tenants | Directory-based ([sharding](sharding.html)) — not hashing at all |

That last row is worth emphasizing in interviews: **hashing gives up control in exchange for statelessness.** When you need to move one specific noisy tenant to its own node, no hash function will do it — you want an explicit directory. Knowing when *not* to reach for consistent hashing is as valuable as knowing how it works.

:::exercise Measure the imbalance
1. 10 nodes, no virtual nodes, keys hashed uniformly. What is the expected ratio between the most- and least-loaded node? Why is it not close to 1?
2. Add 200 virtual nodes per physical node. What happens to that ratio, and what does it cost in memory and lookup time?
3. A node is removed from a 10-node ring. What fraction of keys move, and *where* do they move to? Contrast with `hash(key) % N`.
4. One key is 30% of traffic. Consistent hashing does not help. Why, and what does?
5. Your ring is used for cache affinity, and one node is overloaded. Design the bounded-load escape hatch and say what it costs in hit rate.
:::

:::paper The ring, and its refinements
Karger et al., *Consistent Hashing and Random Trees* (STOC 1997) is the original, written for web caching. *Dynamo* (DeCandia et al., SOSP 2007) popularised virtual nodes.

*Consistent Hashing with Bounded Loads* (Mirrokni, Thorup & Zadimoghaddam, 2016) fixes the load-imbalance problem directly. *Maglev* (Eisenbud et al., NSDI 2016) uses a different construction with better lookup performance and comparable disruption properties. Rendezvous (highest random weight) hashing is a simpler alternative worth knowing.
:::

## Check yourself

```recall
Q: You go from 10 to 11 servers. With `hash(key) % N`, roughly what share of keys move — and with a consistent-hashing ring?
A: Modulo: about 10 in 11, nearly all of them, so a cache empties at once and the database takes the full load. Ring: about 1 in 11 — only the keys the new server takes over.

Q: Node E is added to a ring between B and C. Which keys move, and from where?
A: Only the keys between B and E. They move from C — their old owner, the next node clockwise — to E. Every other key stays where it was.

Q: Why are virtual nodes "the necessary fix" rather than a nice optimisation?
A: With few points on the ring the arcs are uneven, so load is uneven. Worse, a dead node's whole load lands on one successor, which can fail in turn and cascade. Many small arcs per machine even out the load and spread a failed node's keys across many successors.

Q: A server with twice the memory joins the ring. How do you give it twice the keys?
A: Give it twice as many virtual nodes. Its share of the ring — and so of the keys — grows with its number of positions.

Q: For three replicas you "take the next three nodes clockwise". What's the bug?
A: The next positions may be virtual nodes of the same machine, putting two replicas on one box. Walk clockwise and take the next three distinct physical machines.

Q: One key gets 40% of all traffic. Does consistent hashing help? What does?
A: No — it spreads keys, not load, so that key's owner saturates whatever the ring looks like. Replicate the hot key across several nodes, or put a local cache in front of it.

Q: When is rendezvous hashing a better choice than a ring?
A: Up to a few hundred nodes. There are no virtual nodes to tune, weights are easy, and ranking nodes by score gives the replica preference list for free. Its O(N) lookup only matters at thousands of nodes.

Q: You need to move one noisy tenant onto its own server. Which hashing scheme does that?
A: None of them — hashing trades control for statelessness. Use a directory: an explicit map from tenant to shard.
```

## What to carry forward

- `hash(key) % N` moves almost every key when N changes; a ring moves about 1/N of them.
- Virtual nodes — 100 to 200 per machine — even out load, spread a failed node's keys across many successors, and give you weights for free.
- Consistent hashing spreads keys, not load: hot keys need replication or a cache, and bounded loads cap the imbalance.
- Rendezvous hashing is often simpler for replica placement, jump hash suits shards you grow in order, and a directory is the answer when you need control over placement.
