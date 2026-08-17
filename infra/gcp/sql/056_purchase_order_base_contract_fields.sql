\set ON_ERROR_STOP on
\pset pager off

-- 056_purchase_order_base_contract_fields.sql
-- 発注書の「基本契約あり」「基本契約名 / 番号」をフォームに出す。
--
-- 現状: どちらも type='hidden' で画面に出ない。テンプレートはこの2項目で
--   条項を出し分けている:
--     HAS_BASE_CONTRACT 真 → 「準拠契約: 本発注書は…基本契約（{{MASTER_CONTRACT_REF}}）
--                              に基づき発行される…」
--     偽                   → 「適用約款: 別紙『業務委託基本契約約款（スポット契約用）』
--                              が適用される…」
--   つまり法的な前提が変わる分岐が、画面から一切設定できない状態だった。
--   「DBから引用 → 契約・文書」で契約を選ぶと MASTER_CONTRACT_REF は入るが、
--   HAS_BASE_CONTRACT は立たないため常にスポット約款側で出ていた
--   （フラグを立てる側はアプリのコードで修正済み）。
--
-- 変更内容（この2項目のみ・順序も位置もそのまま）:
--   HAS_BASE_CONTRACT   : hidden → boolean（チェックボックス）
--   MASTER_CONTRACT_REF : hidden → text ＋ showWhen（HAS_BASE_CONTRACT が真のときだけ表示）
--   helpText も現在の UI に合わせて直す（「0. 業務委託基本契約を選ぶ」という
--   ピッカーは存在しない。実際のタブ名は「契約・文書」）。
--
-- ★ 053 / 055 と同じく版は上げず、現行版の field_schema だけを書き換える。
--   html_source は無変更＝描画結果は同一。documents.template_version_id は現行版を
--   指したままなので既存文書も従来どおり再描画できる（新版を作ると
--   StoredDocumentTemplateVersionError で PDF 再発行・CloudSign 依頼が全滅する）。
--   documents.form_data には触れないので、既存文書の出方は変わらない
--   （＝過去の発注書は今までどおりスポット約款側で出る）。
--   何度流しても結果は同じ（冪等）。

\if :{?confirm_base_contract_fields}
\else
  \echo 'Run with: -v confirm_base_contract_fields=SHOW_PURCHASE_ORDER_BASE_CONTRACT'
  \quit 2
\endif
SELECT :'confirm_base_contract_fields' = 'SHOW_PURCHASE_ORDER_BASE_CONTRACT' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 適用前：対象2項目の現在の型（想定 2 行・どちらも hidden）。
SELECT f->>'name' AS field, f->>'type' AS type, f->>'label' AS label
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key = 'purchase_order'
   AND f->>'name' IN ('HAS_BASE_CONTRACT', 'MASTER_CONTRACT_REF')
 ORDER BY field;

UPDATE document_template_versions v
   SET field_schema = (
     SELECT jsonb_agg(
              CASE
                WHEN e.f->>'name' = 'HAS_BASE_CONTRACT' THEN
                  e.f || jsonb_build_object(
                    'type', 'boolean',
                    'helpText', '締結済みの業務委託基本契約に基づく発注ならチェック。'
                      || '外すと別紙のスポット契約用約款が適用される旨で出力されます。')
                WHEN e.f->>'name' = 'MASTER_CONTRACT_REF' THEN
                  e.f || jsonb_build_object(
                    'type', 'text',
                    'helpText', 'PDF の準拠契約条項に差し込みます。'
                      || '「DBから引用 → 契約・文書」で契約を選ぶと自動入力されます。',
                    'showWhen', jsonb_build_object('field', 'HAS_BASE_CONTRACT', 'truthy', true))
                ELSE e.f
              END
              ORDER BY e.ord)
       FROM jsonb_array_elements(v.field_schema) WITH ORDINALITY AS e(f, ord)
   )
  FROM document_templates t
 WHERE v.id = t.current_version_id
   AND t.template_key = 'purchase_order'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(v.field_schema) f
      WHERE f->>'name' IN ('HAS_BASE_CONTRACT', 'MASTER_CONTRACT_REF')
        AND f->>'type' = 'hidden');

-- 適用後：型が変わり showWhen が付いていること（hidden が 0 件）。
SELECT f->>'name' AS field, f->>'type' AS type, f->'showWhen' AS show_when
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key = 'purchase_order'
   AND f->>'name' IN ('HAS_BASE_CONTRACT', 'MASTER_CONTRACT_REF')
 ORDER BY field;

-- 版番号・項目数・html の長さが変わっていないこと（＝既存文書の描画は同一）。
SELECT t.template_key, v.version_no, jsonb_array_length(v.field_schema) AS fields,
       length(v.html_source) AS html_len
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'purchase_order';

COMMIT;
