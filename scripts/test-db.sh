#!/usr/bin/env bash
# Throwaway Postgres for the test suite. The suite truncates every table, so it
# must never run against a real project — this gives it a local target.
#
#   ./scripts/test-db.sh up     # start + apply schema, print TEST_DATABASE_URL
#   ./scripts/test-db.sh down   # remove the container
set -euo pipefail

NAME=invoicing-test-db
PORT=55434
URL="postgresql://postgres:test@127.0.0.1:${PORT}/invoicing_test"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-up}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      -e POSTGRES_PASSWORD=test -e POSTGRES_DB=invoicing_test \
      -p "${PORT}:5432" postgres:16-alpine >/dev/null

    printf 'waiting for postgres'
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -U postgres -d invoicing_test >/dev/null 2>&1; then break; fi
      printf '.'; sleep 1
    done
    echo

    # Stub the Supabase-managed pieces the schema and RLS policies depend on:
    # auth.users (referenced by organizations.owner_user_id), auth.uid() (read by
    # every policy) and the anon/authenticated/service_role roles the server
    # switches into per request.
    docker exec -i "$NAME" psql -U postgres -d invoicing_test -v ON_ERROR_STOP=1 -q <<'SQL'
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

    # Every migration, not just the first — the policies live in 0002.
    for f in "$ROOT"/supabase/migrations/*.sql; do
      docker exec -i "$NAME" psql -U postgres -d invoicing_test -v ON_ERROR_STOP=1 -q < "$f"
    done

    echo "test database ready"
    echo "TEST_DATABASE_URL=$URL"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "$NAME not running"
    ;;
  *)
    echo "usage: $0 [up|down]" >&2; exit 1 ;;
esac
