-- ============================================================================
-- Invoicing tool — initial relational schema
--
-- Translates the JSON collections in SCHEMA.md into real tables. Three choices
-- worth understanding before changing anything here:
--
-- 1. IDs stay TEXT ("inv_lx3k2a9f"), not uuid. The existing data already uses
--    these and they are referenced from stored PDFs and activity logs, so
--    keeping them makes the migration lossless and reversible. New rows keep
--    using the same generator in the app.
--
-- 2. Money is NUMERIC, never float. The JSON store used JS numbers and leaned on
--    a round2() helper; numeric(14,2) makes exactness a property of the column.
--
-- 3. `snapshot` stays JSONB. It is a deliberate immutable copy of seller/buyer
--    at issue time (see CLAUDE.md) — denormalized on purpose so editing a
--    customer never rewrites history. Do not normalize it.
--
-- Tenancy: organizations are the tenant boundary. Every table carries org_id.
-- organizations.owner_user_id is the forward hook for multi-user: it is nullable
-- today (single-user, no auth) and the RLS policies at the bottom are written
-- against it so enabling auth is a policy change, not a schema change.
-- ============================================================================

-- ── Shared helpers ──────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── organizations ───────────────────────────────────────────────────────────

create table organizations (
  id                text primary key,
  -- Null today (single-user). Populated once Supabase Auth is enabled; the RLS
  -- policies below already key off it.
  owner_user_id     uuid references auth.users (id) on delete restrict,
  name              text not null,

  -- profile
  business_name     text not null default 'My Business',
  address_lines     jsonb not null default '[]'::jsonb,
  tax_id            text  not null default '',
  email             text  not null default '',
  phone             text  not null default '',
  website           text  not null default '',

  -- branding. logo_path points into the private storage bucket; the old inline
  -- base64 data URL is gone (it was ~45KB on every row that embedded it).
  logo_path         text,
  logo_background   text not null default 'light'
                      check (logo_background in ('light', 'dark')),

  -- defaults applied to new invoices
  currency          text not null default '$',
  tax_label         text not null default 'IGST',
  terms             text not null default 'Net 15',
  notes             text not null default '',
  -- Days relative to due date: negative = before, 0 = on, positive = after.
  reminder_offsets  jsonb not null default '[0]'::jsonb,

  -- numbering. next_number is bumped with an atomic UPDATE ... RETURNING, which
  -- closes a race the in-memory read-modify-write version had.
  invoice_prefix    text    not null default 'INV-',
  next_number       integer not null default 1 check (next_number >= 1),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  metadata          jsonb not null default '{}'::jsonb
);

create index organizations_active_idx on organizations (archived_at) where archived_at is null;
create index organizations_owner_idx  on organizations (owner_user_id);
create trigger organizations_updated_at before update on organizations
  for each row execute function set_updated_at();

-- ── customers ───────────────────────────────────────────────────────────────

create table customers (
  id                     text primary key,
  org_id                 text not null references organizations (id) on delete cascade,
  name                   text not null default 'Untitled customer',
  email                  text not null default '',
  cc_email               text not null default '',
  tax_id                 text not null default '',
  billing_address_lines  jsonb not null default '[]'::jsonb,
  shipping_address_lines jsonb not null default '[]'::jsonb,
  contacts               jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz,
  metadata               jsonb not null default '{}'::jsonb
);

-- Every list query is "active rows in this org", so index exactly that.
create index customers_org_active_idx on customers (org_id) where archived_at is null;
create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();

-- ── tax_rates ───────────────────────────────────────────────────────────────
-- Present in the schema but not yet exercised by any route; kept so the
-- items.tax_rate_id foreign key is real rather than a dangling text column.

create table tax_rates (
  id          text primary key,
  org_id      text not null references organizations (id) on delete cascade,
  name        text not null,
  percent     numeric(6,3) not null default 0 check (percent >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  metadata    jsonb not null default '{}'::jsonb
);

create index tax_rates_org_active_idx on tax_rates (org_id) where archived_at is null;
create trigger tax_rates_updated_at before update on tax_rates
  for each row execute function set_updated_at();

-- ── items (catalog; exposed as /api/products) ───────────────────────────────

create table items (
  id                  text primary key,
  org_id              text not null references organizations (id) on delete cascade,
  name                text not null,
  default_rate        numeric(14,2) not null default 0,
  default_tax_percent numeric(6,3)  not null default 0 check (default_tax_percent >= 0),
  tax_rate_id         text references tax_rates (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  metadata            jsonb not null default '{}'::jsonb
);

create index items_org_active_idx on items (org_id) where archived_at is null;

-- POST /api/products de-dupes by case-insensitive name within an org. That was a
-- linear scan in JS; this makes it an index lookup and enforces the invariant.
create unique index items_org_name_unique_idx
  on items (org_id, lower(name)) where archived_at is null;

create trigger items_updated_at before update on items
  for each row execute function set_updated_at();

-- ── recurring_schedules ─────────────────────────────────────────────────────
-- Declared before invoices because invoices reference it.

create table recurring_schedules (
  id                text primary key,
  org_id            text not null references organizations (id) on delete cascade,
  customer_id       text references customers (id) on delete restrict,
  active            boolean not null default true,

  -- Only monthly exists today; unit/interval are stored so other cadences do not
  -- require a migration.
  frequency_unit     text    not null default 'month' check (frequency_unit in ('day','week','month','year')),
  frequency_interval integer not null default 1 check (frequency_interval >= 1),
  day_of_month       integer not null default 1 check (day_of_month between 1 and 31),

  next_run_date     date,
  last_generated_at timestamptz,

  -- template
  template_terms     text not null default 'Net 15',
  template_tax_label text not null default 'IGST',
  template_notes     text not null default '',

  auto_send         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  metadata          jsonb not null default '{}'::jsonb
);

create index recurring_org_active_idx on recurring_schedules (org_id) where archived_at is null;

-- The hourly scheduler scans for due schedules across all orgs; this serves it.
create index recurring_due_idx on recurring_schedules (next_run_date)
  where archived_at is null and active;

create trigger recurring_updated_at before update on recurring_schedules
  for each row execute function set_updated_at();

-- ── invoices ────────────────────────────────────────────────────────────────

create table invoices (
  id                    text primary key,
  org_id                text not null references organizations (id) on delete cascade,
  number                text not null,
  customer_id           text references customers (id) on delete restrict,
  recurring_schedule_id text references recurring_schedules (id) on delete set null,

  invoice_date  date,
  due_date      date,
  terms         text not null default 'Net 15',
  currency      text not null default '$',
  tax_label     text not null default 'IGST',

  -- Immutable copy of seller/billTo/shipTo/recipientEmail at issue time.
  snapshot      jsonb not null default '{}'::jsonb,

  -- Denormalized totals, recomputed from line items on every write. Kept on the
  -- row because listing invoices must not require aggregating children.
  sub_total     numeric(14,2) not null default 0,
  tax_total     numeric(14,2) not null default 0,
  total         numeric(14,2) not null default 0,

  notes         text not null default '',
  sent_at       timestamptz,
  sent_to       text,
  voided_at     timestamptz,

  -- Path in the private storage bucket, replacing the on-disk data/invoices copy.
  pdf_path       text,
  pdf_updated_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  metadata      jsonb not null default '{}'::jsonb
);

-- Invoice numbers must be unique per org. The JSON store never enforced this;
-- a crash between bumping next_number and saving could reuse one.
create unique index invoices_org_number_unique_idx on invoices (org_id, number);

-- The list view is "active invoices in this org, newest first".
create index invoices_org_created_idx on invoices (org_id, created_at desc) where archived_at is null;
create index invoices_customer_idx    on invoices (customer_id);
create index invoices_recurring_idx   on invoices (recurring_schedule_id);

create trigger invoices_updated_at before update on invoices
  for each row execute function set_updated_at();

-- ── invoice_line_items ──────────────────────────────────────────────────────
-- Was an embedded array; now a child table so line-level reporting is possible.
-- `position` preserves the user's ordering, which a plain table would not.

create table invoice_line_items (
  id          text primary key,
  invoice_id  text not null references invoices (id) on delete cascade,
  org_id      text not null references organizations (id) on delete cascade,
  position    integer not null,
  description text not null default '',
  quantity    numeric(14,3) not null default 0,
  rate        numeric(14,2) not null default 0,
  tax_percent numeric(6,3)  not null default 0 check (tax_percent >= 0)
);

create index invoice_line_items_invoice_idx on invoice_line_items (invoice_id, position);
create unique index invoice_line_items_position_idx on invoice_line_items (invoice_id, position);

-- ── schedule_line_items ─────────────────────────────────────────────────────
-- The recurring template's lines. Separate table (not shared with invoices)
-- because a template line has no invoice to belong to.

create table schedule_line_items (
  id          text primary key,
  schedule_id text not null references recurring_schedules (id) on delete cascade,
  org_id      text not null references organizations (id) on delete cascade,
  position    integer not null,
  description text not null default '',
  quantity    numeric(14,3) not null default 0,
  rate        numeric(14,2) not null default 0,
  tax_percent numeric(6,3)  not null default 0 check (tax_percent >= 0)
);

create index schedule_line_items_schedule_idx on schedule_line_items (schedule_id, position);
create unique index schedule_line_items_position_idx on schedule_line_items (schedule_id, position);

-- ── payments ────────────────────────────────────────────────────────────────
-- The ledger. balanceDue and paid status are DERIVED from this table and are
-- never stored on the invoice — see the invoice_balances view below.

create table payments (
  id          text primary key,
  org_id      text not null references organizations (id) on delete cascade,
  invoice_id  text not null references invoices (id) on delete cascade,
  amount      numeric(14,2) not null default 0,
  currency    text not null default '$',
  mode        text not null default 'Bank Transfer',
  date        date,
  reference   text not null default '',
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  metadata    jsonb not null default '{}'::jsonb
);

-- Unpay archives rather than deletes, so every read filters on archived_at.
create index payments_invoice_active_idx on payments (invoice_id) where archived_at is null;
create index payments_org_idx on payments (org_id);

create trigger payments_updated_at before update on payments
  for each row execute function set_updated_at();

-- ── reminders ───────────────────────────────────────────────────────────────

create table reminders (
  id          text primary key,
  org_id      text not null references organizations (id) on delete cascade,
  invoice_id  text not null references invoices (id) on delete cascade,
  offset_days integer not null default 0,
  due_on      date not null,
  status      text not null default 'pending'
                check (status in ('pending', 'sent', 'cancelled')),
  sent_at     timestamptz,
  sent_to     text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  metadata    jsonb not null default '{}'::jsonb
);

create index reminders_invoice_idx on reminders (invoice_id) where archived_at is null;

-- Serves the hourly reminder sweep: pending reminders that have come due.
create index reminders_due_idx on reminders (due_on)
  where archived_at is null and status = 'pending';

-- createReminders() refuses a duplicate pending reminder on the same date for
-- the same invoice. That was a JS scan; this enforces it in the database.
create unique index reminders_pending_unique_idx
  on reminders (invoice_id, due_on) where archived_at is null and status = 'pending';

create trigger reminders_updated_at before update on reminders
  for each row execute function set_updated_at();

-- ── activity ────────────────────────────────────────────────────────────────
-- Append-only audit log. No updated_at trigger: entries are never modified.

create table activity (
  id       text primary key,
  org_id   text not null references organizations (id) on delete cascade,
  type     text not null,
  ref_type text,
  ref_id   text,
  message  text not null default '',
  at       timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index activity_org_at_idx on activity (org_id, at desc);
create index activity_ref_idx    on activity (ref_type, ref_id);

-- ── integrations ────────────────────────────────────────────────────────────
-- Gmail OAuth tokens. org_id is nullable because the integration is global
-- today; a non-null org_id makes it per-org later without a migration.
--
-- SECURITY: `tokens` holds a Google refresh token — a long-lived credential that
-- can send mail as the user. It is readable by anything holding the service_role
-- key. Do not add a policy that exposes this table to the anon or authenticated
-- roles, and do not select it into any API response.

create table integrations (
  id          text primary key,
  org_id      text references organizations (id) on delete cascade,
  provider    text not null check (provider in ('google')),
  tokens      jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb
);

create unique index integrations_provider_org_idx
  on integrations (provider, coalesce(org_id, ''));

create trigger integrations_updated_at before update on integrations
  for each row execute function set_updated_at();

-- ── app_state ───────────────────────────────────────────────────────────────
-- Replaces db.meta. "Which org is active" is per-user once auth exists, so it is
-- keyed by user_id (null = the single-user case) rather than being a global.

create table app_state (
  user_id        uuid primary key default '00000000-0000-0000-0000-000000000000'::uuid,
  current_org_id text references organizations (id) on delete set null,
  schema_version integer not null default 4,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger app_state_updated_at before update on app_state
  for each row execute function set_updated_at();

-- ── invoice_balances ────────────────────────────────────────────────────────
-- Derived payment state in one place, so the ledger math cannot drift between
-- the API, the Excel export and the reminder scheduler.
--
-- Note: amount_paid is NOT clamped to the total. The current app can record an
-- overpayment (paying with no amount pays the full total even when partially
-- paid), and this view reports that honestly instead of hiding it. balance_due
-- is clamped to zero to match existing API behavior.

create view invoice_balances as
select
  i.id                                            as invoice_id,
  i.org_id,
  i.total,
  coalesce(sum(p.amount), 0)::numeric(14,2)       as amount_paid,
  greatest(i.total - coalesce(sum(p.amount), 0), 0)::numeric(14,2) as balance_due,
  (coalesce(sum(p.amount), 0) > 0
     and coalesce(sum(p.amount), 0) >= i.total)   as is_paid
from invoices i
left join payments p
  on p.invoice_id = i.id and p.archived_at is null
group by i.id, i.org_id, i.total;

-- ============================================================================
-- Row Level Security
--
-- Read this before assuming RLS is protecting anything today.
--
-- The Express server connects with the service_role key, which BYPASSES RLS
-- entirely. So with the current single-user, no-auth setup these policies
-- protect nothing at runtime — the real control is that the service_role key
-- never leaves the server and the browser never talks to Supabase directly.
--
-- RLS is enabled anyway as defense-in-depth: it means a leaked *anon* key grants
-- zero access, and it means the multi-user story is a matter of filling in
-- owner_user_id and uncommenting the policies below rather than redesigning.
-- ============================================================================

alter table organizations       enable row level security;
alter table customers           enable row level security;
alter table tax_rates           enable row level security;
alter table items               enable row level security;
alter table recurring_schedules enable row level security;
alter table invoices            enable row level security;
alter table invoice_line_items  enable row level security;
alter table schedule_line_items enable row level security;
alter table payments            enable row level security;
alter table reminders           enable row level security;
alter table activity            enable row level security;
alter table integrations        enable row level security;
alter table app_state           enable row level security;

-- No policies are defined, so every role except service_role is denied on every
-- table. That is the intended state for single-user.

-- ── Multi-user activation (do not enable until auth exists) ─────────────────
--
-- When Supabase Auth is turned on: backfill organizations.owner_user_id, then
-- create policies shaped like the two below for each table. Membership is
-- resolved through the org so adding a users/teams table later only changes
-- this one helper.
--
-- create function owns_org(target_org_id text)
-- returns boolean
-- language sql
-- security definer
-- stable
-- as $$
--   select exists (
--     select 1 from organizations o
--     where o.id = target_org_id
--       and o.owner_user_id = auth.uid()
--       and o.archived_at is null
--   );
-- $$;
--
-- create policy org_owner_all on organizations
--   for all to authenticated
--   using (owner_user_id = auth.uid())
--   with check (owner_user_id = auth.uid());
--
-- create policy customers_tenant_all on customers
--   for all to authenticated
--   using (owns_org(org_id))
--   with check (owns_org(org_id));
--
-- ...repeat for items, tax_rates, invoices, invoice_line_items, payments,
-- reminders, recurring_schedules, schedule_line_items, activity.
-- `integrations` should stay service_role-only regardless: it holds OAuth
-- refresh tokens that no browser session should ever be able to read.
