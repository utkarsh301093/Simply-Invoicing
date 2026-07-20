#!/usr/bin/env bash
# Prove the RLS policies in 0002_auth_policies.sql actually isolate tenants,
# using a throwaway Postgres container. No Supabase project or credentials.
#
#   ./scripts/test-rls.sh
set -euo pipefail

CONTAINER=invoicing-rls-test
IMAGE=postgres:16-alpine
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "→ starting $IMAGE"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=invoicing_rls "$IMAGE" >/dev/null

printf '→ waiting for postgres'
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -d invoicing_rls >/dev/null 2>&1 && break
  printf '.'; sleep 0.5
done
echo

run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d invoicing_rls "$@"; }

# Supabase-provided pieces the schema depends on. Local only.
echo "→ stubbing Supabase auth"
run -q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema auth to authenticated, service_role;
SQL

echo "→ applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  run -q < "$f"
done

echo "→ running isolation tests"
run < "$ROOT/supabase/tests/rls_isolation.sql"
