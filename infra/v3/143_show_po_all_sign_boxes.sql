-- =====================================================================
-- 発注書の本文にある署名枠（sign-box・署名・押印・甲・乙）を全部洗い出す（読むだけ）。
--   切り替え（SHOW_ORDER_SIGN_SECTION／SHOW_SIGN_SECTION）で囲まれていない
--   署名枠が本文の途中に無いかを見る。出た断片ごとに、直前 400 文字の中に
--   {{#if SHOW_… が含まれるかも一緒に出す。
--   実行: docker compose run --rm ops sql /v3/143_show_po_all_sign_boxes.sql
--   出力はひな形の本文だけ（相手の実名は含まれない）。
-- =====================================================================
\pset pager off

WITH src AS (
  SELECT v.html_source AS html
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'purchase_order'
),
hits AS (
  SELECT (m.pos) AS pos
    FROM src, LATERAL (
      SELECT (regexp_instr(src.html, 'sign-box|記名押印|署名|甲）|乙）', 1, n)) AS pos
        FROM generate_series(1, 60) AS n
    ) AS m
   WHERE m.pos > 0
)
SELECT DISTINCT ON (pos) pos AS 位置,
       substr(src.html, greatest(1, pos - 120), 200) AS 断片,
       (substr(src.html, greatest(1, pos - 1200), 1200) LIKE '%{{#if SHOW_ORDER_SIGN_SECTION}}%') AS 直前1200字に発注署名欄の囲み,
       (substr(src.html, greatest(1, pos - 1200), 1200) LIKE '%{{#if SHOW_SIGN_SECTION}}%') AS 直前1200字に承諾署名欄の囲み
  FROM src, hits
 ORDER BY pos;

-- 見出し（■ …）の並び。どの章があるかを俯瞰する
SELECT m[1] AS 見出し
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source, '(■[^<]{1,40})', 'g') AS m
 WHERE t.template_key = 'purchase_order';
