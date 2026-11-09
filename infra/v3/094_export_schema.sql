-- =====================================================================
-- 本番 v3 の「表の作り（定義）」を Cloud SQL Studio から取り出す（読むだけ・何も書き換えない）
--
--   アプリ（Cloud Run）が止まっていてバックアップの ZIP を落とせないときに、
--   094_export_rows.sql（中身）と一緒に使う。手元の 001/004 は本番に当てた後追いの変更を
--   全部は持っていないので、中身だけを入れると「手元の定義に無い列」で止まる。
--   この結果を同じフォルダに置くと、ops import-rows が表をこの定義で作り直してから中身を入れる。
--
--   使い方:
--     下の SELECT を 1 回流して、結果を CSV で落とす（見出しは schema_seq,schema_b64 の 2 列）。
--     094_export_rows.sql で落とした CSV と同じ infra/local/dumps/rows/ に置いて
--       docker compose run --rm ops import-rows /dumps/rows
--
--   1 行が 1 文。本文は改行を含むので base64 にしてある（Studio の CSV で崩れないように）。
--   アプリのバックアップ（apps/legalbridge-v3/src/server/ops/backup.ts の schemaSql）と同じ組み立て方：
--     拡張機能 → 型 → 連番 → 関数 → 表 → 連番の持ち主 → 主キー・一意・CHECK → 外部キー → 索引
--     → ビュー（依存の順）→ 引き金 → 連番の現在値 → 説明。権限は手元の 003_grants.sql で当て直す。
--   PDF の作り置き（document_pdfs）の表も作る（中身は 094_export_rows.sql が入れない）。
-- =====================================================================

WITH RECURSIVE
ns AS (SELECT oid FROM pg_namespace WHERE nspname = 'v3'),
ext_owned AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e'),
-- ビューの深さ（ほかのビューを使うビューはあとに作る）
vdeps AS (
  SELECT DISTINCT rw.ev_class AS v, d.refobjid AS dep
    FROM pg_rewrite rw JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
    JOIN pg_class dc ON dc.oid = d.refobjid AND dc.relkind IN ('v', 'm')
   WHERE d.refobjid <> rw.ev_class
),
vdepth (v, depth) AS (
  SELECT c.oid, 0 FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('v', 'm')
  UNION ALL
  SELECT d.v, vd.depth + 1 FROM vdeps d JOIN vdepth vd ON vd.v = d.dep WHERE vd.depth < 20
),
stmts (sec, k, stmt) AS (
  SELECT 0, '0', 'SET check_function_bodies = false;'
  UNION ALL SELECT 0, '1', 'SET client_min_messages = warning;'
  UNION ALL SELECT 0, '2', 'SET search_path = pg_catalog, public;'
  UNION ALL SELECT 1, '', 'CREATE SCHEMA IF NOT EXISTS v3;'
  -- 拡張機能（手元に無いものは知らせて続ける）
  UNION ALL
  SELECT 2, e.extname,
         format('DO $x$ BEGIN CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I; EXCEPTION WHEN OTHERS THEN RAISE NOTICE %L, SQLERRM; END $x$;',
                e.extname, n.nspname, '拡張機能 ' || e.extname || ' を入れられません: %')
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname <> 'plpgsql' AND n.nspname IN ('v3', 'public')
  -- 型：列挙
  UNION ALL
  SELECT 3, t.typname,
         format('CREATE TYPE v3.%I AS ENUM (%s);', t.typname,
                (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid))
    FROM pg_type t
   WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'e'
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_type'::regclass AND x.objid = t.oid)
  -- 型：ドメイン
  UNION ALL
  SELECT 4, t.typname,
         format('CREATE DOMAIN v3.%I AS %s%s%s;', t.typname, format_type(t.typbasetype, t.typtypmod),
                CASE WHEN t.typdefault IS NOT NULL THEN ' DEFAULT ' || t.typdefault ELSE '' END,
                CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END)
         || COALESCE((SELECT string_agg(format(E'\nALTER DOMAIN v3.%I ADD CONSTRAINT %I %s;', t.typname, c.conname, pg_get_constraintdef(c.oid)), '' ORDER BY c.conname)
                        FROM pg_constraint c WHERE c.contypid = t.oid), '')
    FROM pg_type t
   WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'd'
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_type'::regclass AND x.objid = t.oid)
  -- 型：複合型
  UNION ALL
  SELECT 5, t.typname,
         format('CREATE TYPE v3.%I AS (%s);', t.typname,
                (SELECT string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum)
                   FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped))
    FROM pg_type t JOIN pg_class c ON c.oid = t.typrelid
   WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'c' AND c.relkind = 'c'
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_type'::regclass AND x.objid = t.oid)
  -- 連番（identity の連番は表と一緒にできるので除く）
  UNION ALL
  SELECT 6, c.relname,
         format('CREATE SEQUENCE v3.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;',
                c.relname, format_type(s.seqtypid, NULL), s.seqincrement, s.seqmin, s.seqmax, s.seqstart, s.seqcache,
                CASE WHEN s.seqcycle THEN ' CYCLE' ELSE '' END)
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
   WHERE c.relnamespace = (SELECT oid FROM ns)
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_class'::regclass AND x.objid = c.oid)
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i')
  -- 関数
  UNION ALL
  SELECT 7, p.proname || ':' || p.oid::text, pg_get_functiondef(p.oid) || ';'
    FROM pg_proc p
   WHERE p.pronamespace = (SELECT oid FROM ns) AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_proc'::regclass AND x.objid = p.oid)
  -- 表（パーティションは親のあと）
  UNION ALL
  SELECT 8, (CASE WHEN c.relispartition THEN '1' ELSE '0' END) || c.relname,
         CASE WHEN c.relispartition THEN
           format('CREATE TABLE v3.%I PARTITION OF %s %s;', c.relname,
                  (SELECT i.inhparent::regclass::text FROM pg_inherits i WHERE i.inhrelid = c.oid), pg_get_expr(c.relpartbound, c.oid))
         ELSE
           format(E'CREATE TABLE v3.%I (\n%s\n)%s;', c.relname,
             (SELECT string_agg(
                format('  %I %s', a.attname, format_type(a.atttypid, a.atttypmod))
                || CASE WHEN a.attcollation <> 0 AND a.attcollation <> ty.typcollation
                        THEN (SELECT format(' COLLATE %I.%I', cn.nspname, co.collname)
                                FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation)
                        ELSE '' END
                || CASE WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY'
                        WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' ELSE '' END
                || CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                        WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END
                || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                E',\n' ORDER BY a.attnum)
                FROM pg_attribute a
                JOIN pg_type ty ON ty.oid = a.atttypid
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
             CASE WHEN c.relkind = 'p' THEN ' PARTITION BY ' || pg_get_partkeydef(c.oid) ELSE '' END)
         END
    FROM pg_class c
   WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_class'::regclass AND x.objid = c.oid)
  -- 連番の持ち主（serial）
  UNION ALL
  SELECT 9, s.relname, format('ALTER SEQUENCE v3.%I OWNED BY %s.%I;', s.relname, t.oid::regclass::text, a.attname)
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
   WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a'
     AND s.relnamespace = (SELECT oid FROM ns)
  -- 制約：主キー → 一意・CHECK・排他 → 外部キー
  UNION ALL
  SELECT CASE k.contype WHEN 'p' THEN 10 WHEN 'f' THEN 12 ELSE 11 END, c.relname || ':' || k.conname,
         format('ALTER TABLE v3.%I ADD CONSTRAINT %I %s;', c.relname, k.conname, pg_get_constraintdef(k.oid))
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE c.relnamespace = (SELECT oid FROM ns) AND k.contype IN ('p', 'u', 'c', 'x', 'f') AND k.conislocal AND k.conparentid = 0
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_class'::regclass AND x.objid = c.oid)
  -- 索引（制約が持つ索引・パーティションの子の索引を除く）
  UNION ALL
  SELECT 13, ic.relname, pg_get_indexdef(i.indexrelid) || ';'
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE ic.relnamespace = (SELECT oid FROM ns)
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x'))
     AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid)
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_class'::regclass AND x.objid = i.indrelid)
  -- ビュー（深い順に後ろ）
  UNION ALL
  SELECT 14, lpad((SELECT max(depth) FROM vdepth vd WHERE vd.v = c.oid)::text, 3, '0') || c.relname,
         CASE WHEN c.relkind = 'm'
              THEN format(E'CREATE MATERIALIZED VIEW v3.%I AS\n%s\nWITH NO DATA;', c.relname, rtrim(pg_get_viewdef(c.oid), ';'))
              ELSE format(E'CREATE VIEW v3.%I%s AS\n%s;', c.relname,
                          CASE WHEN c.reloptions IS NOT NULL THEN ' WITH (' || array_to_string(c.reloptions, ', ') || ')' ELSE '' END,
                          rtrim(pg_get_viewdef(c.oid), ';'))
         END
    FROM pg_class c
   WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('v', 'm')
     AND NOT EXISTS (SELECT 1 FROM ext_owned x WHERE x.classid = 'pg_class'::regclass AND x.objid = c.oid)
  -- 引き金
  UNION ALL
  SELECT 15, c.relname || ':' || t.tgname, pg_get_triggerdef(t.oid) || ';'
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = (SELECT oid FROM ns) AND NOT t.tgisinternal AND t.tgparentid = 0
  -- 連番の現在値
  UNION ALL
  SELECT 16, s.sequencename, format('SELECT setval(%L, %s, true);', format('v3.%I', s.sequencename), s.last_value)
    FROM pg_sequences s WHERE s.schemaname = 'v3' AND s.last_value IS NOT NULL
  -- 説明（表・ビュー・列）
  UNION ALL
  SELECT 17, c.relname,
         format('COMMENT ON %s v3.%I IS %L;', CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                c.relname, obj_description(c.oid, 'pg_class'))
    FROM pg_class c
   WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('r', 'p', 'v', 'm') AND obj_description(c.oid, 'pg_class') IS NOT NULL
  UNION ALL
  SELECT 18, c.relname || ':' || lpad(a.attnum::text, 4, '0'),
         format('COMMENT ON COLUMN v3.%I.%I IS %L;', c.relname, a.attname, col_description(c.oid, a.attnum))
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('r', 'p', 'v', 'm') AND col_description(c.oid, a.attnum) IS NOT NULL
)
SELECT row_number() OVER (ORDER BY sec, k) AS schema_seq,
       translate(encode(convert_to(stmt, 'UTF8'), 'base64'), E'\n', '') AS schema_b64
  FROM stmts
 ORDER BY 1;
