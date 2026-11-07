-- 203_retire_v2_schema.sql を戻す（legacy_v2 の表・ビュー・連番を public へ戻す）。
DO $$
DECLARE r record; kind text;
BEGIN
  IF to_regnamespace('legacy_v2') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'legacy_v2' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                             AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    kind := CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                           WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END;
    EXECUTE format('ALTER %s legacy_v2.%I SET SCHEMA public', kind, r.relname);
  END LOOP;
  RAISE NOTICE 'legacy_v2 の表を public へ戻しました';
END $$;
