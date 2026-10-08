-- =====================================================================
-- 165_royalty_statement_pub_r3.sql（ops sql / psql 用。Cloud SQL Studio は 165_..._studio.sql）
--
--   出版専用の利用許諾料計算書（164）を r3 にする（docs/royalty-shares.md §5.8）。
--     ・源泉徴収税額と差引お振込額の行を消し、本文は「お支払額（税込・源泉徴収前）」で締める。
--       源泉の対象になる相手には「お振込額は、上記のお支払額（税込）から所得税及び復興特別所得税
--       （源泉徴収税）を差し引いた金額となります。」の注記を出す。支払・経理提出用の源泉は従来どおり。
--     ・本文の要約の表で「作品」の列が 1 文字幅に潰れていたのを直す（集計期間を折り返せるように
--       し、作品の列に最小幅を持たせる）。
--
--   164 を流してあること。何度流しても同じ結果。実行:
--     psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f infra/v3/165_royalty_statement_pub_r3.sql
--
--   戻すとき（r2 に戻る）: 164 を流し直す。
-- =====================================================================

\pset pager off

WITH t AS (
  SELECT d.id, d.current_version_id
    FROM v3.document_templates d
   WHERE d.template_key = 'royalty_statement_pub'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = t.id),
         $html$<!-- royalty_statement_pub r3 -->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>利用許諾料計算書 {{DOC_NO}}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Noto Sans CJK JP", "IPAPGothic", "Hiragino Sans", sans-serif; font-size: 10pt; color: #111; line-height: 1.5; }
  h1 { font-size: 15pt; text-align: center; margin: 0 0 6mm; letter-spacing: .2em; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5mm; }
  .head .to { font-size: 12pt; }
  .head .to .reg { font-size: 9pt; margin-top: 1mm; }
  .head .meta { font-size: 9pt; }
  .head .meta td { padding: 0 0 0 8px; text-align: right; }
  .lead { margin: 0 0 4mm; }
  table.t { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.t th, table.t td { border: 1px solid #666; padding: 2px 5px; vertical-align: middle; }
  table.t th { background: #eee; font-weight: normal; text-align: center; }
  table.t thead { display: table-header-group; }
  table.t tr { page-break-inside: avoid; break-inside: avoid; }
  .r { text-align: right; white-space: nowrap; }
  .c { text-align: center; white-space: nowrap; }
  .sub td { background: #f6f6f6; font-weight: bold; }
  .sum { margin: 4mm 0 0 auto; width: 62%; border-collapse: collapse; font-size: 10pt; }
  .sum th, .sum td { border: 1px solid #666; padding: 3px 6px; }
  .sum th { background: #eee; font-weight: normal; text-align: left; width: 45%; }
  .sum .big td, .sum .big th { font-size: 12pt; font-weight: bold; }
  .kv { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 5mm; }
  .kv th { width: 22%; text-align: left; background: #eee; border: 1px solid #666; padding: 3px 6px; font-weight: normal; }
  .kv td { border: 1px solid #666; padding: 3px 6px; }
  .note { font-size: 8.5pt; color: #333; margin-top: 3mm; white-space: pre-wrap; }
  .issuer { margin-top: 6mm; font-size: 9pt; text-align: right; }
  .annex { page-break-before: always; break-before: page; }
  .annex h2 { font-size: 12pt; margin: 0 0 2mm; }
  .annex .subhead { font-size: 9pt; color: #333; margin: 0 0 3mm; }
.c.wrap { white-space: normal }
  table.t td.work { min-width: 40mm }
</style>
</head>
<body>

<h1>利用許諾料計算書</h1>

<div class="head">
  <div class="to">{{VENDOR_NAME}} {{#if VENDOR_SUFFIX}}{{VENDOR_SUFFIX}}{{else}}様{{/if}}
    <div class="reg">{{#if VENDOR_INVOICE_NO}}登録番号　{{VENDOR_INVOICE_NO}}{{else}}登録番号　なし{{/if}}</div>
  </div>
  <table class="meta">
    <tr><td>計算書番号</td><td>{{DOC_NO}}</td></tr>
    <tr><td>発行日</td><td>{{formatDate documentDate}}</td></tr>
    {{#if pubMasterNo}}<tr><td>基本契約番号</td><td>{{pubMasterNo}}</td></tr>{{/if}}
    {{#if pubTermsNo}}<tr><td>個別契約番号</td><td>{{pubTermsNo}}</td></tr>{{/if}}
    <tr><td>対象期間</td><td>{{pubPeriodLabel}}</td></tr>
  </table>
</div>

<p class="lead">{{pubMediaLabel}}にかかる著作物利用許諾料を下記のとおりご報告いたします。作品ごとの内訳（{{#if pubHasDigital}}販売月・書店別{{/if}}{{#if pubHasPrint}}{{#if pubHasDigital}}／{{/if}}刷了・刊行の月別{{/if}}）は末尾の<b>別紙1「明細」</b>のとおりです。</p>

<table class="t">
  <thead>
    <tr><th>作品</th><th style="width:9mm">媒体</th><th style="width:36mm">集計期間</th><th style="width:26mm">個別契約番号</th>
        <th style="width:13mm">数量</th><th style="width:22mm">報告売上（税抜）</th><th style="width:11mm">料率</th>
        <th style="width:22mm">許諾料（税抜）</th></tr>
  </thead>
  <tbody>
    {{#each pubWorks}}
    <tr><td class="work">{{title}}</td><td class="c">{{media}}</td><td class="c wrap">{{period}}</td><td class="c">{{contractNumber}}</td>
        <td class="r">{{quantityStr}}</td><td class="r">¥{{salesStr}}</td><td class="c">{{rate}}</td><td class="r">¥{{feeStr}}</td></tr>
    {{/each}}
    <tr class="sub"><td colspan="4">合計（{{pubWorkCount}} 件・明細 {{pubRowCount}} 行）</td><td class="r">{{pubTotalQuantityStr}}</td>
        <td class="r">¥{{pubTotalSalesStr}}</td><td></td><td class="r">¥{{pubTotalFeeStr}}</td></tr>
  </tbody>
</table>

<table class="sum">
  <tr><th>10%対象　対価の額（税抜）</th><td class="r">¥{{pubTotalFeeStr}}</td></tr>
  <tr><th>10%対象　消費税額</th><td class="r">¥{{pubTaxStr}}</td></tr>
  <tr class="big"><th>お支払額（税込・源泉徴収前）</th><td class="r">¥{{pubTotalIncTaxStr}}</td></tr>
</table>

<table class="kv">
  <tr><th>お支払予定日</th><td>{{#if PAYMENT_DATE}}{{formatDate PAYMENT_DATE}}{{else}}支払条件のとおり{{/if}}</td></tr>
  <tr><th>お振込先</th><td>{{#if BANK_INFO}}{{BANK_INFO}}{{else}}（振込先の登録がありません。ご連絡ください）{{/if}}</td></tr>
  <tr><th>取引内容</th><td>{{pubMediaLabel}}にかかる著作物利用許諾料（{{pubPeriodLabel}}）</td></tr>
  <tr><th>計算方法</th><td>{{#if pubHasDigital}}電子：配信価格（税抜）× ダウンロード数 × 料率。販売月・書店ごと（事業部の報告の行ごと）に円未満を切り捨てて合算。{{/if}}{{#if pubHasPrint}}{{#if pubHasDigital}}<br>{{/if}}紙：税抜定価 × 印税対象部数 × 料率。刷ごとに円未満を切り捨てて合算。{{/if}}</td></tr>
</table>

{{#if notes}}<p class="note">{{notes}}</p>{{/if}}
{{#if pubHasWithholding}}<p class="note">※ お振込額は、上記のお支払額（税込）から所得税及び復興特別所得税（源泉徴収税）を差し引いた金額となります。</p>{{/if}}
<p class="note">本計算書は仕入明細書として作成しています。内容にご不明な点や相違等がございましたら、発行日から 2 週間以内にご連絡ください。期間内にご連絡がない場合は、ご確認いただいたものとして取り扱います。</p>

<div class="issuer">
  <b>作成者</b>　{{COMPANY_NAME}}<br>
  {{#if COMPANY_POSTAL_CODE}}〒{{COMPANY_POSTAL_CODE}} {{/if}}{{COMPANY_ADDRESS}}{{#if COMPANY_TEL}}　TEL {{COMPANY_TEL}}{{/if}}<br>
  {{#if COMPANY_INVOICE_NO}}登録番号 {{COMPANY_INVOICE_NO}}{{/if}}
</div>

<section class="annex">
  <h2>別紙1　明細</h2>
  <p class="subhead">利用許諾料計算書 {{DOC_NO}}　{{VENDOR_NAME}} {{#if VENDOR_SUFFIX}}{{VENDOR_SUFFIX}}{{else}}様{{/if}}　対象期間 {{pubPeriodLabel}}　全 {{pubRowCount}} 行</p>
  <table class="t">
    <thead>
      <tr><th style="width:20mm">販売月</th><th>作品</th><th style="width:26mm">書店・内容</th><th style="width:16mm">単価</th>
          <th style="width:12mm">数量</th><th style="width:20mm">報告売上</th><th style="width:11mm">料率</th><th style="width:18mm">許諾料</th></tr>
    </thead>
    <tbody>
      {{#each pubAnnex}}
      {{#each rows}}
      <tr><td class="c">{{period}}</td><td>{{#if first}}{{../title}}（{{../media}}）{{else}}同上{{/if}}</td><td>{{detail}}</td>
          <td class="r">{{#if unitPriceStr}}¥{{unitPriceStr}}{{/if}}</td><td class="r">{{quantityStr}}</td>
          <td class="r">¥{{salesStr}}</td><td class="c">{{rate}}</td><td class="r">¥{{feeStr}}</td></tr>
      {{/each}}
      <tr class="sub"><td colspan="4">小計　{{title}}（{{media}}）{{#if contractNumber}}　{{contractNumber}}{{/if}}</td>
          <td class="r">{{subtotalQuantityStr}}</td><td class="r">¥{{subtotalSalesStr}}</td><td></td><td class="r">¥{{subtotalFeeStr}}</td></tr>
      {{/each}}
      <tr class="sub"><td colspan="4">合計</td><td class="r">{{pubTotalQuantityStr}}</td><td class="r">¥{{pubTotalSalesStr}}</td><td></td>
          <td class="r">¥{{pubTotalFeeStr}}</td></tr>
    </tbody>
  </table>
</section>

</body>
</html>$html$,
         '[]'::jsonb,
         'r3：源泉徴収税額・差引お振込額の行を消して税込（源泉徴収前）で締め、源泉の注記。作品の列の潰れを直す',
         'infra/v3/165'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- royalty_statement_pub r3 -->' in v.html_source) > 0)
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d
     SET current_version_id = m.id
    FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '同じ本文が既に使われています。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- 確認。r3 になっていて、源泉の行が無いこと。
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版番号, (position('royalty_statement_pub r3' in v.html_source) > 0) AS r3,
       (position('差引お振込額' in v.html_source) = 0) AS 源泉の行なし
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('royalty_statement', 'royalty_statement_pub')
 ORDER BY t.template_key;
