---
title: Design a Distributed Job Scheduler
summary: Running work at the right time, exactly once enough, across a fleet — with retries, dependencies, and the hard problem of not losing jobs when a worker dies.
difficulty: Medium
scope: HLD
tags: [case-study, scheduling, queue, idempotency]
prereqs: [message-queues, leader-election, idempotency]
---

:::interview Why this question
It's a compact test of [leader election](../03-distributed/leader-election.html), [idempotency](../03-distributed/idempotency.html), and failure recovery — with a scheduling problem whose obvious solution fails quietly (a database poll for `WHERE run_at < now()`, which neither scales nor survives worker death).
:::

## 1. Requirements

**Functional**
- Schedule one-off jobs at a specific time, and recurring jobs on a cron expression.
- Execute jobs across a worker fleet.
- Retry failures with backoff; give up after N attempts.
- Job dependencies (run B after A succeeds).
- Visibility: status, history, logs.

**Non-functional**
- **Jobs must not be lost.** A missed billing run is a real problem.
- Execute close to the scheduled time (within seconds).
- At-least-once execution with idempotent jobs — be explicit that exactly-once isn't available.
- Scale to millions of scheduled jobs.
- A worker crash must not strand its jobs.

**Clarifying questions:** Precision required — seconds or minutes? Are jobs idempotent, or must we guarantee single execution? Max job duration? Do we need job dependencies/DAGs, or just independent tasks?

## 2. Estimation

**10M scheduled jobs**, 100K executions/minute at peak, average job runtime 30 s.

```diagram
   Executions: 100,000 / 60 = ~1,700/s

   Concurrent jobs (Little's Law):
     L = λ × W = 1,700/s × 30 s = 51,000 concurrent
   → at 50 jobs per worker: ~1,000 workers

   Job record: id 8 + schedule 50 + payload ~500 + state 50
               ≈ 1 KB
   10M jobs × 1 KB = 10 GB  ← small, fits comfortably

   Execution history: 100K/min × 1440 = 144M runs/day
     × 200 B = 29 GB/day → needs retention policy
```

**What this decided:** the scheduled-job set is small (10 GB), so the challenge is *timing precision and reliability*, not data volume. Execution history is the part that grows, so it needs a TTL and probably a separate store.

## 3. The naive design and why it breaks

```diagram
   Every worker: SELECT * FROM jobs
                 WHERE run_at <= now() AND status='pending'
                 LIMIT 100;
```

Three problems:

1. **Every worker gets the same rows** → the same job runs 1,000 times.
2. **The query scans an index over the whole job table** every poll, from every worker. At 1,000 workers polling every second, that's 1,000 QPS of range scans against a hot index.
3. **If a worker dies after claiming**, the job is stuck in `running` forever with nothing to recover it.

The fixes for each are the design.

## 4. High-level design

```diagram
   ┌──────────┐   create/update   ┌──────────────┐
   │  API     │──────────────────►│  Job store   │  definitions
   └──────────┘                   │  (Postgres)  │  + schedules
                                  └──────┬───────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │      SCHEDULER (leader)     │
                          │  scans the next time window │
                          │  → enqueues due jobs        │
                          └──────────────┬──────────────┘
                                         ▼
                          ┌─────────────────────────────┐
                          │   Queue (Kafka / SQS)       │  priority
                          │   partitioned by job_id     │  lanes
                          └──────────────┬──────────────┘
                                         ▼
                          ┌─────────────────────────────┐
                          │   Worker fleet (1,000+)      │
                          │   claim → execute → report   │
                          └──────────────┬──────────────┘
                                         ▼
                          ┌─────────────────────────────┐
                          │  Execution history + metrics │
                          └─────────────────────────────┘
```

**The key structural decision: separate *scheduling* from *execution*.** The scheduler decides *what* should run and when; workers decide *how*. This means scheduling logic is centralized (so a job is enqueued once) while execution scales horizontally.

## 5. Deep dive — the time index

Scanning "all jobs where `run_at <= now()`" doesn't scale. Bucket by time instead.

```diagram
   Redis sorted set per minute bucket:
     key:   jobs:due:202608071430
     score: exact run_at timestamp
     member: job_id

   The scheduler, each second:
     ZRANGEBYSCORE jobs:due:<current minute> -inf <now>
     → only jobs in THIS minute are ever examined
```

Now the scan touches a tiny set — the jobs due in the current minute — regardless of whether 10M jobs exist in total. Adding a job is one `ZADD` into the right bucket.

**For jobs scheduled far ahead**, keep them in the database and have a background process hydrate the next few hours of buckets into Redis. You never need more than a short horizon in memory.

**Recurring jobs:** store the cron expression; when an occurrence completes, compute the *next* occurrence and insert it. Don't pre-materialize a year of runs — compute lazily, one ahead.

## 6. Deep dive — exactly-once-ish execution

The two hard failure cases.

**Problem 1: two workers claim the same job.**

Use an atomic conditional claim, not a read-then-write:

```sql
UPDATE job_runs
SET status='running', worker_id=:w, claimed_at=now(), lease_until=now()+interval '60s'
WHERE run_id=:r AND status='pending';
-- 0 rows affected → someone else claimed it. Move on.
```

The database does the excluding for you, because that single statement can't be interleaved with another. **No separate lock service required** — and saying why you're *not* reaching for a Redis lock here is a good move: a lock can silently expire while its holder is paused, whereas a conditional update simply fails for the loser. See [Distributed Locks](../02-building-blocks/distributed-locks.html).

**Problem 2: a worker claims a job and dies.**

This is the one that is easiest to miss. The job sits in `running` forever.

A **lease** is a claim with an expiry date. Rather than "this job is mine", a worker says "this job is mine for the next 60 seconds" and has to keep renewing that. A worker that dies stops renewing, and the claim lapses on its own — no one has to detect the death.

```diagram
   LEASES solve it:
     - claiming sets lease_until = now() + 60s
     - the worker RENEWS the lease every ~20s while running
     - a reaper process finds jobs where lease_until < now()
       and status='running' → resets them to 'pending'

   Worker dies → lease expires → job is reclaimed within a minute
```

The worker must also **self-fence**: if a renewal fails, stop working immediately rather than finishing and writing results, because another worker may already have taken over. See [leases](../02-building-blocks/distributed-locks.html).

:::goat The answer that separates candidates
"The claim has to be an atomic conditional update — `UPDATE ... WHERE status='pending'` — so two workers can't both take it. But the harder case is a worker that claims a job and then dies: without a lease, that job is stuck in `running` forever and silently never runs again. So claims carry a lease that the worker renews while executing, and a reaper reclaims expired leases. The consequence is that a paused worker's job may be reclaimed and run twice, which is why every job must be idempotent — I'd make that a requirement of the platform, not a hope."

Naming the *stuck job* problem unprompted is a strong signal; it's the failure mode that shows you've operated one of these.
:::

## 7. Deep dive — the scheduler must not be a single point of failure

One scheduler is simplest (it guarantees a job is enqueued exactly once) and is also a single point of failure.

**Leader election** via etcd/ZooKeeper: one active scheduler, standbys ready. If the leader fails, a standby takes over within seconds. See [Leader Election](../03-distributed/leader-election.html).

**Handling the gap:** during failover, some seconds pass with nobody scheduling. On taking over, the new leader scans backwards over the recent window and enqueues anything missed. Jobs run slightly late rather than not at all — and since workers dedupe on `run_id`, re-enqueueing a job that was already dispatched is harmless.

**Partitioned scheduling** is the better answer at scale: shard jobs by hash, and elect a leader per shard. Now scheduling throughput scales with shard count, and a failure affects 1/N of jobs rather than all of them. Same [partitioned ownership](../03-distributed/leader-election.html) pattern that beats global leadership generally.

## 8. Retries, dependencies, and priorities

**Retries** with exponential backoff and jitter, capped attempts, then a dead-letter state with an alert. Distinguish retriable errors (timeout, 503) from permanent ones (bad payload, missing resource) so you don't waste attempts on jobs that can never succeed.

**Dependencies (DAGs):**

```diagram
   A ──► B ──┐
             ├──► D        D runs only after B and C succeed
   A ──► C ──┘

   Implementation: each job tracks unmet dependency count.
   On success, decrement dependents; enqueue those reaching 0.
```

Add cycle detection at submission time — a dependency cycle means nothing ever runs, and it should be rejected when the DAG is defined, not discovered at runtime.

**Priority lanes** — separate queues with separately-scaled worker pools, so a flood of low-priority batch jobs can't delay a time-critical one. Same structure as the [notification system](notification-system.html).

**Concurrency limits** per job type, so one job class can't consume the entire fleet or overwhelm a shared downstream database.

## 9. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Worker dies mid-job | Lease expires; the reaper requeues. Job runs again → **must be idempotent**. |
| Scheduler leader dies | Standby elected in seconds; scans backwards to catch missed jobs. Late, not lost. |
| Queue unavailable | Scheduler retries and buffers; jobs run late. Alert on scheduling delay. |
| Redis time-index lost | Rebuild from the database — the durable job store is the source of truth. Redis is an index, never the record. |
| A job runs forever | The lease and a max-runtime limit force termination and mark it failed. Without a max runtime, one hung job holds a worker forever. |
| Thundering herd at midnight | Thousands of daily jobs all scheduled for 00:00. **Jitter the schedule** or spread execution across a window. |

**Follow-ups:**
- *"Guarantee exactly-once?"* — not achievable. At-least-once plus idempotent jobs is what you build. If a job genuinely can't be idempotent (sending money), it needs its own idempotency key at the downstream boundary.
- *"How do you handle long-running jobs?"* — lease renewal covers it, plus checkpointing so a restart resumes rather than restarting. Better still, break long jobs into smaller resumable steps.
- *"Timezone-aware cron?"* — store the timezone with the schedule and compute occurrences in local time. **DST is the trap**: 02:30 daily occurs twice on one day per year and not at all on another. Naming DST is a nice detail — it's a real bug people ship.
- *"How would you test this?"* — an injectable clock so you can simulate time passing, plus chaos testing that kills workers mid-execution to verify lease recovery actually works.
