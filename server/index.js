require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const store = require('./store');
const google = require('./google');
const { renderInvoicePdf } = require('./pdf');
const { buildWorkbook } = require('./export');
const { computeTotals, amountToWords, round2 } = require('./invoice');

const app = express();
app.use(express.json({ limit: '15mb' })); // PDFs/logos arrive as base64 data URLs

store.load();

// ─────────────────────────────────────────────────────────────
// Storage ⇄ API mapping layer
//
// Storage uses the normalized model in SCHEMA.md; the API keeps its existing flat
// shapes. These translators are the single place that bridges the two, so the schema
// can grow without touching the frontend or PDF renderer.
// ─────────────────────────────────────────────────────────────
const now = () => store.nowISO();

// Line item: stored {quantity, taxPercent} ⇄ API {qty, taxPct}.
function lineItemToApi(li) { return { description: li.description, qty: li.quantity, rate: li.rate, taxPct: li.taxPercent }; }
function lineItemFromApi(it) {
  return { id: store.id('li'), description: it.description || '', quantity: Number(it.qty) || 0, rate: Number(it.rate) || 0, taxPercent: Number(it.taxPct) || 0 };
}

// Org config ⇄ flat "settings" object the frontend uses.
function settingsView(org) {
  return {
    businessName: org.profile.businessName, addressLines: org.profile.addressLines, gstin: org.profile.taxId,
    currency: org.defaults.currency, logo: org.branding.logo, logoBg: org.branding.logoBackground,
    invoicePrefix: org.numbering.invoicePrefix, nextNumber: org.numbering.nextNumber,
    defaultTerms: org.defaults.terms, defaultTaxLabel: org.defaults.taxLabel, defaultNotes: org.defaults.notes,
  };
}
function applySettings(org, body) {
  const put = (obj, key, val) => { if (val !== undefined) obj[key] = val; };
  put(org.profile, 'businessName', body.businessName);
  put(org.profile, 'addressLines', body.addressLines);
  put(org.profile, 'taxId', body.gstin);
  put(org.defaults, 'currency', body.currency);
  put(org.branding, 'logo', body.logo);
  put(org.branding, 'logoBackground', body.logoBg);
  put(org.numbering, 'invoicePrefix', body.invoicePrefix);
  if (body.nextNumber !== undefined) org.numbering.nextNumber = Number(body.nextNumber) || 1;
  put(org.defaults, 'terms', body.defaultTerms);
  put(org.defaults, 'taxLabel', body.defaultTaxLabel);
  put(org.defaults, 'notes', body.defaultNotes);
  if (org.profile.businessName) org.name = org.profile.businessName;
  org.updatedAt = now();
}

function customerView(c) {
  return {
    id: c.id, name: c.name, email: c.email, ccEmail: c.ccEmail, gstin: c.taxId,
    billingAddressLines: c.billingAddress.lines, shipToAddressLines: c.shippingAddress.lines,
    createdAt: c.createdAt,
  };
}
function itemView(i) { return { id: i.id, name: i.name, rate: i.defaultRate, taxPct: i.defaultTaxPercent, createdAt: i.createdAt }; }
function recurringView(r) {
  return {
    id: r.id, customerId: r.customerId, active: r.active, frequency: 'monthly', dayOfMonth: r.frequency.dayOfMonth,
    nextRunDate: r.nextRunDate, terms: r.template.terms, taxLabel: r.template.taxLabel, notes: r.template.notes,
    items: r.template.lineItems.map(lineItemToApi), autoSend: r.autoSend, lastGeneratedAt: r.lastGeneratedAt, createdAt: r.createdAt,
  };
}

function paymentsForInvoice(db, invoiceId) {
  return db.payments.filter((p) => !p.archivedAt && p.invoiceId === invoiceId);
}

// Invoice view: flattens the snapshot and derives paid-state from the payments ledger.
function invoiceView(db, inv) {
  const pays = paymentsForInvoice(db, inv.id);
  const amountPaid = round2(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const total = inv.amounts.total;
  const balanceDue = round2(Math.max(0, total - amountPaid));
  const paid = amountPaid > 0 && balanceDue <= 0;
  const status = inv.voidedAt ? 'void' : paid ? 'paid' : inv.sentAt ? 'sent' : 'draft';
  const latest = pays.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const s = inv.snapshot;
  return {
    id: inv.id, number: inv.number, status, customerId: inv.customerId,
    business: { name: s.seller.businessName, addressLines: s.seller.addressLines, gstin: s.seller.taxId, logo: s.seller.logo, logoBg: s.seller.logoBackground },
    billTo: { name: s.billTo.name, addressLines: s.billTo.addressLines, gstin: s.billTo.taxId },
    shipTo: { addressLines: s.shipTo.addressLines },
    recipientEmail: s.recipientEmail,
    invoiceDate: inv.invoiceDate, terms: inv.terms, dueDate: inv.dueDate, taxLabel: inv.taxLabel,
    items: inv.lineItems.map(lineItemToApi),
    notes: inv.notes, currency: inv.currency,
    subTotal: inv.amounts.subTotal, taxTotal: inv.amounts.taxTotal, total,
    amountPaid, balanceDue, amountInWords: amountToWords(total),
    payment: latest ? { mode: latest.mode, date: latest.date, reference: latest.reference, amount: latest.amount } : null,
    sentAt: inv.sentAt, sentTo: inv.sentTo, recurringId: inv.recurringScheduleId,
    createdAt: inv.createdAt, updatedAt: inv.updatedAt,
    pdfFile: inv.pdf.file, pdfUpdatedAt: inv.pdf.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Org scoping — every data route works inside the active org
// ─────────────────────────────────────────────────────────────
function requireOrg(res) {
  const org = store.activeOrg();
  if (!org) { res.status(400).json({ error: 'No organization selected. Create one first.' }); return null; }
  return org;
}

function logActivity(db, orgId, type, refType, refId, message) {
  db.activity.push({ id: store.id('act'), orgId, type, refType, refId, message, at: now(), metadata: {} });
}

// ─────────────────────────────────────────────────────────────
// Invoice building / numbering / PDF
// ─────────────────────────────────────────────────────────────
function buildStoredInvoice(org, body, number) {
  const customer = store.rows('customers', org.id).find((c) => c.id === body.customerId);
  if (!customer) throw new Error('Customer not found');
  const lineItems = (body.items || []).map(lineItemFromApi);
  const totals = computeTotals(lineItems.map(lineItemToApi));
  const useShip = body.shipToSameAsBilling === false && customer.shippingAddress.lines.length;
  return {
    id: store.id('inv'), orgId: org.id, number,
    customerId: customer.id, recurringScheduleId: body.recurringId || null,
    invoiceDate: body.invoiceDate, dueDate: body.dueDate, terms: body.terms || org.defaults.terms,
    currency: org.defaults.currency, taxLabel: body.taxLabel || org.defaults.taxLabel,
    snapshot: {
      seller: { businessName: org.profile.businessName, addressLines: org.profile.addressLines, taxId: org.profile.taxId, logo: org.branding.logo || null, logoBackground: org.branding.logoBackground || 'light' },
      billTo: { name: customer.name, addressLines: customer.billingAddress.lines || [], taxId: customer.taxId || '' },
      shipTo: { addressLines: useShip ? customer.shippingAddress.lines : (customer.billingAddress.lines || []) },
      recipientEmail: customer.email || '',
    },
    lineItems, amounts: totals,
    notes: body.notes != null ? body.notes : org.defaults.notes,
    sentAt: null, sentTo: null, voidedAt: null,
    pdf: { file: null, updatedAt: null },
    ...store.envelope(),
  };
}

function nextInvoiceNumber(org) {
  const n = org.numbering.nextNumber || 1;
  org.numbering.nextNumber = n + 1;
  return `${org.numbering.invoicePrefix || 'INV-'}${n}`;
}

// Render the invoice to a vector PDF and save a copy under data/invoices/<org>/.
// Never throws (logs on failure).
async function saveInvoicePdf(db, org, inv) {
  try {
    const buf = await renderInvoicePdf(invoiceView(db, inv), settingsView(org));
    const file = store.pdfPathFor(inv.number, org.id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    inv.pdf = { file: path.basename(file), updatedAt: now() };
    return buf;
  } catch (e) {
    console.error('PDF render failed for', inv.number, e.message);
    return null;
  }
}

// Read the stored PDF, regenerating it if missing/stale.
async function getInvoicePdf(db, org, inv) {
  const file = store.pdfPathFor(inv.number, org.id);
  if (inv.pdf.file && fs.existsSync(file) && (!inv.pdf.updatedAt || inv.pdf.updatedAt >= inv.updatedAt)) {
    return fs.readFileSync(file);
  }
  const buf = await saveInvoicePdf(db, org, inv);
  store.save();
  return buf || fs.readFileSync(file);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function termsToDays(terms) { const m = /net\s*(\d+)/i.exec(terms || ''); return m ? Number(m[1]) : 15; }

// ─────────────────────────────────────────────────────────────
// Organizations
// ─────────────────────────────────────────────────────────────
function orgSummary(o) {
  return {
    id: o.id, name: o.profile.businessName || o.name, createdAt: o.createdAt,
    invoiceCount: store.rows('invoices', o.id).length, customerCount: store.rows('customers', o.id).length,
  };
}

app.get('/api/orgs', (req, res) => {
  const db = store.get();
  res.json({ currentOrgId: db.meta.currentOrgId, orgs: db.organizations.filter((o) => !o.archivedAt).map(orgSummary) });
});

app.post('/api/orgs', (req, res) => {
  const db = store.get();
  const name = (req.body.businessName || req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Business name is required' });
  const d = store.orgDefaults();
  const org = { id: store.id('org'), name, profile: d.profile, branding: d.branding, defaults: d.defaults, numbering: d.numbering, ...store.envelope() };
  org.profile.businessName = name;
  if (Array.isArray(req.body.addressLines)) org.profile.addressLines = req.body.addressLines;
  if (req.body.gstin != null) org.profile.taxId = req.body.gstin;
  if (req.body.currency) org.defaults.currency = req.body.currency;
  if (req.body.invoicePrefix) org.numbering.invoicePrefix = req.body.invoicePrefix;
  if (req.body.nextNumber != null) org.numbering.nextNumber = Number(req.body.nextNumber) || 1;
  if (req.body.defaultTerms) org.defaults.terms = req.body.defaultTerms;
  if (req.body.defaultTaxLabel) org.defaults.taxLabel = req.body.defaultTaxLabel;
  if (req.body.defaultNotes != null) org.defaults.notes = req.body.defaultNotes;
  db.organizations.push(org);
  db.meta.currentOrgId = org.id; // a freshly created org becomes the active one
  store.save();
  res.json(orgSummary(org));
});

app.post('/api/orgs/:id/activate', (req, res) => {
  const db = store.get();
  const org = db.organizations.find((o) => o.id === req.params.id && !o.archivedAt);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  db.meta.currentOrgId = org.id;
  store.save();
  res.json({ currentOrgId: db.meta.currentOrgId });
});

app.delete('/api/orgs/:id', (req, res) => {
  const db = store.get();
  const org = db.organizations.find((o) => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  org.archivedAt = now(); // soft delete — data is recoverable
  if (db.meta.currentOrgId === org.id) {
    const next = db.organizations.find((o) => !o.archivedAt);
    db.meta.currentOrgId = next ? next.id : null;
  }
  store.save();
  res.json({ ok: true, currentOrgId: db.meta.currentOrgId });
});

// ─────────────────────────────────────────────────────────────
// Settings (active org config, flat shape)
// ─────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  res.json(settingsView(org));
});

app.put('/api/settings', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  applySettings(org, req.body);
  store.save();
  res.json(settingsView(org));
});

// ─────────────────────────────────────────────────────────────
// Customers
// ─────────────────────────────────────────────────────────────
app.get('/api/customers', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  res.json(store.rows('customers', org.id).map(customerView));
});

app.post('/api/customers', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const c = {
    id: store.id('cust'), orgId: org.id,
    name: req.body.name || 'Untitled customer', email: req.body.email || '', ccEmail: req.body.ccEmail || '',
    taxId: req.body.gstin || '',
    billingAddress: { lines: req.body.billingAddressLines || [] },
    shippingAddress: { lines: req.body.shipToAddressLines || [] },
    contacts: [], ...store.envelope(),
  };
  store.get().customers.push(c);
  store.save();
  res.json(customerView(c));
});

app.put('/api/customers/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const c = store.rows('customers', org.id).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body;
  if (b.name !== undefined) c.name = b.name;
  if (b.email !== undefined) c.email = b.email;
  if (b.ccEmail !== undefined) c.ccEmail = b.ccEmail;
  if (b.gstin !== undefined) c.taxId = b.gstin;
  if (b.billingAddressLines !== undefined) c.billingAddress.lines = b.billingAddressLines;
  if (b.shipToAddressLines !== undefined) c.shippingAddress.lines = b.shipToAddressLines;
  c.updatedAt = now();
  store.save();
  res.json(customerView(c));
});

app.delete('/api/customers/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const c = store.rows('customers', org.id).find((x) => x.id === req.params.id);
  if (c) { c.archivedAt = now(); store.save(); }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Items catalog (API path kept as /products)
// ─────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  res.json(store.rows('items', org.id).map(itemView));
});

app.post('/api/products', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Item name required' });
  // De-dupe by name (case-insensitive): update the existing one instead.
  const existing = store.rows('items', org.id).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.defaultRate = Number(req.body.rate) || 0;
    existing.defaultTaxPercent = Number(req.body.taxPct) || 0;
    existing.updatedAt = now();
    store.save();
    return res.json(itemView(existing));
  }
  const p = { id: store.id('item'), orgId: org.id, name, defaultRate: Number(req.body.rate) || 0, defaultTaxPercent: Number(req.body.taxPct) || 0, taxRateId: null, ...store.envelope() };
  store.get().items.push(p);
  store.save();
  res.json(itemView(p));
});

app.put('/api/products/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const p = store.rows('items', org.id).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Item not found' });
  if (req.body.name !== undefined) p.name = req.body.name;
  if (req.body.rate !== undefined) p.defaultRate = Number(req.body.rate) || 0;
  if (req.body.taxPct !== undefined) p.defaultTaxPercent = Number(req.body.taxPct) || 0;
  p.updatedAt = now();
  store.save();
  res.json(itemView(p));
});

app.delete('/api/products/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const p = store.rows('items', org.id).find((x) => x.id === req.params.id);
  if (p) { p.archivedAt = now(); store.save(); }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Invoices
// ─────────────────────────────────────────────────────────────
function findInvoice(org, id) { return store.rows('invoices', org.id).find((i) => i.id === id); }

app.get('/api/invoices', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const list = store.rows('invoices', org.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((inv) => invoiceView(db, inv));
  res.json(list);
});

app.get('/api/invoices/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(invoiceView(store.get(), inv));
});

app.post('/api/invoices', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  try {
    const number = nextInvoiceNumber(org);
    const inv = buildStoredInvoice(org, req.body, number);
    db.invoices.push(inv);
    logActivity(db, org.id, 'invoice.created', 'invoice', inv.id, `Created ${inv.number}`);
    await saveInvoicePdf(db, org, inv);
    store.save();
    res.json(invoiceView(db, inv));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/invoices/:id', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (invoiceView(db, inv).status === 'paid') return res.status(400).json({ error: 'Paid invoices cannot be edited' });

  if (req.body.items) {
    inv.lineItems = req.body.items.map(lineItemFromApi);
    inv.amounts = computeTotals(inv.lineItems.map(lineItemToApi));
  }
  for (const k of ['invoiceDate', 'dueDate', 'terms', 'taxLabel', 'notes'])
    if (req.body[k] !== undefined) inv[k] = req.body[k];
  inv.updatedAt = now();
  await saveInvoicePdf(db, org, inv);
  store.save();
  res.json(invoiceView(db, inv));
});

app.delete('/api/invoices/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const inv = findInvoice(org, req.params.id);
  if (inv) { inv.archivedAt = now(); store.save(); }
  res.json({ ok: true });
});

// Mark paid → append a payment to the ledger (supports partial/multiple).
app.post('/api/invoices/:id/pay', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const payment = {
    id: store.id('pay'), orgId: org.id, invoiceId: inv.id,
    amount: req.body.amount != null ? round2(req.body.amount) : inv.amounts.total,
    currency: inv.currency, mode: req.body.mode || 'Bank Transfer',
    date: req.body.date || now().slice(0, 10), reference: req.body.reference || '', note: '',
    ...store.envelope(),
  };
  db.payments.push(payment);
  inv.updatedAt = now();
  logActivity(db, org.id, 'invoice.payment', 'invoice', inv.id, `Recorded ${payment.currency}${payment.amount} via ${payment.mode}`);
  await saveInvoicePdf(db, org, inv);
  store.save();
  res.json(invoiceView(db, inv));
});

// Undo payment(s) → archive the ledger entries for this invoice.
app.post('/api/invoices/:id/unpay', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  for (const p of paymentsForInvoice(db, inv.id)) { p.archivedAt = now(); p.updatedAt = now(); }
  inv.updatedAt = now();
  await saveInvoicePdf(db, org, inv);
  store.save();
  res.json(invoiceView(db, inv));
});

// List the ledger entries behind an invoice.
app.get('/api/invoices/:id/payments', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(paymentsForInvoice(store.get(), inv.id));
});

// Stream the stored PDF (regenerating if needed). ?download=1 forces attachment.
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const buf = await getInvoicePdf(db, org, inv);
    res.setHeader('Content-Type', 'application/pdf');
    const disp = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disp}; filename="${inv.number}.pdf"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send invoice via Gmail (attaches the locally-stored vector PDF).
app.post('/api/invoices/:id/send', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const inv = findInvoice(org, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const view = invoiceView(db, inv);
    const to = req.body.to || view.recipientEmail;
    if (!to) return res.status(400).json({ error: 'No recipient email set for this customer.' });
    const subject = req.body.subject || `Invoice ${inv.number} from ${org.profile.businessName}`;
    const cur = inv.currency || '$';
    const text =
      req.body.message ||
      `Dear ${view.billTo.name},\n\nPlease find attached invoice ${inv.number} for ${cur}${view.total.toFixed(2)}.\nDue date: ${inv.dueDate}.\n\nThank you,\n${org.profile.businessName}`;
    const html = text.replace(/\n/g, '<br>');

    const pdfBuf = req.body.pdfBase64 ? Buffer.from(req.body.pdfBase64, 'base64') : await getInvoicePdf(db, org, inv);

    const result = await google.sendInvoiceEmail({
      to, cc: req.body.cc, subject, text, html,
      pdfBase64: pdfBuf.toString('base64'), attachmentName: `${inv.number}.pdf`,
    });

    inv.sentAt = now();
    inv.sentTo = to;
    inv.updatedAt = now();
    logActivity(db, org.id, 'invoice.sent', 'invoice', inv.id, `Sent ${inv.number} to ${to}`);
    store.save();
    res.json({ ok: true, ...result, invoice: invoiceView(db, inv) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Recurring schedules
// ─────────────────────────────────────────────────────────────
app.get('/api/recurring', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  res.json(store.rows('recurringSchedules', org.id).map(recurringView));
});

app.post('/api/recurring', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const r = {
    id: store.id('rec'), orgId: org.id, customerId: req.body.customerId, active: req.body.active !== false,
    frequency: { unit: 'month', interval: 1, dayOfMonth: Number(req.body.dayOfMonth) || 1 },
    nextRunDate: req.body.nextRunDate || nextMonthlyDate(Number(req.body.dayOfMonth) || 1), lastGeneratedAt: null,
    template: {
      terms: req.body.terms || org.defaults.terms, taxLabel: req.body.taxLabel || org.defaults.taxLabel,
      notes: req.body.notes != null ? req.body.notes : org.defaults.notes,
      lineItems: (req.body.items || []).map(lineItemFromApi),
    },
    autoSend: Boolean(req.body.autoSend), ...store.envelope(),
  };
  store.get().recurringSchedules.push(r);
  store.save();
  res.json(recurringView(r));
});

app.put('/api/recurring/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const r = store.rows('recurringSchedules', org.id).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Schedule not found' });
  const b = req.body;
  if (b.active !== undefined) r.active = b.active;
  if (b.dayOfMonth !== undefined) r.frequency.dayOfMonth = Number(b.dayOfMonth) || 1;
  if (b.nextRunDate !== undefined) r.nextRunDate = b.nextRunDate;
  if (b.customerId !== undefined) r.customerId = b.customerId;
  if (b.terms !== undefined) r.template.terms = b.terms;
  if (b.taxLabel !== undefined) r.template.taxLabel = b.taxLabel;
  if (b.notes !== undefined) r.template.notes = b.notes;
  if (b.items !== undefined) r.template.lineItems = b.items.map(lineItemFromApi);
  if (b.autoSend !== undefined) r.autoSend = b.autoSend;
  r.updatedAt = now();
  store.save();
  res.json(recurringView(r));
});

app.delete('/api/recurring/:id', (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const r = store.rows('recurringSchedules', org.id).find((x) => x.id === req.params.id);
  if (r) { r.archivedAt = now(); store.save(); }
  res.json({ ok: true });
});

// Generate the invoice for a schedule right now (also used by the scheduler).
app.post('/api/recurring/:id/run', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const r = store.rows('recurringSchedules', org.id).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Schedule not found' });
  try {
    const inv = generateFromSchedule(db, org, r);
    await saveInvoicePdf(db, org, inv);
    store.save();
    res.json(invoiceView(db, inv));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function nextMonthlyDate(dayOfMonth) {
  const d0 = new Date();
  let y = d0.getFullYear();
  let m = d0.getMonth();
  if (d0.getDate() >= dayOfMonth) m += 1;
  const d = new Date(y, m, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dayOfMonth, last));
  return d.toISOString().slice(0, 10);
}

function bumpMonth(dateStr, dayOfMonth) {
  const d = new Date(dateStr + 'T00:00:00');
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(dayOfMonth, last));
  return next.toISOString().slice(0, 10);
}

function generateFromSchedule(db, org, r) {
  const invoiceDate = r.nextRunDate || now().slice(0, 10);
  const number = nextInvoiceNumber(org);
  const body = {
    customerId: r.customerId, invoiceDate, terms: r.template.terms,
    dueDate: addDays(invoiceDate, termsToDays(r.template.terms)), taxLabel: r.template.taxLabel,
    items: r.template.lineItems.map(lineItemToApi), notes: r.template.notes, recurringId: r.id,
  };
  const inv = buildStoredInvoice(org, body, number);
  db.invoices.push(inv);
  r.lastGeneratedAt = now();
  r.nextRunDate = bumpMonth(invoiceDate, r.frequency.dayOfMonth);
  r.updatedAt = now();
  logActivity(db, org.id, 'invoice.created', 'invoice', inv.id, `Recurring generated ${inv.number}`);
  return inv;
}

// Scheduler: every hour, materialize any schedule (across all orgs) whose nextRunDate has arrived.
async function runDueSchedules() {
  const db = store.get();
  const today = now().slice(0, 10);
  let changed = false;
  for (const org of db.organizations.filter((o) => !o.archivedAt)) {
    for (const r of store.rows('recurringSchedules', org.id)) {
      if (!r.active) continue;
      let guard = 0;
      while (r.nextRunDate && r.nextRunDate <= today && guard < 36) {
        try {
          const inv = generateFromSchedule(db, org, r);
          await saveInvoicePdf(db, org, inv);
          changed = true;
        } catch (e) {
          console.error('Recurring generation failed for', r.id, e.message);
          break;
        }
        guard++;
      }
    }
  }
  if (changed) store.save();
}

// ─────────────────────────────────────────────────────────────
// Excel export (invoices / customers / items, filtered)
// ─────────────────────────────────────────────────────────────
// Apply the date-range + status + customer filters to mapped invoice rows.
function filterInvoices(rows, { from, to, status, customerId }) {
  const today = now().slice(0, 10);
  return rows.filter((inv) => {
    if (from && (!inv.invoiceDate || inv.invoiceDate < from)) return false;
    if (to && (!inv.invoiceDate || inv.invoiceDate > to)) return false;
    if (customerId && inv.customerId !== customerId) return false;
    if (status && status !== 'all') {
      if (status === 'overdue') {
        if (!(inv.status !== 'paid' && inv.dueDate && inv.dueDate < today)) return false;
      } else if (inv.status !== status) return false;
    }
    return true;
  });
}

app.get('/api/export', async (req, res) => {
  const org = requireOrg(res); if (!org) return;
  const db = store.get();
  const datasets = String(req.query.datasets || 'invoices,customers,items').split(',').map((s) => s.trim()).filter(Boolean);
  const filters = { from: req.query.from || '', to: req.query.to || '', status: req.query.status || 'all', customerId: req.query.customerId || '' };
  try {
    let invoices = store.rows('invoices', org.id).sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1)).map((i) => invoiceView(db, i));
    invoices = filterInvoices(invoices, filters);
    const customers = store.rows('customers', org.id).map(customerView);
    const items = store.rows('items', org.id).map(itemView);
    const settings = settingsView(org);
    const buf = await buildWorkbook({ datasets, invoices, customers, items, settings });
    const safeName = (settings.businessName || 'export').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const fname = `${safeName}-export-${now().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Google auth (global — one Gmail account sends for the active org)
// ─────────────────────────────────────────────────────────────
app.get('/api/google/status', (req, res) => res.json(google.status()));

app.get('/auth/google', (req, res) => {
  if (!google.isConfigured())
    return res.status(400).send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  res.redirect(google.authUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error);
    await google.handleCallback(req.query.code);
    res.send(
      '<html><body style="font-family:sans-serif;padding:40px"><h2>Google account connected ✓</h2>' +
        '<p>You can close this tab and return to the app.</p>' +
        '<script>setTimeout(()=>{window.close()},800)</script></body></html>'
    );
  } catch (e) {
    res.status(400).send('Google connection failed: ' + e.message);
  }
});

app.post('/api/google/disconnect', (req, res) => {
  google.disconnect();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Static frontend
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Invoicing tool running at http://localhost:${PORT}`);
  runDueSchedules();
  setInterval(runDueSchedules, 60 * 60 * 1000); // hourly
});
