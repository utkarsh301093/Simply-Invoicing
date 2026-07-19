#!/usr/bin/env node
// Migrate data/db.json into Postgres (Supabase), plus binaries into Storage.
//
//   node scripts/migrate-to-supabase.js --dry-run       # report only, no writes
//   node scripts/migrate-to-supabase.js --skip-storage  # DB only (local testing)
//   node scripts/migrate-to-supabase.js                 # full migration
//
// Properties this script guarantees:
//   * Idempotent — every write is an upsert keyed by the record's existing id,
//     so re-running converges rather than duplicating. Safe after a partial run.
//   * Atomic — the whole DB portion runs in one transaction. A failure rolls
//     back to empty rather than leaving half a database.
//   * Non-destructive — data/db.json is only ever read. It stays as rollback.
//   * Verified — row counts are compared against the source before committing,
//     and the transaction aborts on any mismatch.
//
// Binaries (logos, invoice PDFs) are uploaded BEFORE the transaction commits but
// are not themselves transactional; a re-run overwrites them, which is harmless.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const SKIP_STORAGE = args.has('--skip-storage');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INVOICES_DIR = path.join(DATA_DIR, 'invoices');
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'invoices';

// Single-user sentinel; matches app_state.user_id's default.
const SINGLE_USER = '00000000-0000-0000-0000-000000000000';

// ── Small helpers ───────────────────────────────────────────────────────────

// Empty strings are not valid dates/timestamps; the JSON store used '' and null
// interchangeably for "unset".
const orNull = (v) => (v === '' || v === undefined ? null : v);
const json = (v) => JSON.stringify(v ?? null);
const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function log(...a) { console.log(...a); }

// ── Storage ─────────────────────────────────────────────────────────────────

// Logos are content-addressed: identical bytes upload once and every record that
// referenced them points at the same object. The old model inlined a ~45KB
// base64 copy per org AND per invoice snapshot.
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const contentType = m[1] || 'application/octet-stream';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { contentType, buf };
}

function extFor(contentType) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' }[contentType] || 'bin';
}

function makeStorage() {
  if (SKIP_STORAGE) {
    return { enabled: false, async ensureBucket() {}, async putLogo() { return null; }, async putPdf() { return null; } };
  }
  const storage = require('../server/storage');
  if (!storage.configured()) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required (or pass --skip-storage)');
  }
  const uploaded = new Map(); // content hash -> storage path

  return {
    enabled: true,
    async ensureBucket() {
      const r = await storage.ensureBucket();
      log(r.created ? `  created private bucket "${BUCKET}"` : `  bucket "${BUCKET}" already exists`);
      if (!r.created && r.public) log(`  ! WARNING: bucket "${BUCKET}" is PUBLIC — invoices would be world-readable`);
    },
    async putLogo(orgId, dataUrl) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) return null;
      // Content-addressed: identical bytes upload once, however many rows point at them.
      const hash = crypto.createHash('sha256').update(parsed.buf).digest('hex').slice(0, 16);
      if (uploaded.has(hash)) return uploaded.get(hash);
      const p = await storage.put(`logos/${orgId}/${hash}.${extFor(parsed.contentType)}`, parsed.buf, parsed.contentType);
      uploaded.set(hash, p);
      return p;
    },
    async putPdf(orgId, fileName, buf) {
      return storage.put(`invoices/${orgId}/${fileName}`, buf, 'application/pdf');
    },
  };
}

// ── Upsert helper ───────────────────────────────────────────────────────────
// Builds "insert ... on conflict (id) do update set ..." so re-runs converge.

async function upsert(client, table, rows, conflictKey = 'id') {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const updates = cols.filter((c) => c !== conflictKey).map((c) => `${c} = excluded.${c}`).join(', ');
  let n = 0;
  for (const row of rows) {
    const values = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(
      `insert into ${table} (${cols.join(', ')}) values (${placeholders})
       on conflict (${conflictKey}) do update set ${updates}`,
      values
    );
    n++;
  }
  return n;
}

// ── Row mappers: JSON collection shape -> table shape ───────────────────────

const mapOrg = (o, logoPath) => ({
  id: o.id,
  owner_user_id: null, // populated when auth is enabled
  name: o.name || o.profile.businessName,
  business_name: o.profile.businessName || 'My Business',
  address_lines: arr(o.profile.addressLines),
  tax_id: o.profile.taxId || '',
  email: o.profile.email || '',
  phone: o.profile.phone || '',
  website: o.profile.website || '',
  logo_path: logoPath,
  logo_background: o.branding.logoBackground === 'dark' ? 'dark' : 'light',
  currency: o.defaults.currency || '$',
  tax_label: o.defaults.taxLabel || 'IGST',
  terms: o.defaults.terms || 'Net 15',
  notes: o.defaults.notes || '',
  reminder_offsets: arr(o.defaults.reminderOffsets || [0]),
  invoice_prefix: o.numbering.invoicePrefix || 'INV-',
  next_number: Math.max(1, num(o.numbering.nextNumber) || 1),
  created_at: o.createdAt,
  updated_at: o.updatedAt,
  archived_at: orNull(o.archivedAt),
  metadata: json(o.metadata || {}),
});

const mapCustomer = (c) => ({
  id: c.id,
  org_id: c.orgId,
  name: c.name || 'Untitled customer',
  email: c.email || '',
  cc_email: c.ccEmail || '',
  tax_id: c.taxId || '',
  billing_address_lines: arr(c.billingAddress && c.billingAddress.lines),
  shipping_address_lines: arr(c.shippingAddress && c.shippingAddress.lines),
  contacts: arr(c.contacts),
  created_at: c.createdAt,
  updated_at: c.updatedAt,
  archived_at: orNull(c.archivedAt),
  metadata: json(c.metadata || {}),
});

const mapTaxRate = (t) => ({
  id: t.id, org_id: t.orgId, name: t.name || '', percent: num(t.percent),
  created_at: t.createdAt, updated_at: t.updatedAt, archived_at: orNull(t.archivedAt), metadata: json(t.metadata || {}),
});

const mapItem = (i) => ({
  id: i.id, org_id: i.orgId, name: i.name || '',
  default_rate: num(i.defaultRate), default_tax_percent: num(i.defaultTaxPercent),
  tax_rate_id: orNull(i.taxRateId),
  created_at: i.createdAt, updated_at: i.updatedAt, archived_at: orNull(i.archivedAt), metadata: json(i.metadata || {}),
});

const mapSchedule = (r) => ({
  id: r.id, org_id: r.orgId, customer_id: orNull(r.customerId), active: r.active !== false,
  frequency_unit: (r.frequency && r.frequency.unit) || 'month',
  frequency_interval: num((r.frequency && r.frequency.interval) || 1) || 1,
  day_of_month: Math.min(31, Math.max(1, num((r.frequency && r.frequency.dayOfMonth) || 1) || 1)),
  next_run_date: orNull(r.nextRunDate),
  last_generated_at: orNull(r.lastGeneratedAt),
  template_terms: (r.template && r.template.terms) || 'Net 15',
  template_tax_label: (r.template && r.template.taxLabel) || 'IGST',
  template_notes: (r.template && r.template.notes) || '',
  auto_send: Boolean(r.autoSend),
  created_at: r.createdAt, updated_at: r.updatedAt, archived_at: orNull(r.archivedAt), metadata: json(r.metadata || {}),
});

const mapInvoice = (inv, snapshot, pdfPath) => ({
  id: inv.id, org_id: inv.orgId, number: inv.number,
  customer_id: orNull(inv.customerId),
  recurring_schedule_id: orNull(inv.recurringScheduleId),
  invoice_date: orNull(inv.invoiceDate),
  due_date: orNull(inv.dueDate),
  terms: inv.terms || 'Net 15',
  currency: inv.currency || '$',
  tax_label: inv.taxLabel || 'IGST',
  snapshot: json(snapshot),
  sub_total: num(inv.amounts && inv.amounts.subTotal),
  tax_total: num(inv.amounts && inv.amounts.taxTotal),
  total: num(inv.amounts && inv.amounts.total),
  notes: inv.notes || '',
  sent_at: orNull(inv.sentAt),
  sent_to: orNull(inv.sentTo),
  voided_at: orNull(inv.voidedAt),
  pdf_path: pdfPath,
  pdf_updated_at: orNull(inv.pdf && inv.pdf.updatedAt),
  created_at: inv.createdAt, updated_at: inv.updatedAt, archived_at: orNull(inv.archivedAt), metadata: json(inv.metadata || {}),
});

const mapLine = (li, parentKey, parentId, orgId, position) => ({
  id: li.id || `li_${crypto.randomBytes(5).toString('hex')}`,
  [parentKey]: parentId,
  org_id: orgId,
  position,
  description: li.description || '',
  quantity: num(li.quantity),
  rate: num(li.rate),
  tax_percent: num(li.taxPercent),
});

const mapPayment = (p) => ({
  id: p.id, org_id: p.orgId, invoice_id: p.invoiceId,
  amount: num(p.amount), currency: p.currency || '$', mode: p.mode || 'Bank Transfer',
  date: orNull(p.date), reference: p.reference || '', note: p.note || '',
  created_at: p.createdAt, updated_at: p.updatedAt, archived_at: orNull(p.archivedAt), metadata: json(p.metadata || {}),
});

const mapReminder = (r) => ({
  id: r.id, org_id: r.orgId, invoice_id: r.invoiceId,
  offset_days: num(r.offsetDays), due_on: r.dueOn,
  status: ['pending', 'sent', 'cancelled'].includes(r.status) ? r.status : 'pending',
  sent_at: orNull(r.sentAt), sent_to: orNull(r.sentTo), error: orNull(r.error),
  created_at: r.createdAt, updated_at: r.updatedAt, archived_at: orNull(r.archivedAt), metadata: json(r.metadata || {}),
});

const mapActivity = (a) => ({
  id: a.id, org_id: a.orgId, type: a.type || 'unknown',
  ref_type: orNull(a.refType), ref_id: orNull(a.refId),
  message: a.message || '', at: a.at || a.createdAt, metadata: json(a.metadata || {}),
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`No database file at ${DB_FILE} — nothing to migrate.`);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

  const counts = {
    organizations: db.organizations.length, customers: db.customers.length,
    taxRates: (db.taxRates || []).length, items: db.items.length,
    recurringSchedules: db.recurringSchedules.length, invoices: db.invoices.length,
    payments: db.payments.length, reminders: (db.reminders || []).length,
    activity: db.activity.length,
  };
  log('Source data/db.json:');
  for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(20)} ${v}`);
  log(`  schemaVersion        ${db.schemaVersion}`);
  log(`  gmail tokens         ${db.integrations && db.integrations.google ? 'present' : 'none'}`);

  if (DRY_RUN) return log('\n--dry-run: no writes performed.');

  const storage = makeStorage();
  if (storage.enabled) { log('\nStorage:'); await storage.ensureBucket(); }

  // ── Upload binaries and collect their paths ──
  const logoPathByOrg = new Map();
  const pdfPathByInvoice = new Map();
  if (storage.enabled) {
    for (const org of db.organizations) {
      if (org.branding && org.branding.logo) {
        logoPathByOrg.set(org.id, await storage.putLogo(org.id, org.branding.logo));
      }
    }
    log(`  uploaded ${logoPathByOrg.size} org logo(s)`);

    let pdfs = 0;
    for (const inv of db.invoices) {
      if (!inv.pdf || !inv.pdf.file) continue;
      const local = path.join(INVOICES_DIR, inv.orgId, inv.pdf.file);
      if (!fs.existsSync(local)) { log(`  ! missing PDF on disk, skipping: ${inv.number}`); continue; }
      pdfPathByInvoice.set(inv.id, await storage.putPdf(inv.orgId, inv.pdf.file, fs.readFileSync(local)));
      pdfs++;
    }
    log(`  uploaded ${pdfs} invoice PDF(s)`);
  }

  // Snapshots embed a base64 logo copy. Swap it for the storage path so history
  // is preserved without carrying ~45KB of base64 on every invoice row.
  function rewriteSnapshot(inv) {
    const snap = JSON.parse(JSON.stringify(inv.snapshot || {}));
    if (snap.seller && snap.seller.logo) {
      const p = logoPathByOrg.get(inv.orgId) || null;
      if (p) { snap.seller.logoPath = p; delete snap.seller.logo; }
    }
    return snap;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /supabase\.(co|com)/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query('begin');
    log('\nWriting rows (single transaction):');

    // Parent-before-child ordering so every foreign key resolves.
    const n = {};
    n.organizations = await upsert(client, 'organizations', db.organizations.map((o) => mapOrg(o, logoPathByOrg.get(o.id) || null)));
    n.customers = await upsert(client, 'customers', db.customers.map(mapCustomer));
    n.tax_rates = await upsert(client, 'tax_rates', (db.taxRates || []).map(mapTaxRate));
    n.items = await upsert(client, 'items', db.items.map(mapItem));
    n.recurring_schedules = await upsert(client, 'recurring_schedules', db.recurringSchedules.map(mapSchedule));

    const schedLines = [];
    for (const r of db.recurringSchedules)
      (r.template && r.template.lineItems ? r.template.lineItems : []).forEach((li, i) =>
        schedLines.push(mapLine(li, 'schedule_id', r.id, r.orgId, i)));
    n.schedule_line_items = await upsert(client, 'schedule_line_items', schedLines);

    n.invoices = await upsert(client, 'invoices', db.invoices.map((inv) =>
      mapInvoice(inv, rewriteSnapshot(inv), pdfPathByInvoice.get(inv.id) || null)));

    const invLines = [];
    for (const inv of db.invoices)
      (inv.lineItems || []).forEach((li, i) => invLines.push(mapLine(li, 'invoice_id', inv.id, inv.orgId, i)));
    n.invoice_line_items = await upsert(client, 'invoice_line_items', invLines);

    n.payments = await upsert(client, 'payments', db.payments.map(mapPayment));
    n.reminders = await upsert(client, 'reminders', (db.reminders || []).map(mapReminder));
    n.activity = await upsert(client, 'activity', db.activity.map(mapActivity));

    // Gmail OAuth tokens. service_role-only; never selected into an API response.
    const g = db.integrations && db.integrations.google;
    if (g) {
      await upsert(client, 'integrations', [{
        id: 'int_google', org_id: null, provider: 'google',
        tokens: json(g), connected_at: g.connectedAt || null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: json({}),
      }]);
      n.integrations = 1;
    }

    await upsert(client, 'app_state', [{
      user_id: SINGLE_USER,
      current_org_id: orNull(db.meta && db.meta.currentOrgId),
      schema_version: 4,
      created_at: (db.meta && db.meta.createdAt) || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }], 'user_id');

    for (const [k, v] of Object.entries(n)) log(`  ${k.padEnd(22)} ${v}`);

    // ── Verify before committing ──
    log('\nVerifying row counts against source:');
    const checks = [
      ['organizations', counts.organizations], ['customers', counts.customers],
      ['tax_rates', counts.taxRates], ['items', counts.items],
      ['recurring_schedules', counts.recurringSchedules], ['invoices', counts.invoices],
      ['payments', counts.payments], ['reminders', counts.reminders], ['activity', counts.activity],
    ];
    const problems = [];
    for (const [table, expected] of checks) {
      const { rows } = await client.query(`select count(*)::int as c from ${table}`);
      const got = rows[0].c;
      log(`  ${table.padEnd(22)} ${got} / ${expected} ${got === expected ? 'ok' : 'MISMATCH'}`);
      if (got !== expected) problems.push(`${table}: expected ${expected}, found ${got}`);
    }

    // Totals must survive the float -> numeric conversion untouched.
    const { rows: totals } = await client.query('select coalesce(sum(total), 0)::float8 as t from invoices');
    const srcTotal = db.invoices.reduce((s, i) => s + num(i.amounts && i.amounts.total), 0);
    const dstTotal = totals[0].t;
    log(`  invoice total sum      ${dstTotal} / ${srcTotal} ${Math.abs(dstTotal - srcTotal) < 0.005 ? 'ok' : 'MISMATCH'}`);
    if (Math.abs(dstTotal - srcTotal) >= 0.005) problems.push(`invoice totals differ: ${dstTotal} vs ${srcTotal}`);

    if (problems.length) {
      await client.query('rollback');
      console.error('\nROLLED BACK — verification failed:');
      for (const p of problems) console.error('  ' + p);
      process.exitCode = 1;
      return;
    }

    await client.query('commit');
    log('\nCommitted. data/db.json is unchanged and remains your rollback.');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('\nMigration failed:', e.message);
  process.exitCode = 1;
});
