-- =====================================================================
-- スタジオ・アーカムの契約の整理（DO ブロック 1 つ）。調査：diag/party-contracts.sql q=アーカム
--
--   起きたこと（アプリは直した：agreements/auto.ts・order-agreement.ts）
--     ・条件書を基本契約（ARC-PUB-2026-0003）を選んで決定すると、個別契約が立たず基本契約に直付けになった
--       → ARC-PUBT-2026-1030／1031 は個別契約が無い。1032 は訂正版 -R2 だけが基本契約に載り、
--         新紀元社版の条件（CL-2026-01116〜01118）がどの契約にも載っていない
--     ・発注書を訂正するたびに、版ごとに個別契約（発注書の器）が立った
--       → ARC-PO-2026-9001 に 6 本（-R7〜-R11）、ARC-PO-2026-1160 に 2 本（-R4）
--
--   直すこと
--     1. 条件書（1029〜1032）：本体の番号の個別契約（無ければ基本契約の下に立てる）に、全部の版を載せる。
--        決定済みの版に載っている条件のうち、契約が無いもの・基本契約に直付けのもの・発注書の器に
--        載っているもの（CL-2026-01128、CL-2026-90006 など）をその個別契約に寄せる。
--        別の条件書の個別契約に載っている条件は動かさない（要確認として出す）。
--     2. 発注書（9001・1160）：版ごとの器を本体の番号の器 1 本にまとめる（器はいま決定済みの版を指す）。
--        文書・条件・案件・稟議のつながりを寄せてから、余った器を消す（消せなければ「統合済み」にして残す）。
--   触らないもの：無題の条件（CL-2026-00098〜00107・00142・00143）、取込文書（ARC-PO-2026-0064／0065、
--     ARC-ROY-2026-0010）、検収書・計算書。金額・実績・支払は変えない。
--
--   ★ 予備系（ローカル）で流す：infra\local で
--       docker compose run --rm ops sql /v3/diag/fix-arkham-contracts.sql
--     まずそのまま流す（お試し。一覧が出て、何も変わらない）→ よければ dry := false にして流す。
--     何度流しても同じ結果（2 回目は「直すものはありません」に近い一覧になる）。
-- =====================================================================

DO $fix$
DECLARE
  dry        boolean := true;                       -- ★ false にすると書き込む
  v_party_name text := 'スタジオ・アーカム';
  v_terms    text[] := ARRAY['ARC-PUBT-2026-1029', 'ARC-PUBT-2026-1030', 'ARC-PUBT-2026-1031', 'ARC-PUBT-2026-1032'];
  v_orders   text[] := ARRAY['ARC-PO-2026-9001', 'ARC-PO-2026-1160'];
  -- 念のため：この条件・文書は何があっても触らない（質問 1・2 の答え待ち）。
  v_keep_conds text[] := ARRAY['CL-2026-00098', 'CL-2026-00099', 'CL-2026-00100', 'CL-2026-00101', 'CL-2026-00102',
                               'CL-2026-00103', 'CL-2026-00104', 'CL-2026-00105', 'CL-2026-00106', 'CL-2026-00107',
                               'CL-2026-00142', 'CL-2026-00143'];
  v_keep_docs  text[] := ARRAY['ARC-PO-2026-0064', 'ARC-PO-2026-0065', 'ARC-ROY-2026-0010'];
  plan       text[] := '{}';
  v_party    bigint;
  v_base     text;
  v_docs     bigint[];
  v_cur      record;
  v_master   record;
  v_supp     record;
  v_supp_id  bigint;
  v_n        int;
  v_list     text;
  v_chain    bigint[];
  v_keep     record;
  v_extra    bigint[];
  v_extra_no text;
  fk         record;
  r          record;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT array_agg(p.id) INTO v_docs FROM v3.parties p WHERE p.name LIKE '%' || v_party_name || '%' AND p.merged_into_id IS NULL;
  IF COALESCE(array_length(v_docs, 1), 0) <> 1 THEN
    RAISE EXCEPTION '取引先「%」が 1 社に決まりません（% 社）', v_party_name, COALESCE(array_length(v_docs, 1), 0);
  END IF;
  v_party := v_docs[1];
  plan := plan || format('取引先 #%s %s', v_party, (SELECT name FROM v3.parties WHERE id = v_party));

  -- ===== 1. 条件書 =====
  plan := plan || '== 1. 条件書を個別契約に載せる =='::text;
  FOREACH v_base IN ARRAY v_terms LOOP
    SELECT array_agg(dd.id ORDER BY dd.id) INTO v_docs
      FROM v3.documents dd
     WHERE (dd.document_no = v_base OR dd.document_no ~ ('^' || v_base || '-R[0-9]+$'))
       AND dd.status IN ('issued', 'superseded') AND dd.document_no <> ALL (v_keep_docs);
    IF v_docs IS NULL THEN plan := plan || format('要確認 %s：文書が見つからないので触らない', v_base); CONTINUE; END IF;

    SELECT dd.id, dd.document_no, dd.issued_at, dd.agreement_id, t.label INTO v_cur
      FROM v3.documents dd
      JOIN v3.document_template_versions tv ON tv.id = dd.template_version_id
      JOIN v3.document_templates t ON t.id = tv.template_id
     WHERE dd.id = ANY(v_docs) AND dd.status = 'issued'
     ORDER BY dd.issued_at DESC, dd.id DESC LIMIT 1;
    IF v_cur.id IS NULL THEN plan := plan || format('要確認 %s：決定済みの版が無いので触らない', v_base); CONTINUE; END IF;

    -- 基本契約：文書が載っている基本契約か、個別契約の親。無ければこの取引先の基本契約（1 本だけのとき）。
    SELECT a.id, a.agreement_no, a.domain, a.direction INTO v_master
      FROM v3.agreements a
     WHERE a.id IN (SELECT CASE WHEN COALESCE(x.kind, 'master') = 'master' THEN x.id ELSE x.parent_id END
                      FROM v3.documents dd JOIN v3.agreements x ON x.id = dd.agreement_id WHERE dd.id = ANY(v_docs))
       AND COALESCE(a.kind, 'master') = 'master' AND a.counterparty_id = v_party
     ORDER BY a.id LIMIT 1;
    IF v_master.id IS NULL THEN
      SELECT count(*) INTO v_n FROM v3.agreements a WHERE a.counterparty_id = v_party AND a.kind = 'master';
      IF v_n = 1 THEN
        SELECT a.id, a.agreement_no, a.domain, a.direction INTO v_master
          FROM v3.agreements a WHERE a.counterparty_id = v_party AND a.kind = 'master';
      ELSE
        plan := plan || format('要確認 %s：基本契約が決まらないので触らない', v_base); CONTINUE;
      END IF;
    END IF;

    -- 個別契約：本体の番号のもの（同じ取引先・発注書の器でない）。無ければ立てる。
    SELECT a.id, a.agreement_no, a.kind, a.parent_id INTO v_supp
      FROM v3.agreements a
     WHERE a.agreement_no = v_base AND a.counterparty_id = v_party
       AND a.kind IN ('supplement', 'standalone') AND a.order_document_id IS NULL
     ORDER BY a.id LIMIT 1;
    IF v_supp.id IS NULL THEN
      IF EXISTS (SELECT 1 FROM v3.agreements a WHERE a.agreement_no = v_base) THEN
        plan := plan || format('要確認 %s：同じ番号の別の契約があるので触らない', v_base); CONTINUE;
      END IF;
      INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id, effective_on)
      VALUES (v_base,
              v_cur.label || COALESCE((SELECT '（' || w.title || '）'
                                         FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
                                         JOIN v3.works w ON w.id = c.work_id
                                        WHERE dc.document_id = v_cur.id ORDER BY c.id LIMIT 1), ''),
              v_party, COALESCE(v_master.direction, 'in'), 'negotiating', 'supplement', COALESCE(v_master.domain, 'license'),
              v_master.id, (v_cur.issued_at AT TIME ZONE 'Asia/Tokyo')::date)
      RETURNING id INTO v_supp_id;
      plan := plan || format('%s：個別契約を立てる（親 %s）', v_base, v_master.agreement_no);
    ELSE
      v_supp_id := v_supp.id;
      IF v_supp.kind = 'standalone' AND v_supp.parent_id IS NULL THEN
        UPDATE v3.agreements SET kind = 'supplement', parent_id = v_master.id, updated_at = now() WHERE id = v_supp_id;
        plan := plan || format('%s：単体契約を %s の下の個別契約にする', v_base, v_master.agreement_no);
      END IF;
    END IF;

    -- 全部の版を個別契約に（契約なし・基本契約に直付けのものだけ）。
    SELECT string_agg(dd.document_no, '・' ORDER BY dd.id) INTO v_list FROM v3.documents dd
     WHERE dd.id = ANY(v_docs) AND (dd.agreement_id IS NULL OR dd.agreement_id = v_master.id);
    UPDATE v3.documents SET agreement_id = v_supp_id
     WHERE id = ANY(v_docs) AND (agreement_id IS NULL OR agreement_id = v_master.id);
    IF v_list IS NOT NULL THEN plan := plan || format('  文書 %s → %s', v_list, v_base); END IF;

    -- 決定済みの版の条件を個別契約に寄せる。
    FOR r IN
      SELECT c.id, c.condition_no, c.name, c.agreement_id AS was_id, a.agreement_no AS was_no, a.kind AS was_kind, a.order_document_id AS was_order,
             a.counterparty_id AS was_party
        FROM v3.document_conditions dc
        JOIN v3.conditions c ON c.id = dc.condition_id
        LEFT JOIN v3.agreements a ON a.id = c.agreement_id
       WHERE dc.document_id = v_cur.id
         AND c.agreement_id IS DISTINCT FROM v_supp_id
         AND COALESCE(c.condition_no, '') <> ALL (v_keep_conds)
       ORDER BY c.condition_no
    LOOP
      IF r.was_id IS NULL OR r.was_id = v_master.id OR (r.was_order IS NOT NULL AND r.was_party = v_party) THEN
        UPDATE v3.conditions SET agreement_id = v_supp_id, updated_at = now() WHERE id = r.id;
        plan := plan || format('  条件 %s（%s）：%s → %s', r.condition_no, left(r.name, 30),
                               COALESCE(r.was_no || CASE WHEN r.was_order IS NOT NULL THEN '（発注書）' ELSE '' END, '契約なし'), v_base);
      ELSE
        plan := plan || format('  要確認 条件 %s：別の契約 %s に載っているので動かさない', r.condition_no, r.was_no);
      END IF;
    END LOOP;
  END LOOP;

  -- ===== 2. 発注書 =====
  plan := plan || '== 2. 発注書の器を 1 本にまとめる =='::text;
  FOREACH v_base IN ARRAY v_orders LOOP
    -- いま決定済みの版から、差し替え元を辿った版の並び。
    SELECT dd.id, dd.document_no INTO v_cur
      FROM v3.documents dd
     WHERE (dd.document_no = v_base OR dd.document_no ~ ('^' || v_base || '-R[0-9]+$')) AND dd.status = 'issued'
     ORDER BY dd.issued_at DESC, dd.id DESC LIMIT 1;
    IF v_cur.id IS NULL THEN plan := plan || format('要確認 %s：決定済みの版が無いので触らない', v_base); CONTINUE; END IF;
    WITH RECURSIVE chain(id, depth) AS (
      SELECT v_cur.id::bigint, 0
      UNION ALL
      SELECT dd.supersedes_id, c.depth + 1 FROM v3.documents dd JOIN chain c ON dd.id = c.id
       WHERE dd.supersedes_id IS NOT NULL AND c.depth < 100
    )
    SELECT array_agg(id ORDER BY depth DESC) INTO v_chain FROM chain;

    -- 器の候補：版を指す器・版が載っている器（同じ取引先の個別契約・単体契約）。
    -- 残すのは本体の番号の器（無ければいちばん古いもの）。
    SELECT a.id, a.agreement_no, a.title INTO v_keep
      FROM v3.agreements a
     WHERE a.counterparty_id = v_party AND a.kind IN ('standalone', 'supplement')
       AND (a.order_document_id = ANY(v_chain) OR a.id IN (SELECT agreement_id FROM v3.documents WHERE id = ANY(v_chain)))
     ORDER BY (a.agreement_no = v_base) DESC, a.id LIMIT 1;
    IF v_keep.id IS NULL THEN plan := plan || format('要確認 %s：器が無いので触らない', v_base); CONTINUE; END IF;
    SELECT array_agg(a.id ORDER BY a.id), string_agg(a.agreement_no || '#' || a.id, '・' ORDER BY a.id) INTO v_extra, v_extra_no
      FROM v3.agreements a
     WHERE a.counterparty_id = v_party AND a.kind IN ('standalone', 'supplement') AND a.id <> v_keep.id
       AND (a.order_document_id = ANY(v_chain) OR a.id IN (SELECT agreement_id FROM v3.documents WHERE id = ANY(v_chain)));

    plan := plan || format('%s：器 %s#%s を残す（決定済みの版 %s を指す）%s', v_base, v_keep.agreement_no, v_keep.id, v_cur.document_no,
                           CASE WHEN v_extra IS NULL THEN '' ELSE format('。%s をまとめる', v_extra_no) END);

    IF v_extra IS NOT NULL THEN
      -- 条件・文書・下の契約・案件・稟議・更新の記録を寄せる。
      SELECT count(*) INTO v_n FROM v3.conditions WHERE agreement_id = ANY(v_extra);
      UPDATE v3.conditions SET agreement_id = v_keep.id, updated_at = now() WHERE agreement_id = ANY(v_extra);
      IF v_n > 0 THEN plan := plan || format('  条件 %s 件 → %s', v_n, v_keep.agreement_no); END IF;
      UPDATE v3.documents SET agreement_id = v_keep.id WHERE agreement_id = ANY(v_extra);
      UPDATE v3.agreements SET parent_id = v_keep.id, updated_at = now() WHERE parent_id = ANY(v_extra);
      DELETE FROM v3.matter_links ml
       WHERE ml.target_type = 'agreement' AND ml.target_ref = ANY(SELECT x::text FROM unnest(v_extra) x)
         AND EXISTS (SELECT 1 FROM v3.matter_links y WHERE y.matter_id = ml.matter_id AND y.target_type = 'agreement' AND y.target_ref = v_keep.id::text);
      DELETE FROM v3.matter_links ml
       WHERE ml.target_type = 'agreement' AND ml.target_ref = ANY(SELECT x::text FROM unnest(v_extra) x)
         AND ml.id <> (SELECT min(z.id) FROM v3.matter_links z WHERE z.matter_id = ml.matter_id AND z.target_type = 'agreement'
                         AND z.target_ref = ANY(SELECT x::text FROM unnest(v_extra) x));
      UPDATE v3.matter_links SET target_ref = v_keep.id::text
       WHERE target_type = 'agreement' AND target_ref = ANY(SELECT x::text FROM unnest(v_extra) x);
      DELETE FROM v3.ringi_links rl
       WHERE rl.target_type = 'agreement' AND rl.target_id = ANY(v_extra)
         AND (EXISTS (SELECT 1 FROM v3.ringi_links y WHERE y.ringi_id = rl.ringi_id AND y.target_type = 'agreement' AND y.target_id = v_keep.id)
              OR rl.target_id <> (SELECT min(z.target_id) FROM v3.ringi_links z WHERE z.ringi_id = rl.ringi_id AND z.target_type = 'agreement'
                                    AND z.target_id = ANY(v_extra)));
      UPDATE v3.ringi_links SET target_id = v_keep.id WHERE target_type = 'agreement' AND target_id = ANY(v_extra);
      UPDATE v3.term_events SET target_id = v_keep.id WHERE target_type = 'agreement' AND target_id = ANY(v_extra);
      -- ほかに agreements を指す列（外部キー）があれば、それも寄せる。
      FOR fk IN
        SELECT n.nspname AS sch, c.relname AS tbl, att.attname AS col
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND con.confrelid = 'v3.agreements'::regclass AND array_length(con.conkey, 1) = 1
           AND NOT (c.relname IN ('conditions', 'documents') AND att.attname = 'agreement_id')
           AND NOT (c.relname = 'agreements' AND att.attname = 'parent_id')
      LOOP
        EXECUTE format('UPDATE %I.%I SET %I = $1 WHERE %I = ANY($2)', fk.sch, fk.tbl, fk.col, fk.col) USING v_keep.id, v_extra;
      END LOOP;
      -- 余った器を消す。消せなければ「統合済み」にして残す。
      UPDATE v3.agreements SET order_document_id = NULL WHERE id = ANY(v_extra);
      BEGIN
        DELETE FROM v3.agreements WHERE id = ANY(v_extra);
        plan := plan || format('  器 %s を消す', v_extra_no);
      EXCEPTION WHEN foreign_key_violation THEN
        UPDATE v3.agreements
           SET status = 'terminated', terminated_on = COALESCE(terminated_on, current_date),
               title = '【統合済み → ' || v_keep.agreement_no || '】' || title, updated_at = now()
         WHERE id = ANY(v_extra);
        plan := plan || format('  器 %s はほかから指されているので「統合済み」にして残す（%s）', v_extra_no, SQLERRM);
      END;
    END IF;

    -- 残す器：決定済みの版を指し、全部の版を載せる。件名の版の番号（-R6 など）を外す。
    UPDATE v3.agreements
       SET order_document_id = v_cur.id,
           title = regexp_replace(title, v_base || '-R[0-9]+', v_base),
           updated_at = now()
     WHERE id = v_keep.id
       AND (order_document_id IS DISTINCT FROM v_cur.id OR title ~ (v_base || '-R[0-9]+'));
    SELECT string_agg(dd.document_no, '・' ORDER BY dd.id) INTO v_list FROM v3.documents dd
     WHERE dd.id = ANY(v_chain) AND dd.agreement_id IS DISTINCT FROM v_keep.id;
    UPDATE v3.documents SET agreement_id = v_keep.id
     WHERE id = ANY(v_chain) AND agreement_id IS DISTINCT FROM v_keep.id
       AND (agreement_id IS NULL OR agreement_id NOT IN (SELECT id FROM v3.agreements WHERE kind = 'master'));
    IF v_list IS NOT NULL THEN plan := plan || format('  文書 %s → %s', v_list, v_keep.agreement_no); END IF;
  END LOOP;

  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES ('sql:fix-arkham-contracts', 'agreement.tidy', 'party', v_party,
          jsonb_build_object('terms', to_jsonb(v_terms), 'orders', to_jsonb(v_orders), 'plan', to_jsonb(plan)));

  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
