#!/usr/bin/env bash
# One-shot Fly.io deploy. Safe to re-run — every step is idempotent.
#
#   ./deploy-fly.sh
#
# Assumes you have already run `flyctl auth login` (browser step, only you
# can do it). Everything after that is automated here.
set -euo pipefail

APP="sysdesign-atlas-armaan"
REGION="bom"
VOLUME="sysdesign_data"
ADMIN_EMAIL="armaanshukla06@gmail.com"

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v flyctl >/dev/null || die "flyctl not found. Run: brew install flyctl"

say "Checking Fly login"
if ! flyctl auth whoami >/dev/null 2>&1; then
  die "Not logged in. Run 'flyctl auth login' first, then re-run this script."
fi
echo "  logged in as $(flyctl auth whoami)"

say "Validating content before spending a build"
npm run check

say "Creating app '$APP' if it does not exist"
if flyctl apps list 2>/dev/null | grep -qw "$APP"; then
  echo "  already exists"
else
  flyctl apps create "$APP" --machines
fi

say "Creating 1 GB volume '$VOLUME' in $REGION if it does not exist"
if flyctl volumes list -a "$APP" 2>/dev/null | grep -qw "$VOLUME"; then
  echo "  already exists"
else
  flyctl volumes create "$VOLUME" --size 1 --region "$REGION" -a "$APP" --yes
fi

say "Setting secrets"
# AUTH_SECRET is generated once and reused — regenerating it logs everyone out,
# so only create it if it is not already set.
if flyctl secrets list -a "$APP" 2>/dev/null | grep -q AUTH_SECRET; then
  echo "  AUTH_SECRET already set, leaving it alone"
  flyctl secrets set \
    ADMIN_EMAIL="$ADMIN_EMAIL" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in your shell before running, e.g. export ADMIN_PASSWORD='...'}" \
    -a "$APP" --stage
else
  flyctl secrets set \
    AUTH_SECRET="$(openssl rand -base64 32)" \
    ADMIN_EMAIL="$ADMIN_EMAIL" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in your shell before running, e.g. export ADMIN_PASSWORD='...'}" \
    -a "$APP" --stage
fi

say "Deploying (building on Fly's builders — no local Docker needed)"
flyctl deploy --remote-only -a "$APP"

say "Ensuring exactly one machine (SQLite is single-writer)"
flyctl scale count 1 -a "$APP" --yes

say "Done"
echo "  URL:   https://$APP.fly.dev"
echo "  Email: $ADMIN_EMAIL"
echo "  Check: flyctl logs -a $APP"
