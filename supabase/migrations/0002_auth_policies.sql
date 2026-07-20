-- ============================================================================
-- Multi-user activation: fills in the policies 0001 left commented out.
--
-- SAFE TO APPLY BEFORE THE SERVER MIGRATES. The server connects as `postgres`,
-- which OWNS these tables, and 0001 did not set FORCE ROW LEVEL SECURITY — so
-- policies do not apply to it. Adding them changes nothing at runtime today.
--
-- Do NOT add `force row level security` here. That is deliberately deferred to
-- 0003, after the server switches to per-request `set local role authenticated`
-- with the user's JWT. Enabling force while the server still relies on owner
-- bypass would make auth.uid() null for every query and take the app down.
--
-- Ordering:
--   0002 (this file)  policies exist, inert          → safe now
--   backfill          organizations.owner_user_id    → safe now
--   server change     connect as authenticated + JWT → policies start applying
--   0003              force row level security       → close the owner bypass
-- ============================================================================

begin;

-- Membership is resolved through the org, exactly as 0001 prescribed, so adding
-- a users/teams table later changes only this helper.
--
-- SECURITY DEFINER so the organizations lookup inside is not itself subject to
-- the organizations policy — without it the policy would recurse.
create or replace function public.owns_org(target_org_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organizations o
    where o.id = target_org_id
      and o.owner_user_id = auth.uid()
      and o.archived_at is null
  );
$$;

revoke all on function public.owns_org(text) from public, anon;
grant execute on function public.owns_org(text) to authenticated;

-- ── organizations ───────────────────────────────────────────────────────────
-- Visible only to its owner. No INSERT policy: creating an org must also set
-- owner_user_id, which the server does in one service-role transaction.
-- Letting `authenticated` insert freely would allow orphan orgs owned by nobody.
drop policy if exists org_select on organizations;
create policy org_select on organizations for select to authenticated
  using (owner_user_id = auth.uid() and archived_at is null);

drop policy if exists org_update on organizations;
create policy org_update on organizations for update to authenticated
  using (owner_user_id = auth.uid() and archived_at is null)
  with check (owner_user_id = auth.uid());

-- ── org-scoped tables ───────────────────────────────────────────────────────
-- Generated so all nine policies are byte-identical. Hand-writing them is how
-- one table quietly ends up with a weaker predicate than its neighbours.
do $$
declare t text;
begin
  foreach t in array array[
    'customers', 'tax_rates', 'items', 'recurring_schedules',
    'invoices', 'payments', 'reminders', 'activity',
    'invoice_line_items', 'schedule_line_items'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_rw', t);
    execute format(
      'create policy %I on %I for all to authenticated '
      'using (public.owns_org(org_id)) with check (public.owns_org(org_id))',
      t || '_rw', t
    );
  end loop;
end $$;

-- Both line-item tables carry their own org_id (not null, FK to organizations),
-- so they use the same predicate as everything else rather than joining through
-- the parent — same guarantee, and it hits the org_id index.

-- ── app_state ───────────────────────────────────────────────────────────────
-- Already keyed by user_id, so "which org is active" becomes per-user for free.
drop policy if exists app_state_rw on app_state;
create policy app_state_rw on app_state for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── integrations ────────────────────────────────────────────────────────────
-- Intentionally NO policy. Holds Gmail OAuth refresh tokens; must remain
-- reachable only by the service role regardless of who is signed in.

-- ── invoice_balances (view) ─────────────────────────────────────────────────
-- Postgres runs a view with its OWNER's privileges by default, which means a
-- plain view punches straight through RLS: `authenticated` would read every
-- org's balances regardless of the policies above. security_invoker makes the
-- view execute as the caller, so the underlying invoices/payments policies
-- apply. Without this line the whole migration is decorative.
alter view invoice_balances set (security_invoker = true);

-- Table privileges. RLS narrows these per row; without them the policies are
-- never even consulted.
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  customers, tax_rates, items, recurring_schedules, invoices,
  invoice_line_items, schedule_line_items, payments, reminders, activity, app_state
  to authenticated;
grant select, update on organizations to authenticated;
grant select on invoice_balances to authenticated;
-- anon is granted nothing: every data route requires a signed-in user.

commit;
