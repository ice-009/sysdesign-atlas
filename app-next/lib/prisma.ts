import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Reuse the client across hot reloads in dev, or we exhaust connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';

  if (url.startsWith('postgres')) {
    // Serverless: use the POOLED Neon connection string, or you exhaust
    // Postgres connections as soon as more than a few functions run at once.
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }

  // SQLite is a local-development convenience only — it is a single-writer
  // file and cannot back more than one replica. Loaded through createRequire
  // rather than a static import so serverless builds never pull in the native
  // better-sqlite3 binary for a driver they will never use.
  const req = createRequire(import.meta.url);
  const { PrismaBetterSqlite3 } = req('@prisma/adapter-better-sqlite3');
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
