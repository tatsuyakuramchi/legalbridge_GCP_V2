-- =====================================================================
-- 169 役務提供完了通知書（service_completion_notice）の登録
--
--   準委任で時間精算（月間包括枠＋実績時間。A-073）の委託料の決済文書。検収書の役務提供版：
--   成果物の検収ではなく、その月の役務の提供が完了したことを確認する。
--
--   ・V3 は、決済文書を作るときに条件が時間精算（conditions.time_settlement）なら
--     検収書ではなくこのひな形を既定にする（作業テーブル・取引管理・支払文書処理）。
--   ・明細は実績 1 件を 包括枠／超過／未消化の控除 の行に分けて出す（template-context.ts）。
--   ・受注者に登録番号があれば副題「兼 仕入明細書」。確認期限は送付日から 10 営業日。
--   ・署名欄は金額が発注時の合意と違うとき（超過・未消化の精算、予定と違う額）だけ出る。
--   ・採番は SC（ARC-SC-年-連番）。分類は国内の検収書と同じ。
--
--   本文は infra/v3/templates/service_completion_notice.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/169_service_completion_notice.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'service_completion_notice';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!DOCTYPE html>
{{!-- 役務提供完了通知書（A-073）。準委任で時間精算（月間包括枠＋実績時間）の委託料の決済文書。
     検収書の役務提供版：成果物の検収ではなく、その月の役務の提供が完了したことを確認する。
     段は 業務概要 → 今回の役務提供内容 → 合計 → 超過精算の確認（金額が合意と違うときだけ） → 備考。
     受注者に登録番号があれば副題「兼 仕入明細書」。無ければ副題なし（経過措置の区分は紙に出さない）。
     本文は infra/v3/templates/service_completion_notice.html（169 で登録）。 --}}
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>役務提供完了通知書</title>
<style>
  @page { size: A4; margin: 12mm 12mm 14mm; }
  body { font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; font-size: 9.5pt; line-height: 1.5; color: #222; margin: 0; padding: 16px; }
  h1.doc-title { font-size: 18pt; margin: 0 0 2px; letter-spacing: .3em; font-weight: 700; text-align: center; }
  .doc-head { text-align: center; margin-bottom: 6px; }
  .doc-sub { font-size: 8.5pt; color: #555; }
  .doc-meta { font-size: 8.5pt; text-align: right; margin: 0 0 6px; }
  .doc-meta b { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  hr.rule { border: none; border-top: 1px solid #333; margin: 0 0 10px; }
  table { border-collapse: collapse; }
  table.party { width: 100%; margin-bottom: 10px; }
  table.party td { vertical-align: top; }
  table.party td + td { border-left: 1px solid #d9d9d9; }
  .vlabel { font-size: 8pt; font-weight: 700; color: #555; margin-bottom: 3px; letter-spacing: .04em; }
  .vendor-name { font-size: 13pt; font-weight: 700; border-bottom: 1px solid #333; padding-bottom: 3px; margin-bottom: 4px; }
  .muted { font-size: 8.5pt; color: #555; }
  .company-name { font-weight: 700; font-size: 10.5pt; margin-bottom: 2px; }
  .contact { margin-top: 6px; padding-top: 5px; border-top: 1px solid #d9d9d9; font-size: 8.5pt; color: #555; }
  p.lead { font-size: 9pt; margin: 0 0 6px; }
  p.section-mark { font-size: 9.5pt; font-weight: 700; margin: 10px 0 4px; padding: 0 0 2px; border: 0; border-bottom: 1px solid #bdbdbd; page-break-after: avoid; }
  table.summary { width: 100%; font-size: 8.5pt; }
  table.summary th, table.summary td { border: 1px solid #d9d9d9; padding: 4px 7px; vertical-align: top; text-align: left; }
  table.summary th { background: #f4f4f2; width: 16%; font-weight: 600; color: #333; white-space: nowrap; }
  table.summary td { width: 34%; }
  table.summary td b.no { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  table.items { width: 100%; font-size: 8.5pt; }
  table.items th, table.items td { border: 1px solid #d9d9d9; padding: 3px 6px; vertical-align: top; line-height: 1.4; }
  table.items th { background: #f4f4f2; font-weight: 600; color: #333; text-align: center; white-space: nowrap; }
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }
  td.center { text-align: center; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .item-name { font-weight: 600; }
  .item-spec { font-size: 8pt; color: #555; margin-top: 1px; }
  tr.spec-row td { border-top: 0; background: #fafaf8; font-size: 8.5pt; white-space: pre-line; padding: 4px 8px 6px; }
  tr.spec-row td:first-child { background: transparent; }
  table.totals { width: auto; min-width: 46%; margin: 6px 0 0 auto; font-size: 8.5pt; }
  table.totals th { text-align: left; font-weight: 400; border: 0; border-bottom: 1px solid #d9d9d9; padding: 2px 10px 2px 2px; white-space: nowrap; }
  table.totals td { border: 0; border-bottom: 1px solid #d9d9d9; padding: 2px 2px 2px 16px; min-width: 9em; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.totals tr.grand th, table.totals tr.grand td { font-weight: 700; font-size: 10pt; border-top: 2px solid #333; border-bottom: 0; padding-top: 4px; }
  table.totals tr.date th, table.totals tr.date td { border: 0; color: #555; font-size: 8pt; padding-top: 0; }
  .signature-section { margin: 10px 0 12px; padding: 8px 10px; border: 1px solid #c9a227; background: #fffbea; page-break-inside: avoid; }
  .signature-section .t { font-size: 9.5pt; font-weight: 700; margin-bottom: 4px; }
  .signature-section p { font-size: 8.5pt; margin: 0 0 8px; line-height: 1.5; }
  .signature-section table { width: 100%; font-size: 8.5pt; }
  .signature-section td { width: 50%; vertical-align: top; padding: 6px 8px; border: 1px solid #bbb; }
  .signature-section .lbl { color: #555; margin-bottom: 6px; }
  .signature-section .line { height: 44px; border-bottom: 1px solid #333; }
  .signature-section .ours { min-height: 44px; border-bottom: 1px solid #333; display: flex; align-items: flex-end; padding-bottom: 2px; line-height: 1.4; }
  .remarks { font-size: 8pt; color: #555; margin-top: 10px; }
  .remarks ol { margin: 2px 0 0; padding-left: 1.4em; }
  .remarks li { margin: 1px 0; }
</style>
</head>
<body data-layout="scn-v1-2026-10">

<div class="doc-head">
  <h1 class="doc-title">役務提供完了通知書</h1>
  <div class="doc-sub">{{#if sc_is_invoice_statement}}兼 仕入明細書　／　{{/if}}{{#if sc_month_label}}{{sc_month_label}}{{/if}}{{#if sc_service_from}}　役務提供期間 {{formatDate sc_service_from}} 〜 {{formatDate sc_service_to}}{{/if}}</div>
</div>
<div class="doc-meta">文書番号: <b>{{DOC_NO}}</b>　　発行日: {{formatDate documentDate}}</div>
<hr class="rule">

<table class="party">
  <tr>
    <td style="width:50%; padding-right:12px;">
      <div class="vlabel">受注者</div>
      <div class="vendor-name">{{VENDOR_NAME}}{{#if VENDOR_SUFFIX}}　{{VENDOR_SUFFIX}}{{else}}　御中{{/if}}</div>
      {{#if VENDOR_ADDRESS}}<div class="muted">{{VENDOR_ADDRESS}}</div>{{/if}}
      <div class="muted">登録番号: {{#if INVOICE_REGISTRATION_NUMBER}}{{INVOICE_REGISTRATION_NUMBER}}{{else}}未登録{{/if}}</div>
    </td>
    <td style="width:50%; padding-left:12px;">
      <div class="vlabel">発注者</div>
      <div class="company-name">{{PARTY_A_NAME}}</div>
      <div class="muted" style="white-space:pre-wrap;">{{PARTY_A_ADDRESS}}</div>
      {{#if COMPANY_INVOICE_NO}}<div class="muted">登録番号: T{{COMPANY_INVOICE_NO}}</div>{{/if}}
      {{#if PARTY_A_REP}}<div class="muted">{{PARTY_A_REP}}</div>{{/if}}
      {{#if STAFF_NAME}}
      <div class="contact">担当: {{#if STAFF_DEPARTMENT}}{{STAFF_DEPARTMENT}} {{/if}}{{STAFF_NAME}}{{#if STAFF_PHONE}}　TEL {{STAFF_PHONE}}{{/if}}{{#if STAFF_EMAIL}}<br>{{STAFF_EMAIL}}{{/if}}</div>
      {{/if}}
    </td>
  </tr>
</table>

<p class="lead">下記のとおり、{{#if sc_month_label}}{{sc_month_label}}の{{/if}}役務の提供が完了したことを確認しましたので、通知いたします。</p>

<p class="section-mark">■ 業務概要</p>
<table class="summary">
  <tr>
    <th>件名</th><td>{{PROJECT_TITLE}}</td>
    <th>発注番号</th><td><b class="no">{{#if parent_po_number}}{{parent_po_number}}{{else}}—{{/if}}</b></td>
  </tr>
  <tr>
    <th>契約種別</th><td>{{sc_contract_form}}{{#if WITHHOLDING_TAX}}（源泉徴収 {{WITHHOLDING_TAX}}）{{else}}（源泉徴収 対象外）{{/if}}</td>
    <th>役務提供期間</th><td>{{#if sc_term_start}}{{formatDate sc_term_start}} 〜 {{#if sc_term_end}}{{formatDate sc_term_end}}{{/if}}{{else}}{{#if sc_service_from}}{{formatDate sc_service_from}} 〜 {{formatDate sc_service_to}}{{else}}—{{/if}}{{/if}}</td>
  </tr>
  <tr>
    <th>精算方法</th><td>{{#if sc_time_settlement}}月間包括枠 {{sc_hours_included_text}}　{{sc_base_amount_str}} 円／月<br>超過分 {{sc_overage_unit_str}} 円／h{{#if sc_shortfall_unit_str}}、未消化 {{sc_shortfall_unit_str}} 円／h 控除{{/if}}{{else}}固定額{{/if}}</td>
    <th>月次業務報告書</th><td>{{#if sc_report_received_on}}{{formatDate sc_report_received_on}} 受領{{else}}—{{/if}}</td>
  </tr>
</table>

<p class="section-mark">■ 今回の役務提供内容{{#if sc_month_label}}（{{sc_month_label}}）{{/if}}</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:4%">No.</th>
      <th style="width:34%">業務内容</th>
      <th style="width:14%">発注番号</th>
      <th style="width:15%">役務提供期間</th>
      <th style="width:9%">実績時間</th>
      <th style="width:12%">単価（税抜）</th>
      <th style="width:12%">金額（税抜）</th>
    </tr>
  </thead>
  <tbody>
    {{#each delivery_line_items}}
    <tr>
      <td class="center">{{index1 @index}}</td>
      <td><div class="item-name">{{item_name}}</div>{{#if item_spec}}<div class="item-spec">{{item_spec}}</div>{{else}}{{#if spec_head}}<div class="item-spec">{{spec_head}}</div>{{/if}}{{/if}}</td>
      <td class="center">{{#if order_no}}{{order_no}}{{else}}{{../parent_po_number}}{{/if}}</td>
      <td class="center">{{#if term_start}}{{formatDateCompact term_start}}〜{{formatDateCompact term_end}}{{else}}{{#if delivery_date}}{{formatDateCompact delivery_date}}{{else}}—{{/if}}{{/if}}</td>
      <td class="num">{{#if sc_hours_text}}{{sc_hours_text}}{{else}}{{#if quantity}}{{quantity}}{{else}}—{{/if}}{{/if}}</td>
      <td class="num">{{#if sc_unit_text}}{{sc_unit_text}}{{else}}{{#if unit_price}}{{formatCurrency unit_price}}{{else}}—{{/if}}{{/if}}</td>
      <td class="num">{{formatCurrency (or inspected_amount_ex_tax amount_ex_tax)}}</td>
    </tr>
    {{#if has_spec_body}}
    <tr class="spec-row"><td></td><td colspan="6">{{spec_body}}</td></tr>
    {{/if}}
    {{/each}}
    {{#each other_fees}}
    <tr>
      <td class="center"></td>
      <td><div class="item-name">{{or fee_name "手数料"}}</div>{{#if remarks}}<div class="item-spec">{{remarks}}</div>{{/if}}</td>
      <td class="center">{{../parent_po_number}}</td>
      <td class="center">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">{{formatCurrency (or amount_ex_tax amount)}}</td>
    </tr>
    {{/each}}
    {{#each expenses}}
    <tr>
      <td class="center"></td>
      <td><div class="item-name">{{or expense_name "実費"}}（実費・税込）</div>{{#if remarks}}<div class="item-spec">{{remarks}}</div>{{/if}}</td>
      <td class="center">{{../parent_po_number}}</td>
      <td class="center">{{#if spent_date}}{{formatDateCompact spent_date}}{{else}}—{{/if}}</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">{{formatCurrency (or amount_inc_tax amount)}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>

<table class="totals">
  <tr><th>小計（税抜）</th><td>{{taxableSubtotalExTaxStr}}</td></tr>
  <tr><th>消費税（{{taxRate}}%）</th><td>{{combinedTaxStr}}</td></tr>
  {{#if expenses.length}}<tr><th>実費（税込）</th><td>{{expensesTotalIncTaxStr}}</td></tr>{{/if}}
  <tr class="grand"><th>お支払額</th><td>{{grandTotalPayableStr}}</td></tr>
  {{#if PAYMENT_DATE}}<tr class="date"><th>お支払予定日</th><td>{{formatDate PAYMENT_DATE}}</td></tr>{{/if}}
</table>

{{#if needsSignature}}
<div class="signature-section">
  <div class="t">■ {{#if hasOverage}}超過精算{{else}}{{#if hasShortfall}}未消化精算{{else}}変更内容{{/if}}{{/if}}の確認</div>
  <p>{{#if hasOverage}}実績が月間包括枠（{{sc_hours_included_text}}）を超えたため、超過 {{sc_overage_hours_text}} × {{sc_overage_unit_str}} 円 ＝ {{sc_overage_amount_str}} 円を追加精算します。{{/if}}{{#if hasShortfall}}実績が月間包括枠（{{sc_hours_included_text}}）に満たないため、未消化 {{sc_shortfall_hours_text}} × {{sc_shortfall_unit_str}} 円 ＝ {{sc_shortfall_amount_str}} 円を控除します。{{/if}}{{#if hasChangeLogs}}{{#each changeLogs}}{{fieldLabel}} {{beforeValue}} → {{afterValue}}（{{reason}}）。{{/each}}{{/if}}発注時の合意額に含まれない額のため、ご確認のうえご署名（または記名押印）ください。</p>
  <table>
    <tr>
      <td>
        <div class="lbl">受注者（署名または記名押印）</div>
        <div class="line"></div>
        <div style="margin-top:6px;">署名日：　　　　年　　　月　　　日</div>
      </td>
      <td>
        <div class="lbl">発注者（確認者）</div>
        <div class="ours">{{PARTY_A_NAME}}　{{#if inspectorDept}}{{inspectorDept}}　{{/if}}{{inspectorName}}</div>
        <div style="margin-top:6px;">確認日：{{formatDate documentDate}}</div>
      </td>
    </tr>
  </table>
</div>
{{/if}}

<div class="remarks">
  <b>備考</b>
  <ol>
    <li>記載内容に相違がある場合は、本通知書の送付日から 10 営業日以内{{#if sc_confirm_deadline}}（{{formatDate sc_confirm_deadline}}まで）{{/if}}に上記の当社担当までご連絡ください。ご連絡がない場合は確認済みとして取り扱います。</li>
    <li>本通知書は役務提供完了の確認であり、成果物の検収ではありません。</li>
    {{#if sc_time_settlement}}<li>実績時間は月次業務報告書によります。報告書にない作業は精算しません。</li>{{/if}}
    <li>実費は税込の実費精算です。その他の経費は事前承認分に限ります。</li>
    <li>受注者の請求書と記載が異なる場合は本通知書を優先します。</li>
    {{#if remarks}}<li>{{remarks}}</li>{{/if}}
  </ol>
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[{"name":"confirm_deadline","label":"確認期限","type":"date","group":"I. 基本情報","helpText":"送付日から 10 営業日。空なら発行日から数えて仮置きする"},{"name":"remarks","label":"備考（追記）","type":"textarea","group":"III. 備考","helpText":"備考の末尾に 1 項目として出る"}]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'inspection_certificate';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'service_completion_notice';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('service_completion_notice', '役務提供完了通知書', base_category, 'SC', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'SC'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '169: 役務提供完了通知書は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '169: 役務提供完了通知書', 'sql:169')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '169: 役務提供完了通知書を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, 'data-layout="scn-v1') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'service_completion_notice';
