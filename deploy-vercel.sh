#!/usr/bin/env bash
# One-shot Vercel + Neon deploy. Safe to re-run — every step is idempotent.
#
# Fully automated once you have two tokens (neither needs a credit card):
#
#   export NEON_API_KEY='...'    # console.neon.tech → Account settings → API keys
#   export VERCEL_TOKEN='...'    # vercel.com/account/tokens
#   export ADMIN_PASSWORD='...'
#   ./deploy-vercel.sh
#
# The Neon project is created for you and its POOLED connection string is used
# automatically. If you already have a database, set DATABASE_URL instead and
# NEON_API_KEY is not needed.
set -euo pipefail

ADMIN_EMAIL="${ADMIN_EMAIL:-armaanshukla06@gmail.com}"
PROJECT="${VERCEL_PROJECT:-sysdesign-atlas}"
NEON_PROJECT="${NEON_PROJECT:-sysdesign-atlas}"

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first}"

# Use the locally installed CLI rather than npx: this machine's global npm
# cache has root-owned files, which makes every `npx` invocation fail with
# EACCES. A local install with its own cache sidesteps it entirely.
if [ -x ./node_modules/.bin/vercel ]; then
  VC=(./node_modules/.bin/vercel)
else
  npm_config_cache=/tmp/npm-cache-clean npm install --no-save --no-audit --no-fund vercel@latest
  VC=(./node_modules/.bin/vercel)
fi
# vercel also reads VERCEL_TOKEN from the environment, but being explicit means
# the same script works whether you logged in interactively or pass a token.
[ -n "${VERCEL_TOKEN:-}" ] && VC+=(--token "$VERCEL_TOKEN")

say "Validating content"
npm run check

# ---------- database ----------
if [ -z "${DATABASE_URL:-}" ]; then
  [ -n "${NEON_API_KEY:-}" ] || die "Set DATABASE_URL, or NEON_API_KEY so I can create the database."
  say "Provisioning Neon database"
  DATABASE_URL="$(node scripts/provision-neon.mjs "$NEON_PROJECT")"
  export DATABASE_URL
fi

case "$DATABASE_URL" in
  postgres*) ;;
  *) die "DATABASE_URL must be a postgres:// or postgresql:// URL" ;;
esac
case "$DATABASE_URL" in
  *-pooler*) ;;
  *) warn 'DATABASE_URL is not the pooled endpoint. Serverless will exhaust connections.' ;;
esac

say "Pushing schema"
npx prisma db push

say "Seeding admin account"
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node prisma/seed.mjs

# ---------- vercel ----------
say "Checking Vercel auth"
"${VC[@]}" whoami >/dev/null 2>&1 \
  || die "Not authenticated. Either 'npx vercel login', or set VERCEL_TOKEN."
echo "  authenticated as $("${VC[@]}" whoami 2>/dev/null)"

say "Linking project"
if [ -f .vercel/project.json ]; then
  echo "  already linked"
else
  "${VC[@]}" link --yes --project "$PROJECT"
fi

say "Setting environment variables"
set_env() {
  local name="$1" value="$2"
  for target in production preview development; do
    "${VC[@]}" env rm "$name" "$target" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | "${VC[@]}" env add "$name" "$target" >/dev/null
  done
  echo "  set $name"
}

# AUTH_SECRET signs session cookies — generate once, then reuse, because
# rotating it invalidates every existing session.
if [ -f .env.production.local ] && grep -q '^AUTH_SECRET=' .env.production.local; then
  AUTH_SECRET="$(grep '^AUTH_SECRET=' .env.production.local | cut -d= -f2-)"
else
  AUTH_SECRET="$(openssl rand -base64 32)"
  printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET" >> .env.production.local
fi

set_env DATABASE_URL    "$DATABASE_URL"
set_env AUTH_SECRET     "$AUTH_SECRET"
set_env AUTH_TRUST_HOST "true"
set_env ADMIN_EMAIL     "$ADMIN_EMAIL"

say "Deploying to production"
"${VC[@]}" deploy --prod --yes

say "Done"
echo "  Email: $ADMIN_EMAIL"
echo "  Logs:  npx vercel logs${VERCEL_TOKEN:+ --token \$VERCEL_TOKEN}"

# Keep the connection string out of the terminal scrollback but available
# locally for `npm run dev` against the same database.
if ! grep -q '^DATABASE_URL=' .env 2>/dev/null; then
  printf 'DATABASE_URL=%s\n' "$DATABASE_URL" >> .env
  echo "  wrote DATABASE_URL into .env for local dev"
fi
