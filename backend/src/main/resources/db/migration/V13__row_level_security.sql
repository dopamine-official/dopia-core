-- Supabase serves every table in `public` over its Data API to whoever holds the project's
-- anon key, unless row level security is on. Only this server reads and writes these tables:
-- it connects as their owner, and an owner is not subject to row level security. With RLS on
-- and no policy, every other role sees no rows and can change none.

DO
$$
DECLARE
    target record;
BEGIN
    FOR target IN
        -- Flyway holds a lock on its own history table while this runs; altering it would wait forever.
        -- It lists migration file names only.
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = current_user AND tablename <> 'flyway_schema_history'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.tablename);
    END LOOP;
END
$$;

-- A view reads with its owner's rights by default, which would step around the tables' RLS.
ALTER VIEW character_review_queue SET (security_invoker = true);
