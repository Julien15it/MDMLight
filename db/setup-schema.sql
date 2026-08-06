-- One-off setup on the shared instance sap-mcp-postgres-aidataenabler.
-- Run as the bound user of the existing binding, against database JeKIkfeREeNq.
--
-- The instance is shared with the AI Data Enabler MCP app, so MDMLight gets
-- its own schema. CAP has no 'schema' credential, so isolation is done with a
-- role-level search_path: every connection from the app role then resolves to
-- the mdmlight schema without any client-side configuration.

-- Option A (preferred) - dedicated role, full isolation.
-- Needs CREATEROLE on the bound user.
CREATE ROLE mdmlight_app LOGIN PASSWORD 'mdmlight_admin';
CREATE SCHEMA mdmlight AUTHORIZATION mdmlight_app;
ALTER ROLE mdmlight_app SET search_path = mdmlight;
GRANT CONNECT ON DATABASE "JeKIkfeREeNq" TO mdmlight_app;

-- Fail-safe, not just isolation. If search_path ever falls back to public,
-- cds-deploy must error rather than create tables next to the other app's -
-- above all its cds_model, which CAP overwrites and diffs against.
REVOKE CREATE ON SCHEMA public FROM mdmlight_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mdmlight_app;

-- Protects the other app from connection starvation on the free plan,
-- independent of whatever pool size CAP decides to use.
ALTER ROLE mdmlight_app CONNECTION LIMIT 5;

-- Option B (fallback) - if CREATEROLE is denied, reuse the existing role.
-- Note this also changes the other app's default resolution order; public stays
-- second so its existing tables still resolve, but any table it creates without
-- an explicit schema would land in mdmlight.
--
--   CREATE SCHEMA mdmlight AUTHORIZATION "bb30cb9661b0";
--   ALTER ROLE "bb30cb9661b0" IN DATABASE "JeKIkfeREeNq"
--     SET search_path = mdmlight, public;

-- ---------------------------------------------------------------------------
-- Verify BEFORE deploying. Connect as mdmlight_app and run all four.
-- ---------------------------------------------------------------------------
-- 1. Must return 'mdmlight'.
--      SHOW search_path;
--      SELECT current_schema();
--
-- 2. Must fail with "permission denied for schema public". If it succeeds,
--    the fail-safe is not in place - stop and fix before deploying.
--      CREATE TABLE public.mdmlight_canary (id int);
--
-- 3. Must land in mdmlight, then clean up.
--      CREATE TABLE canary (id int);
--      SELECT schemaname FROM pg_tables WHERE tablename = 'canary';
--      DROP TABLE canary;
--
-- 4. Headroom check, as the original bound user. Compare in use against max
--    before adding this app's 5.
--      SELECT count(*) AS in_use, current_setting('max_connections') AS max
--        FROM pg_stat_activity;
--
-- Also record what is already there, so any later surprise is diagnosable:
--      SELECT schemaname, tablename FROM pg_tables
--       WHERE schemaname NOT IN ('pg_catalog','information_schema')
--       ORDER BY 1, 2;
