-- =====================================================================
-- 検収書のひな形 v2：役務提供完了通知書（169）と同じ段構成に
--
--   役務提供完了通知書（169）と同じ考え方で検収書を組み直す。
--   宛先と当社を横に並べ、件名〜基本契約を「■ 検収概要」の表に、明細は 1 本の表（No.・品目・
--   発注番号・納品日・数量・単価・金額）、合計は表の下に右寄せの小さな欄（小計・消費税・実費・
--   お支払額・お支払予定日・振込先）。「支払条件・発注情報」「通知先」の表と、別表の変更履歴は出さない。
--
--   ・金額が当初から変わったとき（変更履歴があるとき）だけ「■ 変更内容の確認」の署名欄を出す（従来どおり）。
--   ・分納をまとめた検収書は「■ 支払済みの分（参考）」に前回までの行を出す。
--   ・差し込む名前は変えない（delivery_line_items・other_fees・expenses・taxableSubtotalExTaxStr …）。
--     項目の宣言（variables）も現行版のまま。
--
--   やり方は 120・137 と同じ。現行版の <head>（CSS）を残して </style> の前に
--   CSS を足し、<body>…</body> を丸ごと置き換えた新しい版を作って
--   current_version_id を差し替える。項目の宣言（variables）は現行版のまま。
--   適用済み（本文に data-layout="ins-v2-2026-10" がある）なら何もしない。同じレイアウトの
--   古い改訂が入っていれば、170 より前の版の head を下敷きにして
--   新しい改訂に置き換える（手で前の版に戻さなくてよい）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/170_inspection_layout_v2.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'inspection_certificate';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
--   元の本文と CSS: infra/v3/templates/inspection_certificate_v2_body.html / inspection_certificate_v2_css.txt
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
  /* ---- 170: 検収書 v2（役務提供完了通知書 169 と同じ段構成：概要の表 → 明細 → 右寄せの合計 → 署名欄 → 備考）
     現行版の head の CSS は残し、ここで上書きする。箱と下線は表のセルで組む（Word に貼っても崩れない）。 */
  @page { size: A4; margin: 12mm 12mm 14mm; }
  body { font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; font-size: 9.5pt; line-height: 1.5; color: #222; margin: 0; padding: 16px; }
  h1.doc-title { font-size: 18pt; margin: 0 0 2px; letter-spacing: .3em; font-weight: 700; text-align: center; border: 0; }
  .doc-head { text-align: center; margin-bottom: 6px; }
  .doc-sub { font-size: 8.5pt; color: #555; }
  .doc-meta { font-size: 8.5pt; text-align: right; margin: 0 0 6px; }
  .doc-meta b { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  hr.rule { border: none; border-top: 1px solid #333; margin: 0 0 10px; }
  table { border-collapse: collapse; }
  table.party { width: 100%; margin-bottom: 10px; }
  table.party td { vertical-align: top; border: 0; }
  table.party td + td { border-left: 1px solid #d9d9d9; }
  .vlabel { font-size: 8pt; font-weight: 700; color: #555; margin-bottom: 3px; letter-spacing: .04em; }
  .vendor-name { font-size: 13pt; font-weight: 700; border-bottom: 1px solid #333; padding-bottom: 3px; margin-bottom: 4px; }
  .muted { font-size: 8.5pt; color: #555; }
  .company-name { font-weight: 700; font-size: 10.5pt; margin-bottom: 2px; }
  .contact { margin-top: 6px; padding-top: 5px; border-top: 1px solid #d9d9d9; font-size: 8.5pt; color: #555; }
  p.lead { font-size: 9pt; margin: 0 0 6px; }
  p.section-mark { font-size: 9.5pt; font-weight: 700; margin: 10px 0 4px; padding: 0 0 2px; border: 0; border-bottom: 1px solid #bdbdbd; page-break-after: avoid; }
  table.summary { width: 100%; font-size: 8.5pt; margin: 0; }
  table.summary th, table.summary td { border: 1px solid #d9d9d9; padding: 4px 7px; vertical-align: top; text-align: left; }
  table.summary th { background: #f4f4f2; width: 16%; font-weight: 600; color: #333; white-space: nowrap; }
  table.summary td { width: 34%; }
  table.summary td b.no { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  table.items { width: 100%; font-size: 8.5pt; margin: 0; }
  table.items th, table.items td { border: 1px solid #d9d9d9; padding: 3px 6px; vertical-align: top; line-height: 1.4; }
  table.items th { background: #f4f4f2; font-weight: 600; color: #333; text-align: center; white-space: nowrap; }
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }
  td.center { text-align: center; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .item-name { font-weight: 600; }
  .item-spec { font-size: 8pt; color: #555; margin-top: 1px; }
  .item-change { font-size: 8pt; color: #92400e; margin-top: 1px; }
  tr.spec-row td { border-top: 0; background: #fafaf8; font-size: 8.5pt; white-space: pre-line; padding: 4px 8px 6px; }
  tr.spec-row td:first-child { background: transparent; }
  table.totals { width: auto; min-width: 46%; margin: 6px 0 0 auto; font-size: 8.5pt; }
  table.totals th { text-align: left; font-weight: 400; background: transparent; border: 0; border-bottom: 1px solid #d9d9d9; padding: 2px 10px 2px 2px; white-space: nowrap; width: auto; }
  table.totals td { border: 0; border-bottom: 1px solid #d9d9d9; padding: 2px 2px 2px 16px; min-width: 9em; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: auto; }
  table.totals tr.grand th, table.totals tr.grand td { font-weight: 700; font-size: 10pt; border-top: 2px solid #333; border-bottom: 0; padding-top: 4px; }
  table.totals tr.date th, table.totals tr.date td { border: 0; color: #555; font-size: 8pt; padding-top: 0; white-space: normal; }
  p.progress { font-size: 8pt; color: #555; margin: 4px 0 0; text-align: right; }
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
$q$;
  new_body constant text := $q$<body data-layout="ins-v2-2026-10">

<!-- ===== ヘッダ ===== -->
<div class="doc-head">
  <h1 class="doc-title">検収書</h1>
  {{#if PERIOD}}<div class="doc-sub">{{PERIOD}}</div>{{/if}}
</div>
<div class="doc-meta">文書番号: <b>{{DOC_NO}}</b>　　発行日: {{formatDate documentDate}}{{#if issueKey}}　　課題: {{issueKey}}{{/if}}</div>
<hr class="rule">

<!-- ===== 宛先 ＋ 発注者 ===== -->
<table class="party">
  <tr>
    <td style="width:50%; padding-right:12px;">
      <div class="vlabel">受注者</div>
      <div class="vendor-name">{{VENDOR_NAME}}{{#if VENDOR_SUFFIX}}　{{VENDOR_SUFFIX}}{{else}}　御中{{/if}}</div>
      {{#if VENDOR_REPRESENTATIVE_SAMA}}<div class="muted">{{VENDOR_REPRESENTATIVE_SAMA}}</div>{{/if}}
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

<p class="lead">下記のとおり納品を受け、検収したことを通知いたします。</p>

<!-- ===== 検収概要 ===== -->
<p class="section-mark">■ 検収概要</p>
<table class="summary">
  <tr>
    <th>件名</th><td>{{PROJECT_TITLE}}</td>
    <th>発注番号</th><td><b class="no">{{#if parent_po_number}}{{parent_po_number}}{{else}}—{{/if}}</b></td>
  </tr>
  <tr>
    <th>納品日</th><td>{{#if DELIVERY_DATE}}{{formatDate DELIVERY_DATE}}{{else}}明細のとおり{{/if}}</td>
    <th>検収日</th><td>{{#if INSPECTION_DATE}}{{formatDate INSPECTION_DATE}}{{else}}{{formatDate documentDate}}{{/if}}</td>
  </tr>
  <tr>
    <th>契約種別</th><td>{{#each delivery_line_items}}{{#if @first}}{{#if payment_terms}}{{payment_terms}}{{else}}明細のとおり{{/if}}{{/if}}{{/each}}{{#if WITHHOLDING_TAX}}（源泉徴収 {{WITHHOLDING_TAX}}）{{/if}}</td>
    <th>基本契約</th><td>{{#if HAS_BASE_CONTRACT}}あり{{#if MASTER_CONTRACT_REF}}（{{MASTER_CONTRACT_REF}}）{{/if}}{{else}}なし（発注書の標準約款による）{{/if}}</td>
  </tr>
</table>

<!-- ===== 検収内容 ===== -->
<p class="section-mark">■ 検収内容</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:4%">No.</th>
      <th style="width:36%">品目・成果物</th>
      <th style="width:14%">発注番号</th>
      <th style="width:14%">納品日</th>
      <th style="width:8%">数量</th>
      <th style="width:12%">単価（税抜）</th>
      <th style="width:12%">金額（税抜）</th>
    </tr>
  </thead>
  <tbody>
    {{#each delivery_line_items}}
    <tr>
      <td class="center">{{index1 @index}}</td>
      <td>
        <div class="item-name">{{item_name}}</div>
        {{#if item_spec}}<div class="item-spec">{{item_spec}}</div>{{else}}{{#if spec_head}}<div class="item-spec">{{spec_head}}</div>{{/if}}{{/if}}
        {{#if reward_label}}<div class="item-spec">{{reward_label}}{{#if rate_pct}}　料率 {{rate_pct}}%{{/if}}{{#if formula_text}}　{{formula_text}}{{/if}}</div>{{/if}}
        {{#if payment_terms}}<div class="item-spec">契約種別: {{payment_terms}}{{#if deliverable_ownership}}　帰属: {{deliverable_ownership}}{{/if}}</div>{{else}}{{#if deliverable_ownership}}<div class="item-spec">帰属: {{deliverable_ownership}}</div>{{/if}}{{/if}}
        {{#if hasChange}}<div class="item-change">金額変更: {{changeLabel}}{{#if changeNote}}（{{changeNote}}）{{/if}}</div>{{/if}}
      </td>
      <td class="center">{{#if order_no}}{{order_no}}{{else}}{{../parent_po_number}}{{/if}}</td>
      <td class="center">{{#if term_start}}{{formatDateCompact term_start}}〜{{formatDateCompact term_end}}{{else}}{{#if delivery_date}}{{formatDateCompact delivery_date}}{{else}}—{{/if}}{{/if}}</td>
      <td class="num">{{#if sc_hours_text}}{{sc_hours_text}}{{else}}{{#if inspected_quantity}}{{inspected_quantity}}{{else}}{{#if quantity}}{{quantity}}{{else}}—{{/if}}{{/if}}{{/if}}</td>
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

<!-- ===== 合計 ===== -->
<table class="totals">
  <tr><th>小計（税抜）</th><td>{{taxableSubtotalExTaxStr}}</td></tr>
  <tr><th>消費税（{{taxRate}}%）{{#if isReducedTax}} ※軽減税率{{/if}}</th><td>{{combinedTaxStr}}</td></tr>
  {{#if expenses.length}}<tr><th>実費（税込）</th><td>{{expensesTotalIncTaxStr}}</td></tr>{{/if}}
  <tr class="grand"><th>お支払額</th><td>{{grandTotalPayableStr}}</td></tr>
  {{#if PAYMENT_DATE}}<tr class="date"><th>お支払予定日</th><td>{{formatDate PAYMENT_DATE}}</td></tr>{{/if}}
  {{#if BANK_NAME}}<tr class="date"><th>振込先</th><td>{{BANK_NAME}} {{BRANCH_NAME}}　{{ACCOUNT_TYPE}} {{ACCOUNT_NUMBER}}　{{ACCOUNT_HOLDER_KANA}}</td></tr>{{/if}}
</table>
{{#if totalOrderAmountStr}}{{#unless (eq inspectedPct 100)}}
<p class="progress">発注総額 {{totalOrderAmountStr}} 円のうち、本検収書までの検収済額 {{inspectedAmountStr}} 円（{{inspectedPct}}%）、未検収額 {{pendingAmountStr}} 円。</p>
{{/unless}}{{/if}}

<!-- ===== 支払済みの分（分納をまとめた検収書） ===== -->
{{#if useGroupedInspection}}
<p class="section-mark">■ 支払済みの分（参考）</p>
<table class="items">
  <thead><tr><th style="width:4%"></th><th>品目・成果物</th><th style="width:16%">支払日</th><th style="width:16%">金額（税抜）</th></tr></thead>
  <tbody>
    {{#each paymentGroups}}{{#if isPaid}}
    {{#each lines}}
    <tr><td></td><td><div class="item-name">{{item_name}}</div>{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}</td><td class="center">{{formatDateCompact ../date}}</td><td class="num">{{formatCurrency amount_ex_tax}}</td></tr>
    {{/each}}
    {{/if}}{{/each}}
  </tbody>
</table>
{{/if}}

<!-- ===== 変更内容の確認（金額が当初から変わったときだけ） ===== -->
{{#if needsSignature}}
<div class="signature-section">
  <div class="t">■ 変更内容の確認</div>
  <p>本検収書の金額は当初の発注条件から変更されています。{{#each changeLogs}}{{fieldLabel}} {{beforeValue}} → {{afterValue}}（{{reason}}）。{{/each}}変更の内容および理由を確認のうえ、下記にご署名（または記名押印）ください。ご署名をもって、変更後の金額で検収が確定します。</p>
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
        <div style="margin-top:6px;">確認日：{{#if INSPECTION_DATE}}{{formatDate INSPECTION_DATE}}{{else}}{{formatDate documentDate}}{{/if}}</div>
      </td>
    </tr>
  </table>
</div>
{{/if}}

<!-- ===== 備考 ===== -->
<div class="remarks">
  <b>備考</b>
  <ol>
    <li>記載内容に相違がある場合は、本検収書の受領後 5 営業日以内に上記の当社担当までご連絡ください。ご連絡がない場合は確認済みとして取り扱います。</li>
    <li>成果物の権利の帰属は発注書および{{#if HAS_BASE_CONTRACT}}基本契約{{else}}標準約款{{/if}}の定めによります。</li>
    <li>実費は税込の実費精算です。その他の経費は事前承認分に限ります。</li>
    <li>受注者の請求書と記載が異なる場合は本検収書を優先します。</li>
    {{#if remarks}}<li>{{remarks}}</li>{{/if}}
  </ol>
</div>

</body>$q$;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate のひな形が見つかりません';
  END IF;
  IF strpos(src, 'data-layout="ins-v2-2026-10"') > 0 THEN
    RAISE NOTICE '170: 適用済み（本文に data-layout="ins-v2-2026-10" がある）。何もしません';
    RETURN;
  END IF;
  -- 同じレイアウトの古い改訂が入っていれば、170 より前の版（元の head/CSS を
  -- 持つ版）を下敷きにして置き換える。手で前の版に戻す必要はない。
  IF strpos(src, 'data-layout="ins-v2') > 0 THEN
    SELECT v.id, v.version_no, v.html_source INTO base_version, base_no, src
      FROM v3.document_template_versions v
     WHERE v.template_id = tpl_id AND strpos(v.html_source, 'data-layout="ins-v2') = 0
     ORDER BY v.version_no DESC LIMIT 1;
    IF src IS NULL THEN
      RAISE EXCEPTION '170 より前の版が見つかりません（146 で書き出した本文から作り直してください）';
    END IF;
    RAISE NOTICE '170: 古い改訂（版 %）を置き換える。head は版 % から', from_no, base_no;
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
  new_html := replace(head, '</style>', css_add || E'\n</style>') || body_text || E'\n</html>\n';

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('170: 1 ページ目固定・明細は 2 ページ目から・署名式・利用許諾条件（%s 版の項目を引き継ぎ）', from_no),
         'sql:170'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '170: inspection_certificate 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に目印があり、承諾欄・署名欄・利用許諾条件・改ページが揃っていること
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, 'data-layout="ins-v2-2026-10"') > 0) AS 新レイアウト,
       (strpos(v.html_source, 'class="page-break"') > 0) AS 改ページ,
       (strpos(v.html_source, '■ 検収概要') > 0) AS 検収概要,
       (strpos(v.html_source, '■ 検収内容') > 0) AS 検収内容,
       (strpos(v.html_source, 'signature-section') > 0) AS 署名欄,
       (strpos(v.html_source, 'class="sign-box"') = 0) AS 押印欄なし,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
