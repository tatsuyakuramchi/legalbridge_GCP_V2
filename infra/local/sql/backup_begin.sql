-- =====================================================================
-- 予備系で書き始める（ops backup-begin が流す）。docs/v3-backup-merge.md
--
-- 本番が止まっている間、予備系（ローカル）を正として書き込む。復旧したあと、本番にも
-- 書き込みがあっても持ち帰れるように、ここから先のローカルの変更を全部記録する。
--
--   1. backup スキーマに、記録の表（sessions・changes）と記録の関数を作る
--   2. v3 の全部の表（採番表 document_sequences を除く）に記録の引き金を付ける
--      （変わった行の前と後を、行ごとに backup.changes へ。引き金は v3 の外の関数）
--   3. v3 の連番（id）を :id_base 以上に進める。予備系で作った行の id が、止まっている
--      間に本番で作られた行の id とぶつからないようにする（持ち帰るとき id をそのまま入れる）
--
-- 文書番号などの業務番号は、アプリの番号帯（NUMBER_BAND=backup、9000 番台）で分ける。
-- 採番表 document_sequences は記録しない（予備系の帯の行は持ち帰らない）。
--
-- 写しを入れ直した直後に流すこと。写しの後にローカルで書いた分は記録されず、持ち帰れない。
-- 1 つの取引で行う。途中で失敗すれば何も変わらない。
-- =====================================================================
\set ON_ERROR_STOP on

\if :{?id_base}
\else
  \set id_base 1000000000
\endif
\if :{?data_stamp}
\else
  \set data_stamp ''
\endif
\if :{?started_by}
\else
  \set started_by 'ops'
\endif

BEGIN;

CREATE SCHEMA IF NOT EXISTS backup;

CREATE TABLE IF NOT EXISTS backup.sessions (
  id           serial PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  started_by   text,
  -- 予備系に入っていた写しの時点（SYNC_STAMP）。
  data_stamp   text,
  id_base      bigint NOT NULL,
  exported_at  timestamptz,
  closed_at    timestamptz,
  note         text
);

-- 変わった行。行の値は to_jsonb の形（表の全部の列）。pk は主キーの列だけ。
CREATE TABLE IF NOT EXISTS backup.changes (
  seq         bigserial PRIMARY KEY,
  session_id  int NOT NULL REFERENCES backup.sessions(id),
  txid        bigint NOT NULL DEFAULT txid_current(),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_name  text NOT NULL,
  op          text NOT NULL CHECK (op IN ('I', 'U', 'D')),
  pk          jsonb NOT NULL,
  old         jsonb,
  new         jsonb
);
CREATE INDEX IF NOT EXISTS changes_session_idx ON backup.changes (session_id, table_name, seq);

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM backup.sessions WHERE closed_at IS NULL) THEN
    RAISE EXCEPTION '予備系の書き込みはもう始まっています（backup-status で確認）。閉じるのは本番へ持ち帰ってから backup-close';
  END IF;
END
$guard$;

INSERT INTO backup.sessions (started_by, data_stamp, id_base)
VALUES (:'started_by', NULLIF(:'data_stamp', ''), :id_base);

-- 記録の関数。引き金の引数は主キーの列名。主キーが変わる更新は「消して足す」で記録する
-- （持ち帰るとき主キーで行を探すため）。アプリのロールでも書けるよう SECURITY DEFINER。
CREATE OR REPLACE FUNCTION backup.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, backup AS $fn$
DECLARE
  sid int;
  o jsonb; n jsonb; po jsonb; pn jsonb;
BEGIN
  SELECT id INTO sid FROM backup.sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1;
  IF sid IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN
    o := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, o -> k) INTO po FROM unnest(TG_ARGV) k;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := to_jsonb(NEW);
    SELECT jsonb_object_agg(k, n -> k) INTO pn FROM unnest(TG_ARGV) k;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF o = n THEN RETURN NULL; END IF;
    IF po <> pn THEN
      INSERT INTO backup.changes (session_id, table_name, op, pk, old, new)
      VALUES (sid, TG_TABLE_NAME, 'D', po, o, NULL), (sid, TG_TABLE_NAME, 'I', pn, NULL, n);
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO backup.changes (session_id, table_name, op, pk, old, new)
  VALUES (sid, TG_TABLE_NAME, left(TG_OP, 1), COALESCE(pn, po), o, n);
  RETURN NULL;
END
$fn$;

-- 引き金を付ける。採番表は持ち帰らない（予備系の番号帯で分けてある）。
DO $install$
DECLARE r record; cols text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'v3' AND c.relkind = 'r' AND c.relname <> 'document_sequences'
     ORDER BY c.relname
  LOOP
    SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY array_position(i.indkey, a.attnum))
      INTO cols
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = r.oid AND i.indisprimary;
    IF cols IS NULL THEN
      RAISE EXCEPTION 'v3.% に主キーがありません。持ち帰るとき行を特定できないので止めます', r.relname;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS zz_backup_capture ON v3.%I', r.relname);
    EXECUTE format('CREATE TRIGGER zz_backup_capture AFTER INSERT OR UPDATE OR DELETE ON v3.%I '
                   'FOR EACH ROW EXECUTE FUNCTION backup.capture(%s)', r.relname, cols);
  END LOOP;
END
$install$;

-- 連番（id）を :id_base 以上へ。既に帯の中まで進んでいれば（2 回目の停止など）その続きから。
DO $seq$
DECLARE r record; top bigint; base bigint;
BEGIN
  SELECT id_base INTO base FROM backup.sessions WHERE closed_at IS NULL;
  FOR r IN
    SELECT s.oid::regclass AS seq, t.relname AS tbl, a.attname AS col
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE s.relkind = 'S' AND ns.nspname = 'v3'
  LOOP
    EXECUTE format('SELECT COALESCE(max(%I), 0) FROM v3.%I', r.col, r.tbl) INTO top;
    PERFORM setval(r.seq, GREATEST(base, top + 1), false);
  END LOOP;
END
$seq$;

COMMIT;

SELECT id AS "記録の番号", started_at AS "始めた時刻", data_stamp AS "写しの時点", id_base AS "id の起点"
  FROM backup.sessions WHERE closed_at IS NULL;
