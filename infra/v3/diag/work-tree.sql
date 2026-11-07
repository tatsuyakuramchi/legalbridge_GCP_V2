-- =====================================================================
-- 作品 1 本を軸に「基本契約 → 作品 → 個別契約 → in 条件 → out 条件」の今の形を出す
-- （Cloud SQL Studio 用。読むだけ。書き込みは 1 つも無い）。
--
--   ★ 使い方
--     エディタの置換で (50, 25, 628, 585) を、整理する作品の id（正にする作品と、重複・派生の作品）に
--     置き換えてから 1〜3 を流す。3 の 505 は in 側の権利者（作家）の取引先 id。
--     （初期値はトーネードスプラッシュ：#50 が正、#25・#628 が同じ題名、#585 が派生。平沢さん #505）
-- =====================================================================

-- 1. 作品に付いている条件（全版・全相手先）。in と out、親の条件、載っている契約 ---------
SELECT c.id, c.condition_no AS 番号, c.name AS 条件名, c.direction AS 向き, c.status AS 状態,
       pa.name AS 相手先, c.work_id AS 作品id,
       COALESCE(c.series_id, c.id) AS 系列,
       pc.condition_no || ' ' || pc.name || '（' || pp.name || '）' AS 親の条件,
       (SELECT count(*) FROM v3.conditions ch WHERE ch.parent_id = c.id AND ch.status IN ('active', 'scheduled')) AS 子の条件,
       a.agreement_no AS 契約, a.kind AS 契約の種類, ap.name AS 契約の相手先, par.agreement_no AS 親の契約,
       CASE WHEN c.rate_ppm IS NOT NULL THEN round(c.rate_ppm / 10000.0, 3) || '%' END AS 料率,
       c.flat_amount AS 定額, c.term_start AS 期間開始, c.term_end AS 期間終了,
       (SELECT string_agg(s.scope_type || ':' || s.label, '・' ORDER BY s.scope_type, s.sort_order)
          FROM v3.condition_scopes s WHERE s.condition_id = c.id) AS 範囲,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 実績,
       (SELECT string_agg(DISTINCT d.document_no, '・') FROM v3.document_conditions dc JOIN v3.documents d ON d.id = dc.document_id
         WHERE dc.condition_id = c.id AND d.status <> 'void') AS 文書,
       (SELECT string_agg(DISTINCT pm.payment_no || '(' || pm.status || ')', '・')
          FROM v3.payment_allocations al JOIN v3.payments pm ON pm.id = al.payment_id
         WHERE al.condition_id = c.id AND pm.status <> 'canceled') AS 支払
  FROM v3.conditions c
  JOIN v3.parties pa ON pa.id = c.counterparty_id
  LEFT JOIN v3.conditions pc ON pc.id = c.parent_id
  LEFT JOIN v3.parties pp ON pp.id = pc.counterparty_id
  LEFT JOIN v3.agreements a ON a.id = c.agreement_id
  LEFT JOIN v3.parties ap ON ap.id = a.counterparty_id
  LEFT JOIN v3.agreements par ON par.id = a.parent_id
 WHERE c.work_id IN (50, 25, 628, 585)
 ORDER BY c.direction, pa.name, COALESCE(c.series_id, c.id), c.id;

-- 2. その条件が載っている契約（と親の契約）の形と文書 --------------------------------
WITH a0 AS (
  SELECT DISTINCT c.agreement_id AS id FROM v3.conditions c WHERE c.work_id IN (50, 25, 628, 585) AND c.agreement_id IS NOT NULL
), a1 AS (
  SELECT id FROM a0 UNION SELECT a.parent_id FROM v3.agreements a WHERE a.id IN (SELECT id FROM a0) AND a.parent_id IS NOT NULL
)
SELECT a.id, a.agreement_no AS 番号, a.title AS 件名, a.kind AS 種類, a.domain AS 種別, a.direction AS 向き,
       pa.name AS 相手先, a.status AS 状態, par.agreement_no AS 親, a.executed_on AS 締結日, a.expires_on AS 満了,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id) AS 載っている条件,
       (SELECT string_agg(d.document_no || '(' || d.status || ')', '・') FROM v3.documents d WHERE d.agreement_id = a.id) AS 文書
  FROM v3.agreements a
  JOIN v3.parties pa ON pa.id = a.counterparty_id
  LEFT JOIN v3.agreements par ON par.id = a.parent_id
 WHERE a.id IN (SELECT id FROM a1)
 ORDER BY a.direction, pa.name, COALESCE(a.parent_id, a.id), a.id;

-- 3. 作品の無い in 条件のうち、作品の in 条件と同じ期間・同じ料率のもの（二重登録の候補） ----
SELECT u.condition_no AS 作品の無い条件, round(u.rate_ppm / 10000.0, 3) || '%' AS 料率, u.term_start AS 期間開始,
       u.status AS 状態, t.condition_no AS 同じ期間_料率の作品の条件, t.name AS その条件名,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = u.id AND e.status = 'active') AS 実績,
       (SELECT count(*) FROM v3.payment_allocations al WHERE al.condition_id = u.id) AS 支払の割当
  FROM v3.conditions u
  JOIN v3.conditions t ON t.counterparty_id = u.counterparty_id AND t.work_id IN (50, 25, 628, 585)
   AND t.direction = u.direction AND t.rate_ppm IS NOT DISTINCT FROM u.rate_ppm
   AND t.term_start IS NOT DISTINCT FROM u.term_start AND t.status IN ('active', 'scheduled')
 WHERE u.counterparty_id = 505 AND u.work_id IS NULL
 ORDER BY u.condition_no;
