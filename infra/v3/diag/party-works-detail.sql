-- =====================================================================
-- party-works.sql の続き：取引先 1 件の「無題の条件」「文書だけの契約」「差し替え前の条件に残った実績」を
-- 掘り下げる（Cloud SQL Studio 用。読むだけ。書き込みは 1 つも無い）。
--
--   ★ 使い方
--     505 を取引先の id（party-works.sql の 1 で出た id）に置き換えてから、A〜E を 1 つずつ流す。
--     B は 190_condition_holder.sql を流した DB でだけ動く（退避の表を読む）。
-- =====================================================================

-- A. 作品・契約の無い条件の手がかり（移行元の番号・範囲・期間・備考） ------------
SELECT c.id, c.condition_no AS 番号, c.name AS 条件名, c.status AS 状態,
       round(c.rate_ppm / 10000.0, 3) || '%' AS 料率, c.pricing_model AS 料金の型, c.unit_amount AS 単価,
       c.term_start AS 期間開始, c.term_end AS 期間終了, c.effective_from AS 適用開始,
       c.legacy_id AS 移行元id, c.parent_id AS 親の条件id, c.royalty_base AS 料率の基準,
       (SELECT string_agg(s.scope_type || ':' || s.label, '・' ORDER BY s.scope_type, s.sort_order)
          FROM v3.condition_scopes s WHERE s.condition_id = c.id) AS 範囲,
       left(c.notes, 120) AS 備考,
       (SELECT count(*) FROM v3.document_conditions dc WHERE dc.condition_id = c.id) AS 繋がった文書,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 実績,
       (SELECT count(*) FROM v3.payment_allocations al WHERE al.condition_id = c.id) AS 支払の割当,
       c.created_at AS 登録日時
  FROM v3.conditions c
 WHERE c.counterparty_id = 505 AND (c.work_id IS NULL OR c.agreement_id IS NULL)
 ORDER BY c.term_start NULLS LAST, c.condition_no;

-- B. 190（条件の持ち主の付け替え）の前に、どの契約に載っていたか -----------------
--    （190 を流していない DB ではこの文だけ「表が無い」で止まる。ほかには影響しない）
SELECT c.condition_no AS 番号, round(c.rate_ppm / 10000.0, 3) || '%' AS 料率,
       b.agreement_id AS 以前の契約id, a.agreement_no AS 以前の契約, a.title AS 以前の契約の件名,
       a.kind AS 以前の契約の種類,
       (SELECT string_agg(d.document_no, '・') FROM v3.documents d WHERE d.agreement_id = a.id) AS その契約の文書,
       cur.agreement_no AS いまの契約
  FROM v3.conditions c
  JOIN v3.condition_holder_190_backup b ON b.condition_id = c.id
  LEFT JOIN v3.agreements a ON a.id = b.agreement_id
  LEFT JOIN v3.agreements cur ON cur.id = c.agreement_id
 WHERE c.counterparty_id = 505
 ORDER BY a.agreement_no NULLS FIRST, c.condition_no;

-- C. 文書だけになっている契約と、その文書の中身（製品・作品・料率の手がかり） ---------
SELECT a.agreement_no AS 契約, a.kind AS 種類, d.document_no AS 文書, d.status AS 文書の状態, d.issued_at::date AS 決定日,
       COALESCE(t.template_key, d.manual_inputs->>'documentKind') AS ひな形,
       (SELECT string_agg(kv.key || '=' || left(kv.value #>> '{}', 60), ' ／ ' ORDER BY kv.key)
          FROM jsonb_each(COALESCE(NULLIF(d.rendered_values, '{}'::jsonb), d.manual_inputs)) kv
         WHERE kv.key ~* '(product|work|title|name|rate|edition|sku|item|製品|作品|料率|版)'
           AND jsonb_typeof(kv.value) IN ('string', 'number')
           AND length(kv.value #>> '{}') > 0) AS 中身の手がかり
  FROM v3.agreements a
  LEFT JOIN v3.documents d ON d.agreement_id = a.id
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE a.counterparty_id = 505
 ORDER BY a.agreement_no, d.id;

-- D. 実績の中身（作品の無い条件に入った実績・差し替え前の条件に残った実績） --------------
SELECT c.condition_no AS 条件, c.status AS 条件の状態, e.id AS 実績id, e.event_type AS 種類,
       e.occurred_on AS 日付, e.period AS 期間, e.quantity AS 数量, e.amount AS 金額, e.status AS 実績の状態,
       left(e.note, 80) AS 備考, e.created_at::date AS 入れた日,
       (SELECT string_agg(DISTINCT d.document_no, '・')
          FROM v3.statement_lines sl JOIN v3.statements s ON s.id = sl.statement_id JOIN v3.documents d ON d.id = s.document_id
         WHERE sl.event_id = e.id) AS 計算書,
       (SELECT string_agg(DISTINCT pm.payment_no || '(' || pm.status || ')', '・')
          FROM v3.payment_allocations al JOIN v3.payments pm ON pm.id = al.payment_id WHERE al.event_id = e.id) AS 支払
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE c.counterparty_id = 505
   AND (c.work_id IS NULL OR c.status IN ('superseded', 'void'))
 ORDER BY c.condition_no, e.occurred_on, e.id;

-- E. この人の支払と、割り当てた条件（予定のまま残っているものを見る） -----------------
SELECT pm.payment_no AS 支払, pm.status AS 状態, pm.amount AS 額, pm.withholding_amount AS 源泉,
       pm.due_on AS 期日, pm.paid_on AS 支払日, left(pm.note, 60) AS 備考,
       (SELECT string_agg(c.condition_no || '(' || c.status || ')' || COALESCE(' 実績#' || al.event_id, '') || ' ' || al.amount, '・' ORDER BY al.id)
          FROM v3.payment_allocations al JOIN v3.conditions c ON c.id = al.condition_id WHERE al.payment_id = pm.id) AS 割当
  FROM v3.payments pm
 WHERE pm.party_id = 505 AND pm.direction = 'out'
 ORDER BY pm.due_on NULLS LAST, pm.id;
