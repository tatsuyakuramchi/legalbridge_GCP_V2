-- =====================================================================
-- ひな形（本文と項目の定義）をファイルに書き出す（読むだけ。データベースは変えない）。
--
--   ひな形の本文は DB にしか無いものがある（V1 から移した license_master など）。
--   項目の引き方・必須の出方を調べるために、いまの版の本文と項目の定義を 1 つの JSON にする。
--   取引先・金額などのデータは入らない（ひな形だけ）。
--
--   ★ 使い方（infra\local で）
--       docker compose run --rm ops sql /v3/diag/dump-templates.sql
--     → infra\local\dumps\templates-dump.json ができる
--     キーを選ぶとき：… dump-templates.sql keys=license_master,service_master
--     既定はゲームの文書づくりで使うひな形（基本契約書・条件書・計算書）。
-- =====================================================================

\pset pager off
\if :{?keys}
\else
  \set keys 'license_master,individual_license_terms_v3,individual_license_terms_v4,royalty_statement,service_master,nda'
\endif

SELECT t.template_key AS キー, t.label AS 名前, t.is_active AS 有効, t.number_prefix AS 番号の頭,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ, jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = ANY (string_to_array(:'keys', ','))
 ORDER BY t.template_key;

\t on
\a
\o /dumps/templates-dump.json
SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'templateKey', t.template_key, 'label', t.label, 'category', t.category, 'numberPrefix', t.number_prefix,
         'isActive', t.is_active, 'versionNo', v.version_no, 'variables', COALESCE(v.variables, '[]'::jsonb),
         'html', v.html_source) ORDER BY t.template_key), '[]'::jsonb)::text
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = ANY (string_to_array(:'keys', ','));
\o
\a
\t off
\echo '書き出しました：infra/local/dumps/templates-dump.json'
