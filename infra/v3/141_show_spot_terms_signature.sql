-- =====================================================================
-- 基本契約なしの発注書に別紙で付く標準約款（terms_spot_2026）に、署名欄が
-- 入っていないかを見る（読むだけ）。
--
--   発注書本体の署名欄は SHOW_ORDER_SIGN_SECTION／SHOW_SIGN_SECTION で出し分けて
--   いるが、末尾に差し込む約款は本体の切り替えを見ない。約款の側に甲・乙の
--   記名押印欄があれば、本体の「受領確認（承諾）」と合わせて署名欄が 2 つ出る。
--
--   実行: docker compose run --rm ops sql /v3/141_show_spot_terms_signature.sql q=ARC-PO-2026-1114
--   出力はひな形の本文と切り替えの値だけ（相手の実名は含まれない）。
-- =====================================================================
\pset pager off
\if :{?q}
\else
\set q ''
\endif

-- 1. 部分テンプレートの一覧（約款はここにある）
SELECT t.template_key AS 部品, t.category AS 区分, v.version_no AS 版, length(v.html_source) AS 文字数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.category = 'partial' OR t.template_key LIKE 'terms%'
 ORDER BY 1;

-- 2. 約款の中で署名・押印に触れているところ
SELECT t.template_key AS 部品, m[1] AS 本文の断片
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source, '(.{0,200}(署名|押印|sign-box|甲）|乙）).{0,200})', 'g') AS m
 WHERE t.template_key LIKE 'terms%'
 ORDER BY 1;

-- 3. 約款の末尾（最後の 2500 文字）
SELECT t.template_key AS 部品, right(v.html_source, 2500) AS 末尾
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key LIKE 'terms%';

-- 4. その発注書の切り替えの値（基本契約なしなら約款が付く）
SELECT d.document_no AS 文書番号,
       d.rendered_values ->> 'HAS_BASE_CONTRACT' AS 基本契約あり,
       d.rendered_values ->> 'SHOW_ORDER_SIGN_SECTION' AS 発注署名欄,
       d.rendered_values ->> 'SHOW_SIGN_SECTION' AS 承諾署名欄,
       d.rendered_values ->> 'ACCEPT_METHOD' AS 承諾方法
  FROM v3.documents d
 WHERE (:'q' = '' OR d.document_no = :'q')
   AND d.document_no LIKE 'ARC-PO-%'
 ORDER BY d.id DESC LIMIT 5;
