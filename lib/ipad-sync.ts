import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, SyncRecord } from '@prisma/client';
import { prisma } from './prisma';
import { entitlementFrom } from './plans';

/* Server half of the offline iPad app's sync (/ipad).

   The app keeps everything in IndexedDB and uploads an outbox of changes when
   it has a connection. Each change is a whole record — a highlight, an ink
   stroke, a sketch card, or one piece of study state — with an id minted on
   the device and a hybrid-logical-clock string. The rules:

     - newest clock wins, compared as strings (the format sorts correctly);
     - an equal clock means "already have it", so a retried upload is a no-op;
     - deletes are records with deleted=true, so they sync like anything else;
     - every write takes the next number from the user's SyncState row, and a
       device asks for "everything after #N".

   Study state (done / confidence / bookmark / note) is also mirrored into the
   website's own tables, and the website's routes log their writes here via
   logWebChange, so the iPad and the website stay in agreement. */

type Tx = Prisma.TransactionClient;

export const SYNC_KINDS = [
  // marks
  'highlight',
  'stroke',
  'card',
  // study state, mirrored into the website's tables
  'done',
  'conf',
  'bookmark',
  'note',
  // reading tracker
  'pos', //    where the reader stopped in a topic
  'sec', //    one section read (create-only, so devices merge as a set)
  'time', //   one device's reading seconds for one day (topic = YYYY-MM-DD)
  'review', // review schedule for a topic
  'goal', //   the reader's track goal (topic = "main")
] as const;
const KINDS = new Set<string>(SYNC_KINDS);
const CLOCK = /^[0-9a-z]{9}-[0-9a-z]{4}-[\w-]{1,40}$/;
const ID = /^[\w:.-]{1,120}$/;
const SLUG = /^[\w-]{1,120}$/;
const MAX_DATA_BYTES = 64 * 1024;
const PULL_LIMIT = 500;
export const MAX_CHANGES = 400;

export type Change = {
  id: string;
  kind: string;
  topic: string;
  data: Prisma.InputJsonValue;
  clock: string;
  deleted: boolean;
};

export type WireRecord = Omit<Change, 'data'> & { data: unknown; seq: string };

/* ---------- device keys ---------- */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Same rules as the website's credentials sign-in in lib/auth.ts. */
export async function verifyPassword(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash || user.suspended) return null;
  return (await bcrypt.compare(password, user.passwordHash)) ? user : null;
}

export async function issueDeviceToken(userId: string, name: string) {
  const token = `atl_${crypto.randomBytes(32).toString('base64url')}`;
  await prisma.deviceToken.create({ data: { userId, name, tokenHash: sha256(token) } });
  return token;
}

/** Resolve "Authorization: Bearer atl_…" to a user, or null. */
export async function deviceFromRequest(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith('atl_')) return null;

  const row = await prisma.deviceToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { suspended: true } } },
  });
  if (!row || row.revokedAt || row.user.suspended) return null;

  // Touch lastUsedAt at most every ten minutes — it's for the account page,
  // not worth a write on every sync.
  if (Date.now() - row.lastUsedAt.getTime() > 10 * 60 * 1000) {
    await prisma.deviceToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  }
  return { userId: row.userId, tokenId: row.id };
}

export async function revokeDevice(tokenId: string, userId?: string) {
  await prisma.deviceToken.updateMany({
    where: { id: tokenId, ...(userId ? { userId } : {}), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/* ---------- validation ---------- */

/** Same sortable shape the devices use, stamped "web". */
export const serverClock = (ms = Date.now()) => `${Math.max(0, Math.floor(ms)).toString(36).padStart(9, '0')}-0000-web`;

export function parseChanges(input: unknown): Change[] | string {
  if (input == null) return [];
  if (!Array.isArray(input)) return 'changes must be an array';
  if (input.length > MAX_CHANGES) return `at most ${MAX_CHANGES} changes per request`;

  const out: Change[] = [];
  for (const raw of input) {
    const c = raw as Record<string, unknown>;
    const id = String(c?.id ?? '');
    const kind = String(c?.kind ?? '');
    const topic = String(c?.topic ?? '');
    const clock = String(c?.clock ?? '');
    if (!ID.test(id)) return `bad id: ${id.slice(0, 40)}`;
    if (!KINDS.has(kind)) return `bad kind for ${id}`;
    if (!SLUG.test(topic)) return `bad topic for ${id}`;
    if (!CLOCK.test(clock)) return `bad clock for ${id}`;
    const data = (c.data ?? {}) as Prisma.InputJsonValue;
    if (JSON.stringify(data).length > MAX_DATA_BYTES) return `record ${id} is too large`;
    out.push({ id, kind, topic, clock, data, deleted: c.deleted === true });
  }
  return out;
}

const wire = (r: SyncRecord): WireRecord => ({
  id: r.id,
  kind: r.kind,
  topic: r.topic,
  data: r.data,
  clock: r.clock,
  deleted: r.deleted,
  seq: r.seq.toString(),
});

/* ---------- mirror into the website's tables ---------- */

async function noteLimitFor(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, subscription: { select: { plan: true, status: true, currentPeriodEnd: true } } },
  });
  return entitlementFrom(user?.subscription ?? null, user?.role === 'ADMIN').noteLimit;
}

async function mirror(tx: Tx, userId: string, c: Change, ctx: { noteLimit?: number | null }, prev?: SyncRecord) {
  const d = (c.data && typeof c.data === 'object' ? c.data : {}) as Record<string, unknown>;
  const slug = c.topic;
  const section = String(d.section ?? '').slice(0, 80);
  const key = { userId_slug: { userId, slug } };

  switch (c.kind) {
    case 'done': {
      const done = !c.deleted && Boolean(d.done);
      const at = done ? new Date(typeof d.done === 'number' ? d.done : Date.now()) : null;
      await tx.progress.upsert({
        where: key,
        create: { userId, slug, section, completed: done, completedAt: at },
        update: { completed: done, completedAt: at },
      });
      return;
    }
    case 'conf': {
      const confidence = c.deleted ? 0 : Math.max(0, Math.min(3, Math.round(Number(d.conf) || 0)));
      await tx.progress.upsert({
        where: key,
        create: { userId, slug, section, confidence },
        update: { confidence },
      });
      return;
    }
    case 'bookmark': {
      if (c.deleted) {
        await tx.bookmark.deleteMany({ where: { userId, slug } });
        return;
      }
      const title = String(d.title ?? slug).slice(0, 200);
      await tx.bookmark.upsert({ where: key, create: { userId, slug, section, title }, update: { title } });
      return;
    }
    case 'time': {
      // Each device owns one record per day holding its running total. Only
      // whole minutes gained since the previous version of that record are
      // added to the website's Activity row, so retries and repeats never
      // double-count and the website's own minutes are left alone.
      const day = c.topic;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      const before = prev && !prev.deleted ? Number((prev.data as Record<string, unknown>)?.s) || 0 : 0;
      const after = c.deleted ? before : Math.max(0, Number(d.s) || 0);
      const minutes = Math.floor(after / 60) - Math.floor(before / 60);
      if (minutes <= 0) return;
      await tx.activity.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, minutes },
        update: { minutes: { increment: minutes } },
      });
      return;
    }
    case 'pos': {
      const pos = d.pos as { at?: number } | null | undefined;
      if (c.deleted || !pos) return;
      await tx.progress.updateMany({ where: { userId, slug }, data: { lastViewed: new Date(Number(pos.at) || Date.now()) } });
      return;
    }
    case 'note': {
      const body = c.deleted ? '' : String(d.text ?? '');
      if (!body.trim()) {
        await tx.note.deleteMany({ where: { userId, slug } });
        return;
      }
      const existing = await tx.note.findUnique({ where: key, select: { id: true } });
      if (!existing) {
        // The website's plan limit still applies to what shows up on the
        // website. Past it, the note stays synced between devices here but
        // isn't copied into the website's notes.
        if (ctx.noteLimit === undefined) ctx.noteLimit = await noteLimitFor(tx, userId);
        if (ctx.noteLimit !== null && (await tx.note.count({ where: { userId } })) >= ctx.noteLimit) return;
      }
      await tx.note.upsert({ where: key, create: { userId, slug, section, body }, update: { body } });
      return;
    }
  }
}

/* ---------- first sync: start from what the website already has ---------- */

async function backfillRows(tx: Tx, userId: string) {
  const [progress, bookmarks, notes] = [
    await tx.progress.findMany({ where: { userId } }),
    await tx.bookmark.findMany({ where: { userId } }),
    await tx.note.findMany({ where: { userId } }),
  ];
  const rows: Omit<Change, 'deleted'>[] = [];
  for (const p of progress) {
    if (p.completed) {
      const at = (p.completedAt ?? p.lastViewed).getTime();
      rows.push({ id: `done:${p.slug}`, kind: 'done', topic: p.slug, data: { done: at, section: p.section }, clock: serverClock(at) });
    }
    if (p.confidence) {
      rows.push({
        id: `conf:${p.slug}`,
        kind: 'conf',
        topic: p.slug,
        data: { conf: p.confidence, section: p.section },
        clock: serverClock(p.lastViewed.getTime()),
      });
    }
  }
  for (const b of bookmarks) {
    rows.push({
      id: `bookmark:${b.slug}`,
      kind: 'bookmark',
      topic: b.slug,
      data: { section: b.section, title: b.title, at: b.createdAt.getTime() },
      clock: serverClock(b.createdAt.getTime()),
    });
  }
  for (const n of notes) {
    rows.push({
      id: `note:${n.slug}`,
      kind: 'note',
      topic: n.slug,
      data: { section: n.section, text: n.body },
      clock: serverClock(n.updatedAt.getTime()),
    });
  }
  return rows.filter((r) => SLUG.test(r.topic));
}

/* ---------- the sync transaction ---------- */

export async function runSync(userId: string, cursor: bigint, incoming: Change[]) {
  // Two copies of one record in a batch: keep the newest.
  const latest = new Map<string, Change>();
  for (const c of incoming) {
    const prev = latest.get(c.id);
    if (!prev || c.clock > prev.clock) latest.set(c.id, c);
  }
  const changes = [...latest.values()];

  return prisma.$transaction(
    async (tx) => {
      if (!(await tx.syncState.findUnique({ where: { userId } }))) {
        await tx.syncState.create({ data: { userId } });
        const rows = await backfillRows(tx, userId);
        if (rows.length) {
          const s = await tx.syncState.update({ where: { userId }, data: { seq: { increment: rows.length } } });
          let seq = s.seq - BigInt(rows.length);
          await tx.syncRecord.createMany({ data: rows.map((r) => ({ ...r, userId, seq: ++seq })) });
        }
      }

      // UPDATE … RETURNING: reserves a block of sequence numbers and holds the
      // row lock until commit, so no other write for this user interleaves.
      const locked = await tx.syncState.update({
        where: { userId },
        data: { seq: { increment: changes.length } },
      });
      let next = locked.seq - BigInt(changes.length);

      const pulledRows = await tx.syncRecord.findMany({
        where: { userId, seq: { gt: cursor, lte: next } },
        orderBy: { seq: 'asc' },
        take: PULL_LIMIT + 1,
      });
      const hasMore = pulledRows.length > PULL_LIMIT;
      const pulled = pulledRows.slice(0, PULL_LIMIT);

      const existing = changes.length
        ? await tx.syncRecord.findMany({ where: { userId, id: { in: changes.map((c) => c.id) } } })
        : [];
      const have = new Map(existing.map((r) => [r.id, r]));

      const rejected: WireRecord[] = [];
      const creates: Prisma.SyncRecordCreateManyInput[] = [];
      const updates: Change[] = [];
      for (const c of changes) {
        const ex = have.get(c.id);
        if (ex && ex.clock >= c.clock) {
          // Equal: a retry of something already stored. Older: the device
          // needs to hear about the newer version.
          if (ex.clock > c.clock) rejected.push(wire(ex));
          continue;
        }
        if (ex) updates.push(c);
        else creates.push({ userId, id: c.id, kind: c.kind, topic: c.topic, data: c.data, clock: c.clock, deleted: c.deleted, seq: ++next });
      }

      // New ink strokes are the bulk of most uploads; insert them in one go.
      if (creates.length) await tx.syncRecord.createMany({ data: creates });
      for (const c of updates) {
        await tx.syncRecord.update({
          where: { userId_id: { userId, id: c.id } },
          data: { kind: c.kind, topic: c.topic, data: c.data, clock: c.clock, deleted: c.deleted, seq: ++next },
        });
      }

      const ctx: { noteLimit?: number | null } = {};
      const MIRRORED = new Set(['done', 'conf', 'bookmark', 'note', 'time', 'pos']);
      for (const c of changes) {
        const ex = have.get(c.id);
        if (ex && ex.clock >= c.clock) continue;
        if (MIRRORED.has(c.kind)) await mirror(tx, userId, c, ctx, ex);
      }

      return {
        changes: pulled.map(wire),
        rejected,
        accepted: creates.length + updates.length,
        hasMore,
        // With more to pull, resume after the last row sent. Otherwise the
        // device is current up to and including what it just uploaded.
        cursor: (hasMore ? pulled[pulled.length - 1].seq : locked.seq).toString(),
      };
    },
    { timeout: 25_000, maxWait: 10_000 }
  );
}

/* ---------- writes made on the website ---------- */

/** Record a website-side change so the iPad picks it up on its next sync.
    Never throws: the website's own write has already succeeded, and a
    failure here must not turn it into an error for the reader. */
export async function logWebChange(
  userId: string,
  kind: 'done' | 'conf' | 'bookmark' | 'note',
  slug: string,
  data: Prisma.InputJsonValue,
  deleted = false
) {
  try {
    await prisma.$transaction(async (tx) => {
      // No SyncState yet means no device has ever synced; the first sync will
      // backfill from the website tables, so there is nothing to log.
      if (!(await tx.syncState.findUnique({ where: { userId } }))) return;
      const { seq } = await tx.syncState.update({ where: { userId }, data: { seq: { increment: 1 } } });
      const id = `${kind}:${slug}`;
      const clock = serverClock();
      await tx.syncRecord.upsert({
        where: { userId_id: { userId, id } },
        create: { userId, id, kind, topic: slug, data, clock, deleted, seq },
        update: { kind, data, clock, deleted, seq },
      });
    });
  } catch (err) {
    console.error('[ipad-sync] could not log website change', err);
  }
}
