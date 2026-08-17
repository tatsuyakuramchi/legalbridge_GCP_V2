\set ON_ERROR_STOP on
\pset pager off

-- 055_remove_orphan_form_fields.sql
-- 入力しても出力に反映されない項目をフォームから外す。
--
-- 全テンプレートの field_schema と html_source を突き合わせ、テンプレートがどこからも
-- 読まず、アプリ側のコードも参照していない項目を洗い出した結果が以下。入力欄が
-- 残っている限り「入れたのに反映されない」が起き続けるため、表示から取り除く。
--
--   inspection_certificate : orderDate / itemCount / totalDeliveries / linked_po_number
--   purchase_order         : documentNumberOverride
--   license_master         : documentNumberOverride
--   service_master         : CONTRACT_START_DATE
--
-- 除外した検討対象（消さないもの）:
--   - royalty_statement の mgConsumed* / mgRemaining / mgProgressPct / ledgerId
--     … ラベルに (legacy) と明記された旧データ互換の項目。既存文書の表示に使う。
--   - VENDOR_IS_CORPORATION / LICENSOR_IS_CORPORATION / CHANGE_RECORDS
--     … テンプレートは読まないが、アプリ側（宛名の敬称・変更履歴の組み立て）が使う。
--   - pub_license_terms の 翻訳海外版許諾有無 / 翻訳海外版対象地域言語 / 販売形態 /
--     翻訳海外版計算式 / 翻訳海外版料率
--     … これは「項目が余っている」のではなく **テンプレート側に出力が無い** ケース。
--       消すと入力手段が失われるので、テンプレート改訂（＝新版）で対応する。別途。
--
-- ★ 053 と同じく版は上げず、現行版の field_schema だけを書き換える。
--   html_source は無変更＝描画結果は同一。documents.template_version_id は現行版を
--   指したままなので既存文書も従来どおり再描画できる（新版を作ると
--   StoredDocumentTemplateVersionError で PDF 再発行・CloudSign 依頼が全滅する）。
--   documents.form_data には触れないので、既存データの値は残る。
--   何度流しても結果は同じ（冪等）。

\if :{?confirm_orphan_fields}
\else
  \echo 'Run with: -v confirm_orphan_fields=REMOVE_ORPHAN_FORM_FIELDS'
  \quit 2
\endif
SELECT :'confirm_orphan_fields' = 'REMOVE_ORPHAN_FORM_FIELDS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 適用前：対象項目が実在するか（想定 8 行）。
SELECT t.template_key, f->>'name' AS field, f->>'label' AS label
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE (t.template_key = 'inspection_certificate'
          AND f->>'name' IN ('orderDate', 'itemCount', 'totalDeliveries', 'linked_po_number'))
    OR (t.template_key IN ('purchase_order', 'license_master')
          AND f->>'name' = 'documentNumberOverride')
    OR (t.template_key = 'service_master' AND f->>'name' = 'CONTRACT_START_DATE')
 ORDER BY t.template_key, field;

CREATE TEMP TABLE orphan_fields (template_key text, field_name text) ON COMMIT DROP;
INSERT INTO orphan_fields VALUES
  ('inspection_certificate', 'orderDate'),
  ('inspection_certificate', 'itemCount'),
  ('inspection_certificate', 'totalDeliveries'),
  ('inspection_certificate', 'linked_po_number'),
  ('purchase_order', 'documentNumberOverride'),
  ('license_master', 'documentNumberOverride'),
  ('service_master', 'CONTRACT_START_DATE');

UPDATE document_template_versions v
   SET field_schema = (
     SELECT COALESCE(jsonb_agg(e.f ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(v.field_schema) WITH ORDINALITY AS e(f, ord)
      WHERE NOT EXISTS (
        SELECT 1 FROM orphan_fields o
         WHERE o.template_key = t.template_key AND o.field_name = e.f->>'name')
   )
  FROM document_templates t
 WHERE v.id = t.current_version_id
   AND t.template_key IN (SELECT DISTINCT template_key FROM orphan_fields);

-- 適用後：対象項目が消えていること（0 行が期待値）。
SELECT x.template_key, x.name AS remaining
  FROM (
    SELECT t.template_key, f->>'name' AS name
      FROM document_templates t
      JOIN document_template_versions v ON v.id = t.current_version_id,
      LATERAL jsonb_array_elements(v.field_schema) f
  ) x
  JOIN orphan_fields o ON o.template_key = x.template_key AND o.field_name = x.name;

-- 版番号と html の長さが変わっていないこと（＝描画結果は同一）。
SELECT t.template_key, v.version_no, jsonb_array_length(v.field_schema) AS fields,
       length(v.html_source) AS html_len
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('inspection_certificate', 'purchase_order', 'license_master', 'service_master')
 ORDER BY t.template_key;

COMMIT;
