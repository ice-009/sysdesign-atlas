# syntax=docker/dockerfile:1

# Debian rather than Alpine: better-sqlite3 publishes glibc prebuilds but not
# musl ones, so Alpine would have to compile it from source at install time.

# ---------- deps ----------
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma's client must be generated before Next compiles against it.
RUN npx prisma generate

# A real DATABASE_URL isn't needed to build the app — pages are prerendered
# from markdown on disk and nothing touches the DB at build time.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build:next

# Bake an empty, schema-migrated SQLite file into the image. The entrypoint
# copies it onto the persistent volume on first boot. No credentials are
# seeded here — seeding happens at runtime from Fly secrets, so nothing
# secret ends up in an image layer.
RUN DATABASE_URL="file:/tmp/template.db" npx prisma db push \
    && mv /tmp/template.db ./prisma/template.db

# ---------- runtime ----------
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 nodejs \
    && useradd -u 1001 -g nodejs -m nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# standalone bundles the server plus only the deps it traced as needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Needed at runtime: markdown source, prisma schema/client, and the DB template.
COPY --from=builder --chown=nextjs:nodejs /app/content ./content
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
# The seed script imports dotenv, which the standalone trace has no reason to include.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/dotenv ./node_modules/dotenv

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
