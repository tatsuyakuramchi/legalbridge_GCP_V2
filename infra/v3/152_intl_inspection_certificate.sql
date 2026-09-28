-- =====================================================================
-- 152 海外用の検収書（Acceptance Certificate / intl_inspection_certificate）
--
--   海外（クロスボーダー）の取引の検収書。英文で、金額は消費税・VAT 等を含む総額として出す
--   （海外発注書の約款 6.5 条）。国内の検収書（inspection_certificate）の計算は変えない。
--
--   ・V3 は、検収書を作るときに条件が海外の取引（税区分が「税込（海外・内税）」か、決定済みの
--     海外発注書に載っている）なら、自動でこのひな形に切り替える。
--   ・決定すると、その条件の税区分を「税込（海外・内税）」にする（支払・会計で消費税を足さない）。
--   ・採番のプレフィックスと分類は国内の検収書と同じにする（番号の帯を分けない）。
--   本文は infra/v3/templates/intl_inspection_certificate.html。
--   何度流しても同じ（登録済みで本文が同じなら何もしない。本文が違えば新しい版）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/152_intl_inspection_certificate.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false
--              WHERE template_key = 'intl_inspection_certificate';（国内の検収書に戻る）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!DOCTYPE html>
{{!-- 海外用の検収書（Acceptance Certificate）。海外発注書（148）と同じ体裁。
     金額は消費税・VAT 等を含む総額（Standard Terms, Article 6.5）。税の行は作らない。 --}}
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Acceptance Certificate</title>
<style>
  @page { size: A4; margin: 12mm 12mm 14mm; }
  body { font-family: "Helvetica Neue", Arial, "Noto Sans CJK JP", "Meiryo", sans-serif; font-size: 10pt; line-height: 1.5; color: #222; margin: 0; padding: 16px; }
  h1.doc-title { font-size: 20pt; margin: 0 0 4px; letter-spacing: 4px; font-weight: 700; }
  .doc-head { text-align: center; margin-bottom: 8px; }
  .doc-sub { font-size: 9pt; color: #555; }
  hr.rule { border: none; border-top: 2px solid #111; margin: 0 0 14px; }
  table { border-collapse: collapse; }
  .party { width: 100%; margin-bottom: 14px; }
  .party td { vertical-align: top; }
  .vlabel { font-size: 8pt; font-weight: 700; color: #555; margin-bottom: 3px; letter-spacing: .04em; }
  .vendor-name { font-size: 13pt; font-weight: 800; border-bottom: 1px solid #111; padding-bottom: 3px; margin-bottom: 6px; }
  .muted { color: #555; font-size: 9pt; }
  .section-mark { font-weight: 700; font-size: 10pt; margin: 14px 0 6px; border-bottom: 1px solid #111; padding-bottom: 2px; }
  table.summary { width: 100%; }
  table.summary th, table.summary td { border: 1px solid #cfcfcf; padding: 5px 7px; vertical-align: top; text-align: left; font-size: 9.5pt; }
  table.summary th { background: #f4f4f2; width: 30%; font-weight: 700; }
  table.lines { width: 100%; }
  table.lines th, table.lines td { border: 1px solid #cfcfcf; padding: 4px 6px; font-size: 9pt; vertical-align: top; }
  table.lines th { background: #f4f4f2; text-align: left; }
  .right { text-align: right; white-space: nowrap; }
  .total-amount { font-size: 13pt; font-weight: 800; }
  .amount-note { font-size: 8.5pt; color: #555; }
  .bank-lines { font-size: 8.5pt; line-height: 1.45; }
  .bank-lines .sep { margin-left: 8px; }
  .sign2 { width: 60%; margin-left: auto; margin-top: 14px; }
  .sign2 td { border: 1px solid #cfcfcf; padding: 6px 8px; font-size: 9pt; vertical-align: top; }
  .sign-line { height: 28px; border-bottom: 1px solid #111; }
  .foot-note { font-size: 8.5pt; color: #555; margin-top: 12px; }
</style>
</head>
<body data-layout="iac-v1-2026-09">

<div class="doc-head">
  <h1 class="doc-title">ACCEPTANCE CERTIFICATE</h1>
  <div class="doc-sub">
    Date: {{formatDateEn documentDate}}　／　Certificate No.: {{DOC_NO}}{{#if parent_po_number}}　／　PO No.: {{parent_po_number}}{{/if}}
  </div>
</div>
<hr class="rule">

<table class="party">
  <tr>
    <td style="width:50%; padding-right:12px;">
      <div class="vlabel">To (Contractor)</div>
      <div class="vendor-name">{{VENDOR_NAME}}</div>
      {{#if VENDOR_CONTACT_NAME}}<div class="muted">Attn: {{VENDOR_CONTACT_NAME}}</div>{{/if}}
      {{#if VENDOR_ADDRESS}}<div class="muted">{{VENDOR_ADDRESS}}</div>{{/if}}
    </td>
    <td style="width:50%; padding-left:12px; border-left:1px solid #cfcfcf;">
      <div class="vlabel">From (Purchaser)</div>
      <div style="font-weight:900; font-size:12pt; margin-bottom:4px;">{{PARTY_A_NAME}}</div>
      <div style="white-space:pre-wrap;">{{PARTY_A_ADDRESS}}</div>
      {{#if STAFF_NAME}}
      <div style="margin-top:8px; padding-top:6px; border-top:1px solid #cfcfcf; font-size:9pt;">
        {{#if STAFF_DEPARTMENT}}<strong>Dept.:</strong> {{STAFF_DEPARTMENT}}<br>{{/if}}
        <strong>Contact:</strong> {{STAFF_NAME}}<br>
        {{#if STAFF_PHONE}}Tel: {{STAFF_PHONE}}<br>{{/if}}
        {{#if STAFF_EMAIL}}E-mail: {{STAFF_EMAIL}}{{/if}}
      </div>
      {{/if}}
    </td>
  </tr>
</table>

<p>The Purchaser hereby certifies that the deliverables and/or services listed below, provided under
{{#if parent_po_number}}Purchase Order No. {{parent_po_number}}{{else}}the Purchase Order{{/if}}, have been inspected and accepted
as of {{#if acceptanceDate}}{{formatDateEn acceptanceDate}}{{else}}the date of this certificate{{/if}}.</p>

<p class="section-mark">■ ACCEPTED DELIVERABLES / SERVICES</p>
<table class="lines">
  <tr>
    <th style="width:5%;">#</th>
    <th>Description</th>
    <th style="width:18%;">Delivered</th>
    <th class="right" style="width:22%;">Amount</th>
  </tr>
  {{#each delivery_line_items}}
  <tr>
    <td>{{index1 @index}}</td>
    <td><strong>{{item_name}}</strong>{{#if spec}}<div class="muted" style="white-space:pre-wrap;">{{spec}}</div>{{/if}}</td>
    <td>{{#if delivery_date}}{{formatDateEn delivery_date}}{{else}}—{{/if}}</td>
    <td class="right">{{../currency_code}} {{formatMoney (or inspected_amount_ex_tax (or amount_ex_tax amount))}}</td>
  </tr>
  {{/each}}
  {{#each other_fees}}
  <tr>
    <td></td>
    <td>{{or fee_name "Other fee"}}{{#if remarks}}<div class="muted">{{remarks}}</div>{{/if}}</td>
    <td>—</td>
    <td class="right">{{../currency_code}} {{formatMoney (or amount_ex_tax amount)}}</td>
  </tr>
  {{/each}}
  {{#each expenses}}
  <tr>
    <td></td>
    <td>{{or expense_name "Expense"}} (reimbursement){{#if remarks}}<div class="muted">{{remarks}}</div>{{/if}}</td>
    <td>{{#if spent_date}}{{formatDateEn spent_date}}{{else}}—{{/if}}</td>
    <td class="right">{{../currency_code}} {{formatMoney (or amount_inc_tax amount)}}</td>
  </tr>
  {{/each}}
</table>

<p class="section-mark">■ PAYMENT</p>
<table class="summary">
  <tr>
    <th>Amount Payable</th>
    <td><strong class="total-amount">{{currency_code}} {{formatMoney grandTotalPayable}}</strong>
      <div class="amount-note">Inclusive of any VAT, sales or similar taxes chargeable by the Contractor{{#unless HAS_BASE_CONTRACT}} (Standard Terms, Article 6.5){{/unless}}; no tax is added to this amount.</div></td>
  </tr>
  <tr>
    <th>Payment Due</th>
    <td>{{#if summaryPaymentDate}}{{formatDateEn summaryPaymentDate}}{{else}}As stated in the Purchase Order{{/if}}</td>
  </tr>
  {{#if (or BANK_NAME (or IBAN SWIFT_BIC))}}
  <tr>
    <th>Bank Account</th>
    <td><div class="bank-lines">
      <div>{{#if BANK_NAME}}<b>{{BANK_NAME}}</b>{{/if}}{{#if BRANCH_NAME}}, {{BRANCH_NAME}}{{/if}}{{#if SWIFT_BIC}}<span class="sep">SWIFT/BIC: {{SWIFT_BIC}}</span>{{/if}}{{#if BANK_COUNTRY}}<span class="sep">Country: {{BANK_COUNTRY}}</span>{{/if}}</div>
      <div>{{#if BENEFICIARY_NAME}}Beneficiary: {{BENEFICIARY_NAME}}{{/if}}{{#if ACCOUNT_NUMBER}}<span class="sep">Account No.: {{ACCOUNT_NUMBER}}</span>{{/if}}{{#if IBAN}}<span class="sep">IBAN: {{IBAN}}</span>{{/if}}{{#if ROUTING_NUMBER}}<span class="sep">Routing No.: {{ROUTING_NUMBER}}</span>{{/if}}{{#if BANK_CURRENCY}}<span class="sep">Currency: {{BANK_CURRENCY}}</span>{{/if}}</div>
      {{#if (or BANK_ADDRESS (or INTERMEDIARY_BANK_NAME INTERMEDIARY_BANK_SWIFT))}}<div>{{#if BANK_ADDRESS}}Bank Address: {{BANK_ADDRESS}}{{/if}}{{#if (or INTERMEDIARY_BANK_NAME INTERMEDIARY_BANK_SWIFT)}}<span class="sep">Intermediary: {{INTERMEDIARY_BANK_NAME}}{{#if INTERMEDIARY_BANK_SWIFT}}{{#if INTERMEDIARY_BANK_NAME}} / {{/if}}SWIFT {{INTERMEDIARY_BANK_SWIFT}}{{/if}}</span>{{/if}}</div>{{/if}}
    </div></td>
  </tr>
  {{/if}}
  <tr>
    <th>Bank Charges</th>
    <td>The Purchaser bears remitting bank charges; the Contractor bears intermediary and receiving bank charges{{#unless HAS_BASE_CONTRACT}} (Standard Terms, Article 6.3){{/unless}}.</td>
  </tr>
  <tr>
    <th>Withholding Tax</th>
    <td>{{#if withholding_label}}{{withholding_label}}{{#if (eq withholding_label "Applicable")}} — the Purchaser will deduct and remit withholding tax as required by law. A reduced rate or exemption under an applicable tax treaty applies only if a certificate of residence and other required documents are provided before the payment date{{#unless HAS_BASE_CONTRACT}} (Standard Terms, Articles 6.2 and 6.4){{/unless}}.{{/if}}{{else}}—{{/if}}</td>
  </tr>
</table>

<p class="foot-note">If the Contractor’s local tax rules require an invoice, please send an invoice for the Amount Payable above, quoting this certificate number.
Any non-conformity discovered after acceptance may be notified in accordance with the Purchase Order and the applicable terms.</p>

<table class="sign2" cellspacing="0" cellpadding="0">
  <tr><td><div class="vlabel">For and on behalf of the Purchaser</div>
    <div>{{PARTY_A_NAME}}</div>
    <div class="sign-line"></div>
    <div class="muted">Name / Title{{#if STAFF_NAME}}: {{STAFF_NAME}}{{/if}}</div></td></tr>
</table>

</body>
</html>
$tpl$;
  tpl_id bigint;
  cur text;
  base_prefix text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT number_prefix, category INTO base_prefix, base_category
    FROM v3.document_templates WHERE template_key = 'inspection_certificate';
  IF base_prefix IS NULL THEN
    RAISE EXCEPTION '国内の検収書（inspection_certificate）が見つからないか、採番プレフィックスがありません';
  END IF;

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_inspection_certificate';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('intl_inspection_certificate', '検収書（海外・Acceptance Certificate）',
            base_category, base_prefix, true)
    RETURNING id INTO tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '152: 海外用の検収書は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, '[]'::jsonb, '152: 海外用の検収書（Acceptance Certificate・税込）', 'sql:152')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '152: intl_inspection_certificate 版 %（id=%）。採番は %', next_no, new_id, base_prefix;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS ひな形, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, (strpos(v.html_source, 'ACCEPTANCE CERTIFICATE') > 0) AS 本文
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('inspection_certificate', 'intl_inspection_certificate')
 ORDER BY 1;
