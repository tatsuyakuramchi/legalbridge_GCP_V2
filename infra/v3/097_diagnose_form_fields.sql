-- =====================================================================
-- 画面に出ない項目の理由を出す（Cloud SQL Studio 用・読むだけ）
--
--   ひな形の項目は宣言されていても、画面に出るとは限らない。V3 は V1 の
--   field_schema の出し分け（hidden / showWhen / 明細 / 計算欄）をそのまま
--   引き継いでいる。「宣言はあるのに画面が空」のときは、どの規則で落ちて
--   いるのかをここで見る。
--
--   判定はアプリの isFieldRequested と同じ順で並べてある。
--     1. 明細（type=array）・隠し（type=hidden / hidden=true）→ 出さない
--     2. showWhen → 他の項目の値が条件に合うときだけ出る
--     3. 計算書の計算欄 → 試算があるときだけ隠す（新規作成では出る）
--     4. それ以外 → 出る
--
--   ひな形を変えるときは下の :key（2か所）を書き換える。
-- =====================================================================

WITH target AS (
  SELECT 'royalty_statement'::text AS key      -- ← 見たいひな形
),
fields AS (
  SELECT x.ord, x.f
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
    JOIN target ON target.key = t.template_key,
         LATERAL jsonb_array_elements(v.variables) WITH ORDINALITY AS x(f, ord)
),
computed AS (
  SELECT unnest(ARRAY[
    'calcType','statementMode','msrpStr','quantity','sampleQuantity','billableQuantity',
    'royaltyRatePct','grossRoyaltyStr','mgAmount','mgAmountStr','mgTopupApplied',
    'mgTopupThisTime','mgTopupThisTimeStr','mgRemaining','mgConsumedBefore',
    'mgConsumedThisTime','mgConsumedAfter','mgFullyConsumed','mgProgressPct',
    'agAmount','agAmountStr','agApplied','agConsumedBefore','agConsumedBeforeStr',
    'agConsumedThisTime','agConsumedThisTimeStr','agConsumedAfter','agConsumedAfterStr',
    'agRemaining','agRemainingStr','agFullyConsumed','agProgressPct',
    'actualRoyalty','actualRoyaltyStr','taxAmount','totalPaymentStr',
    'intakeCurrency','fxRate','linesTotalSalesStr','linesTotalPaymentStr',
    'linesTaxStr','linesTotalIncTaxStr']) AS name
),
judged AS (
  SELECT f.ord,
         f.f->>'name'  AS 項目,
         f.f->>'label' AS 名前,
         f.f->>'group' AS 区分,
         CASE
           WHEN f.f->>'type' IN ('array', 'hidden') OR (f.f->>'hidden')::boolean
             THEN '1. 明細・隠しなので出さない'
           WHEN f.f ? 'showWhen'
             THEN '2. showWhen で出し分け'
           WHEN EXISTS (SELECT 1 FROM computed c WHERE c.name = f.f->>'name')
             THEN '3. 計算書の計算欄（試算があるときだけ隠す）'
           ELSE '4. 出るはず'
         END AS 理由,
         COALESCE((f.f->'showWhen')::text, '') AS 条件
    FROM fields f
)
SELECT 理由, count(*) AS 件数,
       string_agg(項目, '、' ORDER BY ord) AS 項目
  FROM judged
 GROUP BY 理由
 ORDER BY 理由;

-- ---------------------------------------------------------------------
-- 出し分けの条件が「どの項目の値」を見ているか。
-- ここに出た項目が V3 で誰も入れない値なら、それを待つ項目は永久に出ない。
-- ---------------------------------------------------------------------
WITH target AS (SELECT 'royalty_statement'::text AS key)
SELECT COALESCE(w->>'field', '(条件なし)') AS 見ている項目,
       COALESCE((w->'anyOf')::text, CASE WHEN w ? 'truthy' THEN 'truthy' ELSE '' END) AS 期待する値,
       count(*) AS その条件で出る項目の数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
  JOIN target ON target.key = t.template_key,
       LATERAL jsonb_array_elements(v.variables) AS f
  LEFT JOIN LATERAL (
    SELECT CASE jsonb_typeof(f->'showWhen')
             WHEN 'array'  THEN f->'showWhen'
             WHEN 'object' THEN jsonb_build_array(f->'showWhen')
             ELSE '[]'::jsonb
           END AS arr
  ) AS s ON true
  LEFT JOIN LATERAL jsonb_array_elements(s.arr) AS w ON true
 GROUP BY 1, 2
 ORDER BY 3 DESC;
