// End-to-end proof that two signed-in users cannot see each other's data.
//
// This drives the real HTTP API against a real Postgres with the real policies,
// and verifies real ES256 tokens against a real JWKS endpoint — the same code
// path production uses. Only the key issuer is local.
//
// Requires a database: scripts/test-auth.sh sets one up and runs this.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');

const PORT = Number(process.env.AUTH_TEST_PORT || 45231);
const JWKS_PORT = Number(process.env.AUTH_TEST_JWKS_PORT || 45232);
const BASE = `http://127.0.0.1:${PORT}`;

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

let privateKey, jwksServer, child, pool;

async function mint(sub, { expired = false, audience = 'authenticated' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setAudience(audience)
    .setIssuedAt(expired ? now - 7200 : now)
    .setExpirationTime(expired ? now - 3600 : now + 3600)
    .sign(privateKey);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (html/pdf) */ }
  return { status: res.status, body: json, text };
}

// Ready == the API answers at all. Every data route 401s without a token now,
// so a 401 is the success signal here.
async function waitForReady(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(BASE + '/api/orgs');
      if (r.status === 401) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not become ready');
}

test.before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  assert.ok(!/supabase\.co/.test(process.env.TEST_DATABASE_URL), 'refusing to run against Supabase');

  // Local JWKS so auth.js exercises its real remote-JWKS path, not a stand-in.
  const kp = await generateKeyPair('ES256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  Object.assign(jwk, { kid: 'test-key', alg: 'ES256', use: 'sig' });

  jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwksServer.listen(JWKS_PORT, '127.0.0.1', r));

  // Seed the auth users the policies key off, and clear any prior run.
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(`truncate organizations, customers, items, invoices, invoice_line_items,
    payments, reminders, activity, recurring_schedules, schedule_line_items,
    tax_rates, integrations, app_state restart identity cascade`);
  await pool.query(`insert into auth.users (id) values ($1), ($2) on conflict do nothing`, [ALICE, BOB]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoicing-auth-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      AUTH_JWKS_URL: `http://127.0.0.1:${JWKS_PORT}/`,
      DATA_DIR: dataDir,
      SUPABASE_URL: '',        // local-filesystem storage driver
      SUPABASE_SECRET_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => {
    const line = String(b);
    if (!/ExperimentalWarning/.test(line)) process.stderr.write(`[server] ${line}`);
  });
  await waitForReady();
});

test.after(async () => {
  if (child) { child.kill('SIGTERM'); }
  if (jwksServer) await new Promise((r) => jwksServer.close(r));
  if (pool) await pool.end();
});

test('auth + tenant isolation', async (t) => {
  const aliceToken = await mint(ALICE);
  const bobToken = await mint(BOB);

  await t.test('rejects unauthenticated requests', async () => {
    assert.equal((await api('/api/invoices')).status, 401);
    assert.equal((await api('/api/customers')).status, 401);
    assert.equal((await api('/api/orgs')).status, 401);
  });

  await t.test('rejects a garbage token', async () => {
    const r = await api('/api/invoices', { token: 'not.a.jwt' });
    assert.equal(r.status, 401);
  });

  await t.test('rejects an expired token', async () => {
    const r = await api('/api/invoices', { token: await mint(ALICE, { expired: true }) });
    assert.equal(r.status, 401);
    assert.equal(r.body.expired, true, 'frontend needs to distinguish expiry from invalid');
  });

  await t.test('rejects a token for the wrong audience', async () => {
    const r = await api('/api/invoices', { token: await mint(ALICE, { audience: 'anon' }) });
    assert.equal(r.status, 401);
  });

  // ── Alice sets up her org ──
  let aliceInvoiceId, aliceOrgId;

  await t.test('alice creates an org, customer and invoice', async () => {
    const org = await api('/api/orgs', {
      token: aliceToken, method: 'POST', body: { businessName: 'Alice Co', currency: '$' },
    });
    assert.equal(org.status, 200);
    aliceOrgId = org.body.id;

    const cust = await api('/api/customers', {
      token: aliceToken, method: 'POST', body: { name: 'Alice Customer' },
    });
    assert.equal(cust.status, 200);

    const inv = await api('/api/invoices', {
      token: aliceToken, method: 'POST',
      body: { customerId: cust.body.id, invoiceDate: '2026-07-20', items: [{ description: 'Work', qty: 1, rate: 1000, taxPct: 0 }] },
    });
    assert.equal(inv.status, 200);
    assert.equal(inv.body.total, 1000);
    aliceInvoiceId = inv.body.id;
  });

  await t.test('bob sees none of alice data', async () => {
    const orgs = await api('/api/orgs', { token: bobToken });
    assert.equal(orgs.status, 200);
    assert.deepEqual(orgs.body.orgs, [], 'bob must see zero orgs');

    // With no org of his own, data routes have nothing to scope to.
    const inv = await api('/api/invoices', { token: bobToken });
    assert.ok(inv.status === 400 || (inv.body && inv.body.length === 0),
      `bob must not see invoices, got ${inv.status} ${inv.text.slice(0, 120)}`);
  });

  await t.test('bob cannot fetch alice invoice by id', async () => {
    const r = await api(`/api/invoices/${aliceInvoiceId}`, { token: bobToken });
    assert.ok(r.status === 404 || r.status === 400,
      `expected not-found, got ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!r.text.includes('Alice Customer'), 'alice data leaked into bob response');
  });

  await t.test('bob gets his own org and stays separated', async () => {
    const org = await api('/api/orgs', {
      token: bobToken, method: 'POST', body: { businessName: 'Bob Co', currency: '$' },
    });
    assert.equal(org.status, 200);
    assert.notEqual(org.body.id, aliceOrgId);

    const bobOrgs = await api('/api/orgs', { token: bobToken });
    assert.equal(bobOrgs.body.orgs.length, 1, 'bob sees only his own org');
    assert.equal(bobOrgs.body.orgs[0].name, 'Bob Co');

    const bobInvoices = await api('/api/invoices', { token: bobToken });
    assert.equal(bobInvoices.status, 200);
    assert.equal(bobInvoices.body.length, 0, 'bob org starts empty');

    const bobCustomers = await api('/api/customers', { token: bobToken });
    assert.deepEqual(bobCustomers.body, [], 'alice customer must not appear for bob');
  });

  await t.test('alice still sees exactly her own data', async () => {
    const orgs = await api('/api/orgs', { token: aliceToken });
    assert.equal(orgs.body.orgs.length, 1);
    assert.equal(orgs.body.orgs[0].name, 'Alice Co');

    const invoices = await api('/api/invoices', { token: aliceToken });
    assert.equal(invoices.body.length, 1);
    assert.equal(invoices.body[0].id, aliceInvoiceId);
  });

  await t.test('bob cannot activate alice org', async () => {
    const r = await api(`/api/orgs/${aliceOrgId}/activate`, { token: bobToken, method: 'POST' });
    assert.ok(r.status >= 400, `expected rejection, got ${r.status}`);

    // And the attempt must not have moved him onto her data.
    const after = await api('/api/invoices', { token: bobToken });
    assert.ok(!after.text.includes(aliceInvoiceId), 'bob reached alice invoices after activate');
  });

  await t.test('bob cannot pay or delete alice invoice', async () => {
    const pay = await api(`/api/invoices/${aliceInvoiceId}/pay`, {
      token: bobToken, method: 'POST', body: { amount: 1 },
    });
    assert.ok(pay.status >= 400, `expected rejection, got ${pay.status}`);

    await api(`/api/invoices/${aliceInvoiceId}`, { token: bobToken, method: 'DELETE' });

    const still = await api(`/api/invoices/${aliceInvoiceId}`, { token: aliceToken });
    assert.equal(still.status, 200, 'alice invoice must survive bob delete attempt');
    assert.equal(still.body.amountPaid, 0, 'bob payment must not have landed');
  });
});
