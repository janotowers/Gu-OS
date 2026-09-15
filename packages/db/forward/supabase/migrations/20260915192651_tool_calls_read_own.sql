-- 20260915192651_tool_calls_read_own.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql) is applied separately by
-- the ordered-apply bootstrap path and is never touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.


-- ============================================================
-- R1 — Cycle 3 order 5 · Slice Plan §8 Q9, decided by the Accountable on
-- 2026-09-15: `tool_calls` is READ-OWN and NOT USER-WRITABLE.
--
-- WHAT CHANGES
--
-- Since 00001 the table's only policy, "Users can manage own tool calls", was
-- FOR ALL over the rows whose session the user owns. It granted every
-- authenticated user write authority over their own audit rows — insert,
-- update and delete, not only select. (Where no WITH CHECK is given,
-- PostgreSQL reuses the applicable USING expression for the rows a write
-- creates or changes, so the one ownership condition governed every command.)
-- The subject of an audit record could create, alter or erase it.
--
-- After this migration:
--   * an authenticated user READS the rows of their own sessions, exactly as
--     before — the chat page and its sync route read them that way;
--   * no user session can insert, update or delete a row: no policy grants
--     it, so row-level security refuses it;
--   * writes stay on the application path, which uses the service role for
--     every tool_calls write (checked 2026-09-15: the agent graph and its
--     tools, the chat, confirm, Telegram, cron, notification and
--     tool-readiness routes, and the operational-case helpers). The policy
--     below states that path; in hosted Supabase the service role bypasses
--     row-level security regardless.
--
-- Proven by the DB-backed suite (packages/db/test-rls/run.ts, "Cycle 3 order
-- 5"): own-read, cross-user and anon denial, user INSERT / UPDATE / DELETE
-- refused, and the service role still opening and closing rows.
--
-- ROLLBACK: drop the two policies below and recreate the 00001 policy
-- (FOR ALL, USING session ownership). No data changes in either direction.
-- ============================================================

drop policy if exists "Users can manage own tool calls" on public.tool_calls;

create policy "Service role manages tool calls"
  on public.tool_calls for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Users read own tool calls"
  on public.tool_calls for select
  to authenticated
  using (
    exists (
      select 1 from public.agent_sessions s
      where s.id = tool_calls.session_id
        and s.user_id = auth.uid()
    )
  );
