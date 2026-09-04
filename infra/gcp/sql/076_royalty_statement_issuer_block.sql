\set ON_ERROR_STOP on
\pset pager off

-- 076_royalty_statement_issuer_block.sql
-- 利用許諾料計算書テンプレ改訂: 発行元（ライセンシー＝自社）ボックスに 住所・電話・
-- インボイス登録番号 を追加する（2026-09-04 利用者指摘「自社情報が入っていない」）。
--   ・従来の変数は licensee（社名）と STAFF_*（担当者）だけだった。
--   ・COMPANY_POSTAL_CODE / COMPANY_ADDRESS / COMPANY_TEL / COMPANY_INVOICE_NO があるときだけ描く
--     （無い旧下書き・確定済み文書は従来どおり社名＋担当者のみ＝後方互換）。
--   ・field_schema にも同名の hidden 項目（dbField company.*）を足し、「DBから引用 → 自社」でも
--     入るようにする（画面には出ない）。「かんたん受領入力」はプロファイルから直接埋める。
--   ・現行版 html_source への文字列置換で新版を INSERT し current_version_id を差し替える。
--     置換対象が想定どおり 1 箇所で見つからないときは何もせず中断。冪等（適用済みなら中断）。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_issuer_block=ADD_ROYALTY_ISSUER_BLOCK \
--         -f infra/gcp/sql/076_royalty_statement_issuer_block.sql

\if :{?confirm_issuer_block}
\else
  \echo 'Run with: -v confirm_issuer_block=ADD_ROYALTY_ISSUER_BLOCK'
  \quit 2
\endif
SELECT :'confirm_issuer_block' = 'ADD_ROYALTY_ISSUER_BLOCK' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  schema jsonb;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  old_block constant text := $old$      <div style="font-weight:900; font-size:12pt; margin-bottom:5px;">{{licensee}}</div>$old$;
  new_block constant text := $new$      <div style="font-weight:900; font-size:12pt; margin-bottom:5px;">{{licensee}}</div>
      {{!-- 076: 自社プロファイル（住所・電話・インボイス登録番号）があるときだけ描く --}}
      {{#if COMPANY_ADDRESS}}
      <div style="font-size:9pt; line-height:1.6;">{{#if COMPANY_POSTAL_CODE}}〒{{COMPANY_POSTAL_CODE}}　{{/if}}{{COMPANY_ADDRESS}}</div>
      {{/if}}
      {{#if COMPANY_TEL}}<div style="font-size:9pt;">TEL: {{COMPANY_TEL}}</div>{{/if}}
      {{#if COMPANY_INVOICE_NO}}<div style="font-size:9pt;">登録番号: {{COMPANY_INVOICE_NO}}</div>{{/if}}$new$;
BEGIN
  SELECT t.id, v.html_source, v.field_schema INTO tpl_id, src, schema
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement';
  IF src IS NULL THEN
    RAISE EXCEPTION 'royalty_statement テンプレートが見つかりません';
  END IF;
  IF strpos(src, 'COMPANY_ADDRESS') > 0 THEN
    RAISE EXCEPTION 'COMPANY_ADDRESS は既に存在します（適用済み）。中断しました';
  END IF;
  IF (length(src) - length(replace(src, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION '発行元ブロック（{{licensee}} の行）が想定どおり 1 箇所で見つかりません。現行版の内容を確認してください';
  END IF;

  new_html := replace(src, old_block, new_block);

  -- 自社の欄を hidden 項目として schema に足す（DBから引用 → 自社 で埋まる。画面には出ない）。
  schema := schema
    || jsonb_build_array(
         jsonb_build_object('name', 'COMPANY_POSTAL_CODE', 'label', '自社 郵便番号（自動）', 'group', 'II. 当事者 (契約マスタから自動入力)', 'type', 'hidden', 'dbField', 'company.postal_code'),
         jsonb_build_object('name', 'COMPANY_ADDRESS',     'label', '自社 住所（自動）',     'group', 'II. 当事者 (契約マスタから自動入力)', 'type', 'hidden', 'dbField', 'company.address'),
         jsonb_build_object('name', 'COMPANY_TEL',         'label', '自社 電話（自動）',     'group', 'II. 当事者 (契約マスタから自動入力)', 'type', 'hidden', 'dbField', 'company.tel'),
         jsonb_build_object('name', 'COMPANY_INVOICE_NO',  'label', '自社 インボイス登録番号（自動）', 'group', 'II. 当事者 (契約マスタから自動入力)', 'type', 'hidden', 'dbField', 'company.invoice_no')
       );

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM document_template_versions WHERE template_id = tpl_id;

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  VALUES (tpl_id, next_no, new_html, schema,
          '計算書テンプレ改訂: 発行元（自社）ボックスに住所・電話・インボイス登録番号（076・変数があるときのみ）',
          'legalbridge-v2')
  RETURNING id INTO new_id;

  UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
END
$do$;

SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, 'COMPANY_ADDRESS') > 0 AS has_issuer_block,
       (SELECT count(*) FROM jsonb_array_elements(v.field_schema) f WHERE f->>'name' LIKE 'COMPANY_%') AS company_fields
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';

COMMIT;
