// Tiny JSON-file-backed store. Zero native deps — fine for a single-user tool.
//
// The data is modeled as normalized top-level collections (see SCHEMA.md): independent
// entities live in their own arrays and reference each other by id. This file owns the
// persistence shape + forward migrations; the API mapping lives in index.js.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INVOICES_DIR = path.join(DATA_DIR, 'invoices'); // saved PDF copies (per-org subdirs)

const SCHEMA_VERSION = 2;

// Empty, current-shape database.
function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { currentOrgId: null, createdAt: nowISO(), updatedAt: nowISO() },
    integrations: { google: null },
    organizations: [],
    customers: [],
    items: [],
    taxRates: [],
    invoices: [],
    payments: [],
    recurringSchedules: [],
    activity: [],
  };
}

// Collections that follow the standard record envelope.
const COLLECTIONS = ['organizations', 'customers', 'items', 'taxRates', 'invoices', 'payments', 'recurringSchedules', 'activity'];

let db = null;

function nowISO() { return new Date().toISOString(); }

function id(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Standard envelope mixed into every record.
function envelope(createdAt) {
  const t = nowISO();
  return { createdAt: createdAt || t, updatedAt: t, archivedAt: null, metadata: {} };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });
}

// ── Default factories ────────────────────────────────────────
function orgDefaults() {
  return {
    profile: { businessName: 'My Business', addressLines: [], taxId: '', email: '', phone: '', website: '' },
    branding: { logo: null, logoBackground: 'light' },
    defaults: { currency: '$', taxLabel: 'IGST', terms: 'Net 15', notes: '' },
    numbering: { invoicePrefix: 'INV-', nextNumber: 1 },
  };
}

// ── Migration ────────────────────────────────────────────────
// Bring any older DB shape up to the current normalized schema.
function migrate(raw) {
  // Already current.
  if (raw && raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.organizations)) {
    return backfill(raw);
  }

  const next = emptyDb();
  next.integrations.google = (raw && raw.google) || (raw && raw.integrations && raw.integrations.google) || null;

  // Legacy A (pre-orgs): settings/customers/... at the top level → one org.
  // Legacy B (nested orgs): raw.orgs[] each with settings/customers/products/invoices/recurring.
  let legacyOrgs = [];
  if (raw && Array.isArray(raw.orgs)) {
    legacyOrgs = raw.orgs;
  } else if (raw && (raw.settings || raw.customers || raw.invoices)) {
    legacyOrgs = [{
      id: id('org'),
      name: (raw.settings && raw.settings.businessName) || 'My business',
      createdAt: nowISO(),
      settings: raw.settings || {},
      customers: raw.customers || [],
      products: raw.products || [],
      invoices: raw.invoices || [],
      recurring: raw.recurring || [],
    }];
  }

  for (const o of legacyOrgs) migrateLegacyOrg(o, next);
  next.meta.currentOrgId = (raw && raw.currentOrgId) || (next.organizations[0] && next.organizations[0].id) || null;
  return backfill(next);
}

function migrateLegacyOrg(o, next) {
  const s = o.settings || {};
  const org = {
    id: o.id || id('org'),
    name: o.name || s.businessName || 'My business',
    profile: { businessName: s.businessName || o.name || 'My business', addressLines: s.addressLines || [], taxId: s.gstin || '', email: '', phone: '', website: '' },
    branding: { logo: s.logo || null, logoBackground: s.logoBg || 'light' },
    defaults: { currency: s.currency || '$', taxLabel: s.defaultTaxLabel || 'IGST', terms: s.defaultTerms || 'Net 15', notes: s.defaultNotes || '' },
    numbering: { invoicePrefix: s.invoicePrefix || 'INV-', nextNumber: s.nextNumber || 1 },
    ...envelope(o.createdAt),
  };
  next.organizations.push(org);

  for (const c of o.customers || []) {
    next.customers.push({
      id: c.id || id('cust'), orgId: org.id, name: c.name || 'Untitled customer',
      email: c.email || '', ccEmail: c.ccEmail || '', taxId: c.gstin || '',
      billingAddress: { lines: c.billingAddressLines || [] },
      shippingAddress: { lines: c.shipToAddressLines || [] },
      contacts: [], ...envelope(c.createdAt),
    });
  }
  for (const p of o.products || []) {
    next.items.push({
      id: p.id || id('item'), orgId: org.id, name: p.name || '',
      defaultRate: Number(p.rate) || 0, defaultTaxPercent: Number(p.taxPct) || 0, taxRateId: null,
      ...envelope(p.createdAt),
    });
  }
  for (const inv of o.invoices || []) {
    const b = inv.business || {};
    const stored = {
      id: inv.id || id('inv'), orgId: org.id, number: inv.number,
      customerId: inv.customerId || null, recurringScheduleId: inv.recurringId || null,
      invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, terms: inv.terms,
      currency: inv.currency || org.defaults.currency, taxLabel: inv.taxLabel || org.defaults.taxLabel,
      snapshot: {
        seller: { businessName: b.name || org.profile.businessName, addressLines: b.addressLines || [], taxId: b.gstin || '', logo: b.logo || null, logoBackground: b.logoBg || 'light' },
        billTo: { name: (inv.billTo && inv.billTo.name) || '', addressLines: (inv.billTo && inv.billTo.addressLines) || [], taxId: (inv.billTo && inv.billTo.gstin) || '' },
        shipTo: { addressLines: (inv.shipTo && inv.shipTo.addressLines) || [] },
        recipientEmail: inv.recipientEmail || '',
      },
      lineItems: (inv.items || []).map((it) => ({ id: id('li'), description: it.description || '', quantity: Number(it.qty) || 0, rate: Number(it.rate) || 0, taxPercent: Number(it.taxPct) || 0 })),
      amounts: { subTotal: inv.subTotal || 0, taxTotal: inv.taxTotal || 0, total: inv.total || 0 },
      notes: inv.notes || '',
      sentAt: inv.sentAt || null, sentTo: inv.sentTo || null, voidedAt: null,
      pdf: { file: inv.pdfFile || null, updatedAt: inv.pdfUpdatedAt || null },
      ...envelope(inv.createdAt),
    };
    if (inv.updatedAt) stored.updatedAt = inv.updatedAt;
    next.invoices.push(stored);

    // An embedded payment becomes a ledger entry.
    if (inv.payment) {
      next.payments.push({
        id: id('pay'), orgId: org.id, invoiceId: stored.id,
        amount: Number(inv.payment.amount) || 0, currency: stored.currency,
        mode: inv.payment.mode || 'Bank Transfer', date: inv.payment.date || null,
        reference: inv.payment.reference || '', note: '', ...envelope(inv.createdAt),
      });
    }
  }
  for (const r of o.recurring || []) {
    next.recurringSchedules.push({
      id: r.id || id('rec'), orgId: org.id, customerId: r.customerId || null, active: r.active !== false,
      frequency: { unit: 'month', interval: 1, dayOfMonth: Number(r.dayOfMonth) || 1 },
      nextRunDate: r.nextRunDate || null, lastGeneratedAt: r.lastGeneratedAt || null,
      template: {
        terms: r.terms || org.defaults.terms, taxLabel: r.taxLabel || org.defaults.taxLabel, notes: r.notes || '',
        lineItems: (r.items || []).map((it) => ({ id: id('li'), description: it.description || '', quantity: Number(it.qty) || 0, rate: Number(it.rate) || 0, taxPercent: Number(it.taxPct) || 0 })),
      },
      autoSend: Boolean(r.autoSend), ...envelope(r.createdAt),
    });
  }
}

// Fill in anything a partial/older record is missing (defensive after upgrades).
function backfill(d) {
  if (typeof d.schemaVersion !== 'number') d.schemaVersion = SCHEMA_VERSION;
  if (!d.meta) d.meta = { currentOrgId: null, createdAt: nowISO(), updatedAt: nowISO() };
  if (!d.integrations) d.integrations = { google: d.google || null };
  for (const k of COLLECTIONS) if (!Array.isArray(d[k])) d[k] = [];
  const od = orgDefaults();
  for (const org of d.organizations) {
    org.profile = Object.assign({}, od.profile, org.profile);
    org.branding = Object.assign({}, od.branding, org.branding);
    org.defaults = Object.assign({}, od.defaults, org.defaults);
    org.numbering = Object.assign({}, od.numbering, org.numbering);
    if (!org.name) org.name = org.profile.businessName;
    ensureEnvelope(org);
  }
  for (const k of ['customers', 'items', 'taxRates', 'invoices', 'payments', 'recurringSchedules', 'activity']) {
    for (const rec of d[k]) ensureEnvelope(rec);
  }
  // currentOrgId must point at a live org.
  const cur = d.meta.currentOrgId;
  if (cur && !d.organizations.some((o) => o.id === cur)) d.meta.currentOrgId = d.organizations[0] ? d.organizations[0].id : null;
  return d;
}

function ensureEnvelope(rec) {
  if (!rec.createdAt) rec.createdAt = nowISO();
  if (!rec.updatedAt) rec.updatedAt = rec.createdAt;
  if (rec.archivedAt === undefined) rec.archivedAt = null;
  if (!rec.metadata) rec.metadata = {};
}

// ── Lifecycle ────────────────────────────────────────────────
function load() {
  ensureDir();
  let raw = null;
  if (fs.existsSync(DB_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { console.error('Could not parse db.json, starting fresh:', e.message); raw = null; }
  }
  db = raw ? migrate(raw) : emptyDb();
  save();
  return db;
}

function save() {
  ensureDir();
  if (db && db.meta) db.meta.updatedAt = nowISO();
  // Atomic write: temp file then rename, so a crash mid-write can't corrupt db.json.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function get() {
  if (!db) load();
  return db;
}

// ── Query helpers ────────────────────────────────────────────
// Active (non-archived) rows in a collection, optionally scoped to an org.
function rows(collection, orgId) {
  const all = get()[collection] || [];
  return all.filter((r) => !r.archivedAt && (!orgId || r.orgId === orgId));
}

function activeOrg() {
  const d = get();
  const live = d.organizations.filter((o) => !o.archivedAt);
  if (!live.length) return null;
  return live.find((o) => o.id === d.meta.currentOrgId) || live[0];
}

function invoicesDir() {
  ensureDir();
  return INVOICES_DIR;
}

// Safe filename for a stored invoice PDF, namespaced per org so numbering can't collide.
function pdfPathFor(number, orgId) {
  const safeNum = String(number).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (orgId) {
    const safeOrg = String(orgId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(invoicesDir(), safeOrg);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, safeNum + '.pdf');
  }
  return path.join(invoicesDir(), safeNum + '.pdf');
}

module.exports = {
  load, save, get, id, nowISO, envelope, orgDefaults,
  rows, activeOrg, invoicesDir, pdfPathFor, SCHEMA_VERSION,
};
