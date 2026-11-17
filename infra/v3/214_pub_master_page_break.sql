-- =====================================================================
-- 214_pub_master_page_break.sql（ops sql / Cloud SQL Studio 用）
--
--   出版等許諾基本契約書（個人版 pub_master_individual・法人版 pub_master_corporate）のページ区切りを直す。
--
--   起きていたこと：1 ページ目が題名だけになり、頭書きの表が丸ごと 2 ページ目へ送られていた
--     （特記事項が長いと 3 ページ目にもあふれる）。印刷用の指定で、頭書きの表（.tobogaki）全体に
--     「途中でページを分けない」が付いていたため。表が 1 ページ目の残りに入らないと、表ごと次のページへ行く。
--
--   直すこと（いまの版の本文を写して、新しい版を作る。条文・項目の定義は変えない）
--     1. 頭書きの表は、行と行の間でページを分ける。行の途中では分けないが、長くなる特記事項の行だけは途中でも分ける。
--        区切りの見出しの行（当事者・許諾条件 …）は次の行と離さない。署名欄は、これまでどおり途中で分けない
--     2. 被許諾者の代表者：「代表取締役　{{アークライト代表者氏名}}」の頭の「代表取締役」を外す
--        （自社の代表者は「代表取締役 ◯◯」と肩書つきで入るので、「代表取締役　代表取締役 ◯◯」と 2 回出ていた）
--
--   何度流しても同じ結果（直した版には印 <!-- pub_master page-break r1 --> が入る）。
--   ローカルは docker compose run --rm ops sql /v3/214_pub_master_page_break.sql
--   決定済みの契約書は変わらない（出したときの版のまま）。直った紙にするには訂正版を作る。
--   戻すとき：ひな形の画面（または SQL）で current_version_id を前の版に戻す
--     UPDATE v3.document_templates d SET current_version_id = v.id FROM v3.document_template_versions v
--      WHERE d.template_key = 'pub_master_individual' AND v.template_id = d.id AND v.version_no = （前の版番号）;
-- =====================================================================
\pset pager off

WITH cur AS (
  SELECT d.id AS template_id, d.template_key, v.id AS version_id, v.version_no, v.html_source, v.variables
    FROM v3.document_templates d
    JOIN v3.document_template_versions v ON v.id = d.current_version_id
   WHERE d.template_key IN ('pub_master_individual', 'pub_master_corporate')
),
fixed AS (
  SELECT c.*,
         position('<!-- pub_master page-break r1 -->' in c.html_source) > 0 AS already,
         position('.head-signature, .tobogaki { page-break-inside: avoid; }' in c.html_source) > 0 AS has_rule,
         replace(replace(replace(c.html_source,
           '.head-signature, .tobogaki { page-break-inside: avoid; }',
           $css$.head-signature { page-break-inside: avoid; }
      /* 頭書きの表は、表ごと次のページへ送らない（行と行の間でページを分ける）。行の途中では分けないが、
         長くなる特記事項の行だけは途中でも分ける。区切りの見出しの行は、次の行と離さない。 */
      .tobogaki { page-break-inside: auto; break-inside: auto; }
      .tobogaki tr { page-break-inside: avoid; break-inside: avoid; }
      .tobogaki tr:has(.special-cell) { page-break-inside: auto; break-inside: auto; }
      .tobogaki tr.sec-row { page-break-after: avoid; break-after: avoid; }$css$),
           '代表取締役　{{アークライト代表者氏名}}', '{{アークライト代表者氏名}}'),
           '<head>', E'<head>\n  <!-- pub_master page-break r1 -->') AS new_html
    FROM cur c
),
made AS (
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT f.template_id,
         (SELECT COALESCE(max(x.version_no), 0) + 1 FROM v3.document_template_versions x WHERE x.template_id = f.template_id),
         f.new_html, f.variables,
         'ページ区切り：頭書きの表を表ごと次のページへ送らない／被許諾者の代表者の肩書の重複を外す',
         'infra/v3/214'
    FROM fixed f
   WHERE NOT f.already AND f.has_rule
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d SET current_version_id = m.id FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT f.template_key AS キー,
       CASE WHEN p.new_version IS NOT NULL THEN '新しい版 ' || p.version_no || '（id ' || p.new_version || '）を作りました'
            WHEN f.already THEN '直した版がもう使われています。何もしていません'
            ELSE '頭書きの表の指定が見つかりません（本文が想定と違います）。何もしていません' END AS 結果,
       f.version_no AS 前の版
  FROM fixed f LEFT JOIN pointed p ON p.template_key = f.template_key
UNION ALL
SELECT '—', 'ひな形（pub_master_individual・pub_master_corporate）が見つかりません', NULL
 WHERE NOT EXISTS (SELECT 1 FROM fixed)
 ORDER BY 1;
