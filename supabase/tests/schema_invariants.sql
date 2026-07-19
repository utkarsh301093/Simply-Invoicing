-- Prove the schema enforces the invariants the JSON store only enforced in JS.
\set ON_ERROR_STOP on

insert into organizations (id, name, business_name, currency, invoice_prefix, next_number)
values ('org_a', 'Acme', 'Acme', '₹', 'ACME-', 1),
       ('org_b', 'Initech', 'Initech', '$', 'INI-', 1);

insert into customers (id, org_id, name) values ('cust_1', 'org_a', 'Globex');

-- 1. Atomic invoice numbering (replaces the read-modify-write race).
update organizations set next_number = next_number + 1
  where id = 'org_a' returning next_number - 1 as issued_number \gset
select :issued_number = 1 as "1_atomic_numbering_returns_1";

-- 2. Invoice number unique per org, but the same number is fine in another org.
insert into invoices (id, org_id, number, customer_id, total)
values ('inv_1', 'org_a', 'ACME-1', 'cust_1', 35400);
insert into invoices (id, org_id, number, total)
values ('inv_b', 'org_b', 'ACME-1', 0);
select 'ok' as "2_same_number_different_org_allowed";

do $$ begin
  insert into invoices (id, org_id, number, total) values ('inv_dup', 'org_a', 'ACME-1', 0);
  raise exception 'FAIL: duplicate invoice number was accepted';
exception when unique_violation then
  raise notice 'PASS 3: duplicate invoice number rejected';
end $$;

-- 4. Case-insensitive item de-dupe per org.
insert into items (id, org_id, name, default_rate) values ('item_1', 'org_a', 'Consulting hour', 2500);
do $$ begin
  insert into items (id, org_id, name, default_rate) values ('item_2', 'org_a', 'consulting HOUR', 3000);
  raise exception 'FAIL: case-variant duplicate item accepted';
exception when unique_violation then
  raise notice 'PASS 4: case-insensitive item name de-dupe enforced';
end $$;

-- 5. Archiving frees the name (partial index only covers active rows).
update items set archived_at = now() where id = 'item_1';
insert into items (id, org_id, name, default_rate) values ('item_2', 'org_a', 'consulting HOUR', 3000);
select 'ok' as "5_archived_name_is_reusable";

-- 6. Ledger math via invoice_balances, including the overpayment case the
--    current app produces (pay-with-no-amount on a partially paid invoice).
insert into payments (id, org_id, invoice_id, amount) values ('pay_1', 'org_a', 'inv_1', 5000);
select amount_paid = 5000 and balance_due = 30400 and is_paid = false
  as "6a_partial_payment"
from invoice_balances where invoice_id = 'inv_1';

insert into payments (id, org_id, invoice_id, amount) values ('pay_2', 'org_a', 'inv_1', 35400);
select amount_paid = 40400 and balance_due = 0 and is_paid = true
  as "6b_overpayment_reported_not_hidden"
from invoice_balances where invoice_id = 'inv_1';

-- 7. Unpay = archive; the view must stop counting archived entries.
update payments set archived_at = now() where invoice_id = 'inv_1';
select amount_paid = 0 and balance_due = 35400 and is_paid = false
  as "7_unpay_reverts_balance"
from invoice_balances where invoice_id = 'inv_1';

-- 8. One pending reminder per (invoice, date); cancelled ones don't block.
insert into reminders (id, org_id, invoice_id, due_on, status)
values ('rem_1', 'org_a', 'inv_1', '2030-01-13', 'pending');
do $$ begin
  insert into reminders (id, org_id, invoice_id, due_on, status)
  values ('rem_2', 'org_a', 'inv_1', '2030-01-13', 'pending');
  raise exception 'FAIL: duplicate pending reminder accepted';
exception when unique_violation then
  raise notice 'PASS 8: duplicate pending reminder rejected';
end $$;

update reminders set status = 'cancelled' where id = 'rem_1';
insert into reminders (id, org_id, invoice_id, due_on, status)
values ('rem_2', 'org_a', 'inv_1', '2030-01-13', 'pending');
select 'ok' as "9_cancelled_reminder_does_not_block_reschedule";

-- 10. Bad reminder status is rejected by the check constraint.
do $$ begin
  insert into reminders (id, org_id, invoice_id, due_on, status)
  values ('rem_bad', 'org_a', 'inv_1', '2030-02-01', 'exploded');
  raise exception 'FAIL: invalid reminder status accepted';
exception when check_violation then
  raise notice 'PASS 10: invalid reminder status rejected';
end $$;

-- 11. Line item ordering is preserved and positions are unique per invoice.
insert into invoice_line_items (id, invoice_id, org_id, position, description, quantity, rate, tax_percent)
values ('li_1', 'inv_1', 'org_a', 0, 'Consulting hour', 12, 2500, 18),
       ('li_2', 'inv_1', 'org_a', 1, 'Setup fee', 1, 10000, 18);
do $$ begin
  insert into invoice_line_items (id, invoice_id, org_id, position, description)
  values ('li_dup', 'inv_1', 'org_a', 0, 'collision');
  raise exception 'FAIL: duplicate line position accepted';
exception when unique_violation then
  raise notice 'PASS 11: duplicate line item position rejected';
end $$;

-- 12. Deleting a customer with invoices is blocked (on delete restrict), so
--     history cannot be orphaned. Archival remains the supported path.
do $$ begin
  delete from customers where id = 'cust_1';
  raise exception 'FAIL: customer with invoices was deleted';
exception when foreign_key_violation then
  raise notice 'PASS 12: cannot hard-delete a customer that has invoices';
end $$;

-- 13. Deleting an org cascades to all its tenant data.
delete from organizations where id = 'org_b';
select count(*) = 0 as "13_org_delete_cascades"
from invoices where org_id = 'org_b';

-- 14. Money keeps exact decimal semantics (this is 0.3, not 0.30000000000000004).
insert into invoices (id, org_id, number, total) values ('inv_money', 'org_a', 'ACME-money', 0.1);
insert into payments (id, org_id, invoice_id, amount) values ('pay_m1', 'org_a', 'inv_money', 0.1),
                                                             ('pay_m2', 'org_a', 'inv_money', 0.2);
select amount_paid = 0.30 as "14_numeric_money_is_exact"
from invoice_balances where invoice_id = 'inv_money';

-- 15. RLS denies a non-service role on every table.
create role anon_test nologin;
grant usage on schema public to anon_test;
grant select, insert, update, delete on all tables in schema public to anon_test;
set role anon_test;
select count(*) = 0 as "15a_rls_blocks_select_for_anon" from invoices;
do $$ begin
  insert into invoices (id, org_id, number, total) values ('inv_evil', 'org_a', 'EVIL-1', 0);
  raise exception 'FAIL: anon role inserted through RLS';
exception when insufficient_privilege then
  raise notice 'PASS 15b: RLS blocked anon insert';
end $$;
reset role;

-- 16. Confirm RLS is actually enabled on every table (not just intended).
select count(*) as tables_without_rls
from pg_tables t
where t.schemaname = 'public'
  and not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity
  );
