---
title: Load Balancing
summary: L4 vs L7, the algorithms and when each actually matters, health checking, and why the load balancer itself isn't a single point of failure.
difficulty: Easy
tags: [load-balancer, traffic, L4, L7]
prereqs: [scalability-basics, networking]
---

## What it buys you

A load balancer sits between clients and a pool of servers and distributes requests. It gives you four things at once:

1. **Horizontal scale** — the pool can grow without clients knowing.
2. **Availability** — unhealthy servers are removed from rotation automatically.
3. **Zero-downtime deploys** — drain a server, update it, return it.
4. **A control point** — TLS termination, rate limiting, routing, observability all live here.

It is the first component in nearly every design, and it is routinely drawn without anyone examining what it actually does. The interesting parts are below.

## L4 vs L7

The most important distinction, and a very common interview question.

**Layer 4 (transport)** balances TCP/UDP connections. It sees IPs and ports, not content. It picks a backend when the connection opens and every packet in that connection goes to the same place.

**Layer 7 (application)** terminates the connection, parses HTTP, and can route on path, header, cookie, or method. It opens its own connection to the backend.

| | L4 | L7 |
|---|---|---|
| Sees | IP, port | Full HTTP request |
| Routing on | Connection tuple | Path, host, header, cookie |
| TLS | Passthrough (or termination) | Terminates (required to read content) |
| Throughput | Very high, low CPU | Lower, more CPU |
| Latency added | ~µs | ~ms |
| Retries failed requests | No (connection-level) | Yes (request-level) |
| Examples | AWS NLB, IPVS, Maglev | AWS ALB, Nginx, Envoy, HAProxy |

**When L4 is right:** non-HTTP protocols, extreme throughput, when you need TLS to terminate at the application, or when you want the LB to be as dumb and fast as possible.

**When L7 is right:** almost all web traffic. You get path-based routing (`/api/*` → API fleet, `/static/*` → asset fleet), per-request load balancing (crucial with HTTP/2, see below), request-level retries, canary routing by header, and centralized TLS.

:::trap HTTP/2 breaks L4 balancing
With HTTP/1.1, many connections meant an L4 balancer spread load reasonably. With HTTP/2 and gRPC, a client opens **one long-lived connection** and multiplexes thousands of requests over it. An L4 balancer assigns that connection once — so all those requests hit one backend, and load becomes wildly uneven. This is a classic real-world gotcha: you need L7 (or a client-side/mesh balancer) to balance gRPC properly. Mentioning it is a strong depth signal.
:::

## Algorithms

These are easy to list; the useful part is knowing when the choice matters. The honest answer: **for homogeneous, stateless servers with uniform request costs, round robin is fine and the choice barely matters.** The algorithms earn their keep when those assumptions break.

**Round robin** — rotate through servers. Simple, no state. Breaks when request costs vary widely (one request takes 5 ms, another takes 5 s) or servers are heterogeneous.

**Weighted round robin** — proportional to declared capacity. Use when your fleet has mixed instance sizes, or to shift traffic gradually during a canary.

**Least connections** — send to the server with fewest active connections. Naturally adapts to varying request duration; a server stuck on slow requests stops receiving new ones. Good default for variable workloads.

**Least response time** — least connections plus measured latency. Best at routing around a degraded ("gray failure") node, since a slow node is penalized automatically.

**Random with two choices (P2C)** — pick two servers at random, send to the less loaded. Nearly as good as global least-connections while requiring no global state, which makes it ideal for distributed/client-side balancing. This is the quiet favorite in modern meshes.

**Hashing (IP hash / consistent hash)** — deterministic mapping from a key to a server. Needed when you have per-server state: a cache tier, a stateful WebSocket session, or sharded in-memory data. Use [consistent hashing](consistent-hashing.html) so adding a server doesn't remap everything.

:::goat The answer that scores
"For the stateless API tier I'd use least-connections — round robin is fine until request cost varies, and here it does. For the cache tier I need consistent hashing, because I want the same key to land on the same node so the cache is actually useful. Different tiers, different algorithms, for different reasons."
:::

## Health checks

The mechanism that turns a load balancer into an availability tool.

**Passive** — observe real traffic; eject a backend after N consecutive failures. Free, but only detects problems by failing user requests first.

**Active** — poll `/health` on an interval. Detects failure before users do; costs a little traffic.

Use both. Active for detection, passive for the failures active checks miss.

**Design your health endpoint carefully — this is where people get burned:**

- A **shallow** check (`return 200`) can't detect a broken process. It'll happily keep a node in rotation while it serves garbage.
- A **deep** check (verify DB, cache, downstream) detects real problems — but if the *shared* database hiccups, every node fails its check simultaneously and the LB removes your **entire fleet**. You've converted a degraded dependency into a total outage.

The standard resolution: deep checks that distinguish *my* problems from *shared* problems, plus a **minimum healthy threshold** — "never eject more than 50% of the pool." If everything looks unhealthy, the failure is probably in the checker, so keep serving.

Related: **connection draining.** On removal, stop sending *new* requests but let in-flight ones finish (typically 30 s). Without it, every deploy drops live requests.

## Who balances the balancer?

The obvious question, and the one the design has to answer.

A single LB instance is a single point of failure. Layered answers, in increasing sophistication:

1. **Active–passive pair with a floating IP.** Two instances, one virtual IP; on failure the standby claims the VIP (VRRP). Simple, wastes half your capacity, failover takes seconds.

2. **DNS round robin to multiple LBs.** Publish several A records. Free horizontal scale, but DNS caching means failover is slow (clients honor TTLs, sometimes badly) — DNS is a poor failure-detection mechanism.

3. **Anycast.** Advertise the *same* IP from many locations via BGP; the network routes each client to the topologically nearest one. Failure removal is a route withdrawal — fast, and it happens in the network rather than in DNS. This is how large CDNs and Google/Cloudflare-scale load balancing actually work.

4. **ECMP + stateless L4 tier.** A router hashes flows across many identical L4 balancers, which forward to L7 balancers, which forward to servers. The L4 tier is stateless and horizontally scalable; losing one just rehashes its flows.

The complete answer: the load balancer is redundant via an active-passive pair with a floating IP, and at higher scale you move to anycast so failover happens in the routing layer rather than in DNS.

## Global load balancing

Distributing across *regions*, not servers. Three mechanisms:

- **GeoDNS** — resolve to the nearest region's IP based on resolver location. Cheap, universally supported, but coarse (it knows the resolver, not the user) and slow to fail over due to caching.
- **Anycast** — one IP everywhere, BGP picks. Fast failover, no DNS TTL problem. Harder to control precisely; long-lived TCP connections can break if routes flap mid-connection.
- **Application-level redirect** — a lightweight global endpoint returns the right regional URL. Total control, extra round trip.

You also need **health-aware routing** and **failover policy**: if `us-east` is down, does `us-west` have the capacity to absorb its traffic? If both regions run at 70%, the answer is no — the failover itself causes the second outage. Sizing for failover capacity (running each region at ≤50% if you want single-region failure tolerance) is the kind of detail that reads as operational experience.

## What else lives here

Because it's on every request path, the load balancer accumulates responsibilities:

- **TLS termination** — one place to manage certs; backends speak plain HTTP inside the trust boundary (or mTLS if you're doing zero-trust).
- **[Rate limiting](rate-limiting.html)** — cheapest place to shed abusive traffic, before it costs you anything.
- **Request routing** — path/host based, plus canary and blue-green by weight or header.
- **Compression, caching, request/response rewriting.**
- **Observability** — a single consistent source of latency, status codes, and traffic metrics.

When it does all of this and fronts many services, we usually call it an [API gateway](api-gateway.html) — same box, more responsibilities.

:::exercise Choose a balancing policy
1. Round robin, least connections, and power-of-two-choices. For each, describe a traffic pattern where it performs badly.
2. Your backends have p50 = 5 ms and p99 = 400 ms, and utilisation is 75%. Which policy do you expect to help most, and by roughly how much? Justify from the queueing curve.
3. Sticky sessions improve cache hit rate and worsen balance. Compute the crossover for a case where a cache hit saves 80 ms and imbalance costs 15 ms of queue wait.
4. A backend is up but responding in 12 seconds. What does each policy do? Which one makes it worse, and what mechanism fixes it?
:::

:::paper Balancing algorithms, measured
*The Power of Two Choices in Randomized Load Balancing* (Mitzenmacher, 1996) is the result behind least-of-two-random-choices: sampling two backends and picking the less loaded gives almost all the benefit of full least-connections at a fraction of the coordination.

*Maglev: A Fast and Reliable Software Network Load Balancer* (Eisenbud et al., NSDI 2016) is Google's L4 balancer and the source of Maglev hashing. For the queueing argument, see [queueing theory](../01-foundations/queueing-theory.html).
:::
