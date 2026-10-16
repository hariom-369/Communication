-- Database roles (least privilege; docs/deployment.md §5, ops/runbooks/secrets.md).
-- Run as the RDS master user (or a superuser locally) against the application database before
-- the first migration and after every migration Job (idempotent):
--   psql "$MASTER_URL" -v ON_ERROR_STOP=1 -f ops/db/roles.sql
-- Passwords are not set here: set them from the secrets manager (ALTER ROLE … PASSWORD) or use
-- IAM authentication; never commit them.
--
--   tessera_migrator  owns the schema; the migration Job only (secret `migrate`)
--   tessera_app       API and admin API: read and write rows, no DDL, and the audit log is
--                     insert-only (no UPDATE, DELETE or TRUNCATE, on top of its trigger)
--   tessera_realtime  realtime gateway: reads sessions, memberships and blocks only
--   tessera_readonly  operators and the restore drill (verify-audit, row counts)

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['tessera_migrator', 'tessera_app', 'tessera_realtime', 'tessera_readonly']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', name);
    END IF;
  END LOOP;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO tessera_migrator, tessera_app, tessera_realtime, tessera_readonly', current_database());
  -- Trusted extensions (citext, pg_trgm) need CREATE on the database.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO tessera_migrator', current_database());
END
$$;

-- The caller must act for the migrator to set its default privileges.
GRANT tessera_migrator TO CURRENT_USER;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO tessera_migrator;
GRANT USAGE ON SCHEMA public TO tessera_app, tessera_realtime, tessera_readonly;
-- Existing tables created before this script (local databases) become the migrator's.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'tessera_migrator'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO tessera_migrator', t.tablename);
  END LOOP;
END
$$;

-- Tables the migrator creates from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE tessera_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tessera_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessera_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tessera_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessera_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO tessera_readonly;

-- Tables that exist now.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tessera_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tessera_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tessera_readonly;
-- Per-table rules, once the migrations have created the tables (this script runs before the
-- first migration, to set the default privileges, and after it).
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM tessera_app;
  END IF;
  IF to_regclass('public.sessions') IS NOT NULL THEN
    GRANT SELECT ON TABLE sessions, conversation_members, blocks TO tessera_realtime;
  END IF;
END
$$;
