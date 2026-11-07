-- =====================================================================
-- 202_table_diet.sql（Cloud SQL Studio 用。DO ブロック 1 つ。201 のあとに流す）
--
--   v3 の片付け（軽量化。infra/v3/diag/table-weight.sql の結果から）。
--     1. 差し替え済み・取り消した文書の PDF の作り置きを捨てる（2026-11-07 時点で 290 枚中 156 枚）。
--        PDF は DB の 3/4（圧縮後 106MB）を占める。捨てた文書も、開けばその場で描く（本文は固定なので同じ PDF）。
--        以後は日次の点検（job.daily）が毎日捨て、作り置くのは今の版（決定済み）だけ。
--     2. 190（条件の持ち主の付け替え）の退避・記録・要確認の表 3 本を archive スキーマへ移す（消さない）。
--        190_condition_holder_rollback.sql はこの表を読むので、移したあとは戻せない（もう戻す予定は無い前提）。
--     3. 使われていないものを外す：旧い文例の表 snippets（空のときだけ。今は text_snippets）、
--        ビュー v_rights_sources、使われていない索引 2 本（parties_aliases_idx・works_title_idx。
--        名前の検索は「〜を含む」なので効かない）、ほかの索引と列がかぶる索引 2 本
--        （condition_shares_condition_idx・work_credits_work_idx。一意制約の索引で足りる）。
--     決定済みの文書・条件・支払・監査ログは触らない。
--
--   ★ 使い方：そのまま流す（お試し）→ 一覧を確かめる → dry := false で流す。何度流しても同じ結果。
--     戻すときは 202_table_diet_rollback.sql（捨てた PDF は戻らない。開けばその場で描き直す）。
--     流したあと、PDF の表の空きを詰めるなら、別に 1 行だけ流す（数秒、そのあいだ PDF の表は読めない）：
--       VACUUM FULL v3.document_pdfs;
--     ※ Cloud SQL のディスクの割り当ては減らない（DB の中身とバックアップが小さくなる）。
-- =====================================================================

DO $diet$
DECLARE
  dry   boolean := true;                       -- ★ false にすると書き込む
  plan  text[] := '{}';
  n     bigint;
  bytes bigint;
  t     text;
BEGIN
  -- 1. 差し替え済み・取り消した文書の PDF -------------------------------------------
  SELECT count(*), COALESCE(sum(p.bytes), 0) INTO n, bytes
    FROM v3.document_pdfs p JOIN v3.documents d ON d.id = p.document_id
   WHERE d.status IN ('void', 'superseded');
  DELETE FROM v3.document_pdfs p USING v3.documents d
   WHERE d.id = p.document_id AND d.status IN ('void', 'superseded');
  IF n > 0 THEN
    plan := plan || format('PDF の作り置き：差し替え済み・取り消した文書の %s 枚（%s）を捨てる', n, pg_size_pretty(bytes));
  END IF;

  -- 2. 190 の表を archive へ ----------------------------------------------------------
  CREATE SCHEMA IF NOT EXISTS archive;
  FOREACH t IN ARRAY ARRAY['condition_holder_190_backup', 'condition_holder_190_created', 'condition_holder_190_review'] LOOP
    IF to_regclass('v3.' || t) IS NOT NULL THEN
      IF to_regclass('archive.' || t) IS NOT NULL THEN
        plan := plan || format('要確認 %s：archive にも同じ名前の表があるので移さない', t);
      ELSE
        EXECUTE format('SELECT count(*) FROM v3.%I', t) INTO n;
        EXECUTE format('ALTER TABLE v3.%I SET SCHEMA archive', t);
        plan := plan || format('表 %s（%s 行）：v3 から archive へ移す', t, n);
      END IF;
    END IF;
  END LOOP;

  -- 3. 使われていないもの ----------------------------------------------------------------
  IF to_regclass('v3.snippets') IS NOT NULL THEN
    SELECT count(*) INTO n FROM v3.snippets;
    IF n = 0 THEN
      DROP TABLE v3.snippets;
      plan := plan || '表 snippets（空。今は text_snippets）：外す'::text;
    ELSE
      plan := plan || format('要確認 表 snippets：%s 行あるので外さない', n);
    END IF;
  END IF;
  IF to_regclass('v3.v_rights_sources') IS NOT NULL THEN
    DROP VIEW v3.v_rights_sources;
    plan := plan || 'ビュー v_rights_sources（使われていない）：外す'::text;
  END IF;
  FOREACH t IN ARRAY ARRAY['parties_aliases_idx', 'works_title_idx', 'condition_shares_condition_idx', 'work_credits_work_idx'] LOOP
    IF to_regclass('v3.' || t) IS NOT NULL THEN
      EXECUTE format('DROP INDEX v3.%I', t);
      plan := plan || format('索引 %s：外す', t);
    END IF;
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['変えるところはありません（もう片付いています）']; END IF;
  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES ('sql:202_table_diet', 'db.table_diet', 'job', 0, jsonb_build_object('plan', to_jsonb(plan)));
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$diet$;
