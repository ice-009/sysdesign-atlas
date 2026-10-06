---
title: "Proxies: Forward and Reverse"
summary: The middleman in front of clients and the middleman in front of servers — what each is for, the jobs a reverse proxy takes off your application servers, and how proxies relate to load balancers, CDNs, API gateways and sidecars.
difficulty: Easy
scope: HLD
tags: [proxy, networking, reverse-proxy, load-balancing]
prereqs: [load-balancing]
---

:::predict Guess first
1. A forward proxy and a reverse proxy are both middlemen. Whose side is each one on?
2. A phone on a weak connection takes 20 seconds to upload a request. Why might you not want your app server waiting for it?
3. Is a load balancer a kind of proxy?
:::

A **proxy** is a computer that sits between two others and passes messages along, acting on one side's behalf. That's the whole definition. The two kinds differ only in *whose* side the proxy is on — and that one difference decides everything it's used for.

## The two kinds, side by side

```diagram
   FORWARD PROXY — works for the clients

     laptop ─┐
     laptop ─┼──▶ [ forward proxy ] ──▶ the internet (any website)
     phone  ─┘     the clients know it's there and send everything through it;
                   websites see the proxy, not the individual clients

   REVERSE PROXY — works for the servers

                                         ┌──▶ app server 1
     anyone on the internet ──▶ [ reverse proxy ] ──▶ app server 2
                                         └──▶ app server 3
                   clients think it IS the website; the servers behind it are hidden
```

An easy way to remember: a forward proxy **hides the clients** from the servers; a reverse proxy **hides the servers** from the clients.

## Forward proxies — on the client's side

The clients are configured to send their requests through it (or the network forces them to). Common uses:

- **Company networks.** All staff traffic leaves through one proxy that blocks some sites, scans downloads for malware and logs access.
- **Caching for many clients.** A school's proxy fetches a popular file once and serves it to every student.
- **Hiding who is asking.** Websites see the proxy's address, not the person's — the basis of privacy tools.
- **Getting out of a locked-down network.** Servers in a private network with no direct internet access reach outside services through one controlled proxy, so there's one place to allow, log and audit outbound calls.

In system design interviews, forward proxies come up rarely — mostly that last case, as an *egress proxy*: "our services call third-party APIs only through an egress proxy, which holds the allow-list and the credentials."

## Reverse proxies — on the server's side

This is the one you'll draw in almost every design. Clients connect to the reverse proxy as if it were the site; it forwards each request to one of the servers behind it and sends back the answer.

Because it handles every request first, it can take whole jobs away from the application servers:

| Job | What it means |
|---|---|
| **Load balancing** | Spread requests across healthy servers — see [Load Balancing](load-balancing.html) |
| **TLS termination** | Do the HTTPS encryption work once, at the edge; talk plain HTTP (or re-encrypted) inside |
| **Caching** | Serve repeated responses without bothering the servers — see [Caching](caching.html) |
| **Compression** | Gzip or Brotli responses, saving bandwidth |
| **Routing** | `/api/*` to one group of servers, `/images/*` to another |
| **Rate limiting and blocking** | Stop abusive clients before they reach the app — see [Rate Limiting](rate-limiting.html) |
| **Buffering slow clients** | Hold a slow phone's upload or download so app servers aren't tied up waiting |
| **Hiding the inside** | Clients never learn how many servers exist or their addresses |

The buffering one is easy to overlook and genuinely important. A phone on a weak connection might take 20 seconds to send a request. If the app server waits for it, that server is busy doing nothing for 20 seconds. A reverse proxy receives the whole request first, *then* hands it to the app server in a few milliseconds — and does the same for the response. App servers spend their time computing, not waiting on networks.

:::tip What it costs
Every proxy adds a network hop (usually well under a millisecond inside one data centre) and is something else that can fail. Run at least two, with traffic able to move between them, so the proxy layer is never a single point of failure.
:::

## Reverse proxy, load balancer, CDN, API gateway — what's the difference?

People use these words loosely, because they overlap. The honest answer: **they're all reverse proxies**, named for their main job.

```diagram
   reverse proxy        the general idea: in front of servers, forwarding requests
     ├─ load balancer    …whose main job is spreading load across servers
     ├─ CDN edge server  …placed near users worldwide, mostly caching
     ├─ API gateway      …that also handles auth, quotas and routing for services
     └─ sidecar proxy    …running next to each service, handling its network calls
```

So in an interview, you can draw one box labelled "load balancer / reverse proxy" at the front and say what it does — the label matters less than naming its jobs. The [CDN](cdn.html) is the same idea spread across the globe, and the [API Gateway](api-gateway.html) is the same idea with business rules added.

## Layer 4 or layer 7

A proxy can work at two depths:

- **Layer 4 (transport):** it forwards TCP connections without looking inside. Very fast, works for any protocol, but can't route by URL or cache — it doesn't know what an HTTP request is.
- **Layer 7 (application):** it reads the HTTP request — path, headers, cookies — so it can route, cache, rewrite and rate-limit per user. More work per request, much more capability.

Most web systems use layer 7 at the edge. Layer 4 shows up where raw speed matters or the protocol isn't HTTP. [Load Balancing](load-balancing.html) covers the trade-off in more detail.

## What the app server stops seeing

Putting a proxy in front changes what the application sees, and forgetting this causes real bugs:

- **The client's address.** The app sees every request coming from the proxy. The proxy adds a header — `X-Forwarded-For: 203.0.113.7` — and the app must read *that*, but only trust it from its own proxies (anyone can send that header).
- **Whether it was HTTPS.** If TLS ends at the proxy, the app sees plain HTTP. The proxy passes `X-Forwarded-Proto: https` so the app builds correct links.
- **Timeouts.** The proxy has its own timeout. If the app allows 60 seconds but the proxy gives up at 30, users see errors for requests the app is still happily processing.

## Sidecars and service meshes

In a system of many services, there's a newer place to put proxies: **next to every service instance**, in the same machine or container group. Each service talks to its local proxy, and the proxies handle retries, timeouts, encryption between services and metrics. A fleet of these is called a **service mesh**.

It's the reverse-proxy idea applied to service-to-service traffic. It's powerful and has real operational cost — see the service mesh section in [API Gateway](api-gateway.html) for when it's worth it.

## In the interview

- Draw the reverse proxy / load balancer at the front of almost every design, and **say which jobs it's doing**: "it terminates TLS, balances across the app servers, and caches the public product pages."
- Mention buffering when there are mobile clients or large uploads.
- Use "egress proxy" when your design calls outside services and security matters.
- Don't spend time on the forward/reverse definitions unless asked — knowing them is assumed; using them well is what scores.

:::exercise Place the proxies
A photo-sharing app has mobile clients, an upload service, a feed API, and calls a third-party payment provider.

1. Draw where reverse proxies sit, and give each one its jobs. Which of them should buffer uploads?
2. The app logs every request's client IP for abuse detection, and every log line shows `10.0.0.5`. What happened, and what's the fix — including the security catch?
3. Payments must only ever go to the provider's addresses, and the API key must not live on every app server. Which kind of proxy solves both, and where does it sit?
:::

## Check yourself

```recall
Q: Forward proxy versus reverse proxy: which side is each on, and what does each hide?
A: A forward proxy works for clients and hides them from servers (company egress, caching, privacy). A reverse proxy works for servers and hides them from clients — the clients think it is the site.

Q: Name five jobs a reverse proxy takes off your application servers.
A: Load balancing, TLS termination, caching, compression, path-based routing, rate limiting and blocking, buffering slow clients, and hiding internal topology.

Q: Why does buffering slow clients matter?
A: The proxy receives a slow phone's whole request (and response) before involving the app server, so app servers spend milliseconds computing instead of seconds waiting on bad networks.

Q: How do load balancers, CDNs, API gateways and sidecars relate to reverse proxies?
A: They're all reverse proxies named for their main job: spreading load, caching near users worldwide, auth and quotas for many services, or handling one service's network calls.

Q: Your app logs every request as coming from 10.0.0.5. What happened, and what's the catch in the fix?
A: It's seeing the proxy's address. Read X-Forwarded-For — but only trust it from your own proxies, because any client can send that header.

Q: What is an egress proxy for?
A: Letting services in a locked-down network call outside APIs through one controlled point that holds the allow-list and credentials and logs every outbound call.

Q: Layer 4 versus layer 7 proxying in one line each?
A: L4 forwards TCP connections without looking inside — fast, any protocol. L7 reads the HTTP request — it can route, cache, rewrite and rate-limit per user.
```

## What to carry forward

- A forward proxy hides clients; a reverse proxy hides servers — and the reverse proxy is in almost every design.
- Reverse proxies terminate TLS, balance load, cache, route, rate-limit and buffer slow clients.
- Load balancers, CDN edges, API gateways and sidecars are reverse proxies named for their main job.
- Behind a proxy, read client IP and scheme from forwarded headers you trust, and align timeouts.
- Run at least two proxies so the proxy layer is never a single point of failure.
