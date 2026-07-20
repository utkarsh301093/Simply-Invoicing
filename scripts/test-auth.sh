#!/usr/bin/env bash
# End-to-end auth + tenant-isolation test against a throwaway Postgres.
# No Supabase project, no credentials, nothing touches production.
#
#   ./scripts/test-auth.sh
set -euo pipefail

NAME=invoicing-auth-test
PORT=55435
URL="postgresql://postgres:test@127.0.0.1:${PORT}/invoicing_auth"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "→ starting postgres"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=invoicing_auth \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null

printf '→ waiting'
for _ in $(seq 1 60); do
  docker exec "$NAME" psql -U postgres -d invoicing_auth -c "select 1" >/dev/null 2>&1 && break
  printf '.'; sleep 0.5
done
echo

run() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoicing_auth "$@"; }

# The Supabase-managed pieces the schema and policies depend on.
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

echo "→ running auth isolation test"
cd "$ROOT"
TEST_DATABASE_URL="$URL" node --test test/auth-isolation.test.js
