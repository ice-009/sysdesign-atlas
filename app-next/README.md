# SysDesign Atlas — Next.js

A systems curriculum that goes from the physics upward — hardware, queueing, distributed
correctness, storage internals — and then applies the same reasoning to AI infrastructure:
GPUs, distributed training, inference serving, retrieval, and agents.

**130 topics · ~215,000 words · 11 tracks in 4 groups · nothing locked.**

Built to be learned rather than skimmed. Every topic declares its prerequisites, so the
material arrives in an order where nothing appears out of nowhere. Interview-specific
advice exists, but it lives in an appendix at the end.

## Run it

```bash
npm run dev      # http://localhost:4321
npm run check    # content integrity: links, prereqs, frontmatter, callouts, viz specs
npm run build    # check + prisma generate + next build
npm run start    # serve the production build
```

The database is already initialized (`dev.db`). To recreate it from scratch:

```bash
npx prisma db push
```

> **npm note:** `~/.npm/_cacache` on this machine is owned by `root` (from a past `sudo npm`),
> so plain `npm install` fails with `EACCES`. Either run
> `sudo chown -R $(whoami) ~/.npm` once to fix it permanently, or pass
> `--cache /tmp/npm-cache` to any install command.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server components; the 66 topic pages prerender as static HTML |
| Auth | Auth.js v5, JWT sessions | Email+password works with zero setup; OAuth is env-gated |
| Database | Prisma 7 + SQLite / Postgres | Adapter chosen from DATABASE_URL scheme |
| Styling | Tailwind v4 + CSS variables | Theme switching without a class explosion |
| Animation | Motion | Layout transitions, scroll reveals, SVG paths |
| Code highlighting | Shiki | Dual light/dark themes, build-time — no client JS |

## Accounts

Sign up at `/signup` with any email and an 8+ character password. Passwords are
hashed with bcrypt (cost 12). Sessions are JWTs, so route handlers don't hit the
database on every request.

**OAuth is optional.** Add credentials to `.env` and the buttons appear automatically;
leave them blank and the sign-in page shows email/password only:

```bash
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
```

Signed-out visitors still get full access to all content, with progress saved to
`localStorage`. Signing in switches to the server as the source of truth.

## Per-user features

| Feature | Where | Stored as |
|---|---|---|
| Completion tracking | Any topic page | `Progress.completed` |
| Confidence rating (Shaky / OK / Solid) | Any topic page | `Progress.confidence` |
| Review queue, weakest first | `/dashboard` | derived from confidence |
| Private notes, autosaved | Bottom of any topic | `Note.body` |
| Bookmarks | Any topic page | `Bookmark` |
| Study streak + 18-week heatmap | `/dashboard` | `Activity` (one row per day) |
| Per-track progress bars | `/dashboard` | derived |
| Timed 45-min mock with phase track | `/practice` | client-side |

All writes are optimistic — the UI updates immediately and persists in the background.

## Admin

```bash
npm run seed
```

Creates an administrator and the default platform settings:

| | |
|---|---|
| Username | `admin` |
| Password | `admin` |
| Sign in | http://localhost:4321/signin |

Override with `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars. When the default password is
used, the account is flagged `mustChangePassword` and `/account` shows a warning until
it's changed.

> **This is a local-development default.** `admin/admin` is fine while everything runs
> on your own machine and nothing else can reach it. Change it before exposing the app
> to a network — the Kubernetes secret ships with placeholder values for the same reason.

`/admin` provides: user list with search, role promote/demote, suspend/restore, delete
(cascades), per-user plan changes, plan distribution, mock revenue, runtime platform
toggles, and an append-only audit log. Guarded server-side by role — the nav link is
cosmetic, the page itself re-checks.

## Subscriptions

Three plans in `lib/plans.ts`, which is the single source of truth for entitlements.

**Every topic is free on every plan.** Paid tiers add study tooling, they don't
paywall the curriculum. (An admin *can* flip `gate_content` in `/admin` if you want the
opposite — it's a toggle, not a rewrite.)

| | Free | Pro | Team |
|---|---|---|---|
| All topics & case studies | ✓ | ✓ | ✓ |
| Progress, confidence, review queue | ✓ | ✓ | ✓ |
| Private notes | 10 | unlimited | unlimited |
| Spaced repetition, analytics, export | — | ✓ | ✓ |
| Seats | 1 | 1 | 10 |

Entitlements degrade correctly: an expired or `past_due` subscription falls back to
Free automatically rather than granting access until someone notices. Limits are
enforced in the API route, not the UI — a client-side gate is decoration.

**Checkout is simulated.** Choosing a plan writes the subscription and an invoice row;
nothing is charged. `Subscription` already carries `providerCustomerId` /
`providerSubscriptionId`, so wiring Stripe means replacing `subscribe()` in
`app/actions/billing.ts` with a redirect to hosted checkout and moving the subscription
write into the webhook handler.

## Docker

```bash
docker compose up --build
```

Brings up Postgres, runs a one-shot migrate+seed container, then starts the app on
http://localhost:4321. The image is multi-stage on `node:22-alpine` using Next's
`standalone` output, and runs as a non-root user.

## Kubernetes

```bash
docker build -t sysdesign-atlas:latest .
kubectl apply -f k8s/
kubectl -n atlas rollout status deploy/atlas-app
kubectl -n atlas port-forward svc/atlas-app 8080:80
```

| File | Contains |
|---|---|
| `00-namespace.yaml` | Namespace |
| `01-config.yaml` | ConfigMap + Secret (**placeholder values — replace**) |
| `02-postgres.yaml` | StatefulSet + headless Service with a PVC |
| `03-migrate-job.yaml` | Job: waits for Postgres, applies schema, seeds admin |
| `04-app.yaml` | Deployment (3 replicas), Service, PodDisruptionBudget |
| `05-hpa.yaml` | HorizontalPodAutoscaler, 3→20 pods |
| `06-ingress.yaml` | nginx Ingress with edge rate limiting |

**Scaling for load** is the HPA: targets 65% CPU (not 90% — scaling takes tens of
seconds, so aiming near saturation means you're already overloaded before new pods are
Ready). Scale-up is capped at doubling per 30s; scale-down uses a 5-minute
stabilization window to prevent flapping. Needs `metrics-server` installed.

Two health endpoints, deliberately different:

- `/api/health` — process only, used for **liveness**. If this checked the database, one
  DB blip would restart every pod at once and turn a degradation into an outage.
- `/api/health?deep=1` — checks the database, used for **readiness**. A pod that can't
  reach Postgres is removed from the Service without being killed.

Before deploying anywhere real:

```bash
kubectl -n atlas create secret generic atlas-secrets \
  --from-literal=AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=DATABASE_URL='postgresql://atlas:STRONG@postgres:5432/atlas' \
  --from-literal=POSTGRES_USER=atlas \
  --from-literal=POSTGRES_PASSWORD='STRONG' \
  --from-literal=POSTGRES_DB=atlas \
  --from-literal=ADMIN_EMAIL='admin@yourdomain.com' \
  --from-literal=ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

For production, prefer a managed database over the bundled Postgres StatefulSet —
running stateful Postgres well on Kubernetes is a genuine specialisation.

## Database: SQLite vs Postgres

`lib/prisma.ts` picks the adapter from the `DATABASE_URL` scheme, so the same code runs
on both:

| | Local | Docker / Kubernetes |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | `postgresql://…` |
| Adapter | better-sqlite3 | pg |

**SQLite cannot back more than one replica** — it's a single file with a single writer.
Multi-pod deployments must use Postgres, which is why the manifests bundle it.

## Editing content

Content lives in `content/<section>/NN-slug.md` — plain Markdown with frontmatter:

```markdown
---
title: Design a URL Shortener
summary: Shown on cards and in search results.
difficulty: Easy | Medium | Hard
tags: [case-study, ids, cache]
prereqs: [back-of-envelope, caching, unique-id-generation]
level: 3          # guided builds only — position on the 1–6 ladder
unlocks: What you can do after this.
---
```

`prereqs` are topic slugs (the filename minus its number prefix). They drive the
readiness banner on every page and are advisory — never a lock. `npm run check` fails
the build if a prereq points at a topic that doesn't exist or introduces a cycle.

Three custom extensions beyond standard Markdown:

- ` ```diagram ` — ASCII architecture diagrams with glyph-level syntax colouring
- ` ```viz ` — a JSON spec rendered to animated SVG at build time (`flow`, `stack`,
  `axes`, `ring`, `fanout`, `compare`, `steps`); see `lib/viz.ts`
- `:::note` `:::tip` `:::warn` `:::trap` `:::math` `:::goat` `:::interview`
  `:::derive` `:::paper` `:::exercise` — callouts, closed with `:::`

`:::derive` shows the arithmetic behind a claim, `:::paper` cites the primary source,
and `:::exercise` gives the reader something to work out. Those three carry most of
the depth.

Sections — title, URL slug, group, accent colour, icon — are declared in `SECTIONS` in
`lib/content.ts`. Directory and filename number prefixes control ordering and are
stripped from the URL, so renumbering never breaks a link or a saved progress row.
`lib/markdown.ts` keeps the pre-restructure directory names in `DIR_TO_SLUG` so older
cross-links in the prose still resolve; don't remove those entries.

## Structure

```
app/
  page.tsx                          landing page
  learn/[section]/[slug]/page.tsx   topic pages (SSG)
  dashboard/                        progress analytics
  practice/                         design drills
  path/                             the guided-build ladder
  pricing/ billing/ account/        subscription surfaces
  admin/                            admin panel (role-guarded)
  api/{progress,notes,bookmarks}/   per-user data
  api/health/                       liveness + readiness probes
  actions/{auth,admin,billing}.ts   server actions
components/                         UI, all client components marked
lib/
  content.ts                        markdown loading + section config
  markdown.ts                       renderer (callouts, diagrams, Shiki)
  auth.ts                           Auth.js config
  prisma.ts                         database client
  plans.ts                          plan catalogue + entitlement logic
  entitlements.ts                   resolve plan/role, settings, audit
prisma/schema.prisma                data model
prisma/seed.mjs                     admin + settings seed
scripts/check-content.mjs           content integrity check (runs in build)
k8s/                                Kubernetes manifests
Dockerfile, docker-compose.yml      container build + local stack
content/                            130 markdown files across 11 sections
```

## A note on the content and visuals

Everything here is written from scratch. System design knowledge is public — it lives
in papers, engineering blogs, and conference talks — so nothing needed copying. All
diagrams and icons are hand-built SVG rather than stock imagery, which keeps them
crisp at any size and correct in both themes.

Technology specifics (latency figures, throughput ceilings, product behaviours) are
order-of-magnitude accurate as written but drift over time. The AI tracks move faster
than anything else here: the architectural principles are stable, but treat specific
figures for model sizes, GPU memory, and throughput as illustrative of the shape of
the problem rather than current fact. Verify anything you plan to state as precise.
