-- ============================================================================
-- Fix: archiving an organization was impossible under the 0002 policies.
--
-- 0002 wrote the org policies as:
--     using (owner_user_id = auth.uid() and archived_at is null)
--
-- Soft-deleting an org sets archived_at, which makes the NEW row fail that same
-- predicate. Postgres rejects the statement with "new row violates row-level
-- security policy", so DELETE /api/orgs/:id returned a 500 and the org could
-- never be archived. The characterization suite caught this at step 47.
--
-- The underlying mistake was conceptual: RLS answers "is this row yours", not
-- "is it still active". Archival is an application-level filter and every read
-- path in db.js already applies `archived_at is null` itself. Mixing lifecycle
-- state into a security predicate turns any soft-delete into a policy violation.
--
-- owns_org() deliberately KEEPS its archived_at check: archiving an org should
-- still hide its customers and invoices, and that path does not update the org
-- row, so it has no such conflict.
-- ============================================================================

begin;

drop policy if exists org_select on organizations;
create policy org_select on organizations for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists org_update on organizations;
create policy org_update on organizations for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

commit;
