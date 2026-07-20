// Test harness: boots the real server against a throwaway DATA_DIR and gives
// back a tiny HTTP client plus a normalizer that strips volatile values.
//
// The point is to capture what the API *currently does* so the Supabase rewrite
// can be diffed against it. Nothing here knows how the data is persisted.
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(baseUrl + '/api/orgs');
      // Data routes now require auth, so an unauthenticated 401 means "listening".
      if (r.ok || r.status === 401) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready in time');
}

// Wipe every table so each run starts from a known-empty database.
// TRUNCATE ... CASCADE also resets the app_state row.
const TABLES = [
  'invoice_line_items', 'schedule_line_items', 'payments', 'reminders', 'activity',
  'invoices', 'recurring_schedules', 'items', 'tax_rates', 'customers',
  'integrations', 'app_state', 'organizations',
];

// The API requires a verified Supabase JWT. Rather than weaken auth for tests,
// the harness becomes its own issuer: an ES256 keypair served over a throwaway
// JWKS endpoint, with AUTH_JWKS_URL pointing the server at it. That exercises
// server/auth.js exactly as production does — only the signing authority differs.
const TEST_USER = '00000000-0000-0000-0000-0000000000a1';

async function startIssuer() {
  const { generateKeyPair, exportJWK, SignJWT } = require('jose');
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'harness', alg: 'ES256', use: 'sig' });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'harness' })
    .setSubject(TEST_USER)
    .setAudience('authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  return { url: `http://127.0.0.1:${server.address().port}/`, token, close: () => server.close() };
}

async function resetDatabase(connectionString) {
  const { Client } = require('pg');
  const c = new Client({ connectionString, ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    await c.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
    // organizations.owner_user_id references auth.users; the row must exist
    // before the suite can create an org.
    await c.query('insert into auth.users (id) values ($1) on conflict do nothing', [TEST_USER]);
  } finally {
    await c.end();
  }
}

// Boot a server on a free port against an empty test database.
//
// SAFETY: this truncates every table, so it must never point at a real project.
// TEST_DATABASE_URL is required and is refused if it looks like Supabase — the
// suite is meant to run against a local throwaway Postgres (npm run test:db:up).
async function startServer() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'TEST_DATABASE_URL is not set.\n' +
      'The suite truncates every table, so it refuses to guess at a database.\n' +
      'Start a throwaway Postgres with:  npm run test:db:up'
    );
  }
  if (/supabase\.(co|com)/.test(connectionString)) {
    throw new Error('TEST_DATABASE_URL points at Supabase. Refusing to truncate a hosted database.');
  }

  await resetDatabase(connectionString);

  const issuer = await startIssuer();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoicing-test-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_URL: connectionString,
      AUTH_JWKS_URL: issuer.url,
      // Unset so storage falls back to the local filesystem driver under
      // DATA_DIR — no test ever writes to a real bucket.
      SUPABASE_URL: '',
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      // Keep Gmail unconfigured so send/reminder paths take their offline branch.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl, child);
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(`${e.message}\n--- server output ---\n${logs.join('')}`);
  }

  // Minimal JSON client. Returns { status, body } and never throws on 4xx/5xx,
  // because error responses are part of the behavior being captured.
  async function api(method, urlPath, body) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        Authorization: `Bearer ${issuer.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    let parsed;
    if (type.includes('application/json')) parsed = await res.json();
    else if (type.includes('application/pdf')) {
      const buf = Buffer.from(await res.arrayBuffer());
      // Don't snapshot PDF bytes — they embed timestamps. Assert shape instead.
      parsed = { pdfBytes: buf.length > 1000, startsWithPdfMagic: buf.subarray(0, 5).toString() === '%PDF-' };
    } else parsed = { text: (await res.text()).slice(0, 200) };
    return { status: res.status, body: parsed };
  }

  return {
    api,
    baseUrl,
    dataDir,
    logs,
    token: issuer.token,
    stop() {
      child.kill('SIGKILL');
      issuer.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ── Normalization ────────────────────────────────────────────
// Generated ids and timestamps differ every run, so replace them with stable
// tokens. Same value seen twice maps to the same token, which preserves the
// referential structure (an invoice's customerId still matches the customer's id).
// Not anchored: ids also appear embedded in URL paths (/api/customers/cust_x),
// and those must tokenize to the same value as the bare id in a response body.
const ID_RE = /\b(org|cust|item|inv|pay|rec|rem|act|li)_[a-z0-9]+\b/g;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function makeNormalizer() {
  const seen = new Map();
  const today = new Date().toISOString().slice(0, 10);

  function token(kind, value) {
    const key = kind + ':' + value;
    if (!seen.has(key)) seen.set(key, `<${kind}#${seen.size + 1}>`);
    return seen.get(key);
  }

  return function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = normalize(value[k]);
      return out;
    }
    if (typeof value !== 'string') return value;
    if (TS_RE.test(value)) return '<timestamp>';
    // A date equal to today is derived from the clock; fixed future dates in the
    // scenario are meaningful and must stay literal.
    if (DATE_RE.test(value) && value === today) return '<today>';
    if (value.startsWith('data:')) return `<data-url:${value.length}>`;
    return value.replace(ID_RE, (m) => token('id', m));
  };
}

module.exports = { startServer, makeNormalizer };
