-- Tenant-isolation tests for the policies in 0002_auth_policies.sql.
-- Run via scripts/test-rls.sh (throwaway container; no Supabase project needed).
-- Every check raises on failure, so a clean run means all passed.

\set ON_ERROR_STOP on

create or replace function assert_eq(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % — expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok: % (%)', label, actual;
end $$;

-- ── Fixtures ────────────────────────────────────────────────
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into organizations (id, name, owner_user_id) values
  ('org_a', 'Alice Co', '11111111-1111-1111-1111-111111111111'),
  ('org_b', 'Bob Co',   '22222222-2222-2222-2222-222222222222');

insert into customers (id, org_id, name) values
  ('cust_a', 'org_a', 'Alice Customer'),
  ('cust_b', 'org_b', 'Bob Customer');

insert into invoices (id, org_id, number, customer_id, total) values
  ('inv_a', 'org_a', 'INV-1', 'cust_a', 100),
  ('inv_b', 'org_b', 'INV-1', 'cust_b', 999);

insert into invoice_line_items (id, invoice_id, org_id, position, description, quantity, rate) values
  ('li_a', 'inv_a', 'org_a', 1, 'Alice work', 1, 100),
  ('li_b', 'inv_b', 'org_b', 1, 'Bob work',   1, 999);

insert into payments (id, org_id, invoice_id, amount) values
  ('pay_a', 'org_a', 'inv_a', 50),
  ('pay_b', 'org_b', 'inv_b', 500);

insert into activity (id, org_id, type, message) values
  ('act_a', 'org_a', 'test', 'alice'),
  ('act_b', 'org_b', 'test', 'bob');

insert into integrations (id, org_id, provider, tokens)
  values ('int_a', 'org_a', 'google', '{"refresh_token":"SECRET-A"}');

insert into app_state (user_id, current_org_id) values
  ('11111111-1111-1111-1111-111111111111', 'org_a'),
  ('22222222-2222-2222-2222-222222222222', 'org_b');

-- ── As Alice ────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', false);

select assert_eq(count(*), 1, 'alice: own org only')        from organizations;
select assert_eq(count(*), 1, 'alice: own customers only')  from customers;
select assert_eq(count(*), 1, 'alice: own invoices only')   from invoices;
select assert_eq(count(*), 1, 'alice: own payments only')   from payments;
select assert_eq(count(*), 1, 'alice: own activity only')   from activity;
select assert_eq(count(*), 1, 'alice: own line items only') from invoice_line_items;
select assert_eq(count(*), 1, 'alice: own app_state only')  from app_state;

-- The view must not punch through RLS (security_invoker).
select assert_eq(count(*), 1, 'alice: invoice_balances scoped') from invoice_balances;
select assert_eq(count(*), 0, 'alice: cannot see bob balance')  from invoice_balances where org_id = 'org_b';

select assert_eq(count(*), 0, 'alice: bob org hidden')       from organizations where id = 'org_b';
select assert_eq(count(*), 0, 'alice: bob line item hidden') from invoice_line_items where id = 'li_b';

do $$ begin
  perform 1 from integrations;
  raise exception 'FAIL: alice read integrations';
exception when insufficient_privilege then raise notice 'ok: integrations denied to authenticated';
end $$;

do $$ begin
  insert into customers (id, org_id, name) values ('cust_evil', 'org_b', 'Injected');
  raise exception 'FAIL: alice inserted into org_b';
exception when insufficient_privilege then raise notice 'ok: cross-tenant insert blocked';
end $$;

do $$ begin
  update customers set org_id = 'org_b' where id = 'cust_a';
  raise exception 'FAIL: alice re-parented a row into org_b';
exception when insufficient_privilege then raise notice 'ok: cross-tenant re-parent blocked';
end $$;

do $$ begin
  insert into invoice_line_items (id, invoice_id, org_id, position, description, quantity, rate)
  values ('li_evil', 'inv_b', 'org_b', 2, 'Injected', 1, 1);
  raise exception 'FAIL: alice inserted a line item on bob invoice';
exception when insufficient_privilege then raise notice 'ok: cross-tenant line item blocked';
end $$;

do $$ begin
  insert into organizations (id, name, owner_user_id)
  values ('org_evil', 'Orphan', '11111111-1111-1111-1111-111111111111');
  raise exception 'FAIL: alice created an org directly';
exception when insufficient_privilege then raise notice 'ok: direct org insert blocked';
end $$;

-- Stealing an org by reassigning ownership must fail the WITH CHECK.
do $$ begin
  update organizations set owner_user_id = '11111111-1111-1111-1111-111111111111' where id = 'org_b';
  if found then raise exception 'FAIL: alice took ownership of org_b'; end if;
  raise notice 'ok: org takeover blocked';
end $$;

-- Silent no-ops rather than errors; effect verified below.
update customers set name = 'Hacked' where id = 'cust_b';
delete from invoices where id = 'inv_b';
update app_state set current_org_id = 'org_a' where user_id = '22222222-2222-2222-2222-222222222222';

reset role;

-- ── Bob's data survived ─────────────────────────────────────
select assert_eq(count(*), 1, 'bob customer intact')     from customers where id = 'cust_b' and name = 'Bob Customer';
select assert_eq(count(*), 1, 'bob invoice not deleted') from invoices  where id = 'inv_b';
select assert_eq(count(*), 0, 'no injected customer')    from customers where id = 'cust_evil';
select assert_eq(count(*), 0, 'no injected line item')   from invoice_line_items where id = 'li_evil';
select assert_eq(count(*), 1, 'org_b still bob''s')      from organizations where id = 'org_b'
  and owner_user_id = '22222222-2222-2222-2222-222222222222';
select assert_eq(count(*), 1, 'bob app_state untouched') from app_state where user_id = '22222222-2222-2222-2222-222222222222'
  and current_org_id = 'org_b';

-- ── As Bob: mirror image ────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', false);
select assert_eq(count(*), 1, 'bob: own org only')        from organizations;
select assert_eq(count(*), 0, 'bob: alice data hidden')   from customers where org_id = 'org_a';
select assert_eq(count(*), 1, 'bob: own balances only')   from invoice_balances;
reset role;

-- ── Anonymous sees nothing ──────────────────────────────────
set role anon;
do $$ begin
  perform 1 from customers;
  raise exception 'FAIL: anon read customers';
exception when insufficient_privilege then raise notice 'ok: anon denied';
end $$;
reset role;

-- ── A signed-in user with no org sees nothing ───────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', false);
select assert_eq(count(*), 0, 'orgless user sees no orgs')      from organizations;
select assert_eq(count(*), 0, 'orgless user sees no invoices')  from invoices;
select assert_eq(count(*), 0, 'orgless user sees no balances')  from invoice_balances;
reset role;

-- ── Archiving an org revokes access ─────────────────────────
update organizations set archived_at = now() where id = 'org_a';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', false);
select assert_eq(count(*), 0, 'archived org revokes access')   from organizations;
select assert_eq(count(*), 0, 'archived org hides customers')  from customers;
reset role;

\echo ''
\echo '===================================='
\echo ' ALL RLS ISOLATION TESTS PASSED'
\echo '===================================='
