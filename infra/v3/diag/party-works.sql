-- =====================================================================
-- ある取引先（作家・権利者）の「作品 ⇔ 条件 ⇔ 契約 ⇔ 文書 ⇔ 実績・計算書・支払」を
-- 一度に洗い出す（Cloud SQL Studio 用。読むだけ。書き込みは 1 つも無い）。
--
--   作品が荒れている（同じ作品が何本も立っている・条件がばらばらの作品に付いている・
--   版の違う条件が混ざっている）ときに、どこを直せばよいかを決めるための材料。
--
--   ★ 使い方
--     エディタの置換で '%平沢%' を、探したい取引先の名前の一部に（%…% のまま）置き換えてから、
--     1〜8 を 1 つずつ流す（Cloud SQL Studio は文ごとに結果が出る）。
--     取引先名・カナ・別名（ペンネーム）のどれに当たっても拾う。
--
--   ★ 読む順番
--     1 で取引先を特定する（同じ人が 2 件あれば、それ自体が荒れの原因）。
--     2 で作品の一覧、3 で同じ・似た題名の作品（重複の候補）。
--     4 で条件ごとに「どの作品・どの契約に付いているか」。
--     5 で契約、6 で文書、7 で実績・計算書・支払。
--     8 に、機械的に分かるずれを 1 行ずつ出す。
-- =====================================================================

-- 1. 取引先 -------------------------------------------------------------
SELECT pa.id, pa.party_code AS コード, pa.name AS 名前, pa.name_kana AS カナ, pa.kind AS 区分,
       pa.status AS 状態, pa.merged_into_id AS 統合先id, array_to_string(pa.aliases, '・') AS 別名,
       (SELECT count(*) FROM v3.conditions c WHERE c.counterparty_id = pa.id) AS 条件数,
       (SELECT count(*) FROM v3.agreements a WHERE a.counterparty_id = pa.id) AS 契約数
  FROM v3.parties pa
 WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
    OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
 ORDER BY pa.id;

-- 2. 作品（この取引先の条件が付いている作品と、その親子） ----------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
), w AS (
  SELECT DISTINCT c.work_id AS id FROM v3.conditions c WHERE c.counterparty_id IN (SELECT id FROM p) AND c.work_id IS NOT NULL
)
SELECT wk.id, wk.work_code AS コード, wk.title AS 題名, wk.kind AS 種類, wk.status AS 状態,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_id = wk.id AND c.counterparty_id IN (SELECT id FROM p)
          AND c.status IN ('active', 'scheduled')) AS この人の有効な条件,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_id = wk.id AND c.counterparty_id IN (SELECT id FROM p)) AS この人の条件_全版,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_id = wk.id AND c.counterparty_id NOT IN (SELECT id FROM p)) AS ほかの人の条件,
       (SELECT string_agg(DISTINCT pw.title || '（' || l.relation_type || '）', '・')
          FROM v3.work_lineage l JOIN v3.works pw ON pw.id = l.parent_work_id WHERE l.child_work_id = wk.id) AS 親の作品,
       (SELECT string_agg(DISTINCT cw.title || '（' || l.relation_type || '）', '・')
          FROM v3.work_lineage l JOIN v3.works cw ON cw.id = l.child_work_id WHERE l.parent_work_id = wk.id) AS 子の作品,
       (SELECT count(*) FROM v3.work_parts wp WHERE wp.work_id = wk.id) AS パート数,
       wk.created_at::date AS 登録日
  FROM v3.works wk
 WHERE wk.id IN (SELECT id FROM w)
 ORDER BY wk.title, wk.id;

-- 3. 同じ・似た題名の作品（重複の候補） -----------------------------------
--   空白・記号・全角半角・大小を落とした題名が同じか、一方が他方を含むもの。
--   この人の条件が付いていない作品も出す（同じ作品を別に立てたものを拾うため）。
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
), w AS (
  SELECT DISTINCT c.work_id AS id FROM v3.conditions c WHERE c.counterparty_id IN (SELECT id FROM p) AND c.work_id IS NOT NULL
), norm AS (
  SELECT wk.id, wk.title, wk.work_code, wk.kind,
         lower(regexp_replace(translate(wk.title, '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ',
                                              '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'),
                                  '[\s　・･\-－ー―_＿:：!！?？「」『』（）()【】〈〉《》、。,.]', '', 'g')) AS key
    FROM v3.works wk
)
SELECT a.id AS 作品id, a.title AS 題名, a.work_code AS コード,
       b.id AS 似た作品id, b.title AS 似た題名, b.work_code AS 似たコード, b.kind AS 似た種類,
       CASE WHEN a.key = b.key THEN '同じ題名' ELSE '一方が他方を含む' END AS 似かた,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_id = b.id) AS 似た作品の条件数,
       (SELECT string_agg(DISTINCT pa.name, '・') FROM v3.conditions c JOIN v3.parties pa ON pa.id = c.counterparty_id
         WHERE c.work_id = b.id) AS 似た作品の相手先
  FROM norm a JOIN norm b ON b.id <> a.id
   AND (a.key = b.key OR (length(a.key) >= 4 AND length(b.key) >= 4 AND (strpos(b.key, a.key) > 0 OR strpos(a.key, b.key) > 0)))
 WHERE a.id IN (SELECT id FROM w)
 ORDER BY a.title, b.title;

-- 4. 条件（全版。どの作品・どの契約に付いているか） -------------------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
)
SELECT c.id, c.condition_no AS 番号, c.name AS 条件名, c.direction AS 向き, c.kind AS 種類,
       c.status AS 状態, COALESCE(c.series_id, c.id) AS 系列, c.superseded_by_id AS 差し替え先id,
       wk.id AS 作品id, wk.title AS 作品, wp.name AS パート,
       a.agreement_no AS 契約, a.kind AS 契約の種類, pa2.agreement_no AS 親の契約,
       CASE WHEN c.rate_ppm IS NOT NULL THEN round(c.rate_ppm / 10000.0, 3) || '%' END AS 料率,
       c.flat_amount AS 定額, c.term_start AS 期間開始, c.term_end AS 期間終了, c.effective_from AS 適用開始,
       c.closed_at::date AS 完了扱い, c.created_at::date AS 登録日
  FROM v3.conditions c
  LEFT JOIN v3.works wk ON wk.id = c.work_id
  LEFT JOIN v3.work_parts wp ON wp.id = c.work_part_id
  LEFT JOIN v3.agreements a ON a.id = c.agreement_id
  LEFT JOIN v3.agreements pa2 ON pa2.id = a.parent_id
 WHERE c.counterparty_id IN (SELECT id FROM p)
 ORDER BY wk.title NULLS FIRST, COALESCE(c.series_id, c.id), c.id;

-- 5. 契約 ---------------------------------------------------------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
)
SELECT a.id, a.agreement_no AS 番号, a.title AS 件名, a.kind AS 種類, a.domain AS 種別, a.direction AS 向き,
       a.status AS 状態, par.agreement_no AS 親, a.executed_on AS 締結日, a.expires_on AS 満了,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id) AS 載っている条件,
       (SELECT string_agg(DISTINCT wk.title, '・') FROM v3.conditions c JOIN v3.works wk ON wk.id = c.work_id
         WHERE c.agreement_id = a.id) AS 条件の作品,
       (SELECT count(*) FROM v3.documents d WHERE d.agreement_id = a.id AND d.status <> 'void') AS 文書
  FROM v3.agreements a
  LEFT JOIN v3.agreements par ON par.id = a.parent_id
 WHERE a.counterparty_id IN (SELECT id FROM p)
 ORDER BY COALESCE(a.parent_id, a.id), a.id;

-- 6. 文書（条件に繋がっているもの・契約に付いているもの） ----------------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
), docs AS (
  SELECT DISTINCT dc.document_id AS id FROM v3.document_conditions dc
    JOIN v3.conditions c ON c.id = dc.condition_id WHERE c.counterparty_id IN (SELECT id FROM p)
  UNION
  SELECT d.id FROM v3.documents d JOIN v3.agreements a ON a.id = d.agreement_id WHERE a.counterparty_id IN (SELECT id FROM p)
)
SELECT d.id, d.document_no AS 番号, COALESCE(t.label, d.manual_inputs->>'documentKind') AS 種類,
       COALESCE(d.manual_inputs->>'title', '') AS 件名, d.status AS 状態, d.issued_at::date AS 決定日,
       a.agreement_no AS 契約,
       (SELECT string_agg(c.condition_no || ' ' || c.name || COALESCE('［' || wk.title || '］', ''), '／' ORDER BY c.id)
          FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
          LEFT JOIN v3.works wk ON wk.id = c.work_id WHERE dc.document_id = d.id) AS 条件と作品,
       d.manual_inputs->>'edition' AS 版
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.agreements a ON a.id = d.agreement_id
 WHERE d.id IN (SELECT id FROM docs)
 ORDER BY d.issued_at NULLS LAST, d.id;

-- 7. 実績・計算書・支払（条件ごと） ----------------------------------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
)
SELECT c.condition_no AS 条件, c.name AS 条件名, wk.title AS 作品, c.status AS 状態,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 実績,
       (SELECT sum(e.quantity) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 数量計,
       (SELECT sum(e.amount) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 金額計,
       (SELECT max(e.occurred_on) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 最後の実績,
       (SELECT string_agg(DISTINCT d.document_no || '(' || d.status || ')', '・')
          FROM v3.statement_lines sl JOIN v3.statements s ON s.id = sl.statement_id JOIN v3.documents d ON d.id = s.document_id
         WHERE sl.condition_id = c.id) AS 計算書,
       (SELECT string_agg(DISTINCT sl.product_name, '・')
          FROM v3.statement_lines sl WHERE sl.condition_id = c.id) AS 計算書の製品名,
       (SELECT string_agg(DISTINCT pm.payment_no || '(' || pm.status || ')', '・')
          FROM v3.payment_allocations al JOIN v3.payments pm ON pm.id = al.payment_id
         WHERE al.condition_id = c.id AND pm.status <> 'canceled') AS 支払
  FROM v3.conditions c
  LEFT JOIN v3.works wk ON wk.id = c.work_id
 WHERE c.counterparty_id IN (SELECT id FROM p)
 ORDER BY wk.title NULLS FIRST, c.id;

-- 8. 機械的に分かるずれ ---------------------------------------------------
WITH p AS (
  SELECT pa.id FROM v3.parties pa
   WHERE pa.name LIKE '%平沢%' OR COALESCE(pa.name_kana, '') LIKE '%平沢%'
      OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x LIKE '%平沢%')
), c AS (
  SELECT c.* FROM v3.conditions c WHERE c.counterparty_id IN (SELECT id FROM p)
)
SELECT 'この人が 2 件以上の取引先として登録されている' AS ずれ, string_agg(pa.name || '#' || pa.id, '・') AS 対象
  FROM v3.parties pa WHERE pa.id IN (SELECT id FROM p) AND pa.status <> 'merged' HAVING count(*) > 1
UNION ALL
SELECT '作品の無い有効な条件', string_agg(c.condition_no || ' ' || c.name, '・')
  FROM c WHERE c.work_id IS NULL AND c.status IN ('active', 'scheduled') HAVING count(*) > 0
UNION ALL
SELECT '同じ作品・同じ条件名で有効な条件が複数（同じ条件を二重に立てた疑い）',
       string_agg(x.v, '／')
  FROM (SELECT wk.title || '：' || c.name || '（' || string_agg(c.condition_no, '・') || '）' AS v
          FROM c JOIN v3.works wk ON wk.id = c.work_id
         WHERE c.status IN ('active', 'scheduled')
         GROUP BY wk.title, c.name HAVING count(*) > 1) x HAVING count(*) > 0
UNION ALL
SELECT '同じ系列の版が別々の作品に付いている',
       string_agg(x.v, '／')
  FROM (SELECT COALESCE(c.series_id, c.id)::text || '：' || string_agg(DISTINCT COALESCE(wk.title, '（作品なし）'), '・') AS v
          FROM c LEFT JOIN v3.works wk ON wk.id = c.work_id
         GROUP BY COALESCE(c.series_id, c.id) HAVING count(DISTINCT COALESCE(c.work_id, 0)) > 1) x HAVING count(*) > 0
UNION ALL
SELECT '有効な条件が、ほかの取引先の契約に載っている', string_agg(c.condition_no || ' → ' || a.agreement_no, '・')
  FROM c JOIN v3.agreements a ON a.id = c.agreement_id
 WHERE a.counterparty_id NOT IN (SELECT id FROM p) AND c.status IN ('active', 'scheduled') HAVING count(*) > 0
UNION ALL
SELECT '有効な条件が、解除・満了した契約に載っている', string_agg(c.condition_no || ' → ' || a.agreement_no || '(' || a.status || ')', '・')
  FROM c JOIN v3.agreements a ON a.id = c.agreement_id
 WHERE a.status IN ('terminated', 'expired') AND c.status IN ('active', 'scheduled') HAVING count(*) > 0
UNION ALL
SELECT '差し替え済み・無効の条件に、まだ実績が載っている', string_agg(DISTINCT c.condition_no, '・')
  FROM c JOIN v3.condition_events e ON e.condition_id = c.id AND e.status = 'active'
 WHERE c.status IN ('superseded', 'void') HAVING count(*) > 0
UNION ALL
SELECT '計算書の製品名と条件の作品が違う', string_agg(DISTINCT c.condition_no || '：' || sl.product_name || ' ≠ ' || wk.title, '／')
  FROM c JOIN v3.works wk ON wk.id = c.work_id
  JOIN v3.statement_lines sl ON sl.condition_id = c.id
 WHERE sl.product_name IS NOT NULL AND strpos(sl.product_name, wk.title) = 0 HAVING count(*) > 0;
