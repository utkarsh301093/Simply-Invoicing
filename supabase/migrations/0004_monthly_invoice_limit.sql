-- ============================================================================
-- Monthly invoice cap, per user.
--
-- Enforced by a trigger rather than by JS, for the same reason invoice
-- numbering and item uniqueness are: there are three ways an invoice gets
-- created (POST /api/invoices, POST /api/recurring/:id/run, and the hourly
-- sweep), and a JS check would have to be repeated at each one and remembered
-- at the next. The trigger is the one place that cannot be bypassed.
--
-- Editing a user's limit: change user_limits.monthly_invoice_limit in the
-- Supabase table editor. A row is created automatically the first time a user
-- generates an invoice, so every active user shows up there. Inserting a row
-- ahead of time also works.
-- ============================================================================

begin;

create table if not exists user_limits (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  monthly_invoice_limit  integer not null default 30 check (monthly_invoice_limit >= 0),
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table  user_limits is 'Per-user quotas. Edit monthly_invoice_limit here to raise or lower a cap.';
comment on column user_limits.monthly_invoice_limit is 'Invoices this user may create per UTC calendar month. 0 blocks all creation.';
comment on column user_limits.note is 'Free text, e.g. why a limit was raised. Ignored by the app.';

create trigger user_limits_updated_at before update on user_limits
  for each row execute function set_updated_at();

-- Deny-all: enabled with no policy, and no grants to anon/authenticated. A user
-- must not be able to read or raise their own cap. Only the service role (and
-- the Supabase dashboard) can touch it.
alter table user_limits enable row level security;

-- ── Usage counting ──────────────────────────────────────────────────────────
-- One definition of "invoices this month", shared by the trigger and the API so
-- the number the user is shown is the number they are judged against.
--
-- Counts EVERY invoice created in the window, including archived ones. Archiving
-- is a soft delete, so excluding them would let a user delete and recreate
-- indefinitely — the cap would stop meaning anything.
--
-- The window is the UTC calendar month. The app stores no per-org timezone, so
-- there is nothing better to key off; a user near a date line may see the reset
-- happen up to a day away from their local month boundary.
create or replace function public.monthly_invoice_count(target_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from invoices i
  join organizations o on o.id = i.org_id
  where o.owner_user_id = target_user
    and i.created_at >= date_trunc('month', (now() at time zone 'utc')) at time zone 'utc';
$$;

create or replace function public.monthly_invoice_limit_for(target_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select monthly_invoice_limit from user_limits where user_id = target_user),
    30  -- default for a user with no row yet
  );
$$;

-- What the signed-in user may see about their own quota. Takes no argument on
-- purpose: a user cannot ask about anybody else.
create or replace function public.my_invoice_usage()
returns table (used integer, allowed integer)
language sql
stable
security definer
set search_path = public
as $$
  select public.monthly_invoice_count(auth.uid()), public.monthly_invoice_limit_for(auth.uid());
$$;

revoke all on function public.monthly_invoice_count(uuid) from public, anon, authenticated;
revoke all on function public.monthly_invoice_limit_for(uuid) from public, anon, authenticated;
revoke all on function public.my_invoice_usage() from public, anon;
grant execute on function public.my_invoice_usage() to authenticated;

-- ── Enforcement ─────────────────────────────────────────────────────────────
create or replace function public.enforce_monthly_invoice_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
  cap   integer;
  used  integer;
begin
  select o.owner_user_id into owner from organizations o where o.id = new.org_id;

  -- Orgs predating auth have no owner, so there is no user to bill the quota
  -- to. Let those through rather than blocking the app on legacy data.
  if owner is null then
    return new;
  end if;

  -- Materialize the row so the limit is visible and editable in the dashboard,
  -- then lock it. The lock serializes concurrent inserts by the same user;
  -- without it two requests could both read used = cap - 1 and both succeed.
  insert into user_limits (user_id) values (owner) on conflict (user_id) do nothing;
  select monthly_invoice_limit into cap from user_limits where user_id = owner for update;

  used := public.monthly_invoice_count(owner);

  if used >= cap then
    raise exception
      'Monthly invoice limit reached (% of % used). The limit resets on %.',
      used, cap, to_char(date_trunc('month', (now() at time zone 'utc')) + interval '1 month', 'FMDD Mon YYYY')
      using errcode = 'IL001';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_monthly_limit on invoices;
create trigger invoices_monthly_limit
  before insert on invoices
  for each row execute function public.enforce_monthly_invoice_limit();

commit;
