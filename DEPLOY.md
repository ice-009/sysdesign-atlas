# Deploying

**Vercel + Neon.** Both free, neither asks for a card. This is the path the
repo is configured for.

(Fly.io was the original plan; it now requires a credit card at signup. The
config is still here — `fly.toml`, `Dockerfile`, `deploy-fly.sh` — and still
works if you ever add one. See the bottom.)

## What you do (two browser steps, no card)

**1. Create a Neon database**

Go to <https://console.neon.tech>, sign in, **New Project**. Any name, pick the
region closest to you (Mumbai or Singapore).

On the project dashboard, copy the **Pooled connection** string. It looks like:

```
postgresql://neondb_owner:xxxx@ep-something-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

The `-pooler` in the hostname matters. Vercel runs serverless functions that
each open their own connection, and the direct (non-pooled) string will exhaust
Postgres connections under any real use. The script warns you if it looks wrong.

**2. Log into Vercel**

```bash
npx vercel login
```

Browser opens, pick your account, done. No card at any point.

## Then run one command

```bash
cd "/Users/ice-009/Desktop/System Design"
export DATABASE_URL='<paste the pooled Neon string>'
export ADMIN_PASSWORD='<your-password>'
./deploy-vercel.sh
```

It validates content, pushes the schema to Neon, seeds your admin account,
links the Vercel project, sets the environment variables on all three
environments, and deploys to production. Re-run it any time you change content
— every step is idempotent.

Your URL will be printed at the end (`https://sysdesign-atlas-*.vercel.app`).
Sign in with `armaanshukla06@gmail.com` and your password; progress, notes and
bookmarks then sync between your phone and laptop.

## Local development after this change

The Prisma provider is now `postgresql`, so the old `dev.db` SQLite file is no
longer used. Two options:

**Point local at Neon** (simplest, and your local and deployed data stay in
sync). Put the pooled string in `.env`:

```
DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require
```

**Or run Postgres locally** for offline work:

```bash
docker compose up -d db
# .env: DATABASE_URL=postgresql://atlas:atlas_dev_password@localhost:5432/atlas
npm run db:deploy      # push schema + seed
npm run dev
```

`lib/prisma.ts` still supports SQLite for anyone who wants it — it loads the
driver lazily via `createRequire`, so serverless builds never pull in the
native binary. To use it you would flip the schema provider back.

## Updating after a content change

```bash
npm run check                 # catch broken links/prereqs first
npx vercel deploy --prod --yes
```

Or re-run `./deploy-vercel.sh`, which does the same plus a schema push.

## Things to know

**Rotating the admin password.** The seed is an idempotent upsert:

```bash
export DATABASE_URL='<pooled neon string>'
ADMIN_EMAIL=armaanshukla06@gmail.com ADMIN_PASSWORD='<new>' node prisma/seed.mjs
```

No redeploy needed — it writes straight to the database.

**`AUTH_SECRET`** signs session cookies. `deploy-vercel.sh` generates it once
and stores it in `.env.production.local` (gitignored) so re-runs reuse it.
Changing it logs every session out.

**Neon free tier** is 0.5 GB storage and one project, and the compute
auto-suspends after 5 minutes idle — the first request after a pause takes an
extra second or so while it wakes. Fine for personal use.

**Schema changes** need `npx prisma db push` against the Neon URL, which
`deploy-vercel.sh` does for you.

**Logs:** `npx vercel logs` or the Vercel dashboard.

## The Fly.io path (needs a card)

Still fully configured. If you add a card:

```bash
flyctl auth login
export ADMIN_PASSWORD='...'
./deploy-fly.sh
```

That keeps SQLite on a persistent volume — one machine, no second provider.
You would need to flip `provider` back to `"sqlite"` in `prisma/schema.prisma`
first, since it is set to `postgresql` for the Vercel path.
