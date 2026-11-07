-- =====================================================================
-- 作品の整理 2 回目：契約書の PDF に合わせて、番号・日付・付き先を振り直す
-- （Cloud SQL Studio 用。DO ブロック 1 つ。work-tree-fix.sql を流したあとに流す）。初期値はトーネードスプラッシュ。
--
--   PDF（2026-05-19 発行）
--     ライセンス利用許諾基本契約書 ARC-LIC-2026-0007：締結 2026-05-19、有効 5 年、満了 1 か月前までに
--       拒絶が無ければ 5 年ずつ自動更新。第20条で旧契約（2024-05-13 の契約）を包括統合。
--     別紙 個別利用許諾条件 LIC-LO-2026-0001-W-2026-0001（いまの文書番号 ARC-ILT-2026-0014）
--       対象製品 トーネードスプラッシュ／契約開始日 2024-05-13／原著作物 トーネードスプラッシュ２
--       金銭条件 1 自社製造・直接販売 5%／2 ライセンスアウト型 50%／3 プロダクトアウト型 10%
--       再許諾先 8 社（いずれも金銭条件 3）
--     別紙 個別利用許諾条件 LIC-LO-2026-0001-W-2026-0002（いまの文書番号 ARC-ILT-2026-0013）
--       対象製品 トーネードスプラッシュキャラスキルミニ拡張／契約開始日 2026-04-21／同じ 3 本
--
--   やること
--     1. 基本契約：締結日・有効開始日・満了日・自動更新（5 年、通知 1 か月前）を PDF に合わせる。
--     2. 作品の原作名を「トーネードスプラッシュ２」にする（PDF の原著作物）。
--     3. 個別契約ごと：
--        - 有効開始日（契約開始日）・締結日（発行日）を PDF に合わせる。
--        - PDF の文書が付いていた契約（ARC-ILT-2026-0014・0013）を個別契約へ統合する
--          （指しているもの・案件の繋がり・更新の記録を付け替えてから、その契約を消す）。
--        - その文書を個別契約の条件書にする：種別を「利用許諾契約書」に、in 条件に繋ぎ、
--          文書番号を PDF のワーク ID（LIC-LO-…）に振り直す（取り込んだ文書だけ。ひな形の文書は番号を変えない）。
--        - old_docs（PDF の前の版）は、PDF の文書があれば「差し替え済み」にする（アプリの訂正版と同じ形。消さない）。
--          PDF の文書がまだ無ければ要確認に出す（画面から上げてから、もう一度流す）。
--        - それ以外に個別契約に付いている文書は触らずに「要確認」に出す。
--     4. out の単体契約：PDF の再許諾先の契約締結日を、その相手先の単体契約の締結日に入れる（空のときだけ）。
--        PDF の相手先がシステムに無い・違う名前のときは「要確認」に出す。
--     計算書・支払・実績・決定済みの本文は書き換えない。
--
--   ★ 使い方：そのまま流す（お試し）→ 一覧を確かめる → dry := false で流す。何度流しても同じ結果。
-- =====================================================================

DO $fix2$
DECLARE
  dry          boolean := true;                     -- ★ false にすると書き込む
  v_party      bigint  := 505;
  v_master_no  text    := 'ARC-LIC-2026-0007';
  v_executed   date    := '2026-05-19';
  v_effective  date    := '2026-05-19';
  v_expires    date    := '2031-05-18';             -- 締結日から 5 年
  v_renew_m    int     := 60;                       -- 自動更新 5 年
  v_notice_m   int     := 1;                        -- 満了 1 か月前までに拒絶
  v_source     text    := 'トーネードスプラッシュ２'; -- 原著作物
  v_works      bigint[] := ARRAY[50, 585]::bigint[];
  v_renumber   boolean := true;                     -- 文書番号を PDF のワーク ID に振り直す
  v_actor      text    := 'sql:work-tree-fix2';

  plan text[] := '{}'; changes jsonb := '[]'::jsonb;
  m record; ind record; src record; ix record; r record; fk record; d record; u record; o record;
  v_cnt bigint; v_ok boolean; v_moved text[]; v_doc bigint;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  --   old_docs … PDF の前の版の文書。PDF の文書があれば、アプリの訂正版と同じく「差し替え済み」にし、
  --              PDF の文書から前の版として辿れるようにする（実績の文書も PDF の文書へ）。消さない。
  CREATE TEMP TABLE IF NOT EXISTS _indiv (ord int, indiv_no text, src_agreement text, src_document text,
                                          effective date, executed date, in_nos text[], old_docs text[]) ON COMMIT DROP;
  TRUNCATE _indiv;
  INSERT INTO _indiv VALUES
    (1, 'LIC-LO-2026-0001-W-2026-0001', 'ARC-ILT-2026-0014', 'ARC-ILT-2026-0014', '2024-05-13', '2026-05-19',
        ARRAY['CL-2026-00406', 'CL-2026-00407', 'CL-2026-00408-R2'], ARRAY['ARC-ILT-2026-0007']),
    (2, 'LIC-LO-2026-0001-W-2026-0002', 'ARC-ILT-2026-0013', 'ARC-ILT-2026-0013', '2026-04-21', '2026-05-19',
        ARRAY['CL-2026-00112', 'CL-2026-00113', 'CL-2026-00114'], ARRAY[]::text[]);
  -- PDF の再許諾先（相手先名の前方一致）と契約締結日。
  CREATE TEMP TABLE IF NOT EXISTS _sub (label text, name_like text, executed date) ON COMMIT DROP;
  TRUNCATE _sub;
  INSERT INTO _sub VALUES
    ('Asmodee Asia Limited', 'Asmodee Asia%', '2026-02-06'), ('BEP Latam Licensing & Consulting LLC', 'BEP Latam%', '2026-03-20'),
    ('Don''t Panic Games', 'Don%t Panic Games%', '2026-03-24'), ('Glyp Games LTDA', 'Glyp Games%', '2026-02-12'),
    ('Hobby Games Trading, LLC.', 'Hobby Games Trading%', '2026-02-11'), ('Magic Store srl', 'Magic Store%', '2026-02-13'),
    ('Meanbook Co., Ltd.', 'Meanbook%', '2026-02-11'), ('MM-Spiele', 'MM-Spiele%', '2026-03-13');

  -- 1. 基本契約 ---------------------------------------------------------------
  SELECT * INTO m FROM v3.agreements WHERE agreement_no = v_master_no;
  IF m.id IS NULL OR m.counterparty_id <> v_party OR m.kind <> 'master' THEN
    RAISE EXCEPTION '基本契約 % が作家の基本契約になっていません（先に work-tree-fix.sql を流す）', v_master_no;
  END IF;
  IF m.executed_on IS DISTINCT FROM v_executed OR m.effective_on IS DISTINCT FROM v_effective OR m.expires_on IS DISTINCT FROM v_expires
     OR m.auto_renewal IS DISTINCT FROM true OR m.renewal_months IS DISTINCT FROM v_renew_m OR m.renewal_notice_months IS DISTINCT FROM v_notice_m THEN
    plan := plan || format('基本契約 %s：締結 %s → %s、有効 %s〜%s → %s〜%s、自動更新 %s か月（通知 %s か月前）',
                           v_master_no, COALESCE(m.executed_on::text, '空'), v_executed,
                           COALESCE(m.effective_on::text, '空'), COALESCE(m.expires_on::text, '空'), v_effective, v_expires, v_renew_m, v_notice_m);
    changes := changes || jsonb_build_object('agreement', m.id, 'before', to_jsonb(m));
    UPDATE v3.agreements SET executed_on = v_executed, effective_on = v_effective, expires_on = v_expires,
           auto_renewal = true, renewal_months = v_renew_m, renewal_notice_months = v_notice_m, updated_at = now()
     WHERE id = m.id;
  END IF;

  -- 2. 原作名 ------------------------------------------------------------------
  FOR r IN SELECT id, title, source_title FROM v3.works WHERE id = ANY(v_works) AND source_title IS DISTINCT FROM v_source ORDER BY id LOOP
    plan := plan || format('作品 #%s「%s」：原作名 %s → %s', r.id, r.title, COALESCE(r.source_title, '空'), v_source);
    changes := changes || jsonb_build_object('work', r.id, 'source_title', r.source_title);
    UPDATE v3.works SET source_title = v_source, updated_at = now() WHERE id = r.id;
  END LOOP;

  -- 3. 個別契約ごと -------------------------------------------------------------
  FOR ix IN SELECT * FROM _indiv ORDER BY ord LOOP
    SELECT * INTO ind FROM v3.agreements WHERE agreement_no = ix.indiv_no;
    IF ind.id IS NULL OR ind.parent_id IS DISTINCT FROM m.id THEN
      RAISE EXCEPTION '個別契約 % が % の下にありません（先に work-tree-fix.sql を流す）', ix.indiv_no, v_master_no;
    END IF;
    IF ind.effective_on IS DISTINCT FROM ix.effective OR ind.executed_on IS DISTINCT FROM ix.executed THEN
      plan := plan || format('個別契約 %s：契約開始日 %s → %s、締結日 %s → %s', ix.indiv_no,
                             COALESCE(ind.effective_on::text, '空'), ix.effective, COALESCE(ind.executed_on::text, '空'), ix.executed);
      changes := changes || jsonb_build_object('agreement', ind.id, 'effective_on', ind.effective_on, 'executed_on', ind.executed_on);
      UPDATE v3.agreements SET effective_on = ix.effective, executed_on = ix.executed, updated_at = now() WHERE id = ind.id;
    END IF;

    -- PDF の文書が付いていた契約を個別契約へ統合する。
    SELECT * INTO src FROM v3.agreements WHERE agreement_no = ix.src_agreement AND id <> ind.id;
    IF src.id IS NOT NULL THEN
      IF src.counterparty_id <> v_party THEN RAISE EXCEPTION '契約 % は作家の契約ではありません', ix.src_agreement; END IF;
      v_moved := '{}'; v_ok := true;
      FOR fk IN
        SELECT con.conrelid::regclass AS tbl, att.attname AS col
          FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND con.confrelid = 'v3.agreements'::regclass AND array_length(con.conkey, 1) = 1
         ORDER BY 1, 2
      LOOP
        EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING src.id;
        CONTINUE WHEN v_cnt = 0;
        BEGIN
          EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING ind.id, src.id;
          v_moved := v_moved || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt);
        EXCEPTION WHEN unique_violation THEN
          v_ok := false;
          plan := plan || format('要確認 %s の統合：%s.%s の %s 行が %s 側とぶつかる', ix.src_agreement, fk.tbl, fk.col, v_cnt, ix.indiv_no);
        END;
      END LOOP;
      DELETE FROM v3.matter_links ml WHERE ml.target_type = 'agreement' AND ml.target_ref = src.id::text
         AND EXISTS (SELECT 1 FROM v3.matter_links x WHERE x.matter_id = ml.matter_id AND x.target_type = 'agreement' AND x.target_ref = ind.id::text);
      UPDATE v3.matter_links SET target_ref = ind.id::text WHERE target_type = 'agreement' AND target_ref = src.id::text;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt > 0 THEN v_moved := v_moved || format('案件の繋がり %s 行', v_cnt); END IF;
      IF to_regclass('v3.term_events') IS NOT NULL THEN
        UPDATE v3.term_events SET target_id = ind.id WHERE target_type = 'agreement' AND target_id = src.id;
        GET DIAGNOSTICS v_cnt = ROW_COUNT;
        IF v_cnt > 0 THEN v_moved := v_moved || format('更新の記録 %s 行', v_cnt); END IF;
      END IF;
      changes := changes || jsonb_build_object('merged_agreement', to_jsonb(src), 'into', ind.id, 'moved', to_jsonb(v_moved));
      IF v_ok THEN
        DELETE FROM v3.agreements WHERE id = src.id;
        plan := plan || format('契約 %s：%s に統合して消す%s', ix.src_agreement, ix.indiv_no,
                               CASE WHEN array_length(v_moved, 1) IS NULL THEN '（付いていたものなし）'
                                    ELSE '（付け替え：' || array_to_string(v_moved, '・') || '）' END);
      ELSE
        UPDATE v3.agreements SET status = 'terminated', updated_at = now() WHERE id = src.id;
        plan := plan || format('契約 %s：付け替えられない行があるので消さず「解除」にする', ix.src_agreement);
      END IF;
    END IF;

    -- PDF の文書を個別契約の条件書にする。
    SELECT d2.* INTO d FROM v3.documents d2
     WHERE d2.document_no IN (ix.src_document, ix.indiv_no) AND d2.status <> 'void'
     ORDER BY (d2.document_no = ix.indiv_no) DESC, d2.id LIMIT 1;
    IF d.id IS NULL THEN
      plan := plan || format('要確認 個別契約 %s：PDF の文書（%s）がシステムにありません。工程表の「＋ 条件書を上げる」から PDF を上げてから、もう一度流してください%s',
                             ix.indiv_no, ix.src_document,
                             CASE WHEN array_length(ix.old_docs, 1) IS NULL THEN ''
                                  ELSE format('（上げたあとに流すと %s を前の版にします）', array_to_string(ix.old_docs, '・')) END);
    ELSE
      IF d.agreement_id IS DISTINCT FROM ind.id THEN
        plan := plan || format('文書 %s：契約 %s → %s', d.document_no,
                               COALESCE((SELECT agreement_no FROM v3.agreements WHERE id = d.agreement_id), 'なし'), ix.indiv_no);
        changes := changes || jsonb_build_object('document', d.id, 'agreement_id', d.agreement_id);
        UPDATE v3.documents SET agreement_id = ind.id WHERE id = d.id;
      END IF;
      IF d.template_version_id IS NULL AND COALESCE(d.manual_inputs->>'documentKind', '') <> '利用許諾契約書' THEN
        plan := plan || format('文書 %s：種別 %s → 利用許諾契約書', d.document_no, COALESCE(NULLIF(d.manual_inputs->>'documentKind', ''), '空'));
        changes := changes || jsonb_build_object('document', d.id, 'documentKind', d.manual_inputs->>'documentKind');
        UPDATE v3.documents SET manual_inputs = manual_inputs || '{"documentKind": "利用許諾契約書"}'::jsonb WHERE id = d.id;
      END IF;
      FOR u IN SELECT c.id, c.condition_no FROM v3.conditions c
                WHERE c.condition_no = ANY(ix.in_nos)
                  AND NOT EXISTS (SELECT 1 FROM v3.document_conditions dc WHERE dc.document_id = d.id AND dc.condition_id = c.id)
                ORDER BY c.id LOOP
        plan := plan || format('文書 %s：条件 %s に繋ぐ', d.document_no, u.condition_no);
        changes := changes || jsonb_build_object('linked_document', d.id, 'condition', u.id);
        INSERT INTO v3.document_conditions (document_id, condition_id, line_no)
        VALUES (d.id, u.id, COALESCE((SELECT max(line_no) FROM v3.document_conditions WHERE document_id = d.id), 0) + 1);
      END LOOP;
      IF v_renumber AND d.document_no IS DISTINCT FROM ix.indiv_no THEN
        IF d.template_version_id IS NOT NULL THEN
          plan := plan || format('要確認 文書 %s：ひな形の文書なので番号は振り直さない', d.document_no);
        ELSIF EXISTS (SELECT 1 FROM v3.documents WHERE document_no = ix.indiv_no AND id <> d.id) THEN
          plan := plan || format('要確認 文書 %s：番号 %s はほかの文書が使っている', d.document_no, ix.indiv_no);
        ELSE
          plan := plan || format('文書 %s → %s：番号を PDF のワーク ID に振り直す', d.document_no, ix.indiv_no);
          changes := changes || jsonb_build_object('document', d.id, 'document_no', d.document_no);
          UPDATE v3.documents SET document_no = ix.indiv_no WHERE id = d.id;
        END IF;
      END IF;
      -- 前の版：PDF の文書が差し替えたことにする（アプリの訂正版と同じ形。issue-service.ts supersede）。
      FOR r IN SELECT d4.id, d4.document_no, d4.status FROM v3.documents d4
                WHERE d4.document_no = ANY(ix.old_docs) AND d4.id <> d.id AND d4.status = 'issued' ORDER BY d4.id LOOP
        plan := plan || format('文書 %s：%s の前の版として「差し替え済み」にする（消さない。%s から前の版として辿れる）',
                               r.document_no, COALESCE((SELECT document_no FROM v3.documents WHERE id = d.id), ix.indiv_no),
                               COALESCE((SELECT document_no FROM v3.documents WHERE id = d.id), ix.indiv_no));
        changes := changes || jsonb_build_object('superseded_document', r.id, 'status', r.status, 'by', d.id,
                                                 'supersedes_before', (SELECT supersedes_id FROM v3.documents WHERE id = d.id));
        UPDATE v3.condition_events SET document_id = d.id WHERE document_id = r.id;
        UPDATE v3.documents SET supersedes_id = r.id WHERE id = d.id AND supersedes_id IS NULL;
        UPDATE v3.documents SET status = 'superseded' WHERE id = r.id;
      END LOOP;
    END IF;
    -- 個別契約に付いているほかの文書（前の版かどうかを人が決める）。
    v_doc := d.id;
    FOR r IN SELECT d3.document_no, d3.status, d3.issued_at::date AS on_day,
                    (SELECT count(*) FROM v3.document_conditions dc WHERE dc.document_id = d3.id) AS conds
               FROM v3.documents d3 WHERE d3.agreement_id = ind.id AND d3.id IS DISTINCT FROM v_doc
                AND d3.status NOT IN ('void', 'superseded') AND NOT (d3.document_no = ANY(ix.old_docs)) ORDER BY d3.id LOOP
      plan := plan || format('要確認 個別契約 %s に PDF 以外の文書 %s（%s・%s・条件 %s 本に繋がる）も付いている。前の版なら外す',
                             ix.indiv_no, r.document_no, r.status, COALESCE(r.on_day::text, '日付なし'), r.conds);
    END LOOP;
  END LOOP;

  -- 4. out の単体契約の締結日（PDF の再許諾先） ----------------------------------------
  FOR o IN
    SELECT s.label, s.name_like, s.executed,
           (SELECT string_agg(DISTINCT a.agreement_no, '・') FROM v3.conditions c
              JOIN v3.parties pa ON pa.id = c.counterparty_id JOIN v3.agreements a ON a.id = c.agreement_id
             WHERE c.direction = 'out' AND c.work_id = v_works[1] AND c.status <> 'void' AND pa.name LIKE s.name_like) AS agreements
      FROM _sub s ORDER BY s.name_like
  LOOP
    IF o.agreements IS NULL THEN
      plan := plan || format('要確認 再許諾先「%s」（締結 %s）：システムの out 条件に、この名前の相手先がありません', o.label, o.executed);
      CONTINUE;
    END IF;
    FOR r IN SELECT DISTINCT a.id, a.agreement_no, a.executed_on FROM v3.conditions c
               JOIN v3.parties pa ON pa.id = c.counterparty_id JOIN v3.agreements a ON a.id = c.agreement_id
              WHERE c.direction = 'out' AND c.work_id = v_works[1] AND c.status <> 'void' AND pa.name LIKE o.name_like
                AND a.executed_on IS NULL LOOP
      plan := plan || format('out 契約 %s（%s）：締結日 → %s', r.agreement_no, o.label, o.executed);
      changes := changes || jsonb_build_object('agreement', r.id, 'executed_on', r.executed_on);
      UPDATE v3.agreements SET executed_on = o.executed, effective_on = COALESCE(effective_on, o.executed), updated_at = now() WHERE id = r.id;
    END LOOP;
  END LOOP;
  FOR r IN
    SELECT DISTINCT pa.name FROM v3.conditions c JOIN v3.parties pa ON pa.id = c.counterparty_id
     WHERE c.direction = 'out' AND c.work_id = v_works[1] AND c.status <> 'void'
       AND NOT EXISTS (SELECT 1 FROM _sub s WHERE pa.name LIKE s.name_like)
     ORDER BY pa.name
  LOOP
    plan := plan || format('要確認 out 条件の相手先「%s」：PDF の再許諾先の一覧にありません', r.name);
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['変えるところはありません（もう整っています）']; END IF;
  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES (v_actor, 'work.tree_fix2', 'agreement', m.id, jsonb_build_object('plan', to_jsonb(plan), 'changes', changes));
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix2$;
