#!/usr/bin/env node
/* Create a Neon project via the API and print its POOLED connection string.
   Idempotent: if a project with the same name already exists, reuse it.

   Usage:  NEON_API_KEY=... node scripts/provision-neon.mjs [project-name]

   Why pooled: Vercel runs each request in its own serverless function, and
   every one opens a Postgres connection. The direct endpoint runs out of
   connections almost immediately; the pooler is what makes it viable. */

const API = 'https://console.neon.tech/api/v2';
const KEY = process.env.NEON_API_KEY;
const NAME = process.argv[2] ?? 'sysdesign-atlas';
const REGION = process.env.NEON_REGION ?? 'aws-ap-southeast-1'; // Singapore

if (!KEY) {
  console.error('NEON_API_KEY is not set.');
  console.error('Create one at https://console.neon.tech/app/settings/api-keys');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'object' ? JSON.stringify(body) : body;
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${msg}`);
  }
  return body;
}

/* Neon returns a direct host like ep-cool-name-123456.ap-southeast-1.aws.neon.tech
   The pooled host is the same with "-pooler" appended to the endpoint id. */
function toPooled(host) {
  if (host.includes('-pooler')) return host;
  const [ep, ...rest] = host.split('.');
  return [`${ep}-pooler`, ...rest].join('.');
}

function buildUri(p) {
  const host = toPooled(p.pooler_host ?? p.host);
  const user = encodeURIComponent(p.role);
  const pass = encodeURIComponent(p.password);
  return `postgresql://${user}:${pass}@${host}/${p.database}?sslmode=require`;
}

const { projects } = await api('/projects');
let project = projects.find((p) => p.name === NAME);

if (project) {
  console.error(`Reusing existing Neon project "${NAME}" (${project.id})`);
  // Connection details are not returned by the list endpoint — fetch them.
  const { roles } = await api(`/projects/${project.id}/branches/${
    (await api(`/projects/${project.id}/branches`)).branches.find((b) => b.default).id
  }/roles`);
  const role = roles[0];
  const { password } = await api(
    `/projects/${project.id}/branches/${role.branch_id}/roles/${role.name}/reveal_password`
  );
  const { databases } = await api(
    `/projects/${project.id}/branches/${role.branch_id}/databases`
  );
  const { endpoints } = await api(`/projects/${project.id}/endpoints`);
  console.log(
    buildUri({
      host: endpoints[0].host,
      pooler_host: null,
      role: role.name,
      password,
      database: databases[0].name,
    })
  );
} else {
  console.error(`Creating Neon project "${NAME}" in ${REGION}…`);
  const created = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      project: { name: NAME, region_id: REGION, pg_version: 17 },
    }),
  });
  const conn = created.connection_uris?.[0];
  if (!conn) throw new Error('Neon did not return a connection URI');
  console.error(`Created project ${created.project.id}`);
  console.log(buildUri(conn.connection_parameters));
}
