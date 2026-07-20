require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const storage = require('./storage');
const google = require('./google');
const { renderInvoicePdf } = require('./pdf');
const { buildWorkbook } = require('./export');
const { computeTotals, amountToWords, round2 } = require('./invoice');
const emailTemplates = require('./emailTemplates');

const app = express();
app.use(express.json({ limit: '15mb' })); // logos arrive as base64 data URLs

// ─────────────────────────────────────────────────────────────
// Storage ⇄ API mapping layer
//
// Storage uses the normalized model in SCHEMA.md; the API keeps its existing flat
// shapes. These translators are the single place that bridges the two, so the schema
// can grow without touching the frontend or PDF renderer.
// ─────────────────────────────────────────────────────────────
const now = () => db.nowISO();

// Line item: stored {quantity, taxPercent} ⇄ API {qty, taxPct}.
function lineItemToApi(li) { return { description: li.description, qty: li.quantity, rate: li.rate, taxPct: li.taxPercent }; }
function lineItemFromApi(it) {
  return { id: db.id('li'), description: it.description || '', quantity: Number(it.qty) || 0, rate: Number(it.rate) || 0, taxPercent: Number(it.taxPct) || 0 };
}

// Org config ⇄ flat "settings" object the frontend uses.
function settingsView(org) {
  return {
    businessName: org.profile.businessName, addressLines: org.profile.addressLines, gstin: org.profile.taxId,
    currency: org.defaults.currency, logo: org.branding.logo, logoBg: org.branding.logoBackground,
    invoicePrefix: org.numbering.invoicePrefix, nextNumber: org.numbering.nextNumber,
    defaultTerms: org.defaults.terms, defaultTaxLabel: org.defaults.taxLabel, defaultNotes: org.defaults.notes,
    reminderOffsets: org.defaults.reminderOffsets || [0],
  };
}

// Mutates the in-memory org record; the caller persists it with db.orgs.save().
// The logo is the one field that needs I/O: it arrives as a data URL and is
// written to Storage, leaving only a path on the row.
async function applySettings(org, body) {
  const put = (obj, key, val) => { if (val !== undefined) obj[key] = val; };
  put(org.profile, 'businessName', body.businessName);
  put(org.profile, 'addressLines', body.addressLines);
  put(org.profile, 'taxId', body.gstin);
  put(org.defaults, 'currency', body.currency);
  if (body.logo !== undefined) {
    if (!body.logo) {
      org.branding.logoPath = null;
      org.branding.logo = null;
    } else if (body.logo.startsWith('data:')) {
      const p = await db.putLogo(org.id, body.logo);
      if (p !== undefined) { org.branding.logoPath = p; org.branding.logo = body.logo; }
    }
    // An unchanged non-data-URL value means "leave the existing logo alone".
  }
  put(org.branding, 'logoBackground', body.logoBg);
  put(org.numbering, 'invoicePrefix', body.invoicePrefix);
  if (body.nextNumber !== undefined) org.numbering.nextNumber = Number(body.nextNumber) || 1;
  put(org.defaults, 'terms', body.defaultTerms);
  put(org.defaults, 'taxLabel', body.defaultTaxLabel);
  put(org.defaults, 'notes', body.defaultNotes);
  if (body.reminderOffsets !== undefined) org.defaults.reminderOffsets = sanitizeOffsets(body.reminderOffsets);
  if (org.profile.businessName) org.name = org.profile.businessName;
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

// Invoice view. Paid-state comes from the invoice_balances view rather than
// being recomputed here, but the derived-status precedence is unchanged:
// void → paid → sent → draft.
function invoiceView(inv) {
  const { amountPaid, balanceDue, isPaid } = inv.balance;
  const total = inv.amounts.total;
  const status = inv.voidedAt ? 'void' : isPaid ? 'paid' : inv.sentAt ? 'sent' : 'draft';
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
    amountPaid: round2(amountPaid), balanceDue: round2(balanceDue), amountInWords: amountToWords(total),
    payment: inv.latestPayment,
    sentAt: inv.sentAt, sentTo: inv.sentTo, recurringId: inv.recurringScheduleId,
    createdAt: inv.createdAt, updatedAt: inv.updatedAt,
    pdfFile: inv.pdf.file, pdfUpdatedAt: inv.pdf.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Org scoping — every data route works inside the active org
// ─────────────────────────────────────────────────────────────
async function requireOrg(res) {
  const org = await db.activeOrg();
  if (!org) { res.status(400).json({ error: 'No organization selected. Create one first.' }); return null; }
  return org;
}

// Every route body now performs I/O, so a thrown error must not hang the
// request or take the process down. This wrapper is the single place that
// turns an unexpected failure into a 500.
function route(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      console.error(`${req.method} ${req.path} failed:`, e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
  };
}

// ─────────────────────────────────────────────────────────────
// Invoice building / numbering / PDF
// ─────────────────────────────────────────────────────────────
async function buildStoredInvoice(org, body, number) {
  const customer = await db.customers.byId(org.id, body.customerId);
  if (!customer) throw new Error('Customer not found');
  const lineItems = (body.items || []).map(lineItemFromApi);
  const totals = computeTotals(lineItems.map(lineItemToApi));
  const useShip = body.shipToSameAsBilling === false && customer.shippingAddress.lines.length;
  return {
    id: db.id('inv'), orgId: org.id, number,
    customerId: customer.id, recurringScheduleId: body.recurringId || null,
    invoiceDate: body.invoiceDate, dueDate: body.dueDate, terms: body.terms || org.defaults.terms,
    currency: org.defaults.currency, taxLabel: body.taxLabel || org.defaults.taxLabel,
    snapshot: {
      // logoPath is what persists; logo (the data URL) is re-resolved on read.
      seller: { businessName: org.profile.businessName, addressLines: org.profile.addressLines, taxId: org.profile.taxId, logoPath: org.branding.logoPath || null, logo: org.branding.logo || null, logoBackground: org.branding.logoBackground || 'light' },
      billTo: { name: customer.name, addressLines: customer.billingAddress.lines || [], taxId: customer.taxId || '' },
      shipTo: { addressLines: useShip ? customer.shippingAddress.lines : (customer.billingAddress.lines || []) },
      recipientEmail: customer.email || '',
    },
    lineItems, amounts: totals,
    notes: body.notes != null ? body.notes : org.defaults.notes,
    sentAt: null, sentTo: null, voidedAt: null,
    pdf: { file: null, path: null, updatedAt: null },
    balance: { amountPaid: 0, balanceDue: totals.total, isPaid: false },
    latestPayment: null,
    createdAt: now(), updatedAt: now(), archivedAt: null, metadata: {},
  };
}

// Snapshots persist a logo path, not the bytes — strip the inline copy so the
// stored row stays small (it was ~45KB of base64 per invoice).
function snapshotForStorage(snapshot) {
  const s = JSON.parse(JSON.stringify(snapshot));
  if (s.seller) delete s.seller.logo;
  return s;
}

function pdfPathFor(orgId, number) {
  const safeNum = String(number).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `invoices/${orgId}/${safeNum}.pdf`;
}

// Render the invoice to a vector PDF and store it. Never throws (logs on failure).
async function saveInvoicePdf(org, inv) {
  try {
    const buf = await renderInvoicePdf(invoiceView(inv), settingsView(org));
    const p = pdfPathFor(org.id, inv.number);
    await storage.put(p, buf, 'application/pdf');
    await db.invoices.setPdf(inv.id, p);
    inv.pdf = { file: p.split('/').pop(), path: p, updatedAt: now() };
    return buf;
  } catch (e) {
    console.error('PDF render failed for', inv.number, e.message);
    return null;
  }
}

// Read the stored PDF, regenerating if missing or stale.
async function getInvoicePdf(org, inv) {
  if (inv.pdf.path && (!inv.pdf.updatedAt || inv.pdf.updatedAt >= inv.updatedAt)) {
    const buf = await storage.get(inv.pdf.path);
    if (buf) return buf;
  }
  const buf = await saveInvoicePdf(org, inv);
  if (buf) return buf;
  throw new Error('Could not render or retrieve the invoice PDF.');
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
async function orgSummary(o) {
  const counts = await db.orgs.counts(o.id);
  return { id: o.id, name: o.profile.businessName || o.name, createdAt: o.createdAt, ...counts };
}

app.get('/api/orgs', route(async (req, res) => {
  const [currentOrgId, list] = await Promise.all([db.appState.currentOrgId(), db.orgs.listActive()]);
  const orgs = await Promise.all(list.map(orgSummary));
  // currentOrgId must point at a live org; fall back the way activeOrg() does.
  const effective = orgs.some((o) => o.id === currentOrgId) ? currentOrgId : (orgs[0] ? orgs[0].id : null);
  res.json({ currentOrgId: effective, orgs });
}));

app.post('/api/orgs', route(async (req, res) => {
  const name = (req.body.businessName || req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Business name is required' });
  const org = await db.orgs.create({
    name, businessName: name,
    addressLines: Array.isArray(req.body.addressLines) ? req.body.addressLines : [],
    taxId: req.body.gstin != null ? req.body.gstin : '',
    currency: req.body.currency, invoicePrefix: req.body.invoicePrefix,
    nextNumber: req.body.nextNumber != null ? Number(req.body.nextNumber) || 1 : 1,
    terms: req.body.defaultTerms, taxLabel: req.body.defaultTaxLabel,
    notes: req.body.defaultNotes != null ? req.body.defaultNotes : '',
  });
  await db.appState.setCurrentOrg(org.id); // a freshly created org becomes active
  res.json(await orgSummary(org));
}));

app.post('/api/orgs/:id/activate', route(async (req, res) => {
  const org = await db.orgs.byId(req.params.id);
  if (!org || org.archivedAt) return res.status(404).json({ error: 'Organization not found' });
  await db.appState.setCurrentOrg(org.id);
  res.json({ currentOrgId: org.id });
}));

app.delete('/api/orgs/:id', route(async (req, res) => {
  const org = await db.orgs.byId(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  await db.orgs.archive(org.id); // soft delete — data is recoverable
  const current = await db.appState.currentOrgId();
  if (current === org.id) {
    const next = (await db.orgs.listActive())[0];
    await db.appState.setCurrentOrg(next ? next.id : null);
  }
  res.json({ ok: true, currentOrgId: await db.appState.currentOrgId() });
}));

// ─────────────────────────────────────────────────────────────
// Settings (active org config, flat shape)
// ─────────────────────────────────────────────────────────────
app.get('/api/settings', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  res.json(settingsView(org));
}));

app.put('/api/settings', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  await applySettings(org, req.body);
  const saved = await db.orgs.save(org);
  res.json(settingsView(saved));
}));

// ─────────────────────────────────────────────────────────────
// Customers
// ─────────────────────────────────────────────────────────────
app.get('/api/customers', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  res.json((await db.customers.list(org.id)).map(customerView));
}));

app.post('/api/customers', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const c = await db.customers.create(org.id, {
    name: req.body.name, email: req.body.email, ccEmail: req.body.ccEmail, taxId: req.body.gstin,
    billingAddressLines: req.body.billingAddressLines, shipToAddressLines: req.body.shipToAddressLines,
  });
  res.json(customerView(c));
}));

app.put('/api/customers/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const b = req.body;
  const c = await db.customers.update(org.id, req.params.id, {
    name: b.name, email: b.email, ccEmail: b.ccEmail, taxId: b.gstin,
    billingAddressLines: b.billingAddressLines, shipToAddressLines: b.shipToAddressLines,
  });
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json(customerView(c));
}));

app.delete('/api/customers/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  await db.customers.archive(org.id, req.params.id);
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────
// Items catalog (API path kept as /products)
// ─────────────────────────────────────────────────────────────
app.get('/api/products', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  res.json((await db.items.list(org.id)).map(itemView));
}));

app.post('/api/products', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Item name required' });
  // De-dupe by name (case-insensitive): update the existing one instead.
  const existing = await db.items.byName(org.id, name);
  if (existing) {
    const updated = await db.items.update(org.id, existing.id, { rate: req.body.rate, taxPct: req.body.taxPct });
    return res.json(itemView(updated));
  }
  res.json(itemView(await db.items.create(org.id, { name, rate: req.body.rate, taxPct: req.body.taxPct })));
}));

app.put('/api/products/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const p = await db.items.update(org.id, req.params.id, { name: req.body.name, rate: req.body.rate, taxPct: req.body.taxPct });
  if (!p) return res.status(404).json({ error: 'Item not found' });
  res.json(itemView(p));
}));

app.delete('/api/products/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  await db.items.archive(org.id, req.params.id);
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────
// Invoices
// ─────────────────────────────────────────────────────────────
app.get('/api/invoices', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  res.json((await db.invoices.list(org.id)).map(invoiceView));
}));

app.get('/api/invoices/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(invoiceView(inv));
}));

app.post('/api/invoices', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  try {
    // Numbering + insert + activity commit together, so a failure can't burn an
    // invoice number or leave an invoice without its line items.
    const inv = await db.tx(async (client) => {
      const number = await db.orgs.nextInvoiceNumber(org.id, client);
      const rec = await buildStoredInvoice(org, req.body, number);
      const stored = { ...rec, snapshot: snapshotForStorage(rec.snapshot) };
      await db.invoices.create(stored, client);
      await db.activity.log(org.id, 'invoice.created', 'invoice', rec.id, `Created ${rec.number}`, client);
      return rec;
    });
    await saveInvoicePdf(org, inv);
    res.json(invoiceView(inv));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.put('/api/invoices/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (invoiceView(inv).status === 'paid') return res.status(400).json({ error: 'Paid invoices cannot be edited' });

  let lineItems = null;
  let amounts = null;
  if (req.body.items) {
    lineItems = req.body.items.map(lineItemFromApi);
    amounts = computeTotals(lineItems.map(lineItemToApi));
  }
  const patch = {};
  for (const k of ['invoiceDate', 'dueDate', 'terms', 'taxLabel', 'notes'])
    if (req.body[k] !== undefined) patch[k] = req.body[k];

  await db.invoices.update(org.id, inv.id, patch, lineItems, amounts);
  const fresh = await db.invoices.byId(org.id, inv.id);
  await saveInvoicePdf(org, fresh);
  res.json(invoiceView(await db.invoices.byId(org.id, inv.id)));
}));

app.delete('/api/invoices/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  await db.invoices.archive(org.id, req.params.id);
  res.json({ ok: true });
}));

// Mark paid → append a payment to the ledger (supports partial/multiple).
app.post('/api/invoices/:id/pay', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  // Default to what is still outstanding, not the full total — otherwise a second
  // "mark paid" on a partially-paid invoice re-records the whole amount, inflating
  // amountPaid and the ledger. balanceDue comes from the invoice_balances view.
  const balanceDue = round2(inv.balance.balanceDue);
  if (balanceDue <= 0) return res.status(400).json({ error: 'Invoice is already fully paid' });
  const amount = req.body.amount != null ? round2(req.body.amount) : balanceDue;
  if (!(amount > 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  if (amount > balanceDue) return res.status(400).json({ error: `Payment exceeds balance due (${inv.currency}${balanceDue})` });

  const payment = await db.payments.add(org.id, inv.id, {
    amount,
    currency: inv.currency, mode: req.body.mode || 'Bank Transfer',
    date: req.body.date || now().slice(0, 10), reference: req.body.reference || '', note: '',
  });
  await db.invoices.touch(inv.id);
  await db.activity.log(org.id, 'invoice.payment', 'invoice', inv.id, `Recorded ${payment.currency}${payment.amount} via ${payment.mode}`);

  const updated = await db.invoices.byId(org.id, inv.id);
  // Fully paid → no further reminders should go out.
  if (invoiceView(updated).status === 'paid') {
    const n = await db.reminders.cancelPendingFor(inv.id);
    if (n) await db.activity.log(org.id, 'reminder.cancelled', 'invoice', inv.id, `Cancelled ${n} pending reminder(s) for ${inv.number}`);
  }
  await saveInvoicePdf(org, updated);
  res.json(invoiceView(await db.invoices.byId(org.id, inv.id)));
}));

// Undo payment(s) → archive the ledger entries for this invoice.
app.post('/api/invoices/:id/unpay', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  await db.payments.archiveForInvoice(inv.id);
  await db.invoices.touch(inv.id);
  const updated = await db.invoices.byId(org.id, inv.id);
  await saveInvoicePdf(org, updated);
  res.json(invoiceView(await db.invoices.byId(org.id, inv.id)));
}));

// List the ledger entries behind an invoice.
app.get('/api/invoices/:id/payments', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(await db.payments.forInvoice(inv.id));
}));

// Stream the stored PDF (regenerating if needed). ?download=1 forces attachment.
app.get('/api/invoices/:id/pdf', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const buf = await getInvoicePdf(org, inv);
    res.setHeader('Content-Type', 'application/pdf');
    const disp = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disp}; filename="${inv.number}.pdf"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// Default email content for the send dialog (subject/body + org default reminders).
app.get('/api/invoices/:id/email-defaults', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const tpl = emailTemplates.invoiceEmail(org, invoiceView(inv));
  res.json({ subject: tpl.subject, message: tpl.text, reminderOffsets: org.defaults.reminderOffsets || [0] });
}));

// Send invoice via Gmail (attaches the stored vector PDF).
app.post('/api/invoices/:id/send', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const view = invoiceView(inv);
    const to = req.body.to || view.recipientEmail;
    if (!to) return res.status(400).json({ error: 'No recipient email set for this customer.' });

    const tpl = emailTemplates.invoiceEmail(org, view);
    const subject = req.body.subject || tpl.subject;
    const text = req.body.message || tpl.text;
    // Untouched default message → full styled template; edited → branded plain rendering.
    const html = text === tpl.text ? tpl.html : emailTemplates.plainHtml(text);

    const pdfBuf = req.body.pdfBase64 ? Buffer.from(req.body.pdfBase64, 'base64') : await getInvoicePdf(org, inv);

    const result = await google.sendInvoiceEmail({
      to, cc: req.body.cc, subject, text, html,
      pdfBase64: pdfBuf.toString('base64'), attachmentName: `${inv.number}.pdf`,
      fromName: org.profile.businessName,
    });

    await db.invoices.markSent(inv.id, to);
    await db.activity.log(org.id, 'invoice.sent', 'invoice', inv.id, `Sent ${inv.number} to ${to}`);

    const offsets = Array.isArray(req.body.reminderOffsets) ? req.body.reminderOffsets : org.defaults.reminderOffsets || [0];
    const created = await createReminders(org, inv, offsets);
    if (created.length)
      await db.activity.log(org.id, 'reminder.scheduled', 'invoice', inv.id, `Scheduled ${created.length} reminder(s) for ${inv.number}`);

    res.json({
      ok: true, ...result,
      invoice: invoiceView(await db.invoices.byId(org.id, inv.id)),
      reminders: (await db.reminders.forInvoice(inv.id)).map(reminderView),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ─────────────────────────────────────────────────────────────
// Payment reminders (sent by the hourly scheduler via Gmail)
// ─────────────────────────────────────────────────────────────
function sanitizeOffsets(list) {
  const offs = (Array.isArray(list) ? list : []).map(Number).filter(Number.isFinite).map(Math.trunc);
  return [...new Set(offs)].sort((a, b) => a - b);
}

function reminderView(r) {
  return {
    id: r.id, invoiceId: r.invoiceId, offsetDays: r.offsetDays, dueOn: r.dueOn,
    status: r.status, sentAt: r.sentAt, sentTo: r.sentTo, error: r.error || null, createdAt: r.createdAt,
  };
}

// offsetDays: negative = before due date, 0 = on it, positive = after.
// Skips offsets whose date is already past; the partial unique index in the
// schema rejects a duplicate pending date, which surfaces as a null insert.
async function createReminders(org, inv, offsets) {
  const today = now().slice(0, 10);
  const created = [];
  for (const offsetDays of sanitizeOffsets(offsets)) {
    const dueOn = addDays(inv.dueDate, offsetDays);
    if (dueOn < today) continue;
    const rem = await db.reminders.create(org.id, inv.id, offsetDays, dueOn);
    if (rem) created.push(rem);
  }
  return created;
}

app.get('/api/invoices/:id/reminders', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json((await db.reminders.forInvoice(inv.id)).map(reminderView));
}));

app.post('/api/invoices/:id/reminders', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const inv = await db.invoices.byId(org.id, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const created = await createReminders(org, inv, [req.body.offsetDays]);
  if (!created.length) return res.status(400).json({ error: 'Reminder date is in the past or already scheduled.' });
  await db.activity.log(org.id, 'reminder.scheduled', 'invoice', inv.id, `Scheduled reminder for ${inv.number} on ${created[0].dueOn}`);
  res.json((await db.reminders.forInvoice(inv.id)).map(reminderView));
}));

app.delete('/api/reminders/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const rem = await db.reminders.byId(org.id, req.params.id);
  if (!rem) return res.status(404).json({ error: 'Reminder not found' });
  if (rem.status === 'pending') await db.reminders.cancel(rem.id);
  res.json((await db.reminders.forInvoice(rem.invoiceId)).map(reminderView));
}));

// ─────────────────────────────────────────────────────────────
// Recurring schedules
// ─────────────────────────────────────────────────────────────
app.get('/api/recurring', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  res.json((await db.recurring.list(org.id)).map(recurringView));
}));

app.post('/api/recurring', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const r = await db.recurring.create(org.id, {
    customerId: req.body.customerId, active: req.body.active,
    dayOfMonth: Number(req.body.dayOfMonth) || 1,
    nextRunDate: req.body.nextRunDate || nextMonthlyDate(Number(req.body.dayOfMonth) || 1),
    terms: req.body.terms || org.defaults.terms,
    taxLabel: req.body.taxLabel || org.defaults.taxLabel,
    notes: req.body.notes != null ? req.body.notes : org.defaults.notes,
    autoSend: req.body.autoSend,
  }, (req.body.items || []).map(lineItemFromApi));
  res.json(recurringView(r));
}));

app.put('/api/recurring/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const existing = await db.recurring.byId(org.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  const b = req.body;
  const r = await db.recurring.update(org.id, req.params.id, {
    active: b.active, dayOfMonth: b.dayOfMonth === undefined ? undefined : Number(b.dayOfMonth) || 1,
    nextRunDate: b.nextRunDate, customerId: b.customerId, terms: b.terms, taxLabel: b.taxLabel,
    notes: b.notes, autoSend: b.autoSend,
  }, b.items !== undefined ? b.items.map(lineItemFromApi) : null);
  res.json(recurringView(r));
}));

app.delete('/api/recurring/:id', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  await db.recurring.archive(org.id, req.params.id);
  res.json({ ok: true });
}));

// Generate the invoice for a schedule right now (also used by the scheduler).
app.post('/api/recurring/:id/run', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const r = await db.recurring.byId(org.id, req.params.id);
  if (!r) return res.status(404).json({ error: 'Schedule not found' });
  try {
    const inv = await generateFromSchedule(org, r);
    await saveInvoicePdf(org, inv);
    res.json(invoiceView(inv));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

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

// Mint an invoice from a schedule and advance its next run date — atomically, so
// a mid-run failure can't generate an invoice without moving the schedule on
// (which would duplicate it next pass) or vice versa.
async function generateFromSchedule(org, r) {
  const invoiceDate = r.nextRunDate || now().slice(0, 10);
  return db.tx(async (client) => {
    const number = await db.orgs.nextInvoiceNumber(org.id, client);
    const body = {
      customerId: r.customerId, invoiceDate, terms: r.template.terms,
      dueDate: addDays(invoiceDate, termsToDays(r.template.terms)), taxLabel: r.template.taxLabel,
      items: r.template.lineItems.map(lineItemToApi), notes: r.template.notes, recurringId: r.id,
    };
    const rec = await buildStoredInvoice(org, body, number);
    await db.invoices.create({ ...rec, snapshot: snapshotForStorage(rec.snapshot) }, client);
    await db.recurring.advance(r.id, bumpMonth(invoiceDate, r.frequency.dayOfMonth), client);
    await db.activity.log(org.id, 'invoice.created', 'invoice', rec.id, `Recurring generated ${rec.number}`, client);
    return rec;
  });
}

// Scheduler: every hour, materialize any schedule (across all orgs) whose nextRunDate has arrived.
async function runDueSchedules() {
  const today = now().slice(0, 10);
  try {
    const due = await db.recurring.due(today);
    for (const r of due) {
      const org = await db.orgs.byId(r.orgId);
      if (!org || org.archivedAt) continue;
      let guard = 0;
      let schedule = r;
      // Catch-up loop for server downtime, capped like the original.
      while (schedule.nextRunDate && schedule.nextRunDate <= today && guard < 36) {
        try {
          const inv = await generateFromSchedule(org, schedule);
          await saveInvoicePdf(org, inv);
        } catch (e) {
          console.error('Recurring generation failed for', schedule.id, e.message);
          break;
        }
        schedule = await db.recurring.byId(org.id, schedule.id);
        if (!schedule) break;
        guard++;
      }
    }
  } catch (e) {
    console.error('runDueSchedules failed:', e.message);
  }
}

// Days between two YYYY-MM-DD dates.
function diffDays(fromDate, toDate) {
  return Math.round((new Date(toDate + 'T00:00:00Z') - new Date(fromDate + 'T00:00:00Z')) / 86400000);
}

// Scheduler: send due payment reminders via Gmail.
async function runDueReminders() {
  if (!google.status().connected) return; // reminders stay pending until Gmail is connected
  const today = now().slice(0, 10);
  try {
    for (const rem of await db.reminders.due(today)) {
      const inv = await db.invoices.byIdAnyOrg(rem.invoiceId);
      const view = inv && !inv.voidedAt ? invoiceView(inv) : null;
      if (!view || view.status === 'paid') {
        await db.reminders.cancel(rem.id);
        continue;
      }
      const org = await db.orgs.byId(rem.orgId);
      if (!org || org.archivedAt) continue;

      const to = view.recipientEmail || inv.sentTo;
      if (!to) {
        await db.reminders.markError(rem.id, 'No recipient email set for this customer.');
        continue;
      }
      try {
        // Tone uses actual lateness today (not the planned offset) so catch-up
        // sends after downtime still read correctly.
        const tpl = emailTemplates.reminderEmail(org, view, diffDays(inv.dueDate, today));
        const customer = await db.customers.byId(org.id, inv.customerId);
        const pdfBuf = await getInvoicePdf(org, inv);
        await google.sendInvoiceEmail({
          to, cc: (customer && customer.ccEmail) || undefined,
          subject: tpl.subject, text: tpl.text, html: tpl.html,
          pdfBase64: pdfBuf.toString('base64'), attachmentName: `${inv.number}.pdf`,
          fromName: org.profile.businessName,
        });
        await db.reminders.markSent(rem.id, to);
        await db.activity.log(org.id, 'reminder.sent', 'invoice', inv.id, `Payment reminder sent for ${inv.number} to ${to}`);
      } catch (e) {
        console.error('Reminder send failed for', rem.id, e.message);
        await db.reminders.markError(rem.id, e.message); // retried on the next hourly pass
      }
    }
  } catch (e) {
    console.error('runDueReminders failed:', e.message);
  }
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

app.get('/api/export', route(async (req, res) => {
  const org = await requireOrg(res); if (!org) return;
  const datasets = String(req.query.datasets || 'invoices,customers,items').split(',').map((s) => s.trim()).filter(Boolean);
  const filters = { from: req.query.from || '', to: req.query.to || '', status: req.query.status || 'all', customerId: req.query.customerId || '' };
  try {
    let invoices = (await db.invoices.list(org.id))
      .sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1))
      .map(invoiceView);
    invoices = filterInvoices(invoices, filters);
    const customers = (await db.customers.list(org.id)).map(customerView);
    const items = (await db.items.list(org.id)).map(itemView);
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
}));

// ─────────────────────────────────────────────────────────────
// Google auth (global — one Gmail account sends for the active org)
// ─────────────────────────────────────────────────────────────
app.get('/api/google/status', (req, res) => res.json(google.status()));

app.get('/auth/google', (req, res) => {
  if (!google.isConfigured())
    return res.status(400).send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  res.redirect(google.authUrl());
});

app.get('/auth/google/callback', route(async (req, res) => {
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
}));

app.post('/api/google/disconnect', route(async (req, res) => {
  await google.disconnect();
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────
// Static frontend
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 4000;

// Verify the database and Storage are reachable before accepting traffic — a bad
// DATABASE_URL should fail loudly at boot, not on the first request.
async function start() {
  try {
    const info = await db.connect();
    console.log(`Connected to Postgres (${info.db})`);
  } catch (e) {
    console.error('Could not connect to the database:', e.message);
    console.error('Check DATABASE_URL in .env');
    process.exit(1);
  }
  if (storage.isLocal()) {
    console.warn('Supabase Storage not configured — using local filesystem for PDFs and logos.');
  }
  await storage.ensureBucket();
  await google.load();

  app.listen(PORT, () => {
    console.log(`Invoicing tool running at http://localhost:${PORT}`);
    runDueSchedules().then(runDueReminders);
    setInterval(() => runDueSchedules().then(runDueReminders), 60 * 60 * 1000); // hourly
  });
}

start();
