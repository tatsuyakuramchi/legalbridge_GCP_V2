-- =====================================================================
-- 発注書のひな形：1 ページ目を固定し、明細は 2 ページ目から（署名式・利用許諾条件つき）
--
--   これまでの発注書は明細の行数で承諾欄が 2 ページ目へ流れ、紙ごとに署名の
--   位置が変わっていた。1 ページ目を「宛先・発注概要・支払情報・受領確認
--   （承諾）」の行数が決まった表だけで組み、業務明細・手数料・経費・利用
--   許諾条件・特約・通知先は強制改ページの後（2 ページ目以降）に置く。
--
--   ・受領確認（承諾）：受注者の欄（名前・住所・法人で担当者の登録があるとき
--     だけ担当）と、承諾日（12pt が入る下線）・署名の欄。押印欄は無い（署名式）。
--   ・発注署名欄＝あり（SHOW_ORDER_SIGN_SECTION）のときは、同じ場所に
--     発注者・受注者の署名欄（署名日・署名）を出す（甲・乙の表記は使わない）。
--   ・Word に貼っても枠が再現できるよう、箱と署名の下線は表（セルの罫線）で組む。
--   ・成果物の帰属先が受注者の品目があれば「■ 利用許諾条件」の表（利用形態／
--     料率・額／MG・AG／期間／地域・言語）を出す。台帳に無ければ
--     「利用許諾の条件は別途定める」と 1 行で出す。値はアプリが
--     license_terms（A-048）として差す。
--
--   やり方は 120・137 と同じ。現行版の <head>（CSS）を残して </style> の前に
--   CSS を足し、<body>…</body> を丸ごと置き換えた新しい版を作って
--   current_version_id を差し替える。項目の宣言（variables）は現行版のまま。
--   適用済み（本文に data-layout="po-v3-2026-09" がある）なら何もしない。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/147_po_layout_v3.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'purchase_order';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
--   元の本文と CSS: infra/v3/templates/purchase_order_v3_body.html / _css.txt
--   （このファイルは infra/v3/tools/make-po-layout-sql.mjs が組み立てる）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  head text;
  new_html text;
  tpl_id bigint;
  from_version bigint;
  from_no int;
  next_no int;
  new_id bigint;
  body_pos int;
  css_add constant text := $q$
  /* ---- 147: 1 ページ目固定レイアウト（概要・支払情報・承諾欄）と 2 ページ目からの明細 ----
     Word に貼っても枠が再現できるよう、箱と署名の下線は表（セルの罫線）で組む。
     flex・grid・div の枠線は使わない。見た目はシンプルに：細い灰の罫線、薄い灰の見出しセル。 */
  @page { size: A4; margin: 12mm 12mm 14mm; }
  body { color: #222; }
  hr.rule { border-top: 1px solid #333; margin: 0 0 12px; }
  .vendor-name { border-bottom: 1px solid #333; }
  .party td + td { border-left: 1px solid #d9d9d9; }
  p.section-mark { font-size: 10pt; font-weight: 700; letter-spacing: .04em; margin: 12px 0 5px; padding: 0 0 3px;
                   border: 0; border-bottom: 1px solid #bdbdbd; page-break-after: avoid; break-after: avoid-page; }
  p.section-mark.first { margin-top: 4px; }
  table.summary th, table.items th { background: #f4f4f2; border: 1px solid #d9d9d9; color: #333; font-weight: 600; }
  table.summary td, table.items td { border: 1px solid #d9d9d9; }
  table.summary.compact th, table.summary.compact td { padding: 5px 8px; }
  table.items { margin-top: 2px; }
  .item-detail td { border-top: 1px dashed #d9d9d9; }
  .total-amount { font-size: 13pt; font-weight: 700; }
  .tag { background: #eef1f4; color: #334; }
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
  table.sign-lines td.lbl { width: 14mm; font-size: 8.5pt; color: #555; padding: 0 0 2px; white-space: nowrap; }
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
  new_body constant text := $q$<body data-layout="po-v3-2026-09">

<!-- ===== ヘッダ ===== -->
<div class="doc-head">
  <h1 class="doc-title">発注書</h1>
  <div class="doc-sub">
    発注日: {{#if 発注日}}{{formatDate 発注日}}{{else}}{{#if order_date}}{{formatDate order_date}}{{else}}{{formatDate (or ORDER_DATE (concat ORDER_DATE_YEAR "-" ORDER_DATE_MONTH "-" ORDER_DATE_DAY))}}{{/if}}{{/if}}
    　／　書類番号: {{ORDER_NO}}{{#if isReissue}}{{#unless (eq showReissueBanner false)}}　（元: {{BASE_DOC_NO}}）{{/unless}}{{/if}}
  </div>
</div>
<hr class="rule">

<!-- ===== 宛先 ＋ 発注者 ===== -->
<table class="party">
  <tr>
    <td style="width:50%; padding-right:12px;">
      <div class="vlabel">発注先（受注者）</div>
      <div class="vendor-name">{{VENDOR_NAME}}{{#if VENDOR_SUFFIX}}　{{VENDOR_SUFFIX}}{{else}}　御中{{/if}}</div>
      {{#if VENDOR_REPRESENTATIVE_SAMA}}<div style="margin-top:3px; font-size:10pt;">{{VENDOR_REPRESENTATIVE_SAMA}}</div>{{/if}}
      {{#if VENDOR_ADDRESS}}<div class="muted">{{VENDOR_ADDRESS}}</div>{{/if}}
      {{#if INVOICE_REGISTRATION_NUMBER}}<div class="muted" style="margin-top:2px;">登録番号: {{INVOICE_REGISTRATION_NUMBER}}</div>{{/if}}
      <div style="margin-top:10px; font-size:9pt;">下記内容にて発注いたします。ご確認をお願いいたします。</div>
      {{#if PROJECT_TITLE}}<div style="margin-top:8px; font-size:10pt;">件名: <strong>{{PROJECT_TITLE}}</strong></div>{{/if}}
    </td>
    <td style="width:50%; padding-left:12px; border-left:1px solid #cfcfcf;">
      <div class="vlabel">発注者</div>
      <div style="font-weight:900; font-size:12pt; margin-bottom:4px;">{{PARTY_A_NAME}}</div>
      <div style="white-space:pre-wrap;">{{PARTY_A_ADDRESS}}</div>
      {{#if PARTY_A_REP}}<div style="margin-top:2px;">{{PARTY_A_REP}}</div>{{/if}}
      {{#if STAFF_NAME}}
      <div style="margin-top:8px; padding-top:6px; border-top:1px solid #cfcfcf; font-size:9pt;">
        {{#if STAFF_DEPARTMENT}}<strong>部署:</strong> {{STAFF_DEPARTMENT}}<br>{{/if}}
        <strong>担当:</strong> {{STAFF_NAME}}<br>
        {{#if STAFF_PHONE}}TEL: {{STAFF_PHONE}}<br>{{/if}}
        {{#if STAFF_EMAIL}}E-mail: {{STAFF_EMAIL}}{{/if}}
      </div>
      {{/if}}
    </td>
  </tr>
</table>

<!-- ===== 発注概要（行数固定。明細は次ページ） ===== -->
<p class="section-mark">■ 発注概要</p>
<table class="summary compact">
  <tr>
    <th>確定額 小計（税抜）</th>
    <td>
      {{#if (gt grandTotalExTax 0)}}
      <strong class="total-amount">¥ {{formatCurrency grandTotalExTax}}</strong>
      <span class="amount-note">　※ 消費税等の精算は、支払通知または請求処理にて行います。</span>
      {{#if has_performance_incentive}}
      <div class="amount-note" style="margin-top:2px; color:#92400e;">※ 本件業務の報酬は、上記確定額のほかインセンティブ報酬が加算された額とします。計算方法は明細のとおり。</div>
      {{/if}}
      {{else}}
      {{#if has_performance_incentive}}
      <strong style="color:#92400e;">報酬はインセンティブ報酬による</strong>
      <span class="amount-note">／ 計算方法は明細のとおり</span>
      {{else}}
      <strong style="color:#92400e;">報酬は利用許諾料に含む</strong>
      <span class="amount-note">／ 算定方法は明細記載の計算方法のとおり</span>
      {{/if}}
      {{/if}}
    </td>
  </tr>
  <tr>
    <th>明細</th>
    <td>業務 {{items_count}} 件{{#if other_fees_count}}・その他手数料 {{other_fees_count}} 件{{/if}}{{#if expenses_count}}・経費 {{expenses_count}} 件{{/if}}（次ページ）</td>
  </tr>
  <tr>
    <th>契約種別</th>
    <td>{{#if contract_form_summary}}{{contract_form_summary}}{{else}}明細のとおり{{/if}}</td>
  </tr>
  <tr>
    <th>納期 <span style="font-size:8pt;color:#888;font-weight:400;">(または役務提供期間)</span></th>
    <td>{{#if delivery_summary}}{{delivery_summary}}{{else}}{{#if DELIVERY_DATE}}{{formatDate DELIVERY_DATE}}{{else}}明細のとおり{{/if}}{{/if}}</td>
  </tr>
  <tr>
    <th>成果物の帰属先</th>
    <td>{{#if ownership_summary}}{{ownership_summary}}{{else}}{{#if deliverable_ownership}}{{deliverable_ownership}}{{else}}発注者{{/if}}{{/if}}{{#if has_contractor_owned}}<span class="amount-note">　※ 受注者に留保する成果物の利用許諾条件は次ページ</span>{{/if}}</td>
  </tr>
  <tr>
    <th>基本契約</th>
    <td>{{#if HAS_BASE_CONTRACT}}あり{{#if MASTER_CONTRACT_REF}}（{{MASTER_CONTRACT_REF}}）{{/if}}{{else}}なし（別紙の標準約款による）{{/if}}</td>
  </tr>
  <tr>
    <th>特約</th>
    <td>{{#if SPECIAL_TERMS}}あり（次ページ）{{else}}なし{{/if}}</td>
  </tr>
</table>

<!-- ===== 支払情報 ===== -->
<p class="section-mark">■ 支払情報</p>
<table class="summary compact">
  <tr>
    <th>支払条件</th>
    <td>{{#if payment_terms_summary}}{{payment_terms_summary}}{{else}}{{#if PAYMENT_TERMS}}{{PAYMENT_TERMS}}{{else}}明細のとおり{{/if}}{{/if}}</td>
  </tr>
  <tr>
    <th>支払期日</th>
    <td>{{#if payment_summary}}{{payment_summary}}{{else}}{{#if PAYMENT_DATE}}{{formatDate PAYMENT_DATE}}{{else}}明細のとおり{{/if}}{{/if}}</td>
  </tr>
  {{#if BANK_NAME}}
  <tr>
    <th>振込先</th>
    <td>{{BANK_NAME}} {{BRANCH_NAME}}　{{ACCOUNT_TYPE}} {{ACCOUNT_NUMBER}}　名義: {{ACCOUNT_HOLDER_KANA}}{{#if TRANSFER_FEE_PAYER}}<div class="amount-note">※ 振込手数料: {{TRANSFER_FEE_PAYER}}負担</div>{{/if}}</td>
  </tr>
  {{else}}{{#if BANK_INFO}}
  <tr>
    <th>振込先</th>
    <td><span style="white-space:pre-wrap;">{{BANK_INFO}}</span>{{#if TRANSFER_FEE_PAYER}}<div class="amount-note">※ 振込手数料: {{TRANSFER_FEE_PAYER}}負担</div>{{/if}}</td>
  </tr>
  {{/if}}{{/if}}
  <tr>
    <th>登録番号（受注者）</th>
    <td>{{#if INVOICE_REGISTRATION_NUMBER}}{{INVOICE_REGISTRATION_NUMBER}}{{else}}—{{/if}}</td>
  </tr>
  <tr>
    <th>源泉徴収</th>
    <td>{{#if WITHHOLDING_TAX}}{{WITHHOLDING_TAX}}{{else}}—{{/if}}</td>
  </tr>
</table>

{{#if SHOW_ORDER_SIGN_SECTION}}
<!-- ===== 署名欄（発注者・受注者の両方が署名するとき） ===== -->
<p class="section-mark">■ 署名欄</p>
<p class="accept-note">発注者および受注者は、本発注書の内容に合意し、下記に署名する。{{#if HAS_BASE_CONTRACT}}本発注書は基本契約{{#if MASTER_CONTRACT_REF}}（{{MASTER_CONTRACT_REF}}）{{/if}}に基づき発行され、定めのない事項は当該基本契約の定めによる。{{else}}本発注書には別紙「業務委託基本契約約款（スポット契約用・2026年改正法対応版）」が適用される。{{/if}}</p>
<table class="sign2 sign-both" cellspacing="0" cellpadding="0">
  <tr>
    <th style="width:50%;">発注者</th>
    <th style="width:50%;">受注者</th>
  </tr>
  <tr>
    <td style="height:30mm;">
      <p class="who">{{PARTY_A_NAME}}</p>
      <p class="muted">{{PARTY_A_ADDRESS}}</p>
      {{#if PARTY_A_REP}}<p class="muted">{{PARTY_A_REP}}</p>{{/if}}
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">署名日</td><td class="ul date"></td><td class="pad"></td></tr>
        <tr><td class="lbl">署名</td><td class="ul name" colspan="2"></td></tr>
      </table>
    </td>
    <td style="height:30mm;">
      <p class="who">{{VENDOR_NAME}}</p>
      {{#if VENDOR_ADDRESS}}<p class="muted">{{VENDOR_ADDRESS}}</p>{{/if}}
      {{#if (eq VENDOR_IS_CORPORATION "法人")}}{{#if VENDOR_REPRESENTATIVE_LINE}}<p class="muted">{{VENDOR_REPRESENTATIVE_LINE}}</p>{{/if}}{{#if VENDOR_CONTACT_NAME}}<p class="muted">担当: {{VENDOR_CONTACT_NAME}}</p>{{/if}}{{/if}}
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">署名日</td><td class="ul date"></td><td class="pad"></td></tr>
        <tr><td class="lbl">署名</td><td class="ul name" colspan="2"></td></tr>
      </table>
    </td>
  </tr>
</table>
{{else}}{{#if (or ACCEPT_METHOD SHOW_SIGN_SECTION)}}
<!-- ===== 受領確認（承諾）：受注者だけが署名する ===== -->
<p class="section-mark">■ 受領確認（承諾）</p>
<p class="accept-note">{{#if ACCEPT_METHOD}}{{ACCEPT_METHOD}}{{else}}本発注書の内容を確認のうえ、下記に承諾日と署名を記入してご返送ください。{{/if}}{{#if ACCEPT_REPLY_DUE_DATE}}　返信期限: {{formatDate ACCEPT_REPLY_DUE_DATE}}。{{/if}}{{#if ACCEPT_BY_PERFORMANCE}}　なお、受注者が本発注に基づく業務へ着手した場合、その時点で本発注内容に承諾したものとして取り扱うことがあります。{{/if}}{{#if HAS_BASE_CONTRACT}}　本発注書は基本契約{{#if MASTER_CONTRACT_REF}}（{{MASTER_CONTRACT_REF}}）{{/if}}に基づき発行され、定めのない事項は当該基本契約の定めによります。{{else}}　本発注書には別紙「業務委託基本契約約款（スポット契約用・2026年改正法対応版）」が適用され、受注者は本発注書を承諾することにより当該約款にも同意したものとみなします。{{/if}}</p>
{{#if SHOW_SIGN_SECTION}}
<table class="sign2 sign-accept" cellspacing="0" cellpadding="0">
  <tr>
    <th style="width:40%;">受注者</th>
    <th>承諾日・署名</th>
  </tr>
  <tr>
    <td style="height:26mm;">
      <p class="who">{{VENDOR_NAME}}</p>
      {{#if VENDOR_ADDRESS}}<p class="muted">{{VENDOR_ADDRESS}}</p>{{/if}}
      {{#if (eq VENDOR_IS_CORPORATION "法人")}}{{#if VENDOR_CONTACT_NAME}}<p class="muted" style="margin-top:6px;">担当: {{VENDOR_CONTACT_NAME}}</p>{{/if}}{{/if}}
    </td>
    <td style="height:26mm;">
      <table class="sign-lines" cellspacing="0" cellpadding="0">
        <tr><td class="lbl">承諾日</td><td class="ul date">{{#if VENDOR_ACCEPT_DATE}}{{formatDate VENDOR_ACCEPT_DATE}}{{/if}}</td><td class="pad"></td></tr>
        <tr><td class="lbl">署名</td><td class="ul name" colspan="2">{{#if VENDOR_ACCEPT_NAME}}<span style="font-size:9pt;color:#555;">{{VENDOR_ACCEPT_NAME}}</span>{{/if}}</td></tr>
      </table>
      <p class="muted" style="margin-top:3px; font-size:8pt;">{{#if (eq VENDOR_IS_CORPORATION "法人")}}受注者の権限ある代表者または担当者が署名{{else}}受注者本人が署名{{/if}}</p>
    </td>
  </tr>
</table>
{{/if}}
{{/if}}{{/if}}
<p class="foot-note">※ 業務明細{{#if SPECIAL_TERMS}}・特約{{/if}}・通知先は次ページ。{{#unless HAS_BASE_CONTRACT}}基本契約がないため、標準約款を別紙として末尾に添付。{{/unless}}</p>

<!-- ===== 2 ページ目：明細 ===== -->
<p class="page-break" style="page-break-before:always; margin:0; height:0;"></p>
<table class="sheet-title" cellspacing="0" cellpadding="0">
  <tr>
    <td class="t">発注書　別紙（明細）</td>
    <td class="doc-sub" style="text-align:right;">書類番号: {{ORDER_NO}}{{#if PROJECT_TITLE}}　／　件名: {{PROJECT_TITLE}}{{/if}}</td>
  </tr>
</table>

<p class="section-mark first">■ 業務明細</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:5%;">No</th>
      <th class="l" style="width:47%;">品目名・成果物</th>
      <th class="center" style="width:10%;">数量</th>
      <th class="right" style="width:18%;">単価</th>
      <th class="right" style="width:20%;">金額（税抜）</th>
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
      <td class="right">{{#if (eq calc_method "ROYALTY")}}{{#if (gt (or amount_ex_tax amount) 0)}}{{formatYen (or unit_price unitPrice)}}{{else}}<span style="color:#888;">-</span>{{/if}}{{else}}{{formatYen (or unit_price unitPrice)}}{{/if}}</td>
      <td class="right">{{#if (eq calc_method "ROYALTY")}}{{#if (gt (or amount_ex_tax amount) 0)}}<strong>{{formatYen (or amount_ex_tax amount)}}</strong><div class="incl-note">{{or reward_label "執筆料"}}（{{#if (eq deliverable_ownership "受注者")}}利用許諾料{{else}}インセンティブ報酬{{/if}}は別途）</div>{{else}}<div class="incl-note">報酬は<br>{{#if (eq deliverable_ownership "受注者")}}利用許諾料{{else}}インセンティブ報酬{{/if}}に含む</div>{{/if}}{{else}}<strong>{{formatYen (or amount_ex_tax amount)}}</strong>{{/if}}</td>
    </tr>
    <tr class="item-detail">
      <td></td>
      <td colspan="4">
        {{#if payment_terms}}契約種別：{{payment_terms}}　／　{{/if}}成果物の帰属先：{{#if (eq deliverable_ownership "受注者")}}受注者（利用許諾型）{{else}}発注者（譲渡型）{{/if}}
        　／　支払方法：{{#if (eq calc_method "SUBSCRIPTION")}}定期払い{{else}}{{#if (eq calc_method "ROYALTY")}}{{#if (eq deliverable_ownership "受注者")}}利用許諾料{{else}}インセンティブ報酬{{/if}}{{else}}固定額{{/if}}{{/if}}
        　／　{{#if (eq calc_method "SUBSCRIPTION")}}役務提供期間{{else}}納期{{/if}}：{{#if (eq calc_method "SUBSCRIPTION")}}{{#if term_start}}{{formatDateCompact term_start}}{{else}}—{{/if}} 〜 {{#if term_end}}{{formatDateCompact term_end}}{{else}}継続中{{/if}}{{else}}{{formatDate delivery_date}}{{/if}}
        　／　支払日：{{#if (eq calc_method "SUBSCRIPTION")}}{{or (billingDayLabel billing_day cycle billing_timing) "支払日未設定"}}{{else}}{{#if (eq calc_method "ROYALTY")}}{{#unless (gt (or amount_ex_tax amount) 0)}}{{#if (eq deliverable_ownership "受注者")}}利用許諾料計算書の通り{{else}}インセンティブ報酬の算定による{{/if}}{{else}}{{formatDate payment_date}}{{/unless}}{{else}}{{formatDate payment_date}}{{/if}}{{/if}}
        {{#if (or spec detailText)}}
        <ul>
          {{#if spec}}<li style="white-space:pre-line;">{{spec}}</li>{{/if}}
          {{#if detailText}}<li>{{detailText}}</li>{{/if}}
        </ul>
        {{/if}}
        {{#if payment_schedule}}
        <div style="margin-top:4px; font-weight:700;">支払スケジュール</div>
        <table style="width:100%; border-collapse:collapse; font-size:8.5pt;">
          <tr><th class="l" style="width:8%;">回</th><th class="l">支払予定日</th><th class="right" style="width:30%;">金額</th></tr>
          {{#each payment_schedule}}
          <tr>
            <td class="center">{{index1 @index}}</td>
            <td>{{date}}</td>
            <td class="right">{{#if amount}}{{formatYen amount}}{{/if}}</td>
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
      <td class="right"><strong>¥ {{formatCurrency grandTotalExTax}}</strong></td>
    </tr>
    <tr class="item-detail">
      <td></td>
      <td colspan="4">
        {{#if PAYMENT_TERMS}}契約種別：{{PAYMENT_TERMS}}　／　{{/if}}支払方法：{{#if (eq CALC_METHOD "SUBSCRIPTION")}}定期払い{{else}}{{#if (eq CALC_METHOD "ROYALTY")}}利用許諾料{{else}}固定額{{/if}}{{/if}}
        　／　納期：{{formatDate DELIVERY_DATE}}
        　／　支払日：{{summaryPaymentTerms}}
      </td>
    </tr>
    {{/if}}
    <tr>
      <td colspan="4" class="right"><strong>確定額 小計（税抜）</strong></td>
      <td class="right">{{#if (gt (or itemsSubtotalExTax grandTotalExTax) 0)}}<strong>¥ {{formatCurrency (or itemsSubtotalExTax grandTotalExTax)}}</strong>{{else}}<span style="color:#888;">—</span>{{/if}}</td>
    </tr>
  </tbody>
</table>

<!-- ===== その他手数料 ===== -->
{{#if other_fees}}
{{#if (gt (length other_fees) 0)}}
<p class="section-mark">■ その他手数料（税抜・合計に加算）</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:6mm;">No</th>
      <th class="l">項目名</th>
      <th class="right" style="width:30mm;">金額（税抜）</th>
      <th class="l">摘要</th>
    </tr>
  </thead>
  <tbody>
    {{#each other_fees}}
    <tr>
      <td class="center">{{or line_no (index1 @index)}}</td>
      <td class="l"><strong>{{fee_name}}</strong></td>
      <td class="right">{{formatYen amount}}</td>
      <td class="l">{{remarks}}</td>
    </tr>
    {{/each}}
    <tr>
      <td colspan="2" class="right"><strong>手数料 小計（税抜）</strong></td>
      <td class="right"><strong>¥ {{formatCurrency otherFeesTotal}}</strong></td>
      <td></td>
    </tr>
  </tbody>
</table>
<table class="summary compact" style="margin-top:6px;">
  <tr>
    <th style="width:40%;">発注合計（税抜・業務委託 + 手数料）</th>
    <td>
      <strong class="total-amount">¥ {{formatCurrency grandTotalExTax}}</strong>
      <span class="amount-note">　※ 業務委託 ¥{{formatCurrency (or itemsSubtotalExTax grandTotalExTax)}} ＋ 手数料 ¥{{formatCurrency otherFeesTotal}}</span>
    </td>
  </tr>
</table>
{{/if}}
{{/if}}

<!-- ===== 経費 ===== -->
{{#if expenses}}
{{#if (gt (length expenses) 0)}}
<p class="section-mark">■ 経費（交通費等／税込み額）</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:6mm;">No</th>
      <th class="l">費目</th>
      <th class="center" style="width:24mm;">発生日</th>
      <th class="right" style="width:26mm;">金額（税込）</th>
      <th class="l">摘要</th>
    </tr>
  </thead>
  <tbody>
    {{#each expenses}}
    <tr>
      <td class="center">{{or line_no (index1 @index)}}</td>
      <td class="l"><strong>{{expense_name}}</strong>{{#if spec}}<div style="font-size:8pt;color:#666;">{{spec}}</div>{{/if}}</td>
      <td class="center">{{formatDate spent_date}}</td>
      <td class="right">{{formatYen amount_inc_tax}}</td>
      <td class="l">{{remarks}}</td>
    </tr>
    {{/each}}
    <tr>
      <td colspan="3" class="right"><strong>経費合計（税込）</strong></td>
      <td class="right"><strong>¥ {{formatCurrency expensesTotalIncTax}}</strong></td>
      <td></td>
    </tr>
  </tbody>
</table>
<p style="margin-top:4px; font-size:8.5pt; color:#555;">※ 経費は税込み額にて精算します。本発注書に記載の各項目の領収書原本またはそのコピーを添付してください。</p>
{{/if}}
{{/if}}

<!-- ===== 利用許諾条件（成果物を受注者に留保する品目があるとき） ===== -->
{{#if has_contractor_owned}}
<p class="section-mark">■ 利用許諾条件（成果物の権利を受注者に留保する品目）</p>
<p style="margin:0 0 4px; font-size:8.5pt; color:#555;">成果物の帰属先が「受注者」の品目については、その権利を受注者に留保し、発注者は下記の条件で利用許諾を受けます。</p>
{{#if license_terms_missing}}
<table class="box" cellspacing="0" cellpadding="0"><tr><td>利用許諾の条件は別途定める。</td></tr></table>
{{else}}
<table class="items">
  <thead>
    <tr>
      <th class="l" style="width:22%;">利用形態</th>
      <th class="l" style="width:22%;">料率／額</th>
      <th class="l" style="width:14%;">MG／AG</th>
      <th class="l" style="width:20%;">期間</th>
      <th class="l" style="width:22%;">地域 ／ 言語</th>
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
<p style="margin-top:4px; font-size:8.5pt; color:#555;">※ 料率型の許諾料は、発注の確定額（小計）には含まれず、別途、利用許諾料計算書により算定・支払われます。</p>
{{/if}}
{{/if}}

<!-- ===== 特約事項 ===== -->
{{#if SPECIAL_TERMS}}
<p class="section-mark">■ 特約</p>
<table class="box" cellspacing="0" cellpadding="0"><tr><td style="white-space:pre-wrap;">{{SPECIAL_TERMS}}</td></tr></table>
{{/if}}

<!-- ===== 備考 ===== -->
{{#if REMARKS}}
<p class="section-mark">■ 備考</p>
<table class="box" cellspacing="0" cellpadding="0"><tr><td>
  {{#if REMARKS_FIXED}}<p style="white-space:pre-wrap; margin:0;">{{REMARKS_FIXED}}</p>{{/if}}
  {{#if REMARKS_FREE}}<p style="white-space:pre-wrap; margin:{{#if REMARKS_FIXED}}8px{{else}}0{{/if}} 0 0;">{{REMARKS_FREE}}</p>{{/if}}
  {{#unless (or REMARKS_FIXED REMARKS_FREE)}}<p style="white-space:pre-wrap; margin:0;">{{REMARKS}}</p>{{/unless}}
</td></tr></table>
{{/if}}

<!-- ===== 通知先 ===== -->
<p class="section-mark">■ 通知先</p>
<table class="summary compact">
  <tr>
    <th>発注先（受注者）</th>
    <td>{{#if VENDOR_CONTACT_NAME}}担当：{{VENDOR_CONTACT_NAME}}{{else}}{{VENDOR_NAME}}{{/if}}{{#if VENDOR_CONTACT_PHONE}}　／　TEL：{{VENDOR_CONTACT_PHONE}}{{/if}}{{#if VENDOR_EMAIL}}　／　E-mail：{{VENDOR_EMAIL}}{{/if}}</td>
  </tr>
  <tr>
    <th>発注元（当社）</th>
    <td>{{#if STAFF_NAME}}担当：{{STAFF_NAME}}{{else}}{{PARTY_A_NAME}}{{/if}}{{#if STAFF_PHONE}}　／　TEL：{{STAFF_PHONE}}{{/if}}{{#if STAFF_EMAIL}}　／　E-mail：{{STAFF_EMAIL}}{{/if}}</td>
  </tr>
</table>
<p style="font-size:9pt; color:#555;">本発注に関する通知その他の連絡は、上記の通知先に対して行うものとします。基本契約がある場合は、その通知条項に従います。</p>

{{!-- 基本契約なしの場合は標準約款（terms_spot_2026）を別紙としてPDF末尾に添付 --}}
{{#unless HAS_BASE_CONTRACT}}
{{> terms_spot_2026}}
{{/unless}}
</body>$q$;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, 'data-layout="po-v3-2026-09"') > 0 THEN
    RAISE NOTICE '147: 適用済み（本文に data-layout="po-v3-2026-09" がある）。何もしません';
    RETURN;
  END IF;
  body_pos := strpos(src, '<body');
  IF body_pos = 0 THEN
    RAISE EXCEPTION '<body が見つかりません。146 で現行版を書き出して確かめてください';
  END IF;
  head := left(src, body_pos - 1);
  IF (length(head) - length(replace(head, '</style>', ''))) / length('</style>') <> 1 THEN
    RAISE EXCEPTION '</style> が <head> に 1 箇所ではありません。146 で現行版を確かめてください';
  END IF;
  new_html := replace(head, '</style>', css_add || E'\n</style>') || new_body || E'\n</html>\n';

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('147: 1 ページ目固定・明細は 2 ページ目から・署名式・利用許諾条件（%s 版の項目を引き継ぎ）', from_no),
         'sql:147'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '147: purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に目印があり、承諾欄・署名欄・利用許諾条件・改ページが揃っていること
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, 'data-layout="po-v3-2026-09"') > 0) AS 新レイアウト,
       (strpos(v.html_source, 'class="page-break"') > 0) AS 改ページ,
       (strpos(v.html_source, '■ 受領確認（承諾）') > 0) AS 承諾欄,
       (strpos(v.html_source, 'sign-both') > 0) AS 両者署名欄,
       (strpos(v.html_source, '■ 利用許諾条件') > 0) AS 利用許諾条件,
       (strpos(v.html_source, 'class="sign-box"') = 0) AS 押印欄なし,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'purchase_order';
