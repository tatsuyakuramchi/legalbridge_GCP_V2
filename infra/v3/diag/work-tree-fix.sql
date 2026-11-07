-- =====================================================================
-- 作品の整理（Cloud SQL Studio 用。DO ブロック 1 つ）。初期値はトーネードスプラッシュ（平沢さん）。
--
--   最終の形
--     基本契約 ARC-LIC-2026-0007（作家・ライセンス・IN）
--       個別契約 LIC-LO-2026-0001-W-2026-0001 → 作品 トーネードスプラッシュ（#50）
--         in 条件（自社製造・自社販売／再許諾／自社製造・他社販売）
--       個別契約 LIC-LO-2026-0001-W-2026-0002 → 作品 トーネードスプラッシュ　キャラスキルミニ拡張（#585）
--         in 条件（同じ 3 種）
--     out 条件 → それぞれの作品に付け、相手先ごと・作品ごとに 1 本の単体契約（ライセンス・OUT）
--     原作は作品として立てない。作品の「原作名」（works.source_title）に入れる。
--
--   やること
--     1. 基本契約：番号 v_master_no の契約があればそれを正にする（移行で「相手先未特定」に付いていたものは
--        作家に付け直し、件名・締結日・満了を v_master_old から写す）。v_master_old は、指しているもの
--        （文書・条件・下の契約・案件の繋がり・更新の記録…）を全部付け替えてから消す。
--        番号 v_master_no の契約が無ければ、v_master_old の番号を付け直す。基本契約・ライセンスにする。
--     2. 作品ごと（_products）：原作名を入れる。個別契約を用意する（indiv_old があれば番号を付け直して使う。
--        無ければ立てる）。基本契約の下の個別契約・ライセンスにし、in 条件（同じ系列の前の版も）を載せ、作品を付ける。
--        「（無題の条件）」の in 条件には、1 本目の作品の同じ料率の条件の名前を付ける。
--        個別契約の前の番号の文書・基本契約の前の番号の文書を、それぞれの契約に付ける。
--     3. 重複の作品（v_dup_works。原作として立てていた作品を含む）：条件を 1 本目の作品に寄せ、
--        系譜（親子）の行を外し、ほかの表（クレジット・刊行物・案件…）の行も 1 本目の作品へ付け替えてから消す。
--        1 本目の作品に同じ行があってぶつかるときは、消さずに「使わない」にして要確認に出す。
--     4. 重複の in 条件：作家の、作品の無い有効な in 条件のうち、残す in 条件と「同じ料率・同じ期間開始」のもの。
--        付帯情報（実績・計算書と明細・支払の割当・文書の繋がり・範囲・取り分・子の条件…）を
--        残す条件へ付け替えてから無効にする。付け替えでぶつかる行（同じ支払・同じ実績の割当など）があれば、
--        その条件は無効にせず「要確認」に出す（範囲・文書の繋がりは、残す側にもうあれば重複側を外す）。
--        付け替える表は、データベースの外部キー（conditions を指すもの）から拾う。
--     5. out 条件：作品（と重複の作品）に付いた out 条件を、相手先ごと・作品ごとに 1 本の単体契約に載せる。
--        その相手先の契約でその作品の条件だけを持つものがあれば単体契約にして使う。無ければ立てる（ARC-ILT）。
--     6. 残りは触らずに「要確認」に出す：作品の無い in 条件（整理前に載っていた契約と文書）、
--        条件の載っていない契約。
--     決定済みの文書の本文・計算書の金額・支払の金額は書き換えない（付き先・作品・名前・番号だけ）。
--
--   ★ 使い方
--     1) そのまま流す（dry := true）。全部を変えたうえで一覧をエラーとして出し、書き込みは取り消す
--        （「お試し：書き込みは取り消しました」で始まる）。一覧を確かめる。
--     2) dry := false にして流す。書き込み、一覧と前の値を監査記録に残す。
--        あとで見るとき：SELECT detail FROM v3.audit_events WHERE action = 'work.tree_fix' ORDER BY id DESC LIMIT 1;
--     3) diag/work-tree.sql を流し直して形を確かめる。何度流しても同じ結果。
-- =====================================================================

DO $fix$
DECLARE
  dry           boolean  := true;                        -- ★ false にすると書き込む
  v_party       bigint   := 505;                         -- 作家（in 側の権利者）
  v_master_old  text     := 'CT-2026-00008';             -- 基本契約のいまの番号
  v_master_no   text     := 'ARC-LIC-2026-0007';         -- 基本契約の番号
  v_source      text     := 'トーネードスプラッシュ';     -- 原作名（作品の原作名に入れる）
  v_master_title text    := '利用許諾契約書（トーネードスプラッシュ）';  -- 基本契約の名前（文書名にも出る）
  v_out_title   text     := '利用許諾契約書（%s・%s）';   -- out の単体契約の名前（作品名・相手先名が入る）
  v_dup_works   bigint[] := ARRAY[25, 628]::bigint[];    -- 消す作品（原作として立てていた #25・重複の #628）
  v_actor       text     := 'sql:work-tree-fix';

  plan    text[] := '{}';
  changes jsonb  := '[]'::jsonb;
  m record; old record; ind record; pr record; r record; w record; u record; oa record; p record; fk record;
  v_main_work bigint; v_target bigint; v_no text; v_seq int; v_year int;
  v_works bigint[] := '{}'; v_keep text[] := '{}'; v_main_nos text[]; v_refs text[]; v_cnt bigint; v_ok boolean; v_moved text[];
  v_name text; v_title text; v_first date;
BEGIN
  -- 後回しの一意制約（予定の回の番号など）も、その場で確かめる。COMMIT のときに初めてぶつかると
  -- お試しでは見えず、本番だけ最後に失敗するため。ぶつかれば各段の例外処理で「要確認」に出る。
  SET CONSTRAINTS ALL IMMEDIATE;
  -- 作品ごとの個別契約と in 条件。1 行目が主の作品（重複の作品の条件はここへ寄せる）。
  --   work_title  … 作品名を直すときだけ入れる（NULL は今のまま）
  --   indiv_title … 個別契約の名前（契約に付いた文書の名前にも出る）
  CREATE TEMP TABLE IF NOT EXISTS _products (ord int, work_id bigint, work_title text, indiv_old text, indiv_no text, indiv_title text, in_nos text[]) ON COMMIT DROP;
  TRUNCATE _products;
  INSERT INTO _products VALUES
    (1, 50,  NULL,                       'ARC-ILT-2026-0007', 'LIC-LO-2026-0001-W-2026-0001', '個別利用許諾条件書（トーネードスプラッシュ）',
        ARRAY['CL-2026-00406', 'CL-2026-00407', 'CL-2026-00408-R2']),
    (2, 585, NULL,                       NULL,               'LIC-LO-2026-0001-W-2026-0002', '個別利用許諾条件書（トーネードスプラッシュ　キャラスキルミニ拡張）',
        ARRAY['CL-2026-00112', 'CL-2026-00113', 'CL-2026-00114']);

  SELECT work_id, in_nos INTO v_main_work, v_main_nos FROM _products ORDER BY ord LIMIT 1;
  SELECT array_agg(work_id ORDER BY ord) INTO v_works FROM _products;
  SELECT array_agg(x) INTO v_keep FROM _products, unnest(in_nos) x;

  -- 0. 前提 -----------------------------------------------------------------
  FOR pr IN SELECT * FROM _products ORDER BY ord LOOP
    IF NOT EXISTS (SELECT 1 FROM v3.works WHERE id = pr.work_id) THEN RAISE EXCEPTION '作品 #% が見つかりません', pr.work_id; END IF;
    IF EXISTS (SELECT 1 FROM v3.agreements a WHERE a.agreement_no = pr.indiv_no
                 AND (a.counterparty_id <> v_party OR a.direction <> 'in')) THEN
      RAISE EXCEPTION '番号 % はほかの相手先・向きの契約が使っています', pr.indiv_no;
    END IF;
    IF pr.indiv_old IS NOT NULL AND EXISTS (SELECT 1 FROM v3.agreements a WHERE a.agreement_no = pr.indiv_no)
       AND EXISTS (SELECT 1 FROM v3.agreements a WHERE a.agreement_no = pr.indiv_old) THEN
      RAISE EXCEPTION '個別契約 % と % が両方あります（どちらに寄せるか人が決める）', pr.indiv_old, pr.indiv_no;
    END IF;
    SELECT count(*) INTO v_cnt FROM v3.conditions
     WHERE condition_no = ANY(pr.in_nos) AND counterparty_id = v_party AND direction = 'in';
    IF v_cnt <> array_length(pr.in_nos, 1) THEN
      RAISE EXCEPTION '作品 #% の in 条件 % のうち、作家・IN で見つかったのは % 本です', pr.work_id, array_to_string(pr.in_nos, '・'), v_cnt;
    END IF;
  END LOOP;
  -- 基本契約：番号 v_master_no の契約があればそれを正にし（移行で「相手先未特定」に付いていたものは
  -- 作家に付け直す）、v_master_old はそこへ統合する。無ければ v_master_old の番号を付け直す。
  SELECT * INTO m FROM v3.agreements WHERE agreement_no = v_master_no;
  SELECT * INTO old FROM v3.agreements WHERE agreement_no = v_master_old;
  IF m.id IS NULL AND old.id IS NULL THEN RAISE EXCEPTION '基本契約 %（%）が見つかりません', v_master_no, v_master_old; END IF;
  IF m.id IS NOT NULL THEN
    IF m.counterparty_id <> v_party
       AND NOT EXISTS (SELECT 1 FROM v3.parties WHERE id = m.counterparty_id AND party_code = 'UNRESOLVED') THEN
      RAISE EXCEPTION '基本契約 % は別の取引先（#%）の契約です', v_master_no, m.counterparty_id;
    END IF;
    IF m.direction <> 'in' THEN RAISE EXCEPTION '基本契約 % の向きが IN ではありません（%）', v_master_no, m.direction; END IF;
    IF EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = m.id AND c.counterparty_id <> v_party) THEN
      RAISE EXCEPTION '基本契約 % に、ほかの取引先の条件が載っています', v_master_no;
    END IF;
  END IF;
  IF old.id IS NOT NULL AND (old.counterparty_id <> v_party OR old.direction <> 'in') THEN
    RAISE EXCEPTION '基本契約 % の相手先・向きが違います（相手先 %、向き %）', v_master_old, old.counterparty_id, old.direction;
  END IF;

  -- 1. 基本契約 ---------------------------------------------------------------
  IF m.id IS NULL THEN
    -- 正の番号が無い：いまの契約の番号を付け直す。
    m := old;
    SELECT * INTO old FROM v3.agreements WHERE false;  -- 統合する相手は無い
  END IF;
  IF m.agreement_no IS DISTINCT FROM v_master_no OR m.counterparty_id <> v_party OR m.kind IS DISTINCT FROM 'master'
     OR m.domain IS DISTINCT FROM 'license' OR m.parent_id IS NOT NULL
     OR (old.id IS NOT NULL AND (m.title = m.agreement_no OR m.executed_on IS NULL)) THEN
    plan := plan || format('基本契約 %s%s：%s種類 %s → 基本契約、種別 %s → ライセンス%s', m.agreement_no,
                           CASE WHEN m.agreement_no IS DISTINCT FROM v_master_no THEN ' → ' || v_master_no ELSE '' END,
                           CASE WHEN m.counterparty_id <> v_party THEN format('相手先 #%s → #%s（作家）、', m.counterparty_id, v_party) ELSE '' END,
                           m.kind, COALESCE(m.domain, '空'),
                           CASE WHEN old.id IS NOT NULL THEN format('、件名・締結日・満了を %s から写す', old.agreement_no) ELSE '' END);
    changes := changes || jsonb_build_object('agreement', m.id, 'before', to_jsonb(m));
    UPDATE v3.agreements
       SET agreement_no = v_master_no, counterparty_id = v_party, kind = 'master', domain = 'license', parent_id = NULL,
           title        = CASE WHEN old.id IS NOT NULL AND (title = agreement_no OR title = '') THEN old.title ELSE title END,
           executed_on  = COALESCE(executed_on, old.executed_on),
           effective_on = COALESCE(effective_on, old.effective_on),
           expires_on   = COALESCE(expires_on, old.expires_on),
           auto_renewal = auto_renewal OR COALESCE(old.auto_renewal, false),
           status       = CASE WHEN old.id IS NOT NULL THEN COALESCE(old.status, status) ELSE status END,
           updated_at   = now()
     WHERE id = m.id;
    SELECT * INTO m FROM v3.agreements WHERE id = m.id;
  END IF;
  IF v_master_title IS NOT NULL AND m.title IS DISTINCT FROM v_master_title THEN
    plan := plan || format('基本契約 %s：名前 %s → %s', v_master_no, m.title, v_master_title);
    changes := changes || jsonb_build_object('agreement', m.id, 'title', m.title);
    UPDATE v3.agreements SET title = v_master_title, updated_at = now() WHERE id = m.id;
  END IF;

  -- いまの契約（v_master_old）を正の基本契約へ統合する：指しているものを全部付け替えてから消す。
  IF old.id IS NOT NULL AND old.id <> m.id THEN
    v_moved := '{}'; v_ok := true;
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.agreements'::regclass AND array_length(con.conkey, 1) = 1
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING old.id;
      CONTINUE WHEN v_cnt = 0;
      BEGIN
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING m.id, old.id;
        v_moved := v_moved || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt);
      EXCEPTION WHEN unique_violation THEN
        v_ok := false;
        plan := plan || format('要確認 %s の統合：%s.%s の %s 行が %s 側とぶつかる', v_master_old, fk.tbl, fk.col, v_cnt, v_master_no);
      END;
    END LOOP;
    -- 番号ではなく id を文字で持つ繋がり（案件・更新の記録）も付け替える（agreements/master-merge.ts と同じ）。
    DELETE FROM v3.matter_links ml WHERE ml.target_type = 'agreement' AND ml.target_ref = old.id::text
       AND EXISTS (SELECT 1 FROM v3.matter_links x WHERE x.matter_id = ml.matter_id AND x.target_type = 'agreement' AND x.target_ref = m.id::text);
    UPDATE v3.matter_links SET target_ref = m.id::text WHERE target_type = 'agreement' AND target_ref = old.id::text;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN v_moved := v_moved || format('案件の繋がり %s 行', v_cnt); END IF;
    IF to_regclass('v3.term_events') IS NOT NULL THEN
      UPDATE v3.term_events SET target_id = m.id WHERE target_type = 'agreement' AND target_id = old.id;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt > 0 THEN v_moved := v_moved || format('更新の記録 %s 行', v_cnt); END IF;
    END IF;
    changes := changes || jsonb_build_object('merged_agreement', to_jsonb(old), 'into', m.id, 'moved', to_jsonb(v_moved));
    IF v_ok THEN
      DELETE FROM v3.agreements WHERE id = old.id;
      plan := plan || format('契約 %s：%s に統合して消す%s', v_master_old, v_master_no,
                             CASE WHEN array_length(v_moved, 1) IS NULL THEN '' ELSE '（付け替え：' || array_to_string(v_moved, '・') || '）' END);
    ELSE
      UPDATE v3.agreements SET status = 'terminated', updated_at = now() WHERE id = old.id;
      plan := plan || format('契約 %s：付け替えられない行があるので消さず「解除」にする', v_master_old);
    END IF;
  END IF;
  FOR r IN SELECT id, document_no, agreement_id FROM v3.documents
            WHERE document_no IN (v_master_old, v_master_no) AND status <> 'void' AND agreement_id IS DISTINCT FROM m.id LOOP
    plan := plan || format('文書 %s：契約 %s → %s', r.document_no, COALESCE((SELECT agreement_no FROM v3.agreements WHERE id = r.agreement_id), 'なし'), v_master_no);
    changes := changes || jsonb_build_object('document', r.id, 'agreement_id', r.agreement_id);
    UPDATE v3.documents SET agreement_id = m.id WHERE id = r.id;
  END LOOP;

  -- 2. 作品ごと：原作名・個別契約・in 条件・文書 ---------------------------------------
  FOR pr IN SELECT * FROM _products ORDER BY ord LOOP
    SELECT title INTO v_title FROM v3.works WHERE id = pr.work_id;
    IF pr.work_title IS NOT NULL AND v_title IS DISTINCT FROM pr.work_title THEN
      plan := plan || format('作品 #%s：作品名 %s → %s', pr.work_id, v_title, pr.work_title);
      changes := changes || jsonb_build_object('work', pr.work_id, 'title', v_title);
      UPDATE v3.works SET title = pr.work_title, updated_at = now() WHERE id = pr.work_id;
      v_title := pr.work_title;
    END IF;
    IF (SELECT source_title FROM v3.works WHERE id = pr.work_id) IS DISTINCT FROM v_source THEN
      plan := plan || format('作品 #%s「%s」：原作名 → %s', pr.work_id, v_title, v_source);
      changes := changes || jsonb_build_object('work', pr.work_id, 'source_title', (SELECT source_title FROM v3.works WHERE id = pr.work_id));
      UPDATE v3.works SET source_title = v_source, updated_at = now() WHERE id = pr.work_id;
    END IF;

    SELECT * INTO ind FROM v3.agreements
     WHERE agreement_no = pr.indiv_no OR (pr.indiv_old IS NOT NULL AND agreement_no = pr.indiv_old)
     ORDER BY (agreement_no = pr.indiv_no) DESC LIMIT 1;
    IF ind.id IS NULL THEN
      SELECT min(term_start) INTO v_first FROM v3.conditions WHERE condition_no = ANY(pr.in_nos);
      INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id, effective_on)
      VALUES (pr.indiv_no, COALESCE(pr.indiv_title, format('個別利用許諾条件書（%s）', v_title)), v_party, 'in', 'executed', 'supplement', 'license', m.id, v_first)
      RETURNING * INTO ind;
      plan := plan || format('個別契約 %s：新しく立てる（名前 %s・%s の下）', pr.indiv_no, ind.title, v_master_no);
      changes := changes || jsonb_build_object('created_agreement', ind.id, 'agreement_no', pr.indiv_no);
    ELSE
      IF ind.counterparty_id <> v_party OR ind.direction <> 'in' THEN
        RAISE EXCEPTION '個別契約 % の相手先・向きが違います', ind.agreement_no;
      END IF;
      IF ind.agreement_no IS DISTINCT FROM pr.indiv_no OR ind.kind IS DISTINCT FROM 'supplement' OR ind.domain IS DISTINCT FROM 'license' OR ind.parent_id IS DISTINCT FROM m.id THEN
        plan := plan || format('個別契約 %s → %s：種類 %s → 個別契約、種別 %s → ライセンス、親 → %s',
                               ind.agreement_no, pr.indiv_no, ind.kind, COALESCE(ind.domain, '空'), v_master_no);
        changes := changes || jsonb_build_object('agreement', ind.id, 'agreement_no', ind.agreement_no, 'kind', ind.kind, 'domain', ind.domain, 'parent_id', ind.parent_id);
        UPDATE v3.agreements SET agreement_no = pr.indiv_no, kind = 'supplement', domain = 'license', parent_id = m.id, updated_at = now() WHERE id = ind.id;
      END IF;
      IF pr.indiv_title IS NOT NULL AND ind.title IS DISTINCT FROM pr.indiv_title THEN
        plan := plan || format('個別契約 %s：名前 %s → %s', pr.indiv_no, ind.title, pr.indiv_title);
        changes := changes || jsonb_build_object('agreement', ind.id, 'title', ind.title);
        UPDATE v3.agreements SET title = pr.indiv_title, updated_at = now() WHERE id = ind.id;
      END IF;
    END IF;

    FOR r IN
      SELECT c.id, c.condition_no, c.name, c.status, c.rate_ppm, c.agreement_id, c.work_id, c.work_part_id, a.agreement_no AS ano
        FROM v3.conditions c LEFT JOIN v3.agreements a ON a.id = c.agreement_id
       WHERE COALESCE(c.series_id, c.id) IN (SELECT COALESCE(series_id, id) FROM v3.conditions WHERE condition_no = ANY(pr.in_nos))
       ORDER BY c.id
    LOOP
      v_name := r.name;
      IF r.name IN ('（無題の条件）', '') THEN
        -- 1 本目の作品の、同じ料率の in 条件の名前（自社製造・自社販売／再許諾／自社製造・他社販売）。
        SELECT c1.name INTO v_name FROM v3.conditions c1
         WHERE c1.condition_no = ANY(v_main_nos) AND c1.rate_ppm IS NOT DISTINCT FROM r.rate_ppm
           AND c1.name NOT IN ('（無題の条件）', '') LIMIT 1;
        v_name := COALESCE(v_name, r.name);
      END IF;
      IF r.agreement_id IS DISTINCT FROM ind.id OR r.work_id IS DISTINCT FROM pr.work_id OR v_name IS DISTINCT FROM r.name THEN
        plan := plan || format('  in 条件 %s（%s）：契約 %s → %s%s%s', r.condition_no, r.status, COALESCE(r.ano, 'なし'), pr.indiv_no,
                               CASE WHEN r.work_id IS DISTINCT FROM pr.work_id THEN format('、作品 %s → #%s', COALESCE('#' || r.work_id, 'なし'), pr.work_id) ELSE '' END,
                               CASE WHEN v_name IS DISTINCT FROM r.name THEN format('、名前 %s → %s', r.name, v_name) ELSE '' END);
        changes := changes || jsonb_build_object('condition', r.id, 'agreement_id', r.agreement_id, 'work_id', r.work_id,
                                                 'work_part_id', r.work_part_id, 'name', r.name);
        UPDATE v3.conditions
           SET agreement_id = ind.id, name = v_name, work_id = pr.work_id,
               work_part_id = CASE WHEN work_id = pr.work_id THEN work_part_id END, updated_at = now()
         WHERE id = r.id;
      END IF;
    END LOOP;

    FOR r IN SELECT id, document_no, agreement_id FROM v3.documents
              WHERE document_no IN (pr.indiv_old, pr.indiv_no) AND status <> 'void' AND agreement_id IS DISTINCT FROM ind.id LOOP
      plan := plan || format('  文書 %s：契約 %s → %s', r.document_no, COALESCE((SELECT agreement_no FROM v3.agreements WHERE id = r.agreement_id), 'なし'), pr.indiv_no);
      changes := changes || jsonb_build_object('document', r.id, 'agreement_id', r.agreement_id);
      UPDATE v3.documents SET agreement_id = ind.id WHERE id = r.id;
    END LOOP;
  END LOOP;

  -- 3. 重複の作品を消す ------------------------------------------------------------
  -- 「使わない」になっていても消す（ほかの表の行は主の作品へ付け替えてから）。
  FOR w IN SELECT * FROM v3.works wk WHERE wk.id = ANY(v_dup_works) ORDER BY wk.id LOOP
    FOR r IN SELECT c.id, c.condition_no, c.direction, c.work_part_id, pa.name AS party FROM v3.conditions c
               JOIN v3.parties pa ON pa.id = c.counterparty_id WHERE c.work_id = w.id ORDER BY c.id LOOP
      plan := plan || format('条件 %s（%s・%s）：作品 #%s → #%s', r.condition_no, r.party, r.direction, w.id, v_main_work);
      changes := changes || jsonb_build_object('condition', r.id, 'work_id', w.id, 'work_part_id', r.work_part_id);
      UPDATE v3.conditions SET work_id = v_main_work, work_part_id = NULL, updated_at = now() WHERE id = r.id;
    END LOOP;
    -- 原作を作品として立てていた系譜（親子）は、原作名に置き換えたので外す。
    FOR r IN SELECT * FROM v3.work_lineage WHERE parent_work_id = w.id OR child_work_id = w.id LOOP
      plan := plan || format('作品の系譜 #%s → #%s（%s）：外す', r.parent_work_id, r.child_work_id, r.relation_type);
      changes := changes || jsonb_build_object('deleted_lineage', to_jsonb(r));
      DELETE FROM v3.work_lineage WHERE parent_work_id = r.parent_work_id AND child_work_id = r.child_work_id AND relation_type = r.relation_type;
    END LOOP;
    -- 作品を指しているほかの行（クレジット・刊行物・案件…）は、主の作品へ付け替える（原作名は作品の項目に
    -- 持つので、原作として立てていた作品の付帯情報も主の作品のものにする）。パートは作品と一緒に消える。
    -- 主の作品に同じ行があってぶつかるものは付け替えず、作品は消さずに「使わない」にして出す。
    v_refs := '{}'; v_moved := '{}';
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.works'::regclass AND array_length(con.conkey, 1) = 1
         AND con.conrelid NOT IN ('v3.work_parts'::regclass, 'v3.work_lineage'::regclass)
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING w.id;
      CONTINUE WHEN v_cnt = 0;
      BEGIN
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING v_main_work, w.id;
        v_moved := v_moved || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt);
      EXCEPTION WHEN unique_violation THEN
        v_refs := v_refs || format('%s.%s %s 行（#%s に同じ行がある）', fk.tbl, fk.col, v_cnt, v_main_work);
      END;
    END LOOP;
    IF array_length(v_moved, 1) IS NOT NULL THEN
      plan := plan || format('作品 #%s の付帯情報を #%s へ付け替える（%s）', w.id, v_main_work, array_to_string(v_moved, '・'));
      changes := changes || jsonb_build_object('moved_from_work', w.id, 'to', v_main_work, 'moved', to_jsonb(v_moved));
    END IF;
    IF array_length(v_refs, 1) IS NULL THEN
      BEGIN
        DELETE FROM v3.works WHERE id = w.id;
        plan := plan || format('作品 #%s %s「%s」：消す', w.id, COALESCE(w.work_code, ''), w.title);
        changes := changes || jsonb_build_object('deleted_work', to_jsonb(w));
      EXCEPTION WHEN foreign_key_violation THEN
        -- パートを指している行などが残っていた。
        UPDATE v3.works SET status = 'archived', updated_at = now() WHERE id = w.id;
        plan := plan || format('要確認 作品 #%s %s：まだ参照されていて消せないので「使わない」にする（%s）', w.id, COALESCE(w.work_code, ''), SQLERRM);
      END;
    ELSE
      UPDATE v3.works SET status = 'archived', updated_at = now() WHERE id = w.id;
      plan := plan || format('要確認 作品 #%s %s「%s」：付け替えるとぶつかる行があるので消さず「使わない」にする（%s）',
                             w.id, COALESCE(w.work_code, ''), w.title, array_to_string(v_refs, '・'));
      changes := changes || jsonb_build_object('archived_work', w.id, 'status', w.status);
    END IF;
  END LOOP;

  -- 4. 重複の in 条件：付帯情報を残す条件へ付け替えてから無効にする -------------------------
  FOR u IN
    SELECT DISTINCT ON (x.id) x.id, x.condition_no, x.status, t.id AS twin_id, t.condition_no AS twin
      FROM v3.conditions x
      JOIN v3.conditions t ON t.condition_no = ANY(v_keep) AND t.counterparty_id = x.counterparty_id
       AND t.rate_ppm IS NOT DISTINCT FROM x.rate_ppm AND t.term_start = x.term_start
     WHERE x.counterparty_id = v_party AND x.direction = 'in' AND x.work_id IS NULL
       AND x.status IN ('active', 'scheduled') AND NOT (x.condition_no = ANY(v_keep))
     ORDER BY x.id, t.id
  LOOP
    v_ok := true; v_moved := '{}';
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.conditions'::regclass AND array_length(con.conkey, 1) = 1
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING u.id;
      CONTINUE WHEN v_cnt = 0;
      BEGIN
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING u.twin_id, u.id;
        v_moved := v_moved || format('%s.%s %s 行', fk.tbl, fk.col, v_cnt);
      EXCEPTION WHEN unique_violation THEN
        -- 範囲・文書の繋がりは残す側にもうある。重複側の行を外す。それ以外は人が見る。
        IF fk.tbl::text IN ('v3.condition_scopes', 'v3.document_conditions') THEN
          EXECUTE format('DELETE FROM %s WHERE %I = $1', fk.tbl, fk.col) USING u.id;
          v_moved := v_moved || format('%s %s 行（残す側にあるので外した）', fk.tbl, v_cnt);
        ELSE
          v_ok := false;
          plan := plan || format('要確認 %s（%s の重複）：%s.%s の %s 行が残す側とぶつかるので付け替えられない', u.condition_no, u.twin, fk.tbl, fk.col, v_cnt);
        END IF;
      END;
    END LOOP;
    IF v_ok THEN
      plan := plan || format('重複の in 条件 %s：%s の重複として無効にする%s', u.condition_no, u.twin,
                             CASE WHEN array_length(v_moved, 1) IS NULL THEN '（付帯情報なし）'
                                  ELSE '（付け替え：' || array_to_string(v_moved, '・') || '）' END);
      changes := changes || jsonb_build_object('voided_condition', u.id, 'twin', u.twin_id, 'status', u.status, 'moved', to_jsonb(v_moved));
      UPDATE v3.conditions
         SET status = 'void', updated_at = now(),
             notes = concat_ws(E'\n', NULLIF(notes, ''), format('作品の整理（%s）：%s の重複として無効。付帯情報は %s へ', current_date, u.twin, u.twin))
       WHERE id = u.id;
    END IF;
  END LOOP;

  -- 5. out 条件：作品ごと・相手先ごとに 1 本の単体契約へ ---------------------------------
  v_year := extract(year FROM (now() AT TIME ZONE 'Asia/Tokyo'))::int;
  FOR p IN
    SELECT c.work_id, wk.title AS work_title, c.counterparty_id AS party_id, pa.name AS party_name,
           array_agg(DISTINCT c2.id) AS ids, min(c2.term_start) AS first_on
      FROM v3.conditions c
      JOIN v3.works wk ON wk.id = c.work_id
      JOIN v3.parties pa ON pa.id = c.counterparty_id
      JOIN v3.conditions c2 ON COALESCE(c2.series_id, c2.id) = COALESCE(c.series_id, c.id)
     WHERE c.direction = 'out' AND c.work_id = ANY(v_works) AND c.status <> 'void'
     GROUP BY c.work_id, wk.title, c.counterparty_id, pa.name ORDER BY c.work_id, pa.name
  LOOP
    SELECT a2.* INTO oa FROM v3.agreements a2
     WHERE a2.id IN (SELECT agreement_id FROM v3.conditions WHERE id = ANY(p.ids))
       AND a2.counterparty_id = p.party_id AND a2.direction = 'out'
       AND NOT EXISTS (SELECT 1 FROM v3.conditions x WHERE x.agreement_id = a2.id AND x.work_id IS DISTINCT FROM p.work_id)
     ORDER BY (a2.kind = 'standalone') DESC, a2.id LIMIT 1;
    IF oa.id IS NOT NULL THEN
      v_target := oa.id;
      IF oa.kind IS DISTINCT FROM 'standalone' OR oa.domain IS DISTINCT FROM 'license' OR oa.parent_id IS NOT NULL THEN
        plan := plan || format('out 契約 %s（%s・%s）：種類 %s → 単体契約、種別 %s → ライセンス', oa.agreement_no, p.party_name, p.work_title, oa.kind, COALESCE(oa.domain, '空'));
        changes := changes || jsonb_build_object('agreement', oa.id, 'kind', oa.kind, 'domain', oa.domain, 'parent_id', oa.parent_id);
        UPDATE v3.agreements SET kind = 'standalone', domain = 'license', parent_id = NULL, updated_at = now() WHERE id = oa.id;
      END IF;
    ELSE
      LOOP
        INSERT INTO v3.document_sequences (prefix, year, current_value)
        VALUES ('ARC-ILT', v_year, COALESCE((
          SELECT max(substring(agreement_no FROM '^ARC-ILT-' || v_year || '-(\d+)$')::int)
            FROM v3.agreements WHERE agreement_no ~ ('^ARC-ILT-' || v_year || '-\d+$')), 0) + 1)
        ON CONFLICT (prefix, year) DO UPDATE SET current_value = v3.document_sequences.current_value + 1
        RETURNING current_value INTO v_seq;
        v_no := format('ARC-ILT-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM v3.agreements WHERE agreement_no = v_no)
              AND NOT EXISTS (SELECT 1 FROM v3.documents WHERE document_no = v_no);
      END LOOP;
      INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, effective_on)
      VALUES (v_no, format(v_out_title, p.work_title, p.party_name), p.party_id, 'out', 'executed', 'standalone', 'license', p.first_on)
      RETURNING id INTO v_target;
      plan := plan || format('out 契約 %s：新しく単体契約を立てる（名前 %s）', v_no, format(v_out_title, p.work_title, p.party_name));
      changes := changes || jsonb_build_object('created_agreement', v_target, 'agreement_no', v_no);
    END IF;
    FOR r IN
      SELECT c.id, c.condition_no, c.status, c.agreement_id, ag.agreement_no AS ano
        FROM v3.conditions c LEFT JOIN v3.agreements ag ON ag.id = c.agreement_id
       WHERE c.id = ANY(p.ids) AND c.agreement_id IS DISTINCT FROM v_target ORDER BY c.id
    LOOP
      plan := plan || format('  out 条件 %s（%s・%s）：契約 %s → %s', r.condition_no, p.party_name, r.status,
                             COALESCE(r.ano, 'なし'), (SELECT agreement_no FROM v3.agreements WHERE id = v_target));
      changes := changes || jsonb_build_object('condition', r.id, 'agreement_id', r.agreement_id);
      UPDATE v3.conditions SET agreement_id = v_target, updated_at = now() WHERE id = r.id;
    END LOOP;
  END LOOP;

  -- 6. 触らずに出すもの ------------------------------------------------------------
  FOR r IN
    SELECT c.condition_no, round(c.rate_ppm / 10000.0, 3) AS rate, c.term_start,
           (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS ev
      FROM v3.conditions c
     WHERE c.counterparty_id = v_party AND c.direction = 'in' AND c.work_id IS NULL AND c.status IN ('active', 'scheduled')
     ORDER BY c.term_start NULLS LAST, c.condition_no
  LOOP
    plan := plan || format('要確認 %s（料率 %s%%・期間開始 %s・実績 %s）：作品の無い条件。重複か、ほかの作品の条件かを決める',
                           r.condition_no, r.rate, COALESCE(r.term_start::text, 'なし'), r.ev);
  END LOOP;
  IF to_regclass('v3.condition_holder_190_backup') IS NOT NULL THEN
    FOR r IN EXECUTE
      'SELECT a.agreement_no, string_agg(c.condition_no, ''・'' ORDER BY c.condition_no) AS conds,
              (SELECT string_agg(d.document_no, ''・'') FROM v3.documents d WHERE d.agreement_id = a.id) AS docs
         FROM v3.conditions c JOIN v3.condition_holder_190_backup b ON b.condition_id = c.id
         JOIN v3.agreements a ON a.id = b.agreement_id
        WHERE c.counterparty_id = $1 AND c.work_id IS NULL AND c.status IN (''active'', ''scheduled'')
        GROUP BY a.id, a.agreement_no ORDER BY a.agreement_no' USING v_party
    LOOP
      plan := plan || format('  手がかり：%s は整理前 %s に載っていた（その契約の文書 %s）', r.conds, r.agreement_no, COALESCE(r.docs, 'なし'));
    END LOOP;
  END IF;
  FOR r IN
    SELECT a.agreement_no, a.kind, (SELECT string_agg(d.document_no, '・') FROM v3.documents d WHERE d.agreement_id = a.id) AS docs
      FROM v3.agreements a
     WHERE a.counterparty_id = v_party AND a.id <> m.id
       AND NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM v3.agreements ch WHERE ch.parent_id = a.id)
     ORDER BY a.agreement_no
  LOOP
    plan := plan || format('要確認 契約 %s（%s・文書 %s）：条件が載っていない。個別契約の版なら文書をその個別契約へ、要らなければ解除',
                           r.agreement_no, r.kind, COALESCE(r.docs, 'なし'));
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['変えるところはありません（もう整っています）']; END IF;

  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES (v_actor, 'work.tree_fix', 'work', v_main_work,
          jsonb_build_object('master', v_master_no, 'products', (SELECT jsonb_agg(to_jsonb(x) ORDER BY ord) FROM _products x),
                             'dupWorks', v_dup_works, 'plan', to_jsonb(plan), 'changes', changes));

  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n'
                                    || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
