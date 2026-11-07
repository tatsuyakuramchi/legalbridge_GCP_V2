-- =====================================================================
-- 作品の整理 3 回目：残りの無題の条件と、文書だけの ARC-ILT 契約・計算書の契約を片付ける
-- （Cloud SQL Studio 用。DO ブロック 1 つ。work-tree-fix.sql・work-tree-fix2.sql のあとに流す）。
-- 初期値はトーネードスプラッシュ（平沢さん #505）。
--
--   やること
--     1. 無題の条件（作家の、作品も契約も無い「（無題の条件）」）を無効にする。
--        契約審査の下書きを取り込んだときに 1 通ごとにできた重複。実績・計算書・支払の割当など
--        付いているもの（範囲・文書の繋がり・予定の回を除く）があれば触らず「要確認」に出す。
--     2. 文書だけの ARC-ILT 契約（条件が載っていない）：文書の中身（ファイル名・件名・値）から、
--        どちらの個別契約の前の版かを見分ける。
--          キャラスキル・拡張・W-2026-0002 … 拡張版の個別契約
--          W-2026-0001・トーネードスプラッシュ（拡張の語が無い）… 本体の個別契約
--        見分けられた文書は個別契約に付け替えて「差し替え済み」（前の版。消さない）にし、空になった
--        契約を消す（ほかから参照されていれば消さずに要確認）。見分けられないものは触らず要確認。
--     3. 計算書が契約として登録されたもの（v_not_contracts）：契約から外して契約を消す（文書は残す）。
--     計算書の金額・支払・実績・決定済みの本文は書き換えない。
--
--   ★ 使い方：そのまま流す（お試し）→ 一覧を確かめる → dry := false で流す。何度流しても同じ結果。
-- =====================================================================

DO $fix3$
DECLARE
  dry             boolean := true;                       -- ★ false にすると書き込む
  v_party         bigint  := 505;
  v_main_indiv    text    := 'LIC-LO-2026-0001-W-2026-0001';  -- 本体（トーネードスプラッシュ）
  v_ext_indiv     text    := 'LIC-LO-2026-0001-W-2026-0002';  -- 拡張（キャラスキルミニ拡張）
  v_not_contracts text[]  := ARRAY['ARC-ROY-2026-0006'];  -- 契約として登録されてしまった計算書
  v_actor         text    := 'sql:work-tree-fix3';

  plan text[] := '{}'; changes jsonb := '[]'::jsonb;
  main_id bigint; ext_id bigint; r record; a record; fk record; d record;
  v_cnt bigint; v_refs text[]; v_text text; v_target bigint; v_target_no text;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT id INTO main_id FROM v3.agreements WHERE agreement_no = v_main_indiv AND counterparty_id = v_party;
  SELECT id INTO ext_id  FROM v3.agreements WHERE agreement_no = v_ext_indiv  AND counterparty_id = v_party;
  IF main_id IS NULL OR ext_id IS NULL THEN
    RAISE EXCEPTION '個別契約 % ／ % が見つかりません（先に work-tree-fix.sql を流す）', v_main_indiv, v_ext_indiv;
  END IF;

  -- 1. 無題の条件を無効にする ------------------------------------------------------
  FOR r IN
    SELECT c.id, c.condition_no, round(c.rate_ppm / 10000.0, 3) AS rate, c.status
      FROM v3.conditions c
     WHERE c.counterparty_id = v_party AND c.direction = 'in' AND c.work_id IS NULL AND c.agreement_id IS NULL
       AND c.status IN ('active', 'scheduled') AND c.name IN ('（無題の条件）', '')
     ORDER BY c.condition_no
  LOOP
    v_refs := '{}';
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.conditions'::regclass AND array_length(con.conkey, 1) = 1
         AND con.conrelid NOT IN ('v3.condition_scopes'::regclass, 'v3.document_conditions'::regclass, 'v3.condition_schedules'::regclass)
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING r.id;
      IF v_cnt > 0 THEN v_refs := v_refs || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt); END IF;
    END LOOP;
    IF array_length(v_refs, 1) IS NULL THEN
      plan := plan || format('無題の条件 %s（料率 %s%%）：無効にする（契約審査の下書きでできた重複）', r.condition_no, r.rate);
      changes := changes || jsonb_build_object('voided_condition', r.id, 'status', r.status);
      UPDATE v3.conditions
         SET status = 'void', updated_at = now(),
             notes = concat_ws(E'\n', NULLIF(notes, ''), format('作品の整理（%s）：契約審査の下書きでできた重複として無効', current_date))
       WHERE id = r.id;
    ELSE
      plan := plan || format('要確認 無題の条件 %s（料率 %s%%）：付いているものがあるので触らない（%s）', r.condition_no, r.rate, array_to_string(v_refs, '・'));
    END IF;
  END LOOP;

  -- 2. 文書だけの ARC-ILT 契約 ------------------------------------------------------
  FOR a IN
    SELECT ag.* FROM v3.agreements ag
     WHERE ag.counterparty_id = v_party AND ag.agreement_no LIKE 'ARC-ILT-%' AND ag.id NOT IN (main_id, ext_id)
       AND NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = ag.id)
       AND NOT EXISTS (SELECT 1 FROM v3.agreements ch WHERE ch.parent_id = ag.id)
     ORDER BY ag.agreement_no
  LOOP
    -- 契約に付いた文書の中身（ファイル名・件名・種別・値）と契約の件名・リンクから見分ける。
    SELECT concat_ws(' ', a.title, a.source_url,
             string_agg(concat_ws(' ', d2.document_no, d2.storage_url, d2.manual_inputs::text, d2.rendered_values::text), ' '))
      INTO v_text
      FROM v3.documents d2 WHERE d2.agreement_id = a.id;
    v_text := COALESCE(v_text, concat_ws(' ', a.title, a.source_url));
    IF v_text ~ '(キャラスキル|拡張|W-2026-0002)' AND v_text !~ 'W-2026-0001' THEN
      v_target := ext_id; v_target_no := v_ext_indiv;
    ELSIF v_text ~ '(W-2026-0001|トーネード)' AND v_text !~ '(キャラスキル|拡張|W-2026-0002)' THEN
      v_target := main_id; v_target_no := v_main_indiv;
    ELSE
      plan := plan || format('要確認 契約 %s：文書の中身から、本体（W-0001）か拡張（W-0002）か見分けられない。触らない（%s）',
                             a.agreement_no, left(regexp_replace(COALESCE(v_text, ''), '\s+', ' ', 'g'), 80));
      CONTINUE;
    END IF;
    FOR d IN SELECT d3.id, d3.document_no, d3.status FROM v3.documents d3 WHERE d3.agreement_id = a.id ORDER BY d3.id LOOP
      plan := plan || format('文書 %s：契約 %s → %s、%s', d.document_no, a.agreement_no, v_target_no,
                             CASE WHEN d.status = 'issued' THEN '前の版として「差し替え済み」にする（消さない）' ELSE '状態はそのまま（' || d.status || '）' END);
      changes := changes || jsonb_build_object('document', d.id, 'agreement_id', a.id, 'status', d.status);
      UPDATE v3.documents SET agreement_id = v_target,
             status = CASE WHEN status = 'issued' THEN 'superseded' ELSE status END
       WHERE id = d.id;
    END LOOP;
    -- 空になった契約を消す。ほかから参照されていれば消さない。
    v_refs := '{}';
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.agreements'::regclass AND array_length(con.conkey, 1) = 1
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING a.id;
      IF v_cnt > 0 THEN v_refs := v_refs || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt); END IF;
    END LOOP;
    SELECT count(*) INTO v_cnt FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = a.id::text;
    IF v_cnt > 0 THEN v_refs := v_refs || format('案件の繋がり %s 行', v_cnt); END IF;
    IF array_length(v_refs, 1) IS NULL THEN
      DELETE FROM v3.agreements WHERE id = a.id;
      plan := plan || format('契約 %s：空になったので消す', a.agreement_no);
      changes := changes || jsonb_build_object('deleted_agreement', to_jsonb(a));
    ELSE
      plan := plan || format('要確認 契約 %s：空になったが、ほかから参照されているので消さない（%s）', a.agreement_no, array_to_string(v_refs, '・'));
    END IF;
  END LOOP;

  -- 3. 計算書が契約として登録されたもの ---------------------------------------------------
  FOR a IN SELECT ag.* FROM v3.agreements ag WHERE ag.agreement_no = ANY(v_not_contracts) AND ag.counterparty_id = v_party ORDER BY ag.id LOOP
    IF EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = a.id) OR EXISTS (SELECT 1 FROM v3.agreements ch WHERE ch.parent_id = a.id) THEN
      plan := plan || format('要確認 契約 %s：条件か下の契約が載っているので外さない', a.agreement_no);
      CONTINUE;
    END IF;
    FOR d IN SELECT d3.id, d3.document_no FROM v3.documents d3 WHERE d3.agreement_id = a.id ORDER BY d3.id LOOP
      plan := plan || format('文書 %s：契約 %s から外す（文書は残す）', d.document_no, a.agreement_no);
      changes := changes || jsonb_build_object('document', d.id, 'agreement_id', a.id);
      UPDATE v3.documents SET agreement_id = NULL WHERE id = d.id;
    END LOOP;
    DELETE FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = a.id::text;
    BEGIN
      DELETE FROM v3.agreements WHERE id = a.id;
      plan := plan || format('契約 %s：計算書が契約として登録されていたので消す', a.agreement_no);
      changes := changes || jsonb_build_object('deleted_agreement', to_jsonb(a));
    EXCEPTION WHEN foreign_key_violation THEN
      plan := plan || format('要確認 契約 %s：まだ参照されていて消せない（%s）', a.agreement_no, SQLERRM);
    END;
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['変えるところはありません（もう整っています）']; END IF;
  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES (v_actor, 'work.tree_fix3', 'party', v_party, jsonb_build_object('plan', to_jsonb(plan), 'changes', changes));
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix3$;
