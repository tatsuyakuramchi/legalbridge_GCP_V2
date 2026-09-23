-- =====================================================================
-- 発注書の署名欄（発注署名欄・承諾署名欄）が、決定済みの紙にどう焼き付いて
-- いるかを見る（読むだけ）。
--
--   発注書には 2 つの署名欄がある。
--     SHOW_ORDER_SIGN_SECTION … 発注署名欄（発注者も署名する）
--     SHOW_SIGN_SECTION       … 承諾署名欄（受注者だけが署名する）
--   両方が「あり」で焼き付いた紙は、署名欄が 2 つ刷られる。決定した紙の値は
--   固定なので、直すなら訂正版を出す（一括作成の「一括修正」で CSV の
--   発注署名欄＝なし・承諾署名欄＝あり を渡すと、まとめて訂正版を起こせる）。
--
--   実行: docker compose run --rm ops sql /v3/138_show_po_sign_sections.sql q=MTR-2026-00216
--         q は案件番号。省略すると全案件。
--   出力に相手の実名は含まれない（文書番号と値だけ）。
-- =====================================================================
\pset pager off
-- 案件番号。外から渡されていればそれ（ops sql … q=案件番号）。無ければ全案件。
\if :{?q}
\else
\set q ''
\endif

-- 1. ひな形の項目の定義（既定値がどうなっているか）
SELECT t.template_key AS ひな形, v.version_no AS 版,
       x.item ->> 'name' AS 項目名, x.item ->> 'label' AS 見出し,
       x.item ->> 'type' AS 型, x.item ->> 'default' AS 既定値
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL jsonb_array_elements(COALESCE(v.variables, '[]'::jsonb)) AS x(item)
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
   AND x.item ->> 'name' IN ('SHOW_ORDER_SIGN_SECTION', 'SHOW_SIGN_SECTION')
 ORDER BY 1, 3;

-- 2. 決定済みの発注書に焼き付いた値（両方 true の紙が直す対象）
SELECT m.matter_no AS 案件, d.document_no AS 文書番号, d.status AS 状態,
       d.rendered_values ->> 'SHOW_ORDER_SIGN_SECTION' AS 発注署名欄,
       d.rendered_values ->> 'SHOW_SIGN_SECTION'       AS 承諾署名欄,
       CASE WHEN d.rendered_values ->> 'SHOW_ORDER_SIGN_SECTION' = 'true'
             AND d.rendered_values ->> 'SHOW_SIGN_SECTION' = 'true' THEN '★ 両方出る' ELSE '' END AS 印
  FROM v3.documents d
  JOIN v3.document_template_versions v ON v.id = d.template_version_id
  JOIN v3.document_templates t ON t.id = v.template_id
  LEFT JOIN v3.matters m ON m.id = d.matter_id
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
   AND d.status IN ('issued', 'draft')
   AND (:'q' = '' OR m.matter_no = :'q')
 ORDER BY m.matter_no, d.id;
