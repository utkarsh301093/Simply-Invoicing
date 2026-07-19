// Characterization test: drives a full business flow through the HTTP API and
// snapshots every response to test/golden/api-flow.json.
//
// This is a *behavioral contract*, not a correctness spec. It records what the
// app does today so the Supabase migration can prove it changed nothing. If a
// diff shows up here, either the rewrite broke something or the behavior change
// was intentional — decide which, then re-record with UPDATE_GOLDEN=1.
//
//   node --test test/                  # verify against the golden file
//   UPDATE_GOLDEN=1 node --test test/  # re-record
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, makeNormalizer } = require('./harness');

const GOLDEN = path.join(__dirname, 'golden', 'api-flow.json');

// Fixed far-future dates keep the snapshot stable: reminder scheduling refuses
// past dates, so relative-to-today dates would make the golden rot.
const INVOICE_DATE = '2030-01-01';
const DUE_DATE = '2030-01-16';

test('API flow characterization', async (t) => {
  const server = await startServer();
  const normalize = makeNormalizer();
  const transcript = [];

  // Record a step under a stable label so a diff points at the failing action.
  async function step(label, method, urlPath, body) {
    const res = await server.api(method, urlPath, body);
    transcript.push({ step: label, request: { method, path: normalize(urlPath) }, status: res.status, response: normalize(res.body) });
    return res.body;
  }

  try {
    // ── Organizations ──
    await step('orgs: empty on first boot', 'GET', '/api/orgs');
    const org = await step('orgs: create', 'POST', '/api/orgs', {
      businessName: 'Acme Consulting',
      addressLines: ['12 Example Road', 'Bengaluru 560001'],
      gstin: '29ABCDE1234F1Z5',
      currency: '₹',
    });

    // ── Settings ──
    await step('settings: defaults after org create', 'GET', '/api/settings');
    await step('settings: update prefix and reminder offsets', 'PUT', '/api/settings', {
      invoicePrefix: 'ACME-',
      nextNumber: 1,
      defaultTerms: 'Net 15',
      defaultTaxLabel: 'IGST',
      reminderOffsets: [-3, 0, 7],
    });
    // Offsets should be de-duped, truncated and sorted by sanitizeOffsets().
    await step('settings: offsets are sanitized', 'PUT', '/api/settings', {
      reminderOffsets: [7, -3, 0, 7, 2.9, 'nonsense'],
    });

    // ── Customers ──
    const customer = await step('customers: create', 'POST', '/api/customers', {
      name: 'Globex Ltd',
      email: 'ap@globex.example',
      ccEmail: 'finance@globex.example',
      gstin: '27FGHIJ5678K1Z2',
      billingAddressLines: ['9 Industrial Way', 'Pune 411001'],
      shipToAddressLines: ['Warehouse 4', 'Pune 411002'],
    });
    await step('customers: update', 'PUT', `/api/customers/${customer.id}`, { name: 'Globex Limited' });
    await step('customers: list', 'GET', '/api/customers');

    // ── Items catalog ──
    await step('products: create', 'POST', '/api/products', { name: 'Consulting hour', rate: 2500, taxPct: 18 });
    await step('products: duplicate name updates in place', 'POST', '/api/products', { name: 'consulting HOUR', rate: 3000, taxPct: 18 });
    await step('products: create second', 'POST', '/api/products', { name: 'Setup fee', rate: 10000, taxPct: 18 });
    await step('products: list', 'GET', '/api/products');
    await step('products: name is required', 'POST', '/api/products', { name: '  ' });

    // ── Invoices ──
    const invoice = await step('invoices: create', 'POST', '/api/invoices', {
      customerId: customer.id,
      invoiceDate: INVOICE_DATE,
      dueDate: DUE_DATE,
      terms: 'Net 15',
      taxLabel: 'IGST',
      items: [
        { description: 'Consulting hour', qty: 10, rate: 2500, taxPct: 18 },
        { description: 'Setup fee', qty: 1, rate: 10000, taxPct: 18 },
      ],
      notes: 'Thanks for your business.',
    });
    await step('invoices: fetch one', 'GET', `/api/invoices/${invoice.id}`);
    await step('invoices: edit line items recomputes totals', 'PUT', `/api/invoices/${invoice.id}`, {
      items: [{ description: 'Consulting hour', qty: 12, rate: 2500, taxPct: 18 }],
    });
    await step('invoices: pdf renders', 'GET', `/api/invoices/${invoice.id}/pdf`);
    await step('invoices: email defaults', 'GET', `/api/invoices/${invoice.id}/email-defaults`);
    await step('invoices: unknown id is 404', 'GET', '/api/invoices/inv_doesnotexist');
    // A rejected create must NOT consume an invoice number. Under the JSON store
    // it did: the counter was bumped before the customer was validated, so this
    // failed request burned ACME-2 and the next invoice jumped to ACME-3.
    // Numbering and insert now share a transaction, so the sequence stays
    // gap-free — which tax authorities in several jurisdictions require.
    await step('invoices: create with unknown customer fails', 'POST', '/api/invoices', {
      customerId: 'cust_doesnotexist',
      invoiceDate: INVOICE_DATE,
      dueDate: DUE_DATE,
      items: [],
    });

    // ── Reminders ──
    await step('reminders: schedule one before due date', 'POST', `/api/invoices/${invoice.id}/reminders`, { offsetDays: -3 });
    await step('reminders: same offset twice is rejected', 'POST', `/api/invoices/${invoice.id}/reminders`, { offsetDays: -3 });
    await step('reminders: past date is rejected', 'POST', `/api/invoices/${invoice.id}/reminders`, { offsetDays: -9000 });
    const reminders = await step('reminders: list', 'GET', `/api/invoices/${invoice.id}/reminders`);
    await step('reminders: cancel one', 'DELETE', `/api/reminders/${reminders[0].id}`);
    await step('reminders: schedule another', 'POST', `/api/invoices/${invoice.id}/reminders`, { offsetDays: 7 });

    // ── Payment ledger (status is derived, never stored) ──
    await step('payments: partial payment leaves balance', 'POST', `/api/invoices/${invoice.id}/pay`, {
      amount: 5000, mode: 'Bank Transfer', date: '2030-01-10', reference: 'UTR-001',
    });
    await step('payments: ledger after partial', 'GET', `/api/invoices/${invoice.id}/payments`);
    await step('payments: settling the balance marks it paid', 'POST', `/api/invoices/${invoice.id}/pay`, {
      mode: 'UPI', date: '2030-01-12', reference: 'UTR-002',
    });
    await step('reminders: pending ones cancel when invoice is paid', 'GET', `/api/invoices/${invoice.id}/reminders`);
    await step('invoices: paid invoices cannot be edited', 'PUT', `/api/invoices/${invoice.id}`, {
      items: [{ description: 'Sneaky edit', qty: 1, rate: 1, taxPct: 0 }],
    });
    await step('payments: unpay archives the ledger', 'POST', `/api/invoices/${invoice.id}/unpay`);
    await step('invoices: status reverts after unpay', 'GET', `/api/invoices/${invoice.id}`);

    // ── Recurring schedules ──
    const schedule = await step('recurring: create', 'POST', '/api/recurring', {
      customerId: customer.id,
      dayOfMonth: 1,
      nextRunDate: '2030-02-01', // explicit so the snapshot doesn't depend on today
      terms: 'Net 30',
      taxLabel: 'IGST',
      notes: 'Monthly retainer',
      items: [{ description: 'Retainer', qty: 1, rate: 50000, taxPct: 18 }],
    });
    await step('recurring: run now mints an invoice and advances nextRunDate', 'POST', `/api/recurring/${schedule.id}/run`);
    await step('recurring: list', 'GET', '/api/recurring');
    await step('recurring: update', 'PUT', `/api/recurring/${schedule.id}`, { active: false, terms: 'Net 45' });

    // ── Archival is soft ──
    await step('invoices: list before archive', 'GET', '/api/invoices');
    await step('invoices: archive', 'DELETE', `/api/invoices/${invoice.id}`);
    await step('invoices: archived row disappears from list', 'GET', '/api/invoices');
    await step('orgs: summary counts reflect archival', 'GET', '/api/orgs');

    // ── Multi-org scoping ──
    const org2 = await step('orgs: create a second org', 'POST', '/api/orgs', { businessName: 'Initech' });
    await step('customers: new org starts empty', 'GET', '/api/customers');
    await step('invoices: new org starts empty', 'GET', '/api/invoices');
    await step('orgs: activate the first again', 'POST', `/api/orgs/${org.id}/activate`);
    await step('customers: first org data is intact', 'GET', '/api/customers');
    await step('orgs: archive the second', 'DELETE', `/api/orgs/${org2.id}`);

    // ── Google integration reports disconnected without credentials ──
    await step('google: status without credentials', 'GET', '/api/google/status');
  } finally {
    server.stop();
  }

  const actual = JSON.stringify(transcript, null, 2);

  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, actual + '\n');
    t.diagnostic(`recorded ${transcript.length} steps to ${path.relative(process.cwd(), GOLDEN)}`);
    return;
  }

  assert.ok(fs.existsSync(GOLDEN), `missing golden file — run: UPDATE_GOLDEN=1 node --test test/`);
  const expected = fs.readFileSync(GOLDEN, 'utf8').trimEnd();

  if (actual !== expected) {
    // Point at the first diverging step rather than dumping the whole transcript.
    const before = JSON.parse(expected);
    for (let i = 0; i < Math.max(before.length, transcript.length); i++) {
      const a = JSON.stringify(before[i]);
      const b = JSON.stringify(transcript[i]);
      if (a !== b) {
        assert.deepStrictEqual(
          transcript[i],
          before[i],
          `behavior changed at step ${i + 1}: ${(transcript[i] || before[i]).step}`
        );
      }
    }
  }
  assert.strictEqual(actual, expected);
});
