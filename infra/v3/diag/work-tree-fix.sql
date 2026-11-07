-- =====================================================================
-- 作品 1 本を「基本契約 → 作品 → 個別契約 → in 条件 ／ out 条件は作品に付けて相手先ごとの単体契約」
-- に整える（Cloud SQL Studio 用。DO ブロック 1 つ）。初期値はトーネードスプラッシュ。
--
--   やること
--     1. 基本契約：v_master_no を 基本契約（master）・ライセンスにする。
--     2. 個別契約：v_indiv_no を 基本契約の下の個別契約（supplement）・ライセンスにする。
--     3. in 条件：v_in_nos（と同じ系列の前の版）を個別契約に載せ、作品を v_work にする。
--     4. 文書：個別契約の番号の文書を個別契約に、基本契約の番号の文書を基本契約に付ける。
--     5. 重複の作品（v_dup_works）：付いている条件を v_work に寄せてから消す。
--        ほかの表から参照されていて消せなければ「使わない（archived）」にする。
--     6. 重複の in 条件：作家の「作品の無い条件」のうち、v_in_nos と同じ期間開始・同じ料率のものを
--        無効（void）にする。実績・支払の割当・文書・計算書の行があるものは触らず「要確認」に出す。
--     7. out 条件：作品（v_work と重複の作品）に付いた out 条件を、全版とも作品 v_work に付け、
--        相手先ごとに 1 本の単体契約（standalone・ライセンス・OUT）に載せる。
--        その相手先の契約でこの作品の条件だけを持つものがあれば、それを単体契約にして使う。
--        無ければ新しく立てる（番号 ARC-ILT-年-連番。アプリの採番と同じ表を進める）。
--        中身が空になった前の契約は消さずに一覧に出す。
--     決定済みの計算書・支払・実績は書き換えない（条件の付き先と作品だけ）。
--
--   ★ 使い方
--     1) そのまま流す（dry := true）。何も書かずに、やることの一覧がエラーとして出る
--        （「お試し：書き込みは取り消しました」で始まる）。一覧を確かめる。
--     2) dry := false にして流す。書き込んで、やったことの一覧を監査記録に残す。
--        あとで見るとき：SELECT detail FROM v3.audit_events WHERE action = 'work.tree_fix' ORDER BY id DESC LIMIT 1;
--     3) diag/work-tree.sql を流し直して形を確かめる。
--
--   戻すとき：監査記録（detail.changes）に前の値が残る。
-- =====================================================================

DO $fix$
DECLARE
  dry          boolean  := true;                      -- ★ false にすると書き込む
  v_party      bigint   := 505;                       -- 作家（in 側の権利者）
  v_work       bigint   := 50;                        -- 正にする作品
  v_dup_works  bigint[] := ARRAY[25, 628]::bigint[];  -- 同じ作品の重複（消す）
  v_master_no  text     := 'CT-2026-00008';           -- 基本契約
  v_indiv_no   text     := 'ARC-ILT-2026-0007';       -- 個別契約
  v_in_nos     text[]   := ARRAY['CL-2026-00406', 'CL-2026-00407', 'CL-2026-00408-R2'];
  v_actor      text     := 'sql:work-tree-fix';

  plan    text[]  := '{}';
  changes jsonb   := '[]'::jsonb;
  m record; i record; r record; w record; u record; oa record; p record;
  v_title text; v_target bigint; v_no text; v_seq int; v_year int; v_works bigint[];
  fk record; v_refs text[]; v_cnt bigint;
  n_ev int; n_al int; n_dc int; n_sl int; n int;
BEGIN
  v_works := ARRAY[v_work] || v_dup_works;
  SELECT title INTO v_title FROM v3.works WHERE id = v_work;
  IF v_title IS NULL THEN RAISE EXCEPTION '作品 % が見つかりません', v_work; END IF;

  -- 0. 前提 -----------------------------------------------------------------
  SELECT * INTO m FROM v3.agreements WHERE agreement_no = v_master_no;
  IF m.id IS NULL THEN RAISE EXCEPTION '基本契約 % が見つかりません', v_master_no; END IF;
  IF m.counterparty_id <> v_party OR m.direction <> 'in' THEN
    RAISE EXCEPTION '基本契約 % の相手先・向きが違います（相手先 %、向き %）', v_master_no, m.counterparty_id, m.direction;
  END IF;
  SELECT * INTO i FROM v3.agreements WHERE agreement_no = v_indiv_no;
  IF i.id IS NULL THEN RAISE EXCEPTION '個別契約 % が見つかりません', v_indiv_no; END IF;
  IF i.counterparty_id <> v_party OR i.direction <> 'in' THEN
    RAISE EXCEPTION '個別契約 % の相手先・向きが違います（相手先 %、向き %）', v_indiv_no, i.counterparty_id, i.direction;
  END IF;
  SELECT count(*) INTO n FROM v3.conditions
   WHERE condition_no = ANY(v_in_nos) AND counterparty_id = v_party AND direction = 'in';
  IF n <> array_length(v_in_nos, 1) THEN
    RAISE EXCEPTION 'in 条件 % のうち、作家・IN で見つかったのは % 本です', array_to_string(v_in_nos, '・'), n;
  END IF;

  -- 1. 基本契約 ---------------------------------------------------------------
  IF m.kind IS DISTINCT FROM 'master' OR m.domain IS DISTINCT FROM 'license' OR m.parent_id IS NOT NULL THEN
    plan := plan || format('基本契約 %s：種類 %s → 基本契約、種別 %s → ライセンス', v_master_no, m.kind, COALESCE(m.domain, '空'));
    changes := changes || jsonb_build_object('agreement', m.id, 'no', v_master_no, 'kind', m.kind, 'domain', m.domain, 'parent_id', m.parent_id);
    UPDATE v3.agreements SET kind = 'master', domain = 'license', parent_id = NULL, updated_at = now() WHERE id = m.id;
  END IF;

  -- 2. 個別契約 ---------------------------------------------------------------
  IF i.kind IS DISTINCT FROM 'supplement' OR i.domain IS DISTINCT FROM 'license' OR i.parent_id IS DISTINCT FROM m.id THEN
    plan := plan || format('個別契約 %s：種類 %s → 個別契約、種別 %s → ライセンス、親 → %s', v_indiv_no, i.kind, COALESCE(i.domain, '空'), v_master_no);
    changes := changes || jsonb_build_object('agreement', i.id, 'no', v_indiv_no, 'kind', i.kind, 'domain', i.domain, 'parent_id', i.parent_id);
    UPDATE v3.agreements SET kind = 'supplement', domain = 'license', parent_id = m.id, updated_at = now() WHERE id = i.id;
  END IF;

  -- 3. in 条件（同じ系列の前の版も） ----------------------------------------------
  FOR r IN
    SELECT c.id, c.condition_no, c.status, c.agreement_id, c.work_id, c.work_part_id, a.agreement_no AS ano
      FROM v3.conditions c LEFT JOIN v3.agreements a ON a.id = c.agreement_id
     WHERE COALESCE(c.series_id, c.id) IN (
       SELECT COALESCE(series_id, id) FROM v3.conditions WHERE condition_no = ANY(v_in_nos))
     ORDER BY c.id
  LOOP
    IF r.agreement_id IS DISTINCT FROM i.id OR r.work_id IS DISTINCT FROM v_work THEN
      plan := plan || format('in 条件 %s（%s）：契約 %s → %s%s', r.condition_no, r.status, COALESCE(r.ano, 'なし'), v_indiv_no,
                             CASE WHEN r.work_id IS DISTINCT FROM v_work THEN format('、作品 %s → %s', COALESCE(r.work_id::text, 'なし'), v_work) ELSE '' END);
      changes := changes || jsonb_build_object('condition', r.id, 'no', r.condition_no, 'agreement_id', r.agreement_id,
                                               'work_id', r.work_id, 'work_part_id', r.work_part_id);
      UPDATE v3.conditions
         SET agreement_id = i.id, work_id = v_work,
             work_part_id = CASE WHEN work_id = v_work THEN work_part_id END, updated_at = now()
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- 4. 文書の付き先 --------------------------------------------------------------
  FOR r IN SELECT d.id, d.document_no, d.agreement_id FROM v3.documents d
            WHERE d.document_no IN (v_indiv_no, v_master_no) AND d.status <> 'void' LOOP
    v_target := CASE WHEN r.document_no = v_indiv_no THEN i.id ELSE m.id END;
    IF r.agreement_id IS DISTINCT FROM v_target THEN
      plan := plan || format('文書 %s：契約 %s → %s', r.document_no,
                             COALESCE((SELECT agreement_no FROM v3.agreements WHERE id = r.agreement_id), 'なし'), r.document_no);
      changes := changes || jsonb_build_object('document', r.id, 'no', r.document_no, 'agreement_id', r.agreement_id);
      UPDATE v3.documents SET agreement_id = v_target WHERE id = r.id;
    END IF;
  END LOOP;

  -- 5. 重複の作品 ----------------------------------------------------------------
  FOR w IN SELECT * FROM v3.works wk WHERE wk.id = ANY(v_dup_works)
              -- もう「使わない」にしてあり、条件も付いていなければ済み（2 回目に流したとき）。
              AND NOT (wk.status = 'archived' AND NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.work_id = wk.id))
            ORDER BY wk.id LOOP
    SELECT count(*) INTO n FROM v3.conditions WHERE work_id = w.id AND direction = 'in';
    IF n > 0 THEN
      plan := plan || format('重複の作品 #%s %s：in 条件 %s 本を #%s に寄せる', w.id, w.work_code, n, v_work);
      changes := changes || jsonb_build_object('move_in_conditions_from_work', w.id,
        'ids', (SELECT jsonb_agg(id) FROM v3.conditions WHERE work_id = w.id AND direction = 'in'));
      UPDATE v3.conditions SET work_id = v_work, work_part_id = NULL, updated_at = now()
       WHERE work_id = w.id AND direction = 'in';
    END IF;
    -- out 条件も作品だけ先に寄せる（契約は 7 で付け替える）。消す前に寄せておく。
    FOR r IN SELECT c.id, c.condition_no, c.work_part_id, pa.name AS party FROM v3.conditions c
               JOIN v3.parties pa ON pa.id = c.counterparty_id
              WHERE c.work_id = w.id AND c.direction = 'out' ORDER BY c.id LOOP
      plan := plan || format('out 条件 %s（%s）：作品 #%s → #%s', r.condition_no, r.party, w.id, v_work);
      changes := changes || jsonb_build_object('condition', r.id, 'no', r.condition_no, 'work_id', w.id, 'work_part_id', r.work_part_id);
      UPDATE v3.conditions SET work_id = v_work, work_part_id = NULL, updated_at = now() WHERE id = r.id;
    END LOOP;
    -- ほかの表（パート・親子・クレジット・刊行物・案件…）から参照されていれば消さない。
    -- 消すと「消したら一緒に消える」表（ON DELETE CASCADE）の行まで黙って消えるため。
    v_refs := '{}';
    FOR fk IN
      SELECT con.conrelid::regclass AS tbl, att.attname AS col
        FROM pg_constraint con
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'v3.works'::regclass AND array_length(con.conkey, 1) = 1
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO v_cnt USING w.id;
      IF v_cnt > 0 THEN v_refs := v_refs || format('%s %s 行', fk.tbl, v_cnt); END IF;
    END LOOP;
    IF array_length(v_refs, 1) IS NULL THEN
      DELETE FROM v3.works WHERE id = w.id;
      plan := plan || format('重複の作品 #%s %s「%s」：消す', w.id, COALESCE(w.work_code, ''), w.title);
      changes := changes || jsonb_build_object('deleted_work', to_jsonb(w));
    ELSE
      UPDATE v3.works SET status = 'archived', updated_at = now() WHERE id = w.id;
      plan := plan || format('重複の作品 #%s %s「%s」：参照があるので消さず「使わない」にする（%s）',
                             w.id, COALESCE(w.work_code, ''), w.title, array_to_string(v_refs, '・'));
      changes := changes || jsonb_build_object('archived_work', w.id, 'status', w.status);
    END IF;
  END LOOP;

  -- 6. 重複の in 条件（作品の無い条件のうち、同じ期間開始・同じ料率のもの） -------------
  FOR u IN
    SELECT DISTINCT ON (x.id) x.id, x.condition_no, x.status, x.notes, t.condition_no AS twin
      FROM v3.conditions x
      JOIN v3.conditions t ON t.condition_no = ANY(v_in_nos)
       AND t.rate_ppm IS NOT DISTINCT FROM x.rate_ppm AND t.term_start IS NOT DISTINCT FROM x.term_start
     WHERE x.counterparty_id = v_party AND x.direction = 'in' AND x.work_id IS NULL
       AND x.status IN ('active', 'scheduled') AND x.term_start IS NOT NULL
     ORDER BY x.id, t.id
  LOOP
    SELECT count(*) INTO n_ev FROM v3.condition_events WHERE condition_id = u.id AND status = 'active';
    SELECT count(*) INTO n_al FROM v3.payment_allocations WHERE condition_id = u.id;
    SELECT count(*) INTO n_dc FROM v3.document_conditions WHERE condition_id = u.id;
    SELECT count(*) INTO n_sl FROM v3.statement_lines WHERE condition_id = u.id;
    IF n_ev + n_al + n_dc + n_sl = 0 THEN
      plan := plan || format('重複の in 条件 %s：%s の二重登録として無効にする', u.condition_no, u.twin);
      changes := changes || jsonb_build_object('voided_condition', u.id, 'no', u.condition_no, 'status', u.status);
      UPDATE v3.conditions
         SET status = 'void', updated_at = now(),
             notes = concat_ws(E'\n', NULLIF(notes, ''), format('作品の整理（%s）：%s の二重登録として無効', current_date, u.twin))
       WHERE id = u.id;
    ELSE
      plan := plan || format('要確認 %s（%s の二重登録の疑い）：実績 %s・支払の割当 %s・文書 %s・計算書の行 %s があるので触らない',
                             u.condition_no, u.twin, n_ev, n_al, n_dc, n_sl);
    END IF;
  END LOOP;
  -- 作品の無い in 条件で、実績が入っているもの（重複かどうかを人が決める）
  FOR u IN
    SELECT c.condition_no, count(e.id) AS ev, sum(e.quantity) AS q, sum(e.amount) AS amt
      FROM v3.conditions c JOIN v3.condition_events e ON e.condition_id = c.id AND e.status = 'active'
     WHERE c.counterparty_id = v_party AND c.direction = 'in' AND c.work_id IS NULL AND c.status IN ('active', 'scheduled')
     GROUP BY c.condition_no ORDER BY c.condition_no
  LOOP
    plan := plan || format('要確認 %s：作品の無い条件に実績 %s 件（数量 %s・金額 %s）。この作品のものなら実績を正しい条件へ移す', u.condition_no, u.ev, u.q, u.amt);
  END LOOP;

  -- 7. out 条件：作品に付け、相手先ごとに 1 本の単体契約へ ---------------------------
  v_year := extract(year FROM (now() AT TIME ZONE 'Asia/Tokyo'))::int;
  FOR p IN
    SELECT c.counterparty_id AS party_id, pa.name AS party_name,
           array_agg(DISTINCT c2.id) AS ids, min(c2.term_start) AS first_on
      FROM v3.conditions c
      JOIN v3.parties pa ON pa.id = c.counterparty_id
      JOIN v3.conditions c2 ON COALESCE(c2.series_id, c2.id) = COALESCE(c.series_id, c.id)
     WHERE c.direction = 'out' AND c.work_id = ANY(v_works) AND c.status <> 'void'
     GROUP BY c.counterparty_id, pa.name ORDER BY pa.name
  LOOP
    -- この相手先の契約で、この作品の条件だけを持っているもの（あれば単体契約にして使う）。
    SELECT a2.* INTO oa FROM v3.agreements a2
     WHERE a2.id IN (SELECT agreement_id FROM v3.conditions WHERE id = ANY(p.ids))
       AND a2.counterparty_id = p.party_id AND a2.direction = 'out'
       AND NOT EXISTS (SELECT 1 FROM v3.conditions x WHERE x.agreement_id = a2.id
                         AND (x.work_id IS NULL OR NOT (x.work_id = ANY(v_works))))
     ORDER BY (a2.kind = 'standalone') DESC, a2.id LIMIT 1;
    IF oa.id IS NOT NULL THEN
      v_target := oa.id;
      IF oa.kind IS DISTINCT FROM 'standalone' OR oa.domain IS DISTINCT FROM 'license' OR oa.parent_id IS NOT NULL THEN
        plan := plan || format('out 契約 %s（%s）：種類 %s → 単体契約、種別 %s → ライセンス', oa.agreement_no, p.party_name, oa.kind, COALESCE(oa.domain, '空'));
        changes := changes || jsonb_build_object('agreement', oa.id, 'no', oa.agreement_no, 'kind', oa.kind, 'domain', oa.domain, 'parent_id', oa.parent_id);
        UPDATE v3.agreements SET kind = 'standalone', domain = 'license', parent_id = NULL, updated_at = now() WHERE id = oa.id;
      END IF;
    ELSE
      -- 新しく単体契約を立てる。番号はアプリ（agreements/service.ts）と同じ ARC-ILT の採番表を進める。
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
      VALUES (v_no, format('%s 利用許諾（%s）', v_title, p.party_name), p.party_id, 'out', 'executed', 'standalone', 'license', p.first_on)
      RETURNING id INTO v_target;
      plan := plan || format('out 契約 %s（%s）：新しく単体契約を立てる（%s 利用許諾）', v_no, p.party_name, v_title);
      changes := changes || jsonb_build_object('created_agreement', v_target, 'no', v_no);
    END IF;
    -- 条件（全版）を作品と単体契約に付ける。
    FOR r IN
      SELECT c.id, c.condition_no, c.status, c.agreement_id, c.work_id, c.work_part_id, ag.agreement_no AS ano
        FROM v3.conditions c LEFT JOIN v3.agreements ag ON ag.id = c.agreement_id
       WHERE c.id = ANY(p.ids) ORDER BY c.id
    LOOP
      IF r.agreement_id IS DISTINCT FROM v_target OR r.work_id IS DISTINCT FROM v_work THEN
        plan := plan || format('  out 条件 %s（%s・%s）：契約 %s → %s%s', r.condition_no, p.party_name, r.status,
                               COALESCE(r.ano, 'なし'), (SELECT agreement_no FROM v3.agreements WHERE id = v_target),
                               CASE WHEN r.work_id IS DISTINCT FROM v_work THEN format('、作品 %s → %s', COALESCE(r.work_id::text, 'なし'), v_work) ELSE '' END);
        changes := changes || jsonb_build_object('condition', r.id, 'no', r.condition_no, 'agreement_id', r.agreement_id,
                                                 'work_id', r.work_id, 'work_part_id', r.work_part_id);
        UPDATE v3.conditions
           SET agreement_id = v_target, work_id = v_work,
               work_part_id = CASE WHEN work_id = v_work THEN work_part_id END, updated_at = now()
         WHERE id = r.id;
      END IF;
    END LOOP;
  END LOOP;

  -- 中身が空になった契約（消さない。文書があれば付いたまま）
  FOR r IN
    SELECT DISTINCT a3.agreement_no, (SELECT count(*) FROM v3.documents d WHERE d.agreement_id = a3.id) AS docs
      FROM jsonb_array_elements(changes) ch
      JOIN v3.agreements a3 ON a3.id = (ch->>'agreement_id')::bigint
     WHERE ch ? 'condition'
       AND NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = a3.id)
       AND NOT EXISTS (SELECT 1 FROM v3.agreements ch2 WHERE ch2.parent_id = a3.id)
  LOOP
    plan := plan || format('空になった契約 %s（文書 %s）：消していない。要らなければ契約の画面で解除するか、文書だけの契約に', r.agreement_no, r.docs);
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['変えるところはありません（もう整っています）']; END IF;

  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES (v_actor, 'work.tree_fix', 'work', v_work,
          jsonb_build_object('master', v_master_no, 'individual', v_indiv_no, 'inConditions', v_in_nos,
                             'dupWorks', v_dup_works, 'plan', to_jsonb(plan), 'changes', changes));

  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n'
                                    || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
