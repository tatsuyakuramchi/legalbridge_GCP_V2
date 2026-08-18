\set ON_ERROR_STOP on
\pset pager off

-- 060_royalty_statement_receipt_rows.sql
-- 利用許諾料計算書テンプレ改訂: 多明細モードの「■ 受領情報」を、サブライセンシーごとの
-- 明細表（受領日・入金額・換算方法・円換算base）に拡張する。
--   ・receiptRows（フォーム再設計の受領行）があるときだけ明細表を描画し、
--     無い旧下書き・確定済み文書は従来の label テーブルのまま（後方互換）。
--   ・現行版 html_source への文字列置換で新版を INSERT し current_version_id を差し替える。
--     置換対象が想定どおり見つからないときは何もせず中断。
--   ・field_schema は現行版をそのまま引き継ぐ。確定済み文書は自分の版で再生成されるため影響なし。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_royalty_receipts=ADD_ROYALTY_RECEIPT_ROWS \
--         -f infra/gcp/sql/060_royalty_statement_receipt_rows.sql

\if :{?confirm_royalty_receipts}
\else
  \echo 'Run with: -v confirm_royalty_receipts=ADD_ROYALTY_RECEIPT_ROWS'
  \quit 2
\endif
SELECT :'confirm_royalty_receipts' = 'ADD_ROYALTY_RECEIPT_ROWS' AS confirmed \gset
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
  tpl_id bigint;
  next_no int;
  new_id bigint;
  old_block constant text := $old$  {{!-- ── 受領情報 (アウト側入金) ── --}}
  <div class="section-mark">■ 受領情報（サブライセンス入金）</div>
  <table style="margin-bottom:12px;">
    <tr>
      <td class="label">入金企業</td>
      <td>{{payerCompany}}</td>
      <td class="label" style="width:120px;">カテゴリー</td>
      <td class="center" style="width:170px;">{{royaltyCategory}}</td>
    </tr>
    <tr>
      <td class="label">デザイナー / 権利者</td>
      <td>{{designerName}}</td>
      <td class="label">入金通貨</td>
      <td class="center">{{intakeCurrency}}{{#unless (eq intakeCurrency "JPY")}}（入金日レート: {{fxRate}}）{{/unless}}</td>
    </tr>
    {{#if desiredDeadline}}
    <tr>
      <td class="label">希望納期</td>
      <td colspan="3">{{desiredDeadline}}</td>
    </tr>
    {{/if}}
  </table>$old$;
  new_block constant text := $new$  {{!-- ── 受領情報 (アウト側入金) ── --}}
  {{!-- 060: 多明細フォームの受領行（receiptRows）があるときはサブライセンシーごとの
       明細表（受領日・入金額・換算方法・円換算base）で出す。行ごとに通貨・換算方法を
       持てる（交換前=入金日レート換算 / 交換後=円転済み・適用レートは記録）。
       receiptRows が無い旧下書きは従来の label テーブルのまま。 --}}
  {{#if receiptRows}}
  <div class="section-mark">■ 受領情報（サブライセンス入金）</div>
  <table style="margin-bottom:12px;">
    <thead>
      <tr>
        <th style="text-align:left;">サブライセンシー</th>
        <th style="width:13%;">受領日</th>
        <th style="width:17%;">入金額</th>
        <th style="width:28%;">換算</th>
        <th style="width:17%;">円換算 base</th>
      </tr>
    </thead>
    <tbody>
      {{#each receiptRows}}
      <tr>
        <td>{{this.sublicensee}}</td>
        <td class="center">{{this.receivedOn}}</td>
        <td class="right">{{this.amountStr}}</td>
        <td style="font-size:8.5pt;">{{this.conversionStr}}</td>
        <td class="right">¥{{this.jpyBaseStr}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{#if desiredDeadline}}
  <div style="font-size:9pt; color:#555; margin:-6px 0 12px;">希望納期: {{desiredDeadline}}</div>
  {{/if}}
  {{else}}
    <div class="section-mark">■ 受領情報（サブライセンス入金）</div>
    <table style="margin-bottom:12px;">
      <tr>
        <td class="label">入金企業</td>
        <td>{{payerCompany}}</td>
        <td class="label" style="width:120px;">カテゴリー</td>
        <td class="center" style="width:170px;">{{royaltyCategory}}</td>
      </tr>
      <tr>
        <td class="label">デザイナー / 権利者</td>
        <td>{{designerName}}</td>
        <td class="label">入金通貨</td>
        <td class="center">{{intakeCurrency}}{{#unless (eq intakeCurrency "JPY")}}（入金日レート: {{fxRate}}）{{/unless}}</td>
      </tr>
      {{#if desiredDeadline}}
      <tr>
        <td class="label">希望納期</td>
        <td colspan="3">{{desiredDeadline}}</td>
      </tr>
      {{/if}}
    </table>
  {{/if}}$new$;
BEGIN
  SELECT t.id, v.html_source INTO tpl_id, src
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement';
  IF src IS NULL THEN
    RAISE EXCEPTION 'royalty_statement テンプレートが見つかりません';
  END IF;
  IF (length(src) - length(replace(src, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION '受領情報ブロックが想定どおり 1 箇所で見つかりません。現行版の内容を確認してください';
  END IF;
  IF strpos(src, 'receiptRows') > 0 THEN
    RAISE EXCEPTION 'receiptRows は既に存在します（適用済み）。中断しました';
  END IF;

  new_html := replace(src, old_block, new_block);

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM document_template_versions WHERE template_id = tpl_id;

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.field_schema,
         '計算書テンプレ改訂: 受領情報をサブライセンシー明細表に拡張（060・receiptRows があるときのみ）',
         'legalbridge-v2'
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.id = tpl_id
  RETURNING id INTO new_id;

  UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
END
$do$;

SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, 'receiptRows') > 0 AS has_receipt_rows
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';

COMMIT;
