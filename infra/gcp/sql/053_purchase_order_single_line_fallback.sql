\set ON_ERROR_STOP on
\pset pager off

-- 053_purchase_order_single_line_fallback.sql
-- 発注書の「単一明細フォールバック」項目を、明細が0件のときだけフォームへ出す。
--   対象: purchase_order  … IV-z. 単一明細用（ITEM_NAME / CALC_METHOD / PAYMENT_TERMS
--                            / summaryPaymentTerms）＋ 完全に未使用の PAYMENT_METHOD を削除
--         intl_purchase_order … Services & Deliverables（ITEM_NAME / PAYMENT_METHOD）
--   これらはテンプレートの {{#each items}} の {{else}} 側でしか参照されない。明細を
--   1行でも入れると出力に効かないのに入力欄だけ残り、明細側の支払方法と重複して
--   「どちらが効くのか分からない」状態になっていた。
--
-- ★ 版は上げず、現行版の field_schema を直接更新する。
--   html_source は一切変更しない＝描画結果は同一。documents.template_version_id は
--   現行版を指したままなので、既存の発注書も従来どおり再描画できる。ここで
--   新版を作って current_version_id を差し替えると、既存文書は
--   StoredDocumentTemplateVersionError になり PDF 再発行・CloudSign 依頼が全て失敗する。
--   （出力が変わる改訂のときは従来どおり versions に新版を INSERT すること）
--
-- 削除する PAYMENT_METHOD（purchase_order のみ）はテンプレートから参照が0件。
--   intl_purchase_order では {{or CALC_METHOD PAYMENT_METHOD "FIXED"}} で使うため残す。
--   いずれも documents.form_data には手を触れないので、既存データは失われない。

\if :{?confirm_po_fallback}
\else
  \echo 'Run with: -v confirm_po_fallback=HIDE_PO_SINGLE_LINE_FIELDS'
  \quit 2
\endif
SELECT :'confirm_po_fallback' = 'HIDE_PO_SINGLE_LINE_FIELDS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 適用前の状態（差分確認用）。
SELECT t.template_key, f->>'name' AS field, (f ? 'showWhen') AS has_show_when
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
   AND f->>'name' IN ('ITEM_NAME', 'CALC_METHOD', 'PAYMENT_TERMS', 'PAYMENT_METHOD', 'summaryPaymentTerms')
 ORDER BY t.template_key, field;

-- purchase_order: フォールバック4項目に showWhen を付け、PAYMENT_METHOD は取り除く。
UPDATE document_template_versions v
   SET field_schema = (
     SELECT COALESCE(jsonb_agg(
         CASE
           WHEN e.f->>'name' IN ('ITEM_NAME', 'CALC_METHOD', 'PAYMENT_TERMS', 'summaryPaymentTerms')
             THEN e.f || jsonb_build_object(
                    'showWhen', jsonb_build_object('field', 'items', 'truthy', false))
           ELSE e.f
         END
         ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(v.field_schema) WITH ORDINALITY AS e(f, ord)
      WHERE e.f->>'name' IS DISTINCT FROM 'PAYMENT_METHOD'
   )
  FROM document_templates t
 WHERE t.template_key = 'purchase_order' AND v.id = t.current_version_id;

-- intl_purchase_order: フォールバック2項目に showWhen を付ける（PAYMENT_METHOD は使用中）。
UPDATE document_template_versions v
   SET field_schema = (
     SELECT COALESCE(jsonb_agg(
         CASE
           WHEN e.f->>'name' IN ('ITEM_NAME', 'PAYMENT_METHOD')
             THEN e.f || jsonb_build_object(
                    'showWhen', jsonb_build_object('field', 'items', 'truthy', false))
           ELSE e.f
         END
         ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(v.field_schema) WITH ORDINALITY AS e(f, ord)
   )
  FROM document_templates t
 WHERE t.template_key = 'intl_purchase_order' AND v.id = t.current_version_id;

-- 適用後の確認：対象項目に showWhen が付いていること、
-- purchase_order から PAYMENT_METHOD が消えていること、項目総数が想定どおりであること。
SELECT t.template_key, f->>'name' AS field, f->'showWhen' AS show_when
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
   AND f ? 'showWhen'
 ORDER BY t.template_key, field;

SELECT t.template_key, v.version_no, jsonb_array_length(v.field_schema) AS fields,
       length(v.html_source) AS html_len
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
 ORDER BY t.template_key;

COMMIT;
