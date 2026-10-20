-- =====================================================================
-- 予備系の変更を本番へ持ち帰る：取り込みの本体（ops backup-export が、変更の行の後ろに付ける）。
-- docs/v3-backup-merge.md
--
-- この前に、生成したファイルの頭で次ができている:
--   merge_changes        持ち帰る変更（行ごとにまとめたもの。no の順に流す）
--   merge_local_columns  ローカルの v3 の列（本番の列と比べる）
--   psql の変数 merge_mode（check / apply）・merge_skip・merge_force・merge_db
--   （merge_show=表名,表名 を付けると、その表の持ち帰る行を 1 行ずつ出す）
--
-- 行ごとに 3 方向で比べる（写しの値＝old、ローカルの値＝new、本番のいまの値）:
--   足した行  本番に同じ主キーの行が無ければ足す。あって中身も同じなら済み。中身が違えばぶつかり
--   直した行  ローカルで直した列ごとに、本番の値が写しのままか、ローカルと同じ値なら直す。
--             本番でも同じ列を別の値に直していればぶつかり。ローカルが触っていない列は本番のまま
--   消した行  本番の行が写しのままなら消す。本番で直されていればぶつかり。もう無ければ済み
-- ぶつかった行は、merge_skip（本番を正として飛ばす）か merge_force（ローカルを正とする）に
-- 番号を入れて流し直す。
--
-- 流したあと、業務の決まり（訂正版と元が両方有効、同じ実績に二重の支払 など）を確かめ、
-- 取り込みで新しく崩れたものがあれば止める。
--
-- check は試すだけで必ず取り消す。apply は、ぶつかり・失敗・決まりの崩れが 1 件も無いときだけ確定する。
-- =====================================================================

SELECT current_database() = :'merge_db' AS db_ok \gset
\if :db_ok
\else
  \echo 'つないでいるデータベースが違います。何も変えていません。'
  ROLLBACK;
  \quit
\endif

-- 1. ローカルの列が本番に全部あるか（本番に 004_amend を当て忘れていないか）。
--    本番にしか無い列は構わない（足す行では既定値になり、直す行では触らない）。
DO $cols$
DECLARE diff text;
BEGIN
  SELECT string_agg(format('%s.%s', l.table_name, l.column_name), '、' ORDER BY l.table_name, l.column_name)
    INTO diff
    FROM merge_local_columns l
   WHERE l.table_name IN (SELECT DISTINCT table_name FROM merge_changes)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'v3' AND c.table_name = l.table_name AND c.column_name = l.column_name);
  IF diff IS NOT NULL THEN
    RAISE EXCEPTION 'ローカルにあって本番に無い列があります（先に本番へ 004_amend を当てる）: %', diff;
  END IF;
END
$cols$;

-- ローカルにしか無い PDF の保存先（/local-files/）は持ち帰らない。ひな形から作った文書は、
-- 本番で文書の本文から PDF を作り直す。比べる前に外しておく（外したあとの値で比べる）。
UPDATE merge_changes
   SET new = jsonb_set(new, '{storage_url}', 'null'::jsonb)
 WHERE table_name = 'documents' AND new ->> 'storage_url' LIKE '%/local-files/%'
   AND new ->> 'template_version_id' IS NOT NULL;
UPDATE merge_changes
   SET cols = (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(new) k WHERE (old -> k) IS DISTINCT FROM (new -> k))
 WHERE op = 'U' AND table_name = 'documents';
DELETE FROM merge_changes WHERE op = 'U' AND cols IS NULL;

CREATE TEMP TABLE merge_result (
  id      serial PRIMARY KEY,
  no      int,
  status  text NOT NULL,
  detail  text
) ON COMMIT DROP;

-- 2. 道具。行は主キー（pk）で探す。値は表の型に戻して比べる（文字の形で比べると、
--    時刻の書き方の違いなどで同じ値を違うと見てしまう）。
CREATE FUNCTION pg_temp.merge_pkcond(pk jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT string_agg(format('t.%1$I = k.%1$I', key), ' AND ' ORDER BY key) FROM jsonb_object_keys(pk) key
$fn$;

CREATE FUNCTION pg_temp.merge_exists(tbl text, pk jsonb) RETURNS boolean LANGUAGE plpgsql AS $fn$
DECLARE found boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$s t, jsonb_populate_record(NULL::%1$s, $1) k WHERE %2$s)',
                 tbl, pg_temp.merge_pkcond(pk))
    INTO found USING pk;
  RETURN found;
END
$fn$;

-- 本番のいまの値が ref と違う列（cols のうち）。
CREATE FUNCTION pg_temp.merge_diff(tbl text, pk jsonb, ref jsonb, cols text[]) RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE out text[];
BEGIN
  IF cols IS NULL OR cardinality(cols) = 0 THEN RETURN '{}'; END IF;
  EXECUTE format(
    'SELECT array_remove(ARRAY[%3$s]::text[], NULL) FROM %1$s t, jsonb_populate_record(NULL::%1$s, $1) k, '
    'jsonb_populate_record(NULL::%1$s, $2) r WHERE %2$s',
    tbl, pg_temp.merge_pkcond(pk),
    (SELECT string_agg(format('CASE WHEN t.%1$I IS DISTINCT FROM r.%1$I THEN %1$L END', c), ', ') FROM unnest(cols) c))
    INTO out USING pk, ref;
  RETURN COALESCE(out, '{}');
END
$fn$;

CREATE FUNCTION pg_temp.merge_insert(tbl text, val jsonb) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE cols text;
BEGIN
  SELECT string_agg(format('%I', k), ', ') INTO cols FROM jsonb_object_keys(val) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %3$s FROM jsonb_populate_record(NULL::%1$s, $1) r',
                 tbl, cols, (SELECT string_agg(format('r.%I', k), ', ') FROM jsonb_object_keys(val) k))
    USING val;
END
$fn$;

CREATE FUNCTION pg_temp.merge_update(tbl text, pk jsonb, val jsonb, cols text[]) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF cols IS NULL OR cardinality(cols) = 0 THEN RETURN; END IF;
  EXECUTE format(
    'UPDATE %1$s t SET %3$s FROM jsonb_populate_record(NULL::%1$s, $1) k, jsonb_populate_record(NULL::%1$s, $2) r WHERE %2$s',
    tbl, pg_temp.merge_pkcond(pk),
    (SELECT string_agg(format('%1$I = r.%1$I', c), ', ') FROM unnest(cols) c))
    USING pk, val;
END
$fn$;

CREATE FUNCTION pg_temp.merge_delete(tbl text, pk jsonb) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DELETE FROM %1$s t USING jsonb_populate_record(NULL::%1$s, $1) k WHERE %2$s',
                 tbl, pg_temp.merge_pkcond(pk))
    USING pk;
END
$fn$;

-- ぶつかった列の値（本番／ローカル／写し）。長い値は切る。
CREATE FUNCTION pg_temp.merge_show(tbl text, pk jsonb, mine jsonb, base jsonb, cols text[]) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE cur jsonb; out text;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %1$s t, jsonb_populate_record(NULL::%1$s, $1) k WHERE %2$s',
                 tbl, pg_temp.merge_pkcond(pk))
    INTO cur USING pk;
  SELECT string_agg(
           format('%s（本番 %s／ローカル %s%s）', c,
                  left(COALESCE(cur -> c, 'null'::jsonb)::text, 60),
                  left(COALESCE(mine -> c, 'null'::jsonb)::text, 60),
                  CASE WHEN base IS NULL THEN '' ELSE '／写し ' || left(COALESCE(base -> c, 'null'::jsonb)::text, 60) END),
           '、' ORDER BY c)
    INTO out FROM unnest(cols) c;
  RETURN out;
END
$fn$;

-- 業務の決まり。取り込みの前と後で数え、後にだけあるものを「崩れ」とする
-- （前からあるものは本番の現状なので、取り込みのせいにしない）。
CREATE FUNCTION pg_temp.merge_invariants() RETURNS TABLE (label text, item text) LANGUAGE sql AS $fn$
  SELECT '訂正版と元が両方とも有効', d.document_no || ' と ' || n.document_no
    FROM v3.documents d JOIN v3.documents n ON n.supersedes_id = d.id
   WHERE d.status = 'issued' AND n.status = 'issued'
  UNION ALL
  SELECT '差し替え済みの文書に結ばれたままの実績', '実績 #' || e.id || '（' || d.document_no || '）'
    FROM v3.condition_events e JOIN v3.documents d ON d.id = e.document_id
   WHERE e.status = 'active' AND d.status = 'superseded'
  UNION ALL
  SELECT '同じ実績・同じ相手に支払が 2 件以上', '条件 #' || a.condition_id || '・実績 #' || a.event_id || '・取引先 #' || p.party_id
    FROM v3.payment_allocations a JOIN v3.payments p ON p.id = a.payment_id
   WHERE p.status <> 'canceled' AND a.event_id IS NOT NULL
   GROUP BY a.condition_id, a.event_id, p.party_id
  HAVING count(DISTINCT p.id) > 1
  UNION ALL
  SELECT '同じ文書・条件・受取人の計算書が 2 件以上', '文書 #' || s.document_id || '・条件 #' || s.condition_id
    FROM v3.statements s
   GROUP BY s.document_id, s.condition_id, s.payee_party_id
  HAVING count(*) > 1
$fn$;

CREATE TEMP TABLE merge_inv_before ON COMMIT DROP AS SELECT * FROM pg_temp.merge_invariants();

-- 3. 外部キーを「最後に確かめる」にする（足す順番に関わらず、親子をまとめて確かめる）。
--    利用者の引き金（条件の系列番号）は止めない。値が空のときだけ埋めるので、入れる値を変えない。
CREATE TEMP TABLE merge_fk ON COMMIT DROP AS
SELECT format('%I.%I', n.nspname, c.relname) AS rel, con.conname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype = 'f' AND n.nspname = 'v3' AND NOT con.condeferrable;
DO $defer$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM merge_fk LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', r.rel, r.conname);
  END LOOP;
END
$defer$;
SET CONSTRAINTS ALL DEFERRED;

-- 4. 流す。1 行ずつ小さな取引で行い、失敗した行はその行だけ取り消して記録する。
CREATE FUNCTION pg_temp.merge_run(skip int[], force int[]) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  c record; tbl text; here boolean; d text[]; d2 text[]; st text; det text; more text;
BEGIN
  FOR c IN SELECT * FROM merge_changes ORDER BY no LOOP
    tbl := format('v3.%I', c.table_name);
    st := NULL; det := NULL;
    IF c.no = ANY(skip) THEN
      INSERT INTO merge_result (no, status, detail) VALUES (c.no, 'skipped', '本番を正として飛ばした');
      CONTINUE;
    END IF;
    BEGIN
      here := pg_temp.merge_exists(tbl, c.pk);
      IF c.op = 'I' THEN
        IF NOT here THEN
          PERFORM pg_temp.merge_insert(tbl, c.new);
          st := 'applied';
        ELSE
          d := pg_temp.merge_diff(tbl, c.pk, c.new, ARRAY(SELECT jsonb_object_keys(c.new)));
          IF cardinality(d) = 0 THEN
            st := 'same';
          ELSIF c.no = ANY(force) THEN
            PERFORM pg_temp.merge_update(tbl, c.pk, c.new, d);
            st := 'forced';
          ELSE
            st := 'conflict';
            det := 'ローカルで足した行と同じ主キーの行が本番にもある：' || pg_temp.merge_show(tbl, c.pk, c.new, NULL, d);
          END IF;
        END IF;
      ELSIF c.op = 'U' THEN
        IF NOT here AND c.no = ANY(force) THEN
          PERFORM pg_temp.merge_insert(tbl, c.new);
          st := 'forced';
        ELSIF NOT here THEN
          st := 'conflict';
          det := 'ローカルで直した行が、本番では消されている（ローカルを正とすると、ローカルの値で足し直す）';
        ELSE
          d := pg_temp.merge_diff(tbl, c.pk, c.old, c.cols);   -- 本番で写しから変わった列
          d2 := pg_temp.merge_diff(tbl, c.pk, c.new, d);       -- そのうちローカルの値とも違う列
          IF cardinality(pg_temp.merge_diff(tbl, c.pk, c.new, c.cols)) = 0 THEN
            st := 'same';                                      -- 本番がもうローカルと同じ値
          ELSIF cardinality(d2) = 0 OR c.no = ANY(force) THEN
            PERFORM pg_temp.merge_update(tbl, c.pk, c.new, c.cols);
            st := CASE WHEN cardinality(d2) = 0 THEN 'applied' ELSE 'forced' END;
          ELSE
            st := 'conflict';
            det := '同じ列を本番でも直している：' || pg_temp.merge_show(tbl, c.pk, c.new, c.old, d2);
          END IF;
        END IF;
      ELSE
        IF NOT here THEN
          st := 'same';
        ELSE
          d := pg_temp.merge_diff(tbl, c.pk, c.old, ARRAY(SELECT jsonb_object_keys(c.old)));
          IF cardinality(d) = 0 OR c.no = ANY(force) THEN
            PERFORM pg_temp.merge_delete(tbl, c.pk);
            st := CASE WHEN cardinality(d) = 0 THEN 'applied' ELSE 'forced' END;
          ELSE
            st := 'conflict';
            det := 'ローカルで消した行を、本番では直している：' || pg_temp.merge_show(tbl, c.pk, NULL, c.old, d);
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS more = PG_EXCEPTION_DETAIL;
      st := 'error';
      det := SQLERRM || COALESCE('（' || NULLIF(more, '') || '）', '');
    END;
    INSERT INTO merge_result (no, status, detail) VALUES (c.no, st, det);
  END LOOP;
END
$fn$;

SELECT pg_temp.merge_run(
  COALESCE(string_to_array(NULLIF(regexp_replace(:'merge_skip', '\s', '', 'g'), ''), ',')::int[], '{}'),
  COALESCE(string_to_array(NULLIF(regexp_replace(:'merge_force', '\s', '', 'g'), ''), ',')::int[], '{}')
) \gset merge_ran_

-- 5. 外部キーを確かめる（親の行がぶつかって入らなかった子の行など）。
DO $fk$
DECLARE more text;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS more = PG_EXCEPTION_DETAIL;
  INSERT INTO merge_result (no, status, detail)
  VALUES (NULL, 'error', '親子のつながりが切れる（親の行を飛ばした・入らなかったなど）：' || SQLERRM
                         || COALESCE('（' || NULLIF(more, '') || '）', ''));
END
$fk$;

-- 6. 業務の決まりが崩れていないか（取り込みで新しく出たものだけ）。
INSERT INTO merge_result (no, status, detail)
SELECT NULL, 'check', a.label || '：' || a.item
  FROM (SELECT * FROM pg_temp.merge_invariants() EXCEPT SELECT * FROM merge_inv_before) a;

-- 7. 結果
\echo ''
\echo '=== 持ち帰りの結果 ==='
SELECT CASE status
         WHEN 'applied'  THEN '入れた'
         WHEN 'same'     THEN '本番でもう同じ'
         WHEN 'skipped'  THEN '飛ばした（本番を正）'
         WHEN 'forced'   THEN 'ローカルを正として入れた'
         WHEN 'conflict' THEN 'ぶつかり'
         WHEN 'error'    THEN '失敗'
         WHEN 'check'    THEN '業務の決まりの崩れ'
       END AS 結果,
       count(*) AS 件数
  FROM merge_result GROUP BY status ORDER BY min(id);

\echo ''
\echo '=== 見てほしいもの（ぶつかり・失敗・崩れ・ローカルを正とした行） ==='
SELECT r.no AS 番号, c.table_name AS 表,
       CASE c.op WHEN 'I' THEN '足した' WHEN 'U' THEN '直した' WHEN 'D' THEN '消した' END AS 操作,
       c.pk::text AS 主キー,
       r.status AS 結果, r.detail AS 中身
  FROM merge_result r LEFT JOIN merge_changes c ON c.no = r.no
 WHERE r.status IN ('conflict', 'error', 'check', 'forced')
 ORDER BY r.id;

\echo ''
\echo '=== 持ち帰る行（表ごと） ==='
SELECT c.table_name AS 表,
       count(*) FILTER (WHERE c.op = 'I') AS 足した,
       count(*) FILTER (WHERE c.op = 'U') AS 直した,
       count(*) FILTER (WHERE c.op = 'D') AS 消した,
       min(c.no) || '〜' || max(c.no) AS 番号
  FROM merge_changes c GROUP BY c.table_name ORDER BY min(c.no);
\if :{?merge_show}
  \echo ''
  \echo '=== 持ち帰る行の中身（' :merge_show '） ==='
  SELECT c.no AS 番号, CASE c.op WHEN 'I' THEN '足した' WHEN 'U' THEN '直した' WHEN 'D' THEN '消した' END AS 操作,
         c.pk::text AS 主キー, r.status AS 結果,
         left(COALESCE(CASE WHEN c.op = 'U' THEN (SELECT jsonb_object_agg(k, c.new -> k) FROM unnest(c.cols) k) ELSE COALESCE(c.new, c.old) END, '{}'::jsonb)::text, 200) AS 値
    FROM merge_changes c LEFT JOIN merge_result r ON r.no = c.no
   WHERE c.table_name = ANY (string_to_array(regexp_replace(:'merge_show', '\s', '', 'g'), ','))
   ORDER BY c.no;
\endif

\echo ''
\echo '=== ローカルにしか無いファイル（本番で手で上げ直す） ==='
SELECT c.no AS 番号, c.table_name AS 表, c.pk::text AS 主キー
  FROM merge_changes c
 WHERE c.new::text LIKE '%/local-files/%'
 ORDER BY c.no;
\echo '（ひな形から作った文書の PDF は、本番で文書の本文から作り直すのでここには出ません）'

SELECT :'merge_mode' = 'apply'
       AND NOT EXISTS (SELECT 1 FROM merge_result WHERE status IN ('conflict', 'error', 'check')) AS merge_commit,
       EXISTS (SELECT 1 FROM merge_result WHERE status IN ('conflict', 'error', 'check')) AS merge_blocked
\gset

\if :merge_commit
  DO $restore$
  DECLARE r record;
  BEGIN
    FOR r IN SELECT * FROM merge_fk LOOP
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', r.rel, r.conname);
    END LOOP;
  END
  $restore$;

  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  SELECT 'ops@merge', 'ops.merge_from_backup', 'system', 0,
         jsonb_build_object('session', :'merge_session', 'exportedAt', :'merge_exported_at',
                            'changes', (SELECT count(*) FROM merge_changes),
                            'applied', (SELECT count(*) FROM merge_result WHERE status = 'applied'),
                            'same', (SELECT count(*) FROM merge_result WHERE status = 'same'),
                            'skipped', (SELECT array_agg(no) FROM merge_result WHERE status = 'skipped'),
                            'forced', (SELECT array_agg(no) FROM merge_result WHERE status = 'forced'));
  COMMIT;
  \echo ''
  \echo '持ち帰りました（確定）。予備系で ops backup-close を流して記録を閉じてください。'
\else
  ROLLBACK;
  \echo ''
  \if :merge_blocked
    \echo 'ぶつかり・失敗・崩れがあるので、何も変えていません。上の「見てほしいもの」を確かめ、'
    \echo 'merge_skip（本番を正）か merge_force（ローカルを正）に番号を入れて、もう一度 check から流してください。'
  \else
    \echo '試しただけです（check）。何も変えていません。問題が無ければ -v merge_mode=apply で流してください。'
  \endif
\endif
