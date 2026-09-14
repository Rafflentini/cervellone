-- La fotografia dello schema, per il guardiano della deriva repo-database.
--
-- Serve perche' PostgREST espone solo gli schemi dichiarati: il client non
-- puo' leggere information_schema. Sola lettura, e solo per il service_role:
-- la forma del proprio schema non e' una cosa che si racconta a chi passa.

CREATE OR REPLACE FUNCTION public.fotografia_schema()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT jsonb_build_object(
    'tabelle', (
      SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ),
    'colonne', (
      SELECT coalesce(jsonb_agg(table_name || '.' || column_name ORDER BY table_name, column_name), '[]'::jsonb)
      FROM information_schema.columns WHERE table_schema = 'public'
    ),
    'chiaviPrimarie', (
      SELECT coalesce(jsonb_object_agg(t.tabella, t.colonne), '{}'::jsonb) FROM (
        SELECT c.conrelid::regclass::text AS tabella,
               jsonb_agg(a.attname ORDER BY a.attname) AS colonne
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'p'
        GROUP BY c.conrelid
      ) t
    ),
    'indici', (
      SELECT coalesce(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
      FROM pg_indexes WHERE schemaname = 'public'
    ),
    'chiaviConfig', (
      SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM public.cervellone_config
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.fotografia_schema() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fotografia_schema() TO service_role;
