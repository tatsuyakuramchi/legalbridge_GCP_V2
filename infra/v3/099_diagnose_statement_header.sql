-- =====================================================================
-- 利用許諾料計算書の「受領情報（サブライセンス入金）」を見る
-- （Cloud SQL Studio／ops sql 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
-- なぜ要るか:
--   計算書の本文（ひな形）はデータベースの中にあり、アプリからは読み取り
--   専用にしてある。受領情報の各欄がどの名前を差しているかは本文にしか
--   書いていないので、名前を知らないまま供給側を直すと、別の欄に当たる。
--   実際 payerCompany は「自社名」の別名として登録されていて、入金企業の
--   欄に株式会社アークライト（当社）が出ていた。
--
--   直したいのは4つ:
--     入金企業   … 当社ではなく、許諾（OUT）の取引先名（払ってきた相手）
--     デザイナー / 権利者 … 取得（IN）の取引先名
--     カテゴリー … 使わないので消す
--     入金通貨   … 受領通貨と、当社適用レート
--
--   1・2 の出力をそのまま貼っていただければ、供給側と本文の直し方を
--   確定できる。個人情報は含まない（ひな形の骨組みだけ）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 受領情報の block をそのまま出す
--
--    「受領情報」から 1800 文字。表の作りと {{ }} の名前が見える。
-- ---------------------------------------------------------------------
SELECT t.template_key                                        AS ひな形,
       v.id                                                  AS 版,
       length(v.html_source)                                 AS 本文の長さ,
       position('受領情報' in v.html_source)                  AS 受領情報の位置,
       substring(v.html_source
                 from greatest(1, position('受領情報' in v.html_source) - 200)
                 for 1800)                                   AS 受領情報のあたり
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';

-- ---------------------------------------------------------------------
-- 2. 受領情報のあたりで差している名前だけを並べる
--
--    ここに出た名前が、そのまま直す対象になる。
-- ---------------------------------------------------------------------
WITH blk AS (
  SELECT substring(v.html_source
                   from greatest(1, position('受領情報' in v.html_source) - 200)
                   for 1800) AS html
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement'
)
SELECT DISTINCT m[1] AS 受領情報が差す名前
  FROM blk,
       LATERAL regexp_matches(blk.html,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
 WHERE m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup')
 ORDER BY 1;

-- ---------------------------------------------------------------------
-- 3. 計算書の本文が差している名前（全体）
--
--    受領情報の欄が block の外の名前を使っていたとき用。
-- ---------------------------------------------------------------------
SELECT DISTINCT m[1] AS 本文が差す名前
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
 WHERE t.template_key = 'royalty_statement'
   AND m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup')
 ORDER BY 1;
