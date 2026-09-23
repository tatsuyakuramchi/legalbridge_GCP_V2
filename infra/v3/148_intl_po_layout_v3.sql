-- =====================================================================
-- 海外版の発注書のひな形：国内版（147）と同じレイアウトに（Page 1 固定・署名式・License Terms）
--
--   国内版（147）と同じ考え方。1 ページ目を To/From・Order Summary・Payment・
--   Acceptance（または Signatures）の行数が決まった表だけで組み、Line Items・
--   Other Fees・Expenses・License Terms・Special Terms・Notices は改ページの後。
--
--   ・Acceptance：Contractor の欄（名前・住所・法人で担当者の登録があるときだけ
--     Attn）と Date（12pt が入る 44mm の下線）・Signature。押印欄は無い。
--   ・発注署名欄＝あり なら同じ場所に Purchaser / Contractor の署名欄。
--   ・金額は通貨コード付き（JPY 246,000 / USD 2,460.00）。日付は英語表記。
--   ・Bank Account は SWIFT / Account No. / Beneficiary、手数料は remitting＝発注者・
--     receiving＝受注者。Withholding Tax は Applicable / Not applicable。
--   ・約款（Standard Terms）の partial は現行版の本文にある {{> 名前}} を拾って
--     同じ名前で差す。現行版に無ければ約款は付けない。
--   ・CSS は全部を書く（現行版の head に頼らない）。
--
--   やり方は 120・137 と同じ。現行版の <head>（CSS）を残して </style> の前に
--   CSS を足し、<body>…</body> を丸ごと置き換えた新しい版を作って
--   current_version_id を差し替える。項目の宣言（variables）は現行版のまま。
--   適用済み（本文に data-layout="ipo-v3-2026-09r1" がある）なら何もしない。同じレイアウトの
--   古い改訂が入っていれば、148 より前の版の head を下敷きにして
--   新しい改訂に置き換える（手で前の版に戻さなくてよい）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/148_intl_po_layout_v3.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'intl_purchase_order';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
--   元の本文と CSS: infra/v3/templates/intl_purchase_order_v3_body.html / intl_purchase_order_v3_css.txt
--   （このファイルは infra/v3/tools/make-po-layout-sql.mjs が組み立てる）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  head text;
  new_html text;
  body_text text;
  terms_partial text;
  tpl_id bigint;
  from_version bigint;
  from_no int;
  base_version bigint;
  base_no int;
  next_no int;
  new_id bigint;
  body_pos int;
  css_add constant text := $q$
  /* ---- 148: international purchase order, same layout as 147 (fixed page 1, schedule from page 2).
     Boxes and signature lines are table cells so the document survives a paste into Word.
     Written in full (does not rely on the older head), so the page renders the same on any prior version. */
  @page { size: A4; margin: 12mm 12mm 14mm; }
  body { font-family: "Helvetica Neue", Arial, "Noto Sans CJK JP", "Meiryo", sans-serif; font-size: 10pt; line-height: 1.5; color: #222; margin: 0; padding: 16px; }
  h1.doc-title { font-size: 20pt; margin: 0 0 4px; letter-spacing: 4px; font-weight: 700; }
  .doc-head { text-align: center; margin-bottom: 8px; }
  .doc-sub { font-size: 9pt; color: #555; }
  hr.rule { border: none; border-top: 1px solid #333; margin: 0 0 12px; }
  table { border-collapse: collapse; }
  .party { width: 100%; margin-bottom: 12px; }
  .party td { vertical-align: top; }
  .party td + td { border-left: 1px solid #d9d9d9; }
  .party .vlabel { font-size: 8pt; font-weight: 700; color: #555; margin-bottom: 3px; letter-spacing: .06em; text-transform: uppercase; }
  .vendor-name { font-size: 13pt; font-weight: 700; border-bottom: 1px solid #333; padding-bottom: 3px; margin-bottom: 6px; }
  .muted { font-size: 9pt; color: #555; }
  p.section-mark { font-size: 10pt; font-weight: 700; letter-spacing: .04em; margin: 12px 0 5px; padding: 0 0 3px;
                   border: 0; border-bottom: 1px solid #bdbdbd; page-break-after: avoid; break-after: avoid-page; }
  p.section-mark.first { margin-top: 4px; }
  table.summary { width: 100%; margin-bottom: 12px; font-size: 10pt; }
  table.summary th { width: 30%; background: #f4f4f2; border: 1px solid #d9d9d9; padding: 7px 8px; text-align: left; color: #333; font-weight: 600; }
  table.summary td { border: 1px solid #d9d9d9; padding: 7px 8px; }
  table.summary.compact th, table.summary.compact td { padding: 5px 8px; }
  .total-amount { font-size: 13pt; font-weight: 700; }
  .amount-note { font-size: 8.5pt; color: #555; }
  table.items { width: 100%; font-size: 9pt; margin-top: 2px; table-layout: fixed; }
  table.items th { background: #f4f4f2; border: 1px solid #d9d9d9; padding: 6px 8px; color: #333; font-weight: 600; }
  table.items td { border: 1px solid #d9d9d9; padding: 6px 8px; vertical-align: top; }
  table.items th.l, table.items td.l { text-align: left; }
  .center { text-align: center; }
  .right { text-align: right; }
  .item-main td { border-bottom: none; padding: 8px 8px 4px; }
  .item-detail td { border-top: 1px dashed #d9d9d9; padding: 3px 8px 8px; font-size: 8.5pt; color: #555; }
  .item-detail ul { margin: 4px 0 0; padding-left: 16px; color: #333; line-height: 1.55; }
  .tag { display: inline-block; font-size: 7.5pt; font-weight: 700; background: #eef1f4; color: #334; border-radius: 3px; padding: 1px 5px; margin-right: 4px; }
  .incl-note { font-size: 7.5pt; color: #92400e; }
  .page-break { page-break-before: always; break-before: page; }
  table.sheet-title { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  table.sheet-title td { border: 0; border-bottom: 1px solid #333; padding: 0 0 3px; vertical-align: bottom; }
  table.sheet-title td.t { font-size: 12pt; font-weight: 700; letter-spacing: 2px; }
  table.sheet-title td.doc-sub { font-size: 8.5pt; color: #555; }
  table.box { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.box td { border: 1px solid #d9d9d9; padding: 8px 10px; font-size: 9pt; }
  table.sign2 { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 9.5pt; page-break-inside: avoid; }
  table.sign2 th { background: #f4f4f2; border: 1px solid #d9d9d9; padding: 5px 8px; text-align: left; font-weight: 600; color: #333; }
  table.sign2 td { border: 1px solid #d9d9d9; padding: 8px 10px; vertical-align: top; }
  table.sign2 p { margin: 0; }
  table.sign2 p.who { font-weight: 700; font-size: 10.5pt; margin-bottom: 2px; }
  table.sign2 p.muted { font-size: 9pt; color: #555; }
  table.sign-lines { border-collapse: collapse; width: 100%; margin-top: 6px; }
  table.sign-lines td { border: 0; padding: 0; vertical-align: bottom; }
  table.sign-lines td.lbl { width: 18mm; font-size: 8.5pt; color: #555; padding: 0 0 2px; white-space: nowrap; }
  table.sign-lines td.ul { border-bottom: 1px solid #333; height: 7.5mm; font-size: 12pt; line-height: 1; padding: 0 4px 1px; }
  table.sign-lines td.ul.date { width: 44mm; }
  table.sign-lines td.ul.name { height: 9mm; }
  table.sign-lines td.pad { width: auto; }
  table.sign-lines tr + tr td { padding-top: 5px; }
  table.sign-lines tr + tr td.ul { padding-top: 0; }
  p.accept-note { font-size: 8.5pt; color: #555; margin: 0 0 4px; line-height: 1.5; }
  p.foot-note { font-size: 8pt; color: #777; margin: 6px 0 0; }
  table.items thead { display: table-header-group; }
  table.items tr, table.box { page-break-inside: avoid; break-inside: avoid-page; }
$q$;
  new_body constant text := $q$<body data-layout="ipo-v3-2026-09r1">

<!-- ===== ヘッダ ===== -->
<div class="doc-head">
  <h1 class="doc-title">PURCHASE ORDER</h1>
  <div class="doc-sub">
    Date: {{#if 発注日}}{{formatDateEn 発注日}}{{else}}{{#if order_date}}{{formatDateEn order_date}}{{else}}{{formatDateEn (or ORDER_DATE (concat ORDER_DATE_YEAR "-" ORDER_DATE_MONTH "-" ORDER_DATE_DAY))}}{{/if}}{{/if}}
    　／　PO No.: {{ORDER_NO}}{{#if isReissue}}{{#unless (eq showReissueBanner false)}}　(supersedes {{BASE_DOC_NO}}){{/unless}}{{/if}}
  </div>
</div>
<hr class="rule">

<!-- ===== 宛先 ＋ 発注者 ===== -->
<table class="party">
  <tr>
    <td style="width:50%; padding-right:12px;">
      <div class="vlabel">To (Contractor)</div>
      <div class="vendor-name">{{VENDOR_NAME}}</div>
      {{#if VENDOR_REPRESENTATIVE_LINE}}<div style="margin-top:3px; font-size:10pt;">{{VENDOR_REPRESENTATIVE_LINE}}</div>{{/if}}
      {{#if VENDOR_CONTACT_NAME}}<div class="muted">Attn: {{VENDOR_CONTACT_NAME}}</div>{{/if}}
      {{#if VENDOR_ADDRESS}}<div class="muted">{{VENDOR_ADDRESS}}</div>{{/if}}
      {{#if INVOICE_REGISTRATION_NUMBER}}<div class="muted" style="margin-top:2px;">Tax ID / VAT No.: {{INVOICE_REGISTRATION_NUMBER}}</div>{{/if}}
      <div style="margin-top:10px; font-size:9pt;">We hereby place the following order. Please review and confirm.</div>
      {{#if PROJECT_TITLE}}<div style="margin-top:8px; font-size:10pt;">Subject: <strong>{{PROJECT_TITLE}}</strong></div>{{/if}}
    </td>
    <td style="width:50%; padding-left:12px; border-left:1px solid #cfcfcf;">
      <div class="vlabel">From (Purchaser)</div>
      <div style="font-weight:900; font-size:12pt; margin-bottom:4px;">{{PARTY_A_NAME}}</div>
      <div style="white-space:pre-wrap;">{{PARTY_A_ADDRESS}}</div>
      {{#if PARTY_A_REP}}<div style="margin-top:2px;">{{PARTY_A_REP}}</div>{{/if}}
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

<!-- ===== ORDER SUMMARY (fixed rows; details on the next page) ===== -->
<p class="section-mark">■ ORDER SUMMARY</p>
<table class="summary compact">
  <tr>
    <th>Fixed Fee Subtotal (excl. tax)</th>
    <td>
      {{#if (gt grandTotalExTax 0)}}
      <strong class="total-amount">{{currency_code}} {{formatMoney grandTotalExTax}}</strong>
      <span class="amount-note">　Taxes, if any, are handled as stated in the Payment section.</span>
      {{#if has_performance_incentive}}
      <div class="amount-note" style="margin-top:2px; color:#92400e;">The fee for this order is the fixed fee above plus the incentive fee calculated as stated in the details.</div>
      {{/if}}
      {{else}}
      {{#if has_performance_incentive}}
      <strong style="color:#92400e;">Fee: incentive-based</strong>
      <span class="amount-note">／ calculated as stated in the details</span>
      {{else}}
      <strong style="color:#92400e;">Fee: included in the license fee</strong>
      <span class="amount-note">／ calculated as stated in the details</span>
      {{/if}}
      {{/if}}
    </td>
  </tr>
  <tr>
    <th>Line Items</th>
    <td>Services {{items_count}}{{#if other_fees_count}} · Other Fees {{other_fees_count}}{{/if}}{{#if expenses_count}} · Expenses {{expenses_count}}{{/if}} (see next page)</td>
  </tr>
  <tr>
    <th>Contract Type</th>
    <td>{{#if contract_form_summary}}{{contract_form_summary}}{{else}}See details{{/if}}</td>
  </tr>
  <tr>
    <th>Delivery <span style="font-size:8pt;color:#888;font-weight:400;">(or service period)</span></th>
    <td>{{#if delivery_summary}}{{delivery_summary}}{{else}}{{#if DELIVERY_DATE}}{{formatDateEn DELIVERY_DATE}}{{else}}See details{{/if}}{{/if}}</td>
  </tr>
  <tr>
    <th>Ownership of Deliverables</th>
    <td>{{#if ownership_summary}}{{ownership_summary}}{{else}}Purchaser{{/if}}{{#if has_contractor_owned}}<span class="amount-note">　License terms for Contractor-owned items: see next page</span>{{/if}}</td>
  </tr>
  <tr>
    <th>Master Agreement</th>
    <td>{{#if HAS_BASE_CONTRACT}}Yes{{#if MASTER_CONTRACT_REF}} ({{MASTER_CONTRACT_REF}}){{/if}}{{else}}None (the attached Standard Terms apply){{/if}}</td>
  </tr>
  <tr>
    <th>Special Terms</th>
    <td>{{#if SPECIAL_TERMS}}Yes (see next page){{else}}None{{/if}}</td>
  </tr>
</table>

<!-- ===== PAYMENT ===== -->
<p class="section-mark">■ PAYMENT</p>
<table class="summary compact">
  <tr>
    <th>Payment Terms</th>
    <td>{{#if payment_terms_summary}}{{payment_terms_summary}}{{else}}{{#if PAYMENT_TERMS}}{{PAYMENT_TERMS}}{{else}}See details{{/if}}{{/if}}</td>
  </tr>
  <tr>
    <th>Payment Due</th>
    <td>{{#if payment_summary}}{{payment_summary}}{{else}}{{#if PAYMENT_DATE}}{{formatDateEn PAYMENT_DATE}}{{else}}See details{{/if}}{{/if}}</td>
  </tr>
  {{#if BANK_NAME}}
  <tr>
    <th>Bank Account</th>
    <td>Bank: {{BANK_NAME}}{{#if BRANCH_NAME}}, {{BRANCH_NAME}}{{/if}}{{#if SWIFT_CODE}}　SWIFT: {{SWIFT_CODE}}{{/if}}{{#if ACCOUNT_NUMBER}}　Account No.: {{ACCOUNT_NUMBER}}{{/if}}{{#if ACCOUNT_HOLDER_KANA}}　Beneficiary: {{ACCOUNT_HOLDER_KANA}}{{/if}}<div class="amount-note">Bank charges: the Purchaser bears remitting bank charges; the Contractor bears intermediary and receiving bank charges.</div></td>
  </tr>
  {{else}}{{#if BANK_INFO}}
  <tr>
    <th>Bank Account</th>
    <td><span style="white-space:pre-wrap;">{{BANK_INFO}}</span><div class="amount-note">Bank charges: the Purchaser bears remitting bank charges; the Contractor bears intermediary and receiving bank charges.</div></td>
  </tr>
  {{/if}}{{/if}}
  <tr>
    <th>Withholding Tax</th>
    <td>{{#if withholding_label}}{{withholding_label}}{{#if (eq withholding_label "Applicable")}} (subject to the applicable tax treaty; a certificate of residency may be requested){{/if}}{{else}}—{{/if}}</td>
  </tr>
</table>

{{#if SHOW_ORDER_SIGN_SECTION}}
<!-- ===== SIGNATURES (both parties sign) ===== -->
<p class="section-mark">■ SIGNATURES</p>
<p class="accept-note">The Purchaser and the Contractor agree to the terms of this Purchase Order and sign below. {{#if HAS_BASE_CONTRACT}}This Purchase Order is issued under the master agreement{{#if MASTER_CONTRACT_REF}} ({{MASTER_CONTRACT_REF}}){{/if}}; matters not provided for herein are governed by that agreement.{{else}}Where no master agreement is in place, the attached Standard Terms form part of this Purchase Order.{{/if}}</p>
<table class="sign2 sign-both" cellspacing="0" cellpadding="0">
  <tr>
    <th style="width:50%;">Purchaser</th>
    <th style="width:50%;">Contractor</th>
  </tr>
  <tr>
    <td style="height:30mm;">
      <p class="who">{{PARTY_A_NAME}}</p>
      <p class="muted">{{PARTY_A_ADDRESS}}</p>
      {{#if PARTY_A_REP}}<p class="muted">{{PARTY_A_REP}}</p>{{/if}}
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">Date</td><td class="ul date"></td><td class="pad"></td></tr>
        <tr><td class="lbl">Signature</td><td class="ul name" colspan="2"></td></tr>
      </table>
    </td>
    <td style="height:30mm;">
      <p class="who">{{VENDOR_NAME}}</p>
      {{#if VENDOR_ADDRESS}}<p class="muted">{{VENDOR_ADDRESS}}</p>{{/if}}
      {{#if (eq VENDOR_IS_CORPORATION "法人")}}{{#if VENDOR_REPRESENTATIVE_LINE}}<p class="muted">{{VENDOR_REPRESENTATIVE_LINE}}</p>{{/if}}{{#if VENDOR_CONTACT_NAME}}<p class="muted">Attn: {{VENDOR_CONTACT_NAME}}</p>{{/if}}{{/if}}
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">Date</td><td class="ul date"></td><td class="pad"></td></tr>
        <tr><td class="lbl">Signature</td><td class="ul name" colspan="2"></td></tr>
      </table>
    </td>
  </tr>
</table>
{{else}}{{#if (or ACCEPT_METHOD SHOW_SIGN_SECTION)}}
<!-- ===== ACCEPTANCE (the Contractor alone signs) ===== -->
<p class="section-mark">■ ACCEPTANCE</p>
<p class="accept-note">{{#if ACCEPT_METHOD}}{{ACCEPT_METHOD}}{{else}}Please confirm your acceptance of this Purchase Order by dating and signing below and returning a copy to the Purchaser.{{/if}}{{#if ACCEPT_REPLY_DUE_DATE}} Please reply by {{formatDateEn ACCEPT_REPLY_DUE_DATE}}.{{/if}}{{#if ACCEPT_BY_PERFORMANCE}} If the Contractor commences the work under this Purchase Order, such commencement shall be deemed acceptance of this Purchase Order.{{/if}}{{#if HAS_BASE_CONTRACT}} This Purchase Order is issued under the master agreement{{#if MASTER_CONTRACT_REF}} ({{MASTER_CONTRACT_REF}}){{/if}}; matters not provided for herein are governed by that agreement.{{else}} Where no master agreement is in place, the attached Standard Terms form part of this Purchase Order, and acceptance of this Purchase Order constitutes acceptance of those terms.{{/if}}</p>
{{#if SHOW_SIGN_SECTION}}
<table class="sign2 sign-accept" cellspacing="0" cellpadding="0">
  <tr>
    <th style="width:40%;">Contractor</th>
    <th>Date &amp; Signature</th>
  </tr>
  <tr>
    <td style="height:26mm;">
      <p class="who">{{VENDOR_NAME}}</p>
      {{#if VENDOR_ADDRESS}}<p class="muted">{{VENDOR_ADDRESS}}</p>{{/if}}
      {{#if (eq VENDOR_IS_CORPORATION "法人")}}{{#if VENDOR_CONTACT_NAME}}<p class="muted" style="margin-top:6px;">Attn: {{VENDOR_CONTACT_NAME}}</p>{{/if}}{{/if}}
    </td>
    <td style="height:26mm;">
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">Date</td><td class="ul date">{{#if VENDOR_ACCEPT_DATE}}{{formatDateEn VENDOR_ACCEPT_DATE}}{{/if}}</td><td class="pad"></td></tr>
        <tr><td class="lbl">Signature</td><td class="ul name" colspan="2">{{#if VENDOR_ACCEPT_NAME}}<span style="font-size:9pt;color:#555;">{{VENDOR_ACCEPT_NAME}}</span>{{/if}}</td></tr>
      </table>
      <p class="muted" style="margin-top:3px; font-size:8pt;">{{#if (eq VENDOR_IS_CORPORATION "法人")}}Signed by an authorized signatory or the contact person of the Contractor{{else}}Signed by the Contractor{{/if}}</p>
    </td>
  </tr>
</table>
{{/if}}
{{/if}}{{/if}}
<p class="foot-note">Line items{{#if SPECIAL_TERMS}}, special terms{{/if}} and notices follow on the next page.{{#unless HAS_BASE_CONTRACT}} As no master agreement is in place, the Standard Terms are attached at the end.{{/unless}}</p>

<!-- ===== Page 2: schedule ===== -->
<p class="page-break" style="page-break-before:always; margin:0; height:0;"></p>
<table class="sheet-title" cellspacing="0" cellpadding="0">
  <tr>
    <td class="t">PURCHASE ORDER — SCHEDULE</td>
    <td class="doc-sub" style="text-align:right;">PO No.: {{ORDER_NO}}{{#if PROJECT_TITLE}}　／　Subject: {{PROJECT_TITLE}}{{/if}}</td>
  </tr>
</table>

<p class="section-mark first">■ LINE ITEMS</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:5%;">No</th>
      <th class="l" style="width:47%;">Item / Deliverable</th>
      <th class="center" style="width:10%;">Qty</th>
      <th class="right" style="width:18%;">Unit Price</th>
      <th class="right" style="width:20%;">Amount (excl. tax)</th>
    </tr>
  </thead>
  <tbody>
    {{#if items}}
    {{#each items}}
    <tr class="item-main">
      <td class="center">{{or line_no (index1 @index)}}</td>
      <td class="l">
        {{#if category}}<span class="tag">{{category}}</span>{{/if}}
        <strong style="font-size:10pt;">{{item_name}}</strong>
      </td>
      <td class="right">{{or quantity qty}}</td>
      <td class="right">{{#if (eq calc_method "ROYALTY")}}{{#if (gt (or amount_ex_tax amount) 0)}}{{formatMoney (or unit_price unitPrice)}}{{else}}<span style="color:#888;">-</span>{{/if}}{{else}}{{formatMoney (or unit_price unitPrice)}}{{/if}}</td>
      <td class="right">{{#if (eq calc_method "ROYALTY")}}{{#if (gt (or amount_ex_tax amount) 0)}}<strong>{{formatMoney (or amount_ex_tax amount)}}</strong><div class="incl-note">{{or reward_label "Fee"}} ({{#if (eq deliverable_ownership "受注者")}}license fee{{else}}incentive fee{{/if}} separately)</div>{{else}}<div class="incl-note">Fee included in the<br>{{#if (eq deliverable_ownership "受注者")}}license fee{{else}}incentive fee{{/if}}</div>{{/if}}{{else}}<strong>{{formatMoney (or amount_ex_tax amount)}}</strong>{{/if}}</td>
    </tr>
    <tr class="item-detail">
      <td></td>
      <td colspan="4">
        {{#if payment_terms}}Contract type: {{payment_terms}}　／　{{/if}}Ownership: {{#if (eq deliverable_ownership "受注者")}}Contractor (licensed to the Purchaser){{else}}Purchaser (assignment){{/if}}
        　／　Payment: {{#if (eq calc_method "SUBSCRIPTION")}}recurring{{else}}{{#if (eq calc_method "ROYALTY")}}{{#if (eq deliverable_ownership "受注者")}}license fee{{else}}incentive fee{{/if}}{{else}}fixed fee{{/if}}{{/if}}
        　／　{{#if (eq calc_method "SUBSCRIPTION")}}Service period{{else}}Delivery{{/if}}: {{#if (eq calc_method "SUBSCRIPTION")}}{{#if term_start}}{{formatDateCompact term_start}}{{else}}—{{/if}} – {{#if term_end}}{{formatDateCompact term_end}}{{else}}ongoing{{/if}}{{else}}{{formatDateEn delivery_date}}{{/if}}
        　／　Payment date: {{#if (eq calc_method "SUBSCRIPTION")}}{{or (billingDayLabelEn billing_day cycle billing_timing) "not set"}}{{else}}{{#if (eq calc_method "ROYALTY")}}{{#unless (gt (or amount_ex_tax amount) 0)}}{{#if (eq deliverable_ownership "受注者")}}per royalty statement{{else}}per incentive fee calculation{{/if}}{{else}}{{formatDateEn payment_date}}{{/unless}}{{else}}{{formatDateEn payment_date}}{{/if}}{{/if}}
        {{#if (or spec detailText)}}
        <ul>
          {{#if spec}}<li style="white-space:pre-line;">{{spec}}</li>{{/if}}
          {{#if detailText}}<li>{{detailText}}</li>{{/if}}
        </ul>
        {{/if}}
        {{#if payment_schedule}}
        <div style="margin-top:4px; font-weight:700;">Payment schedule</div>
        <table style="width:100%; border-collapse:collapse; font-size:8.5pt;">
          <tr><th class="l" style="width:8%;">#</th><th class="l">Scheduled date</th><th class="right" style="width:30%;">Amount</th></tr>
          {{#each payment_schedule}}
          <tr>
            <td class="center">{{index1 @index}}</td>
            <td>{{date}}</td>
            <td class="right">{{#if amount}}{{formatMoney amount}}{{/if}}</td>
          </tr>
          {{/each}}
        </table>
        {{/if}}
      </td>
    </tr>
    {{/each}}
    {{else}}
    <tr class="item-main">
      <td class="center">1</td>
      <td class="l"><strong style="font-size:10pt;">{{ITEM_NAME}}</strong></td>
      <td class="right">1</td>
      <td class="right">-</td>
      <td class="right"><strong>{{currency_code}} {{formatMoney grandTotalExTax}}</strong></td>
    </tr>
    <tr class="item-detail">
      <td></td>
      <td colspan="4">
        {{#if PAYMENT_TERMS}}Contract type: {{PAYMENT_TERMS}}　／　{{/if}}Payment: {{#if (eq CALC_METHOD "SUBSCRIPTION")}}recurring{{else}}{{#if (eq CALC_METHOD "ROYALTY")}}license fee{{else}}fixed fee{{/if}}{{/if}}
        　／　Delivery: {{formatDateEn DELIVERY_DATE}}
        　／　Payment date: {{summaryPaymentTerms}}
      </td>
    </tr>
    {{/if}}
    <tr>
      <td colspan="4" class="right"><strong>Fixed Fee Subtotal (excl. tax)</strong></td>
      <td class="right">{{#if (gt (or itemsSubtotalExTax grandTotalExTax) 0)}}<strong>{{currency_code}} {{formatMoney (or itemsSubtotalExTax grandTotalExTax)}}</strong>{{else}}<span style="color:#888;">—</span>{{/if}}</td>
    </tr>
  </tbody>
</table>

<!-- ===== OTHER FEES ===== -->
{{#if other_fees}}
{{#if (gt (length other_fees) 0)}}
<p class="section-mark">■ OTHER FEES (excl. tax, added to the total)</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:6mm;">No</th>
      <th class="l">Description</th>
      <th class="right" style="width:30mm;">Amount (excl. tax)</th>
      <th class="l">Remarks</th>
    </tr>
  </thead>
  <tbody>
    {{#each other_fees}}
    <tr>
      <td class="center">{{or line_no (index1 @index)}}</td>
      <td class="l"><strong>{{fee_name}}</strong></td>
      <td class="right">{{formatMoney amount}}</td>
      <td class="l">{{remarks}}</td>
    </tr>
    {{/each}}
    <tr>
      <td colspan="2" class="right"><strong>Other Fees Subtotal (excl. tax)</strong></td>
      <td class="right"><strong>{{currency_code}} {{formatMoney otherFeesTotal}}</strong></td>
      <td></td>
    </tr>
  </tbody>
</table>
<table class="summary compact" style="margin-top:6px;">
  <tr>
    <th style="width:40%;">Order Total (excl. tax: services + other fees)</th>
    <td>
      <strong class="total-amount">{{currency_code}} {{formatMoney grandTotalExTax}}</strong>
      <span class="amount-note">　Services {{currency_code}} {{formatMoney (or itemsSubtotalExTax grandTotalExTax)}} + Other Fees {{currency_code}} {{formatMoney otherFeesTotal}}</span>
    </td>
  </tr>
</table>
{{/if}}
{{/if}}

<!-- ===== EXPENSES ===== -->
{{#if expenses}}
{{#if (gt (length expenses) 0)}}
<p class="section-mark">■ EXPENSES (reimbursed at actual cost)</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:6mm;">No</th>
      <th class="l">Description</th>
      <th class="center" style="width:28mm;">Date</th>
      <th class="right" style="width:26mm;">Amount</th>
      <th class="l">Remarks</th>
    </tr>
  </thead>
  <tbody>
    {{#each expenses}}
    <tr>
      <td class="center">{{or line_no (index1 @index)}}</td>
      <td class="l"><strong>{{expense_name}}</strong>{{#if spec}}<div style="font-size:8pt;color:#666;">{{spec}}</div>{{/if}}</td>
      <td class="center">{{formatDateEn spent_date}}</td>
      <td class="right">{{formatMoney amount_inc_tax}}</td>
      <td class="l">{{remarks}}</td>
    </tr>
    {{/each}}
    <tr>
      <td colspan="3" class="right"><strong>Expenses Total</strong></td>
      <td class="right"><strong>{{currency_code}} {{formatMoney expensesTotalIncTax}}</strong></td>
      <td></td>
    </tr>
  </tbody>
</table>
<p style="margin-top:4px; font-size:8.5pt; color:#555;">Expenses are reimbursed at actual cost. Please attach the original receipts (or copies) for each item listed above.</p>
{{/if}}
{{/if}}

<!-- ===== LICENSE TERMS (items whose rights remain with the Contractor) ===== -->
{{#if has_contractor_owned}}
<p class="section-mark">■ LICENSE TERMS (items whose rights remain with the Contractor)</p>
<p style="margin:0 0 4px; font-size:8.5pt; color:#555;">For items marked “Ownership: Contractor”, the Contractor retains the rights in the deliverable and grants the Purchaser a license on the terms below.</p>
{{#if license_terms_missing}}
<table class="box" cellspacing="0" cellpadding="0"><tr><td>License terms to be agreed separately.</td></tr></table>
{{else}}
<table class="items">
  <thead>
    <tr>
      <th class="l" style="width:22%;">Usage</th>
      <th class="l" style="width:22%;">Rate / Fee</th>
      <th class="l" style="width:14%;">MG / AG</th>
      <th class="l" style="width:20%;">Term</th>
      <th class="l" style="width:22%;">Territory / Language</th>
    </tr>
  </thead>
  <tbody>
    {{#each license_terms}}
    <tr>
      <td class="l">{{usage}}{{#if condition_no}}<div style="font-size:7.5pt;color:#666;">{{condition_no}}</div>{{/if}}</td>
      <td class="l">{{fee}}</td>
      <td class="l">{{guarantee}}</td>
      <td class="l">{{term}}</td>
      <td class="l">{{scope}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>
<p style="margin-top:4px; font-size:8.5pt; color:#555;">Rate-based license fees are not included in the Fixed Fee Subtotal and are calculated and paid separately under a royalty statement.</p>
{{/if}}
{{/if}}

<!-- ===== SPECIAL TERMS ===== -->
{{#if SPECIAL_TERMS}}
<p class="section-mark">■ SPECIAL TERMS</p>
<table class="box" cellspacing="0" cellpadding="0"><tr><td style="white-space:pre-wrap;">{{SPECIAL_TERMS}}</td></tr></table>
{{/if}}

<!-- ===== REMARKS ===== -->
{{#if REMARKS}}
<p class="section-mark">■ REMARKS</p>
<table class="box" cellspacing="0" cellpadding="0"><tr><td>
  {{#if REMARKS_FIXED}}<p style="white-space:pre-wrap; margin:0;">{{REMARKS_FIXED}}</p>{{/if}}
  {{#if REMARKS_FREE}}<p style="white-space:pre-wrap; margin:{{#if REMARKS_FIXED}}8px{{else}}0{{/if}} 0 0;">{{REMARKS_FREE}}</p>{{/if}}
  {{#unless (or REMARKS_FIXED REMARKS_FREE)}}<p style="white-space:pre-wrap; margin:0;">{{REMARKS}}</p>{{/unless}}
</td></tr></table>
{{/if}}

<!-- ===== NOTICES ===== -->
<p class="section-mark">■ NOTICES</p>
<table class="summary compact">
  <tr>
    <th>To the Contractor</th>
    <td>{{#if VENDOR_CONTACT_NAME}}Attn: {{VENDOR_CONTACT_NAME}}{{else}}{{VENDOR_NAME}}{{/if}}{{#if VENDOR_CONTACT_PHONE}}　／　Tel: {{VENDOR_CONTACT_PHONE}}{{/if}}{{#if VENDOR_EMAIL}}　／　E-mail: {{VENDOR_EMAIL}}{{/if}}</td>
  </tr>
  <tr>
    <th>To the Purchaser</th>
    <td>{{#if STAFF_NAME}}Attn: {{STAFF_NAME}}{{else}}{{PARTY_A_NAME}}{{/if}}{{#if STAFF_PHONE}}　／　Tel: {{STAFF_PHONE}}{{/if}}{{#if STAFF_EMAIL}}　／　E-mail: {{STAFF_EMAIL}}{{/if}}</td>
  </tr>
</table>
<p style="font-size:9pt; color:#555;">Notices and other communications concerning this Purchase Order shall be sent to the contacts above. Where a master agreement exists, its notice clause prevails.</p>

{{!-- Standard Terms (partial) are attached at the end where no master agreement exists. The partial name is taken from the previous version by the 148 SQL. --}}
__TERMS_BLOCK__
</body>$q$;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, 'data-layout="ipo-v3-2026-09r1"') > 0 THEN
    RAISE NOTICE '148: 適用済み（本文に data-layout="ipo-v3-2026-09r1" がある）。何もしません';
    RETURN;
  END IF;
  -- 同じレイアウトの古い改訂が入っていれば、148 より前の版（元の head/CSS を
  -- 持つ版）を下敷きにして置き換える。手で前の版に戻す必要はない。
  IF strpos(src, 'data-layout="ipo-v3') > 0 THEN
    SELECT v.id, v.version_no, v.html_source INTO base_version, base_no, src
      FROM v3.document_template_versions v
     WHERE v.template_id = tpl_id AND strpos(v.html_source, 'data-layout="ipo-v3') = 0
     ORDER BY v.version_no DESC LIMIT 1;
    IF src IS NULL THEN
      RAISE EXCEPTION '148 より前の版が見つかりません（146 で書き出した本文から作り直してください）';
    END IF;
    RAISE NOTICE '148: 古い改訂（版 %）を置き換える。head は版 % から', from_no, base_no;
  END IF;
  body_pos := strpos(src, '<body');
  IF body_pos = 0 THEN
    RAISE EXCEPTION '<body が見つかりません。146 で現行版を書き出して確かめてください';
  END IF;
  head := left(src, body_pos - 1);
  IF (length(head) - length(replace(head, '</style>', ''))) / length('</style>') <> 1 THEN
    RAISE EXCEPTION '</style> が <head> に 1 箇所ではありません。146 で現行版を確かめてください';
  END IF;
  body_text := new_body;
  -- 約款の partial 名は現行版から拾う（{{> 名前}}）。無ければ約款は付けない。
  terms_partial := substring(src from '\{\{>\s*([A-Za-z0-9_]+)\s*\}\}');
  IF terms_partial IS NULL THEN
    RAISE NOTICE '148: 現行版に約款の partial（{{> …}}）が無いので、約款は付けません';
    body_text := replace(body_text, '__TERMS_BLOCK__', '');
  ELSE
    body_text := replace(body_text, '__TERMS_BLOCK__',
      E'{{#unless HAS_BASE_CONTRACT}}\n{{> ' || terms_partial || E'}}\n{{/unless}}');
  END IF;
  new_html := replace(head, '</style>', css_add || E'\n</style>') || body_text || E'\n</html>\n';

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('148: 1 ページ目固定・明細は 2 ページ目から・署名式・利用許諾条件（%s 版の項目を引き継ぎ）', from_no),
         'sql:148'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '148: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に目印があり、承諾欄・署名欄・利用許諾条件・改ページが揃っていること
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, 'data-layout="ipo-v3-2026-09r1"') > 0) AS 新レイアウト,
       (strpos(v.html_source, 'class="page-break"') > 0) AS 改ページ,
       (strpos(v.html_source, '■ ACCEPTANCE') > 0) AS acceptance,
       (strpos(v.html_source, 'sign-both') > 0) AS signatures,
       (strpos(v.html_source, '■ LICENSE TERMS') > 0) AS license_terms,
       (strpos(v.html_source, '{{> ') > 0) AS terms_partial,
       (strpos(v.html_source, 'class="sign-box"') = 0) AS 押印欄なし,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';
