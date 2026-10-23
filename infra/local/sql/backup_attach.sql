-- =====================================================================
-- 記録の引き金を、あとから作った表にも付ける（ops backup-attach が流す）。docs/v3-backup-merge.md
--
-- backup-begin は、そのとき v3 にあった表にだけ引き金を付ける。停止中に移行 SQL で表を足すと
-- （172 の document_parties・agreement_successions など）、その表の行は記録されず持ち帰れない。
-- ここで、引き金の無い v3 の表に引き金を付け、いま入っている行を「足した行」として記録する
-- （本番に同じ行があれば持ち帰りで「済み」になるだけなので、重ねて流しても二重にはならない）。
-- 採番表 document_sequences は対象外。記録が始まっていなければ何もしない。
-- =====================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $attach$
DECLARE r record; cols text; sid int; n bigint;
BEGIN
  SELECT id INTO sid FROM backup.sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1;
  IF sid IS NULL THEN
    RAISE EXCEPTION '予備系の書き込みは始まっていません（ops backup-begin で始める）';
  END IF;
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'v3' AND c.relkind = 'r' AND c.relname <> 'document_sequences'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'zz_backup_capture')
     ORDER BY c.relname
  LOOP
    SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY array_position(i.indkey, a.attnum))
      INTO cols
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = r.oid AND i.indisprimary;
    IF cols IS NULL THEN
      RAISE EXCEPTION 'v3.% に主キーがありません。持ち帰るとき行を特定できないので止めます', r.relname;
    END IF;
    EXECUTE format('CREATE TRIGGER zz_backup_capture AFTER INSERT OR UPDATE OR DELETE ON v3.%I '
                   'FOR EACH ROW EXECUTE FUNCTION backup.capture(%s)', r.relname, cols);
    -- いま入っている行を「足した行」として記録する（この表は記録の後に作られたので、全部が予備系の行）。
    EXECUTE format(
      'INSERT INTO backup.changes (session_id, table_name, op, pk, old, new) '
      'SELECT %s, %L, ''I'', (SELECT jsonb_object_agg(k, to_jsonb(t) -> k) FROM unnest(ARRAY[%s]) k), NULL, to_jsonb(t) '
      '  FROM v3.%I t',
      sid, r.relname, cols, r.relname);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '引き金を付けた: v3.%（いまの行 % 件を記録）', r.relname, n;
  END LOOP;
END
$attach$;

COMMIT;

SELECT c.relname AS "引き金の無い表（0 行なら全部に付いている）"
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
 WHERE ns.nspname = 'v3' AND c.relkind = 'r' AND c.relname <> 'document_sequences'
   AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'zz_backup_capture');
