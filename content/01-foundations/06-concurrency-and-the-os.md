---
title: Concurrency & What the OS Is Doing
summary: Threads versus event loops, the real cost of a context switch and a syscall, and why the answer to "how many concurrent connections" depends on what they're waiting for.
difficulty: Medium
scope: Core
tags: [fundamentals, concurrency, os, performance]
prereqs: [hardware-numbers, queueing-theory]
unlocks: Choosing a concurrency model on evidence instead of fashion, and knowing what a server's connection ceiling really is.
---

## The question this page answers

"How many concurrent requests can one server handle?"

The honest answer is: *it depends entirely on what those requests are doing while they're concurrent.* A server handling 100,000 idle WebSocket connections and a server handling 100 CPU-bound requests are both at their limit, for completely different reasons, and confusing the two is the most common source of bad capacity decisions.

## Two kinds of work

```viz
{
  "type": "compare",
  "caption": "The concurrency model that's right for one is wrong for the other.",
  "left": {
    "title": "CPU-bound",
    "items": [
      "Encoding, compression, parsing, crypto",
      "Concurrency ceiling = number of cores",
      "More threads make it SLOWER (switching overhead)",
      "Scale by adding cores or machines"
    ]
  },
  "right": {
    "title": "I/O-bound",
    "items": [
      "Waiting on DB, cache, network, disk",
      "Ceiling = memory and file descriptors",
      "Thousands of concurrent operations are fine",
      "Scale by not blocking a thread per wait"
    ]
  }
}
```

Almost all web and service work is I/O-bound: a request spends 1 ms computing and 40 ms waiting on a database. Little's Law says handling 2,000 req/s at 41 ms means 82 operations in flight. The design question is what mechanism holds those 82 waits.

## The cost of a thread

A thread is not free, and the costs are worth knowing precisely because they set the ceiling.

| Cost | Typical value | Notes |
|---|---|---|
| Stack (virtual) | 1–8 MB reserved | Address space, not committed memory |
| Stack (resident) | 8–64 KB typical | What you actually pay in RAM |
| Kernel task struct | ~2–10 KB | Scheduler bookkeeping |
| Creation | 10–100 µs | Why you use a pool |
| Voluntary context switch | 1–3 µs | Blocking on I/O |
| Involuntary switch (preemption) | 1–3 µs direct | Plus cache pollution |
| **Cache pollution after a switch** | **10–100 µs** | **The real cost, and the one people forget** |

:::goat The context switch cost that isn't in the manual
The direct cost of a context switch — save registers, swap page tables, restore — is a couple of microseconds. That number is quoted everywhere and it is misleadingly small.

The real cost is that the incoming thread finds L1 and L2 full of the *outgoing* thread's data. It then runs at DRAM speed instead of cache speed until it has warmed the cache back up, which can take tens of microseconds of degraded execution. On a machine with many more runnable threads than cores, every thread runs permanently cache-cold.

This is why **more threads than cores makes CPU-bound work slower**, and why thread-per-request breaks down long before you run out of memory.
:::

:::derive The thread-per-request ceiling
```
   Target: 10,000 concurrent requests, each waiting 100 ms on a database

   Thread-per-request:
     10,000 threads × 64 KB resident stack   =   640 MB  (survivable)
     10,000 threads × 8 KB kernel struct     =    80 MB  (fine)
     Scheduler with 10,000 runnable-ish tasks on 16 cores
       → context switches dominate; cache hit rate collapses
     Practical ceiling on a normal server:  ~5,000-10,000 threads,
       and performance is already degrading well before that.

   Event loop / async:
     10,000 in-flight operations × ~1-2 KB of state  =  ~15 MB
     One thread per core, no switching
     Practical ceiling: hundreds of thousands, bounded by
       file descriptors and memory, not by the scheduler.
```
:::

## How waiting actually works

The mechanism underneath every async runtime is the same: ask the kernel to watch many file descriptors and tell you which ones are ready.

```diagram
   BLOCKING (one thread per connection)
     read(fd) ──► thread sleeps until data arrives
     10,000 connections → 10,000 sleeping threads

   select / poll  — O(n) per call
     "here are all 10,000 fds; which are ready?"
     kernel scans the whole list EVERY call
     → cost grows with connection count even when idle

   epoll (Linux) / kqueue (BSD)  — O(ready)
     register each fd ONCE
     "which of my registered fds became ready?"
     kernel returns only the ready ones
     → cost grows with ACTIVITY, not with connection count

   io_uring (Linux 5.1+)
     shared submission and completion ring buffers
     batch many operations, often ZERO syscalls per operation
     → works for disk I/O too, which epoll never did well
```

**The `select` → `epoll` transition is the whole reason the C10K problem was solvable.** Once the kernel stopped scanning every descriptor on every call, idle connections became nearly free — and "100,000 open connections" turned from absurd into routine.

:::trap "Async is faster than threads"
Async is not faster per operation. It is *cheaper per waiting operation*.

For CPU-bound work, an async runtime is slower than plain threads — you've added a scheduler in userspace for no benefit. For workloads with modest concurrency (a few hundred), thread-per-request is simpler, debugs better, and performs identically.

Async wins specifically when you need many thousands of simultaneous waits. Choose it for that reason, not because it's the modern-sounding option.
:::

## Syscalls, and why they got expensive

A syscall is a transition into the kernel: switch stacks, switch privilege level, and — since Spectre and Meltdown mitigations — flush or tag parts of the CPU's speculative state.

```
   Syscall cost:
     pre-2018:    ~50-100 ns
     with mitigations:  ~200-1,000 ns

   A server doing 100,000 req/s with 10 syscalls per request:
     1,000,000 syscalls/s × 500 ns = 0.5 seconds of CPU per second
     → half a core doing nothing but crossing the kernel boundary
```

This is why the modern performance techniques all look like *avoiding the kernel*:

- **Batching** — `writev`/`sendmmsg` send many buffers in one call.
- **io_uring** — submit and complete through shared memory rings; the syscall becomes optional.
- **`sendfile` / zero-copy** — move file bytes to a socket without copying through userspace. This is how static file servers and video origins hit line rate.
- **Kernel bypass** (DPDK, AF_XDP) — used at the extreme end, in load balancers and packet processors.

You will rarely reach for the last two. You should recognise them when you see them in a design, and you should know that "we're syscall-bound" is a real and diagnosable condition.

## Shared state is where it goes wrong

Concurrency is manageable. Concurrency plus mutable shared state is where the bugs live.

| Mechanism | Uncontended cost | Behaviour under contention |
|---|---|---|
| Atomic increment | ~5–20 ns | Cache line ping-pongs between cores |
| Uncontended mutex | ~15–25 ns | Stays in userspace, cheap |
| Contended mutex | 1–10 µs | Syscall, thread parked, context switch |
| Read-write lock (read) | ~20 ns | Still writes a shared counter — not free |
| Channel / queue handoff | ~50–200 ns | Depends on implementation |

:::goat False sharing, the invisible 10× slowdown
Two threads updating two *different* variables that happen to live in the same 64-byte cache line will contend as fiercely as if they shared one variable. The hardware's coherence protocol works at cache-line granularity and cannot tell that you meant them to be independent.

Symptom: a "lock-free" counter array that gets slower as you add cores. Fix: pad each entry to its own cache line, or give each core its own counter and sum them on read.

This is the same instinct behind sharded counters, per-core allocators, and thread-local buffers — **the fastest coordination is no coordination**. It's also the same idea as [sharding](../02-building-blocks/sharding.html), one level down.
:::

The design principle that follows: **partition the state so threads don't share it.** A per-core, per-shard, or per-connection structure needs no lock at all. When you genuinely must share, prefer short critical sections over clever lock-free algorithms — an uncontended mutex costs 20 ns and is comprehensible; a hand-rolled lock-free structure costs a week and a memory-ordering bug.

## Choosing a model

| Model | Where it fits | Where it hurts |
|---|---|---|
| Thread per request | Simple services, <1,000 concurrent, CPU-heavy work | Memory and switching at high concurrency |
| Thread pool + blocking I/O | Most business services; the boring correct default | Pool exhaustion under a slow dependency |
| Event loop (single-threaded) | High-concurrency I/O; Node, Redis, nginx | One long CPU task blocks *everything* |
| Event loop per core + sharding | Maximum throughput; Envoy, ScyllaDB, Seastar | Complex; needs a shardable workload |
| Async/await runtime | High-concurrency I/O with multi-core use; Go, Tokio, asyncio | Coloured functions, harder debugging, blocking-call landmines |
| Virtual/green threads | Thread-per-request ergonomics, async costs; Go, Java 21+ | Still needs care with native blocking calls |

**Virtual threads are the notable recent shift.** Go's goroutines and Java's virtual threads let you write straightforward blocking code while the runtime multiplexes thousands of them onto a few OS threads. You get the mental model of threads with the ceiling of an event loop — which is why "just use goroutines" is usually correct advice, and why Java 21 mattered.

:::trap Pool exhaustion is the outage you'll actually have
A thread pool of 200 talks to a database whose connection pool is 50. The database gets slow. All 200 threads block on connections; the pool is exhausted; every request — including ones that never touch the database — now queues behind it.

One slow dependency has taken down the whole service. The fix is **bulkheads**: a separate, bounded pool per dependency, so a failure in one cannot consume the capacity of the others. This is [backpressure](../03-distributed/backpressure.html) applied inside a single process.
:::

## Applying it

:::exercise Diagnose these
1. A Node service handles 5,000 req/s comfortably. Someone adds synchronous JSON parsing of a 10 MB payload on one endpoint. Throughput on *every* endpoint collapses. Why, and what's the fix?
2. A Java service with a 200-thread pool sits at 15% CPU while p99 latency is 4 seconds. What's the bottleneck, and what would you measure to confirm it?
3. A worker keeps a per-thread counter array `long[numThreads]`, incremented on every request. Throughput goes *down* when you increase threads from 8 to 16 on a 16-core box. Why?
4. You need 200,000 idle WebSocket connections on one host. What's your actual limiting resource — and name three things you'd have to change from defaults?
:::

Reasoning: (1) The event loop is single-threaded; a 200 ms parse blocks every other connection. Move it to a worker thread or stream the parse. (2) I/O-bound with a saturated downstream — measure connection pool wait time and downstream latency, not CPU. (3) False sharing: 8 counters share one cache line. Pad them. (4) Memory per connection and file descriptors — raise `ulimit -n`, tune `net.core.somaxconn` and socket buffer sizes, and shrink per-connection buffers, since 200,000 × 64 KB buffers is 12.8 GB before any application state.

:::paper Sources
Dan Kegel's *The C10K Problem* (1999) framed the question and is still worth reading as history. Ulrich Drepper's *What Every Programmer Should Know About Memory* covers false sharing and coherence properly.

For io_uring, Jens Axboe's design paper *Efficient IO with io_uring*. For the shard-per-core model, the ScyllaDB and Seastar architecture write-ups are the clearest published treatment.
:::

## What to carry forward

- **Classify the work first.** CPU-bound ceilings are cores; I/O-bound ceilings are memory and descriptors.
- A context switch's real cost is **cache pollution**, not register saving.
- **epoll/kqueue made idle connections nearly free**; that's what makes 100K connections routine.
- **Syscalls cost ~500 ns** post-mitigations; high-throughput systems batch or bypass them.
- **The fastest synchronisation is none** — partition state per core, per shard, per connection.
- **Bulkhead your pools**, or one slow dependency takes the whole service with it.
