-- =====================================================================
-- 取引先 1 社の契約を整理する（条件書の個別契約・発注書の器）。fix-arkham-contracts.sql を一般にしたもの。
-- 調査は diag/party-contracts.sql q=…（先に流して中身を確かめる）。
--
--   直すこと（アプリは 2026-11 に直した：agreements/auto.ts・order-agreement.ts。以前に決定した分の後始末）
--     1. 条件書（個別利用許諾条件書・出版等利用許諾条件書。番号が ARC-PUBT／ARC-ILT の文書は、取り込んだもの・
--        旧システムから移したもの（pub_license_terms など）も条件書として扱う）
--        本体の番号ごとに、個別契約（基本契約の下）に全部の版を載せる。
--          ・本体の番号の個別契約があればそれ、決定済みの版が個別契約・単体契約に載っていればそれを使う
--          ・無ければ基本契約の下に立てる（番号＝条件書の本体の番号）
--          ・文書：契約なし・基本契約に直付けの版だけ移す
--          ・条件：決定済みの版に載っている条件のうち、契約なし・基本契約に直付け・発注書の器に載っているものを寄せる
--            （別の条件書の個別契約に載っているもの・名前の無い条件（種類未設定）は動かさず、要確認に出す）
--     2. 発注書：訂正のたびに立った器（版ごとの個別契約）を 1 本にまとめ、器はいま決定済みの版を指す
--   金額・実績・支払は変えない。
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/fix-party-contracts.sql q=DucQrews
--       書き込む：docker compose run --rm ops sql /v3/diag/fix-party-contracts.sql q=DucQrews write=1
--     q は取引先名・カナ・別名・取引先コードの一部（統合先で 1 社に決まらなければ止まる）。
--     何度流しても同じ結果（2 回目は「直すものはありません」）。
--     本番（Cloud SQL Studio）で流すときは、\ で始まる行を消し、2 か所の current_setting(...) を値に置き換える。
-- =====================================================================

\if :{?q}
\else
  \echo '取引先名の一部を q=… で渡してください（例: ops sql /v3/diag/fix-party-contracts.sql q=DucQrews）'
  \quit
\endif
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.party_q', :'q', false) AS 取引先, set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry        boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  v_q        text := '%' || current_setting('fix.party_q') || '%';
  -- 条件書のひな形。旧システム（V2）から移した pub_license_terms・individual_license_terms も含める。
  terms_keys text[] := ARRAY['individual_license_terms_v3', 'individual_license_terms_v4', 'pub_license_terms_v3', 'pub_license_terms_v3_annex',
                             'pub_license_terms', 'individual_license_terms'];
  order_keys text[] := ARRAY['purchase_order', 'intl_purchase_order'];
  plan       text[] := '{}';
  changed    int := 0;
  v_party    bigint;
  v_parties  bigint[];
  v_names    text;
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
  o          record;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;

  -- 取引先：統合先で 1 社に決まること。
  SELECT array_agg(DISTINCT rp.resolved_id), string_agg(DISTINCT p2.name, '・')
    INTO v_parties, v_names
    FROM v3.parties pa
    JOIN v3.v_party_resolved rp ON rp.party_id = pa.id
    JOIN v3.parties p2 ON p2.id = rp.resolved_id
   WHERE pa.name ILIKE v_q OR COALESCE(pa.name_kana, '') ILIKE v_q OR COALESCE(pa.party_code, '') ILIKE v_q
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x ILIKE v_q);
  IF COALESCE(array_length(v_parties, 1), 0) <> 1 THEN
    RAISE EXCEPTION '取引先「%」が 1 社に決まりません（%）。q を絞ってください', current_setting('fix.party_q'), COALESCE(v_names, '該当なし');
  END IF;
  v_party := v_parties[1];
  -- 統合元も含めた取引先の id。
  SELECT array_agg(party_id) INTO v_parties FROM v3.v_party_resolved WHERE resolved_id = v_party;
  plan := plan || format('取引先 #%s %s', v_party, (SELECT name FROM v3.parties WHERE id = v_party));

  -- ===== 1. 条件書 =====
  plan := plan || '== 1. 条件書を個別契約に載せる =='::text;
  FOR v_base IN
    WITH td AS (
      SELECT dd.id, regexp_replace(dd.document_no, '-R[0-9]+$', '') AS base
        FROM v3.documents dd
        LEFT JOIN v3.document_template_versions tv ON tv.id = dd.template_version_id
        LEFT JOIN v3.document_templates t ON t.id = tv.template_id
       WHERE dd.status IN ('issued', 'superseded') AND dd.document_no IS NOT NULL
         -- ひな形が条件書か、番号が条件書の番号（ARC-PUBT／ARC-ILT。取り込んだ文書・移行した文書も）。
         AND (t.template_key = ANY (terms_keys)
              OR dd.document_no ~ '^ARC-(PUBT|ILT)(-D)?-[0-9]{4}-[0-9]+(-R[0-9]+)?$')
         -- 取り込んだ文書で、種類が条件書以外（計算書・検収書など）と分かっているものは条件書と見なさない
         -- （番号だけ PUBT で取り込んだ計算書があった。種類は diag/not-terms-document.sql か画面で直す）。
         AND NOT (dd.template_version_id IS NULL
                  AND COALESCE(dd.manual_inputs->>'documentKind', '') ~ '計算書|検収|納品|請求|支払|発注|見積|領収')
         AND (dd.agreement_id IN (SELECT id FROM v3.agreements WHERE counterparty_id = ANY (v_parties))
              OR EXISTS (SELECT 1 FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
                          WHERE dc.document_id = dd.id AND c.counterparty_id = ANY (v_parties)))
    )
    SELECT DISTINCT base FROM td ORDER BY base
  LOOP
    SELECT array_agg(dd.id ORDER BY dd.id) INTO v_docs
      FROM v3.documents dd
     WHERE (dd.document_no = v_base OR dd.document_no ~ ('^' || v_base || '-R[0-9]+$'))
       AND dd.status IN ('issued', 'superseded');

    SELECT dd.id, dd.document_no, dd.issued_at, dd.agreement_id,
           COALESCE(t.label, dd.manual_inputs->>'documentKind', '条件書') AS label,
           COALESCE(a.kind, 'master') AS agreement_kind, a.order_document_id AS agreement_order, a.counterparty_id AS agreement_party
      INTO v_cur
      FROM v3.documents dd
      LEFT JOIN v3.document_template_versions tv ON tv.id = dd.template_version_id
      LEFT JOIN v3.document_templates t ON t.id = tv.template_id
      LEFT JOIN v3.agreements a ON a.id = dd.agreement_id
     WHERE dd.id = ANY(v_docs) AND dd.status = 'issued'
     ORDER BY dd.issued_at DESC NULLS LAST, dd.id DESC LIMIT 1;
    IF v_cur.id IS NULL THEN plan := plan || format('要確認 %s：決定済みの版が無いので触らない', v_base); CONTINUE; END IF;

    -- 基本契約：版が載っている基本契約か、個別契約の親。無ければこの取引先の基本契約（1 本だけのとき）。
    SELECT a.id, a.agreement_no, a.domain, a.direction INTO v_master
      FROM v3.agreements a
     WHERE a.id IN (SELECT CASE WHEN COALESCE(x.kind, 'master') = 'master' THEN x.id ELSE x.parent_id END
                      FROM v3.documents dd JOIN v3.agreements x ON x.id = dd.agreement_id WHERE dd.id = ANY(v_docs))
       AND COALESCE(a.kind, 'master') = 'master' AND a.counterparty_id = ANY (v_parties)
     ORDER BY a.id LIMIT 1;
    IF v_master.id IS NULL THEN
      SELECT count(*) INTO v_n FROM v3.agreements a WHERE a.counterparty_id = ANY (v_parties) AND a.kind = 'master' AND a.terminated_on IS NULL;
      IF v_n = 1 THEN
        SELECT a.id, a.agreement_no, a.domain, a.direction INTO v_master
          FROM v3.agreements a WHERE a.counterparty_id = ANY (v_parties) AND a.kind = 'master' AND a.terminated_on IS NULL;
      ELSE
        plan := plan || format('要確認 %s：基本契約が決まらないので触らない（基本契約 %s 本）', v_base, v_n); CONTINUE;
      END IF;
    END IF;

    -- 個別契約：本体の番号のもの → 決定済みの版が載っている個別契約・単体契約 → 無ければ立てる。
    SELECT a.id, a.agreement_no, a.kind, a.parent_id INTO v_supp
      FROM v3.agreements a
     WHERE a.agreement_no = v_base AND a.counterparty_id = ANY (v_parties)
       AND a.kind IN ('supplement', 'standalone') AND a.order_document_id IS NULL
     ORDER BY a.id LIMIT 1;
    IF v_supp.id IS NULL AND v_cur.agreement_kind IN ('supplement', 'standalone') AND v_cur.agreement_order IS NULL
       AND v_cur.agreement_party = ANY (v_parties) THEN
      SELECT a.id, a.agreement_no, a.kind, a.parent_id INTO v_supp FROM v3.agreements a WHERE a.id = v_cur.agreement_id;
    END IF;
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
      changed := changed + 1;
    ELSE
      v_supp_id := v_supp.id;
      IF v_supp.kind = 'standalone' AND v_supp.parent_id IS NULL THEN
        UPDATE v3.agreements SET kind = 'supplement', parent_id = v_master.id, updated_at = now() WHERE id = v_supp_id;
        plan := plan || format('%s：単体契約 %s を %s の下の個別契約にする', v_base, v_supp.agreement_no, v_master.agreement_no);
        changed := changed + 1;
      END IF;
    END IF;

    -- 全部の版を個別契約に（契約なし・基本契約に直付けのものだけ）。
    SELECT string_agg(dd.document_no, '・' ORDER BY dd.id) INTO v_list FROM v3.documents dd
     WHERE dd.id = ANY(v_docs) AND (dd.agreement_id IS NULL OR dd.agreement_id = v_master.id);
    IF v_list IS NOT NULL THEN
      UPDATE v3.documents SET agreement_id = v_supp_id
       WHERE id = ANY(v_docs) AND (agreement_id IS NULL OR agreement_id = v_master.id);
      plan := plan || format('  文書 %s → %s', v_list, (SELECT agreement_no FROM v3.agreements WHERE id = v_supp_id));
      changed := changed + 1;
    END IF;

    -- 決定済みの版の条件を個別契約に寄せる。
    FOR r IN
      SELECT c.id, c.condition_no, c.name, c.agreement_id AS was_id, a.agreement_no AS was_no, a.order_document_id AS was_order,
             a.counterparty_id AS was_party
        FROM v3.document_conditions dc
        JOIN v3.conditions c ON c.id = dc.condition_id
        LEFT JOIN v3.agreements a ON a.id = c.agreement_id
       WHERE dc.document_id = v_cur.id AND c.status NOT IN ('superseded', 'void')
         AND c.agreement_id IS DISTINCT FROM v_supp_id
       ORDER BY c.condition_no
    LOOP
      IF btrim(COALESCE(r.name, '')) = '' THEN
        plan := plan || format('  要確認 条件 %s：名前の無い条件（種類未設定）なので動かさない', r.condition_no);
      ELSIF r.was_id IS NULL OR r.was_id = v_master.id OR (r.was_order IS NOT NULL AND r.was_party = ANY (v_parties)) THEN
        UPDATE v3.conditions SET agreement_id = v_supp_id, updated_at = now() WHERE id = r.id;
        plan := plan || format('  条件 %s（%s）：%s → %s', r.condition_no, left(r.name, 30),
                               COALESCE(r.was_no || CASE WHEN r.was_order IS NOT NULL THEN '（発注書）' ELSE '' END, '契約なし'),
                               (SELECT agreement_no FROM v3.agreements WHERE id = v_supp_id));
        changed := changed + 1;
      ELSE
        plan := plan || format('  要確認 条件 %s：別の契約 %s に載っているので動かさない', r.condition_no, r.was_no);
      END IF;
    END LOOP;
  END LOOP;

  -- ===== 2. 発注書 =====
  plan := plan || '== 2. 発注書の器を 1 本にまとめる =='::text;
  FOR o IN
    SELECT dd.id, dd.document_no
      FROM v3.documents dd
      JOIN v3.document_template_versions tv ON tv.id = dd.template_version_id
      JOIN v3.document_templates t ON t.id = tv.template_id
     WHERE dd.status = 'issued' AND t.template_key = ANY (order_keys)
       AND (dd.agreement_id IN (SELECT id FROM v3.agreements WHERE counterparty_id = ANY (v_parties))
            OR EXISTS (SELECT 1 FROM v3.agreements x WHERE x.order_document_id = dd.id AND x.counterparty_id = ANY (v_parties))
            OR EXISTS (SELECT 1 FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
                        WHERE dc.document_id = dd.id AND c.counterparty_id = ANY (v_parties)))
     ORDER BY dd.document_no
  LOOP
    WITH RECURSIVE chain(id, depth) AS (
      SELECT o.id::bigint, 0
      UNION ALL
      SELECT dd.supersedes_id, c.depth + 1 FROM v3.documents dd JOIN chain c ON dd.id = c.id
       WHERE dd.supersedes_id IS NOT NULL AND c.depth < 100
    )
    SELECT array_agg(id ORDER BY depth DESC) INTO v_chain FROM chain;
    v_base := regexp_replace(o.document_no, '-R[0-9]+$', '');

    SELECT a.id, a.agreement_no, a.title, a.order_document_id INTO v_keep
      FROM v3.agreements a
     WHERE a.counterparty_id = ANY (v_parties) AND a.kind IN ('standalone', 'supplement')
       AND (a.order_document_id = ANY(v_chain) OR a.id IN (SELECT agreement_id FROM v3.documents WHERE id = ANY(v_chain)))
     ORDER BY (a.agreement_no = v_base) DESC, a.id LIMIT 1;
    IF v_keep.id IS NULL THEN CONTINUE; END IF;   -- 器の無い発注書（決定前の移行分など）は触らない
    SELECT array_agg(a.id ORDER BY a.id), string_agg(a.agreement_no || '#' || a.id, '・' ORDER BY a.id) INTO v_extra, v_extra_no
      FROM v3.agreements a
     WHERE a.counterparty_id = ANY (v_parties) AND a.kind IN ('standalone', 'supplement') AND a.id <> v_keep.id
       AND (a.order_document_id = ANY(v_chain) OR a.id IN (SELECT agreement_id FROM v3.documents WHERE id = ANY(v_chain)));
    SELECT string_agg(dd.document_no, '・' ORDER BY dd.id) INTO v_list FROM v3.documents dd
     WHERE dd.id = ANY(v_chain) AND dd.agreement_id IS DISTINCT FROM v_keep.id
       AND (dd.agreement_id IS NULL OR dd.agreement_id NOT IN (SELECT id FROM v3.agreements WHERE kind = 'master'));
    -- 直すものが無ければ何も出さない。
    IF v_extra IS NULL AND v_list IS NULL AND v_keep.order_document_id IS NOT DISTINCT FROM o.id
       AND v_keep.title !~ (v_base || '-R[0-9]+') THEN
      CONTINUE;
    END IF;
    plan := plan || format('%s：器 %s#%s を残す（決定済みの版 %s を指す）%s', v_base, v_keep.agreement_no, v_keep.id, o.document_no,
                           CASE WHEN v_extra IS NULL THEN '' ELSE format('。%s をまとめる', v_extra_no) END);
    changed := changed + 1;

    IF v_extra IS NOT NULL THEN
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

    UPDATE v3.agreements
       SET order_document_id = o.id, title = regexp_replace(title, v_base || '-R[0-9]+', v_base), updated_at = now()
     WHERE id = v_keep.id AND (order_document_id IS DISTINCT FROM o.id OR title ~ (v_base || '-R[0-9]+'));
    IF v_list IS NOT NULL THEN
      UPDATE v3.documents SET agreement_id = v_keep.id
       WHERE id = ANY(v_chain) AND agreement_id IS DISTINCT FROM v_keep.id
         AND (agreement_id IS NULL OR agreement_id NOT IN (SELECT id FROM v3.agreements WHERE kind = 'master'));
      plan := plan || format('  文書 %s → %s', v_list, v_keep.agreement_no);
    END IF;
  END LOOP;

  IF changed = 0 THEN plan := plan || '直すものはありません'::text; END IF;
  IF NOT dry AND changed > 0 THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    VALUES ('sql:fix-party-contracts', 'agreement.tidy', 'party', v_party, jsonb_build_object('plan', to_jsonb(plan)));
  END IF;

  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  -- 書き込んだ結果は、ops の psql が NOTICE を出さないことがあるので WARNING で出す。
  RAISE WARNING E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
