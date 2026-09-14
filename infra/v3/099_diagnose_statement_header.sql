-- =====================================================================
-- 利用許諾料計算書の「受領情報（サブライセンス入金）」を見る
-- （ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
-- なぜ要るか:
--   計算書の本文（ひな形）はデータベースの中にあり、アプリからは読み取り
--   専用にしてある。受領情報の各欄がどの名前を差しているかは本文にしか
--   書いていないので、名前を知らないまま供給側を直すと、別の欄に当たる。
--   実際 payerCompany は「自社名」の別名として登録されていて、入金企業の
--   欄に当社の名前が出ていた。
--
--   出力の 1 と 2 をそのまま貼っていただければ、直し方を確定できる。
--   ひな形の骨組みだけで、個人情報・口座情報は含まない。
-- =====================================================================

-- ページャと桁揃えを止める。揃えると長い行が切られて、肝心の {{ }} が
-- 「--More--」の向こうに隠れる。
\pset pager off
\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------
-- 1. 直したい欄のまわりだけを、そのまま出す
--
--    欄の見出しの語を本文から探して、その前後を切り出す。本文は2万字
--    あるので全部は出さない。
--
--    同じ語が何か所にも出ることがある（希望納期は受領情報の表と、下の
--    合計の枠と、2か所にある）。最初の1つだけを見て直すと、もう片方が
--    残る。ここは出てくるだけ全部出す。
-- ---------------------------------------------------------------------
WITH src AS (
  SELECT v.html_source AS h
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement'
),
lbl(name) AS (
  VALUES ('受領情報'), ('入金企業'), ('デザイナー'), ('カテゴリ'),
         ('入金通貨'), ('レート'), ('希望納期')
),
hit AS (
  SELECT lbl.name,
         (regexp_matches(src.h, '(.{0,300}' || lbl.name || '.{0,500})', 'g'))[1] AS around
    FROM src, lbl
)
SELECT E'\n========== ' || hit.name || E' ==========\n' || hit.around
  FROM hit
UNION ALL
SELECT E'\n========== ' || lbl.name || E' ==========\n（この語は本文に無い）'
  FROM lbl
 WHERE NOT EXISTS (SELECT 1 FROM hit WHERE hit.name = lbl.name);

-- ---------------------------------------------------------------------
-- 2. 受領情報の block が差している名前
-- ---------------------------------------------------------------------
SELECT E'\n========== 受領情報が差す名前 ==========';

WITH blk AS (
  SELECT substring(v.html_source
                   from greatest(1, position('受領情報' in v.html_source) - 200)
                   for 2500) AS html
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement'
)
SELECT DISTINCT m[1]
  FROM blk,
       LATERAL regexp_matches(blk.html,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
 WHERE m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup', 'eq')
 ORDER BY 1;

-- ---------------------------------------------------------------------
-- 3. 計算書の本文が差している名前（全体）
--
--    受領情報の欄が block の外の名前を使っていたとき用。
-- ---------------------------------------------------------------------
SELECT E'\n========== 本文が差す名前（全体） ==========';

SELECT DISTINCT m[1]
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
 WHERE t.template_key = 'royalty_statement'
   AND m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup', 'eq')
 ORDER BY 1;
