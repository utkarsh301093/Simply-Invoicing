// Postgres data-access layer (Supabase). Replaces the JSON store.
//
// Design rule: every function here returns records in the SAME nested shape the
// old JSON store used ({ profile, branding, defaults, numbering }, { snapshot,
// amounts, lineItems }, …). That keeps the storage⇄API mapping in index.js as
// the single translation point, exactly as CLAUDE.md describes — the routes and
// the frontend never learn that the backing store changed.
//
// Two things the JSON store could not do, which are now free:
//   * Real transactions — invoice + line items + activity commit atomically.
//   * Atomic invoice numbering — UPDATE ... RETURNING closes a read-modify-write
//     race that could hand two concurrent requests the same number.
require('./pgtypes');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const storage = require('./storage');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase terminates TLS at the pooler with its own CA chain.
  ssl: /supabase\.(co|com)/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('Unexpected idle client error:', err.message));

const nowISO = () => new Date().toISOString();

// Same id scheme as the JSON store, so existing rows and new ones are uniform.
function id(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Request session ─────────────────────────────────────────────────────────
// RLS needs Postgres to know *who* is asking. That identity has to reach every
// query, but threading a client argument through ~40 repository functions would
// touch all of them and be easy to forget on the next one. Instead the client
// lives in async context: q()/one()/tx() pick it up automatically, so the
// repositories below are unchanged and cannot accidentally opt out.
//
// withUser() opens ONE transaction per request, sets the verified JWT claims and
// switches to the `authenticated` role. `set local` scopes both to that
// transaction, so a pooled connection can never leak one user's identity into
// the next request — which is also why the whole request must share a single
// transaction rather than a connection.
const session = new AsyncLocalStorage();

function runner() {
  const ctx = session.getStore();
  return (ctx && ctx.client) || pool;
}

// True when the current request is scoped to a signed-in user (RLS applies).
function isUserScoped() {
  const ctx = session.getStore();
  return Boolean(ctx && ctx.client);
}

async function withUser(claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Set claims BEFORE dropping privileges — set_config on a reserved setting
    // is not something the `authenticated` role may do itself.
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query('set local role authenticated');
    const out = await session.run({ client, claims }, () => fn());
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Escape hatch for work that has no user: the hourly schedulers sweep every org,
// and org creation must write the owner_user_id row that RLS then keys off. Runs
// as the connecting role (table owner), so RLS does not apply. Keep the surface
// small and deliberate.
// claims are carried through even though RLS is bypassed: "who is asking" still
// decides which app_state row to touch and who owns a newly created org.
async function withService(fn, claims) {
  const ctx = session.getStore();
  return session.run({ client: null, claims: claims || (ctx && ctx.claims) || null }, () => fn());
}

async function q(text, params) {
  const res = await runner().query(text, params);
  return res.rows;
}

async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

let savepointSeq = 0;

// Run fn inside a transaction. Inside withUser() the request already owns one —
// opening a second on a different client would run outside the JWT context and
// silently see nothing, so nest on a SAVEPOINT instead.
//
// The savepoint is load-bearing, not tidiness: routes catch domain errors and
// answer 4xx without rethrowing, so the request transaction goes on to COMMIT.
// Without a savepoint, a rejected invoice create would keep the `next_number`
// increment it had already made and burn an invoice number — the gap-free
// numbering that several tax jurisdictions require. The characterization suite
// catches this precise case.
async function tx(fn) {
  const ctx = session.getStore();
  if (ctx && ctx.client) {
    const client = ctx.client;
    const sp = `sp_${++savepointSeq}`;
    await client.query(`savepoint ${sp}`);
    try {
      const out = await fn(client);
      await client.query(`release savepoint ${sp}`);
      return out;
    } catch (e) {
      await client.query(`rollback to savepoint ${sp}`).catch(() => {});
      throw e;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Logo resolution ─────────────────────────────────────────────────────────
// Rows store a Storage path; the PDF renderer, email templates and frontend all
// expect an inline data URL. Resolve on read and cache, so a logo is fetched at
// most once per process rather than once per invoice.
const logoCache = new Map();

function contentTypeFor(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' }[ext] || 'application/octet-stream';
}

async function logoDataUrl(path) {
  if (!path) return null;
  if (logoCache.has(path)) return logoCache.get(path);
  let url = null;
  try {
    const buf = await storage.get(path);
    if (buf) url = `data:${contentTypeFor(path)};base64,${buf.toString('base64')}`;
  } catch (e) {
    // A missing logo must not break invoice rendering.
    console.error('Logo fetch failed for', path, '-', e.message);
  }
  logoCache.set(path, url);
  return url;
}

// Store a logo submitted as a data URL; returns its path. Null clears it.
async function putLogo(orgId, dataUrl) {
  if (dataUrl === null || dataUrl === '') return null;
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return undefined; // not a data URL — caller leaves the column alone
  const contentType = m[1] || 'image/png';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' }[contentType] || 'bin';
  const path = `logos/${orgId}/${hash}.${ext}`;
  await storage.put(path, buf, contentType);
  logoCache.set(path, dataUrl);
  return path;
}

// ── Row mappers: table row -> legacy nested record ──────────────────────────

async function orgFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    profile: {
      businessName: r.business_name, addressLines: r.address_lines || [], taxId: r.tax_id,
      email: r.email, phone: r.phone, website: r.website,
    },
    branding: { logo: await logoDataUrl(r.logo_path), logoBackground: r.logo_background, logoPath: r.logo_path },
    defaults: {
      currency: r.currency, taxLabel: r.tax_label, terms: r.terms,
      notes: r.notes, reminderOffsets: r.reminder_offsets || [0],
    },
    numbering: { invoicePrefix: r.invoice_prefix, nextNumber: r.next_number },
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
  };
}

const customerFromRow = (r) => r && ({
  id: r.id, orgId: r.org_id, name: r.name, email: r.email, ccEmail: r.cc_email, taxId: r.tax_id,
  billingAddress: { lines: r.billing_address_lines || [] },
  shippingAddress: { lines: r.shipping_address_lines || [] },
  contacts: r.contacts || [],
  createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
});

const itemFromRow = (r) => r && ({
  id: r.id, orgId: r.org_id, name: r.name,
  defaultRate: r.default_rate, defaultTaxPercent: r.default_tax_percent, taxRateId: r.tax_rate_id,
  createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
});

const lineFromRow = (r) => ({
  id: r.id, description: r.description, quantity: r.quantity, rate: r.rate, taxPercent: r.tax_percent,
});

async function invoiceFromRow(r, lines) {
  if (!r) return null;
  const snapshot = r.snapshot || {};
  // Snapshots hold a logo path; downstream code expects an inline data URL.
  // `logo` is always present (null when there is none) — the API contract has
  // an explicit null here, and an absent key would be dropped by JSON.stringify.
  if (snapshot.seller) {
    snapshot.seller = {
      ...snapshot.seller,
      logo: snapshot.seller.logo || (snapshot.seller.logoPath ? await logoDataUrl(snapshot.seller.logoPath) : null),
    };
  }
  return {
    id: r.id, orgId: r.org_id, number: r.number,
    customerId: r.customer_id, recurringScheduleId: r.recurring_schedule_id,
    invoiceDate: r.invoice_date, dueDate: r.due_date, terms: r.terms,
    currency: r.currency, taxLabel: r.tax_label,
    snapshot,
    lineItems: (lines || []).map(lineFromRow),
    amounts: { subTotal: r.sub_total, taxTotal: r.tax_total, total: r.total },
    notes: r.notes, sentAt: r.sent_at, sentTo: r.sent_to, voidedAt: r.voided_at,
    // pdfFile stays a basename for API compatibility; pdfPath is the storage key.
    pdf: { file: r.pdf_path ? r.pdf_path.split('/').pop() : null, path: r.pdf_path, updatedAt: r.pdf_updated_at },
    balance: { amountPaid: r.amount_paid ?? 0, balanceDue: r.balance_due ?? r.total, isPaid: r.is_paid ?? false },
    latestPayment: r.pay_mode ? { mode: r.pay_mode, date: r.pay_date, reference: r.pay_reference, amount: r.pay_amount } : null,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
  };
}

const paymentFromRow = (r) => r && ({
  id: r.id, orgId: r.org_id, invoiceId: r.invoice_id, amount: r.amount, currency: r.currency,
  mode: r.mode, date: r.date, reference: r.reference, note: r.note,
  createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
});

const reminderFromRow = (r) => r && ({
  id: r.id, orgId: r.org_id, invoiceId: r.invoice_id, offsetDays: r.offset_days, dueOn: r.due_on,
  status: r.status, sentAt: r.sent_at, sentTo: r.sent_to, error: r.error,
  createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
});

const scheduleFromRow = (r, lines) => r && ({
  id: r.id, orgId: r.org_id, customerId: r.customer_id, active: r.active,
  frequency: { unit: r.frequency_unit, interval: r.frequency_interval, dayOfMonth: r.day_of_month },
  nextRunDate: r.next_run_date, lastGeneratedAt: r.last_generated_at,
  template: {
    terms: r.template_terms, taxLabel: r.template_tax_label, notes: r.template_notes,
    lineItems: (lines || []).map(lineFromRow),
  },
  autoSend: r.auto_send,
  createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, metadata: r.metadata || {},
});

// ── Organizations ───────────────────────────────────────────────────────────

const ORG_COLS = `id, name, business_name, address_lines, tax_id, email, phone, website,
  logo_path, logo_background, currency, tax_label, terms, notes, reminder_offsets,
  invoice_prefix, next_number, created_at, updated_at, archived_at, metadata`;

const orgs = {
  async listActive() {
    const rows = await q(`select ${ORG_COLS} from organizations where archived_at is null order by created_at`);
    return Promise.all(rows.map(orgFromRow));
  },
  async byId(orgId) {
    return orgFromRow(await one(`select ${ORG_COLS} from organizations where id = $1`, [orgId]));
  },
  async create(fields) {
    const r = await one(
      `insert into organizations (id, name, business_name, address_lines, tax_id, currency,
         tax_label, terms, notes, invoice_prefix, next_number, reminder_offsets, owner_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${ORG_COLS}`,
      [id('org'), fields.name, fields.businessName || fields.name, JSON.stringify(fields.addressLines || []),
       fields.taxId || '', fields.currency || '$', fields.taxLabel || 'IGST', fields.terms || 'Net 15',
       fields.notes || '', fields.invoicePrefix || 'INV-', fields.nextNumber || 1,
       JSON.stringify(fields.reminderOffsets || [0]), fields.ownerUserId || null]
    );
    return orgFromRow(r);
  },
  // Persist the mutated nested org record produced by applySettings().
  async save(org) {
    const r = await one(
      `update organizations set name=$2, business_name=$3, address_lines=$4, tax_id=$5, email=$6,
         phone=$7, website=$8, logo_path=$9, logo_background=$10, currency=$11, tax_label=$12,
         terms=$13, notes=$14, reminder_offsets=$15, invoice_prefix=$16, next_number=$17
       where id=$1 returning ${ORG_COLS}`,
      [org.id, org.name, org.profile.businessName, JSON.stringify(org.profile.addressLines || []),
       org.profile.taxId || '', org.profile.email || '', org.profile.phone || '', org.profile.website || '',
       org.branding.logoPath || null, org.branding.logoBackground || 'light',
       org.defaults.currency, org.defaults.taxLabel, org.defaults.terms, org.defaults.notes,
       JSON.stringify(org.defaults.reminderOffsets || [0]), org.numbering.invoicePrefix, org.numbering.nextNumber]
    );
    return orgFromRow(r);
  },
  async archive(orgId) {
    await q('update organizations set archived_at = now() where id = $1', [orgId]);
  },
  // Atomic. The JSON version read nextNumber, incremented in memory and saved —
  // two concurrent requests could both read the same value.
  async nextInvoiceNumber(orgId, client) {
    const conn = client || runner();
    const { rows } = await conn.query(
      'update organizations set next_number = next_number + 1 where id = $1 returning invoice_prefix, next_number - 1 as issued',
      [orgId]
    );
    if (!rows[0]) throw new Error('Organization not found');
    return `${rows[0].invoice_prefix || 'INV-'}${rows[0].issued}`;
  },
  async counts(orgId) {
    const r = await one(
      `select (select count(*) from invoices where org_id=$1 and archived_at is null) as invoices,
              (select count(*) from customers where org_id=$1 and archived_at is null) as customers`,
      [orgId]
    );
    return { invoiceCount: r.invoices, customerCount: r.customers };
  },
};

// ── App state (replaces db.meta) ────────────────────────────────────────────

// Pre-auth rows were written under this sentinel; it stays as the fallback for
// service-role work (the schedulers), which has no user.
const SINGLE_USER = '00000000-0000-0000-0000-000000000000';

// "Which org is active" is per-user. app_state is already keyed by user_id, so
// reading the subject out of the request session is all it takes.
function currentUserId() {
  const ctx = session.getStore();
  return (ctx && ctx.claims && ctx.claims.sub) || SINGLE_USER;
}

const appState = {
  async currentOrgId() {
    const r = await one('select current_org_id from app_state where user_id = $1', [currentUserId()]);
    return r ? r.current_org_id : null;
  },
  async setCurrentOrg(orgId) {
    await q(
      `insert into app_state (user_id, current_org_id) values ($1, $2)
       on conflict (user_id) do update set current_org_id = excluded.current_org_id`,
      [currentUserId(), orgId]
    );
  },
};

// The active org: whatever app_state points at, else the oldest live org.
async function activeOrg() {
  const wanted = await appState.currentOrgId();
  if (wanted) {
    const r = await one(`select ${ORG_COLS} from organizations where id=$1 and archived_at is null`, [wanted]);
    if (r) return orgFromRow(r);
  }
  const fallback = await one(`select ${ORG_COLS} from organizations where archived_at is null order by created_at limit 1`);
  return orgFromRow(fallback);
}

// ── Customers ───────────────────────────────────────────────────────────────

const CUST_COLS = `id, org_id, name, email, cc_email, tax_id, billing_address_lines,
  shipping_address_lines, contacts, created_at, updated_at, archived_at, metadata`;

const customers = {
  async list(orgId) {
    return (await q(`select ${CUST_COLS} from customers where org_id=$1 and archived_at is null order by created_at`, [orgId])).map(customerFromRow);
  },
  async byId(orgId, cid) {
    return customerFromRow(await one(`select ${CUST_COLS} from customers where org_id=$1 and id=$2 and archived_at is null`, [orgId, cid]));
  },
  async create(orgId, b) {
    return customerFromRow(await one(
      `insert into customers (id, org_id, name, email, cc_email, tax_id, billing_address_lines, shipping_address_lines)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${CUST_COLS}`,
      [id('cust'), orgId, b.name || 'Untitled customer', b.email || '', b.ccEmail || '', b.taxId || '',
       JSON.stringify(b.billingAddressLines || []), JSON.stringify(b.shipToAddressLines || [])]
    ));
  },
  async update(orgId, cid, patch) {
    return customerFromRow(await one(
      `update customers set name=coalesce($3,name), email=coalesce($4,email), cc_email=coalesce($5,cc_email),
         tax_id=coalesce($6,tax_id),
         billing_address_lines=coalesce($7::jsonb, billing_address_lines),
         shipping_address_lines=coalesce($8::jsonb, shipping_address_lines)
       where org_id=$1 and id=$2 and archived_at is null returning ${CUST_COLS}`,
      [orgId, cid,
       patch.name ?? null, patch.email ?? null, patch.ccEmail ?? null, patch.taxId ?? null,
       patch.billingAddressLines ? JSON.stringify(patch.billingAddressLines) : null,
       patch.shipToAddressLines ? JSON.stringify(patch.shipToAddressLines) : null]
    ));
  },
  async archive(orgId, cid) {
    await q('update customers set archived_at = now() where org_id=$1 and id=$2', [orgId, cid]);
  },
};

// ── Items ───────────────────────────────────────────────────────────────────

const ITEM_COLS = `id, org_id, name, default_rate, default_tax_percent, tax_rate_id,
  created_at, updated_at, archived_at, metadata`;

const items = {
  async list(orgId) {
    return (await q(`select ${ITEM_COLS} from items where org_id=$1 and archived_at is null order by created_at`, [orgId])).map(itemFromRow);
  },
  async byId(orgId, iid) {
    return itemFromRow(await one(`select ${ITEM_COLS} from items where org_id=$1 and id=$2 and archived_at is null`, [orgId, iid]));
  },
  async byName(orgId, name) {
    return itemFromRow(await one(`select ${ITEM_COLS} from items where org_id=$1 and lower(name)=lower($2) and archived_at is null`, [orgId, name]));
  },
  async create(orgId, b) {
    return itemFromRow(await one(
      `insert into items (id, org_id, name, default_rate, default_tax_percent) values ($1,$2,$3,$4,$5) returning ${ITEM_COLS}`,
      [id('item'), orgId, b.name, Number(b.rate) || 0, Number(b.taxPct) || 0]
    ));
  },
  async update(orgId, iid, patch) {
    return itemFromRow(await one(
      `update items set name=coalesce($3,name), default_rate=coalesce($4,default_rate),
         default_tax_percent=coalesce($5,default_tax_percent)
       where org_id=$1 and id=$2 and archived_at is null returning ${ITEM_COLS}`,
      [orgId, iid, patch.name ?? null,
       patch.rate === undefined ? null : Number(patch.rate) || 0,
       patch.taxPct === undefined ? null : Number(patch.taxPct) || 0]
    ));
  },
  async archive(orgId, iid) {
    await q('update items set archived_at = now() where org_id=$1 and id=$2', [orgId, iid]);
  },
};

// ── Invoices ────────────────────────────────────────────────────────────────

// Joined with the balances view so paid-state never has to be recomputed in JS.
// The lateral join pulls the most recent payment in the same round trip — the
// API exposes it as invoice.payment, and fetching it per row would make the
// list endpoint N+1.
const INV_SELECT = `
  select i.id, i.org_id, i.number, i.customer_id, i.recurring_schedule_id, i.invoice_date, i.due_date,
         i.terms, i.currency, i.tax_label, i.snapshot, i.sub_total, i.tax_total, i.total, i.notes,
         i.sent_at, i.sent_to, i.voided_at, i.pdf_path, i.pdf_updated_at,
         i.created_at, i.updated_at, i.archived_at, i.metadata,
         b.amount_paid, b.balance_due, b.is_paid,
         lp.mode as pay_mode, lp.date as pay_date, lp.reference as pay_reference, lp.amount as pay_amount
  from invoices i
  join invoice_balances b on b.invoice_id = i.id
  left join lateral (
    select p.mode, p.date, p.reference, p.amount
    from payments p
    where p.invoice_id = i.id and p.archived_at is null
    order by p.created_at desc
    limit 1
  ) lp on true`;

async function linesFor(invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await q(
    'select id, invoice_id, position, description, quantity, rate, tax_percent from invoice_line_items where invoice_id = any($1) order by invoice_id, position',
    [invoiceIds]
  );
  const byInvoice = new Map();
  for (const r of rows) {
    if (!byInvoice.has(r.invoice_id)) byInvoice.set(r.invoice_id, []);
    byInvoice.get(r.invoice_id).push(r);
  }
  return byInvoice;
}

const invoices = {
  async list(orgId) {
    const rows = await q(`${INV_SELECT} where i.org_id=$1 and i.archived_at is null order by i.created_at desc`, [orgId]);
    const lines = await linesFor(rows.map((r) => r.id));
    return Promise.all(rows.map((r) => invoiceFromRow(r, lines.get(r.id))));
  },
  async byId(orgId, iid) {
    const r = await one(`${INV_SELECT} where i.org_id=$1 and i.id=$2 and i.archived_at is null`, [orgId, iid]);
    if (!r) return null;
    return invoiceFromRow(r, (await linesFor([r.id])).get(r.id));
  },
  // Any invoice by id regardless of org — used by the cross-org schedulers.
  async byIdAnyOrg(iid) {
    const r = await one(`${INV_SELECT} where i.id=$1 and i.archived_at is null`, [iid]);
    if (!r) return null;
    return invoiceFromRow(r, (await linesFor([r.id])).get(r.id));
  },
  // Insert invoice + its lines atomically. `rec` is a legacy-shaped record.
  async create(rec, client) {
    const run = (text, params) => (client || runner()).query(text, params);
    await run(
      `insert into invoices (id, org_id, number, customer_id, recurring_schedule_id, invoice_date, due_date,
         terms, currency, tax_label, snapshot, sub_total, tax_total, total, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [rec.id, rec.orgId, rec.number, rec.customerId, rec.recurringScheduleId || null,
       rec.invoiceDate || null, rec.dueDate || null, rec.terms, rec.currency, rec.taxLabel,
       JSON.stringify(rec.snapshot), rec.amounts.subTotal, rec.amounts.taxTotal, rec.amounts.total, rec.notes || '']
    );
    await insertLines(run, 'invoice_line_items', 'invoice_id', rec.id, rec.orgId, rec.lineItems);
    return rec.id;
  },
  // Replace line items and recompute-dependent fields in one transaction.
  async update(orgId, iid, patch, lineItems, amounts) {
    return tx(async (client) => {
      await client.query(
        `update invoices set invoice_date=coalesce($3,invoice_date), due_date=coalesce($4,due_date),
           terms=coalesce($5,terms), tax_label=coalesce($6,tax_label), notes=coalesce($7,notes),
           sub_total=coalesce($8,sub_total), tax_total=coalesce($9,tax_total), total=coalesce($10,total)
         where org_id=$1 and id=$2`,
        [orgId, iid, patch.invoiceDate ?? null, patch.dueDate ?? null, patch.terms ?? null,
         patch.taxLabel ?? null, patch.notes ?? null,
         amounts ? amounts.subTotal : null, amounts ? amounts.taxTotal : null, amounts ? amounts.total : null]
      );
      if (lineItems) {
        await client.query('delete from invoice_line_items where invoice_id=$1', [iid]);
        await insertLines((t, p) => client.query(t, p), 'invoice_line_items', 'invoice_id', iid, orgId, lineItems);
      }
    });
  },
  async setPdf(iid, pdfPath) {
    await q('update invoices set pdf_path=$2, pdf_updated_at=now() where id=$1', [iid, pdfPath]);
  },
  async markSent(iid, to) {
    await q('update invoices set sent_at=now(), sent_to=$2 where id=$1', [iid, to]);
  },
  async touch(iid) {
    await q('update invoices set updated_at=now() where id=$1', [iid]);
  },
  async archive(orgId, iid) {
    await q('update invoices set archived_at=now() where org_id=$1 and id=$2', [orgId, iid]);
  },
};

async function insertLines(run, table, fkCol, parentId, orgId, lineItems) {
  const list = lineItems || [];
  for (let i = 0; i < list.length; i++) {
    const li = list[i];
    await run(
      `insert into ${table} (id, ${fkCol}, org_id, position, description, quantity, rate, tax_percent)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [li.id || id('li'), parentId, orgId, i, li.description || '', Number(li.quantity) || 0, Number(li.rate) || 0, Number(li.taxPercent) || 0]
    );
  }
}

// ── Payments ────────────────────────────────────────────────────────────────

const PAY_COLS = `id, org_id, invoice_id, amount, currency, mode, date, reference, note,
  created_at, updated_at, archived_at, metadata`;

const payments = {
  async forInvoice(invoiceId) {
    return (await q(`select ${PAY_COLS} from payments where invoice_id=$1 and archived_at is null order by created_at desc`, [invoiceId])).map(paymentFromRow);
  },
  async add(orgId, invoiceId, p) {
    return paymentFromRow(await one(
      `insert into payments (id, org_id, invoice_id, amount, currency, mode, date, reference, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${PAY_COLS}`,
      [id('pay'), orgId, invoiceId, p.amount, p.currency, p.mode, p.date || null, p.reference || '', p.note || '']
    ));
  },
  async archiveForInvoice(invoiceId) {
    await q('update payments set archived_at=now() where invoice_id=$1 and archived_at is null', [invoiceId]);
  },
};

// ── Reminders ───────────────────────────────────────────────────────────────

const REM_COLS = `id, org_id, invoice_id, offset_days, due_on, status, sent_at, sent_to, error,
  created_at, updated_at, archived_at, metadata`;

const reminders = {
  async forInvoice(invoiceId) {
    return (await q(`select ${REM_COLS} from reminders where invoice_id=$1 and archived_at is null order by due_on`, [invoiceId])).map(reminderFromRow);
  },
  async byId(orgId, rid) {
    return reminderFromRow(await one(`select ${REM_COLS} from reminders where org_id=$1 and id=$2 and archived_at is null`, [orgId, rid]));
  },
  // Relies on the partial unique index for the duplicate rule; a conflict means
  // "already scheduled for that date", so return null rather than throwing.
  async create(orgId, invoiceId, offsetDays, dueOn) {
    const r = await one(
      `insert into reminders (id, org_id, invoice_id, offset_days, due_on, status)
       values ($1,$2,$3,$4,$5,'pending')
       on conflict do nothing returning ${REM_COLS}`,
      [id('rem'), orgId, invoiceId, offsetDays, dueOn]
    );
    return reminderFromRow(r);
  },
  async cancel(rid) {
    await q("update reminders set status='cancelled' where id=$1 and status='pending'", [rid]);
  },
  async cancelPendingFor(invoiceId) {
    const rows = await q("update reminders set status='cancelled' where invoice_id=$1 and status='pending' and archived_at is null returning id", [invoiceId]);
    return rows.length;
  },
  // Due pending reminders across every org — drives the hourly sweep.
  async due(today) {
    return (await q(`select ${REM_COLS} from reminders where status='pending' and archived_at is null and due_on <= $1 order by due_on`, [today])).map(reminderFromRow);
  },
  async markSent(rid, to) {
    await q("update reminders set status='sent', sent_at=now(), sent_to=$2, error=null where id=$1", [rid, to]);
  },
  async markError(rid, message) {
    await q('update reminders set error=$2 where id=$1', [rid, message]);
  },
};

// ── Recurring schedules ─────────────────────────────────────────────────────

const SCHED_COLS = `id, org_id, customer_id, active, frequency_unit, frequency_interval, day_of_month,
  next_run_date, last_generated_at, template_terms, template_tax_label, template_notes, auto_send,
  created_at, updated_at, archived_at, metadata`;

async function schedLines(scheduleIds) {
  if (!scheduleIds.length) return new Map();
  const rows = await q(
    'select id, schedule_id, position, description, quantity, rate, tax_percent from schedule_line_items where schedule_id = any($1) order by schedule_id, position',
    [scheduleIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.schedule_id)) map.set(r.schedule_id, []);
    map.get(r.schedule_id).push(r);
  }
  return map;
}

const recurring = {
  async list(orgId) {
    const rows = await q(`select ${SCHED_COLS} from recurring_schedules where org_id=$1 and archived_at is null order by created_at`, [orgId]);
    const lines = await schedLines(rows.map((r) => r.id));
    return rows.map((r) => scheduleFromRow(r, lines.get(r.id)));
  },
  async byId(orgId, sid) {
    const r = await one(`select ${SCHED_COLS} from recurring_schedules where org_id=$1 and id=$2 and archived_at is null`, [orgId, sid]);
    if (!r) return null;
    return scheduleFromRow(r, (await schedLines([r.id])).get(r.id));
  },
  async due(today) {
    const rows = await q(
      `select ${SCHED_COLS} from recurring_schedules
       where archived_at is null and active and next_run_date is not null and next_run_date <= $1`,
      [today]
    );
    const lines = await schedLines(rows.map((r) => r.id));
    return rows.map((r) => scheduleFromRow(r, lines.get(r.id)));
  },
  async create(orgId, b, lineItems) {
    const sid = id('rec');
    await tx(async (client) => {
      await client.query(
        `insert into recurring_schedules (id, org_id, customer_id, active, day_of_month, next_run_date,
           template_terms, template_tax_label, template_notes, auto_send)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sid, orgId, b.customerId || null, b.active !== false, b.dayOfMonth || 1, b.nextRunDate || null,
         b.terms, b.taxLabel, b.notes || '', Boolean(b.autoSend)]
      );
      await insertLines((t, p) => client.query(t, p), 'schedule_line_items', 'schedule_id', sid, orgId, lineItems);
    });
    return this.byId(orgId, sid);
  },
  async update(orgId, sid, patch, lineItems) {
    await tx(async (client) => {
      await client.query(
        `update recurring_schedules set active=coalesce($3,active), day_of_month=coalesce($4,day_of_month),
           next_run_date=coalesce($5,next_run_date), customer_id=coalesce($6,customer_id),
           template_terms=coalesce($7,template_terms), template_tax_label=coalesce($8,template_tax_label),
           template_notes=coalesce($9,template_notes), auto_send=coalesce($10,auto_send)
         where org_id=$1 and id=$2`,
        [orgId, sid, patch.active ?? null, patch.dayOfMonth ?? null, patch.nextRunDate ?? null,
         patch.customerId ?? null, patch.terms ?? null, patch.taxLabel ?? null,
         patch.notes ?? null, patch.autoSend ?? null]
      );
      if (lineItems) {
        await client.query('delete from schedule_line_items where schedule_id=$1', [sid]);
        await insertLines((t, p) => client.query(t, p), 'schedule_line_items', 'schedule_id', sid, orgId, lineItems);
      }
    });
    return this.byId(orgId, sid);
  },
  async advance(sid, nextRunDate, client) {
    const run = (t, p) => (client || runner()).query(t, p);
    await run('update recurring_schedules set next_run_date=$2, last_generated_at=now() where id=$1', [sid, nextRunDate]);
  },
  async archive(orgId, sid) {
    await q('update recurring_schedules set archived_at=now() where org_id=$1 and id=$2', [orgId, sid]);
  },
};

// ── Activity ────────────────────────────────────────────────────────────────

const activity = {
  async log(orgId, type, refType, refId, message, client) {
    const run = (t, p) => (client || runner()).query(t, p);
    await run(
      'insert into activity (id, org_id, type, ref_type, ref_id, message) values ($1,$2,$3,$4,$5,$6)',
      [id('act'), orgId, type, refType, refId, message]
    );
  },
  async list(orgId, limit = 100) {
    return q('select id, org_id, type, ref_type, ref_id, message, at, metadata from activity where org_id=$1 order by at desc limit $2', [orgId, limit]);
  },
};

// ── Integrations (Gmail OAuth tokens) ───────────────────────────────────────
// service_role-only. Never selected into an API response.

const integrations = {
  async getGoogle() {
    const r = await one("select tokens from integrations where provider='google' and org_id is null");
    return r ? r.tokens : null;
  },
  async setGoogle(tokens) {
    await q(
      `insert into integrations (id, provider, tokens, connected_at)
       values ('int_google','google',$1, now())
       on conflict (id) do update set tokens=excluded.tokens, connected_at=excluded.connected_at`,
      [JSON.stringify(tokens)]
    );
  },
  async clearGoogle() {
    await q("delete from integrations where provider='google' and org_id is null");
  },
};

// Verify connectivity at boot so a bad DATABASE_URL fails loudly and early.
async function connect() {
  const r = await one('select current_database() as db, version() as v');
  return r;
}

module.exports = {
  pool, q, one, tx, id, nowISO, connect,
  withUser, withService, isUserScoped, currentUserId,
  orgs, appState, activeOrg, customers, items, invoices, payments, reminders, recurring, activity, integrations,
  logoDataUrl, putLogo,
};
