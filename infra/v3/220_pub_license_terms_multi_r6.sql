-- =====================================================================
-- 220_pub_license_terms_multi_r6.sql（ops sql / Cloud SQL Studio 用。デプロイでも流れる：deploy-migrations.txt）
--
--   出版等利用許諾条件書（作品ごとに番号・A4 横）の 6 版目。217 を流したあとに流す。
--     ・対象著作物の一覧の欄名「共著者等」を「共著者等（編集者印税対象者含む）」にする
--     ・第三者知的財産権の「第三者IPの関与」の文も、同じ欄名を指す
--         対象著作物ごとに上記一覧の「共著者等（編集者印税対象者含む）」欄および「備考」欄に記載のとおり。
--       （相手方の求め：合同会社ハーベストバレーとの契約を本契約に紐づけて結ぶので、「編集者印税」の語を本書面にも置く）
--     ・ほかは 5 版目（217）と同じ。欄の中身（分配を受ける人の名前・第三者権利）は変わらない
--
--   何度流しても同じ結果。ローカルは docker compose run --rm ops sql /v3/220_pub_license_terms_multi_r6.sql
--   決定済みの条件書は変わらない（出したときの版のまま）。作りかけの下書きは作った版のままなので、作り直す。
--   戻すとき：217 の版（5 版目）に current_version_id を戻す
--     UPDATE v3.document_templates d SET current_version_id = v.id FROM v3.document_template_versions v
--      WHERE d.template_key = 'pub_license_terms_multi' AND v.template_id = d.id
--        AND position('<!-- pub_license_terms_multi r5 -->' in v.html_source) > 0;
-- =====================================================================
\pset pager off

WITH t AS (
  SELECT d.id, d.current_version_id FROM v3.document_templates d WHERE d.template_key = 'pub_license_terms_multi'
),
made AS (
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1 FROM v3.document_template_versions x WHERE x.template_id = t.id),
         $html$<!-- pub_license_terms_multi r6 -->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>出版等利用許諾条件書 {{docNo}}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Yu Gothic", "游ゴシック", "YuGothic", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif;
    font-size: 7pt; line-height: 1.45; color: #111417;
  }
  .meta { font-size: 6.5pt; color: #6b7178; margin: 0 0 1.2mm; }
  h1 { text-align: center; font-size: 12pt; font-weight: bold; letter-spacing: .08em; margin: 0 0 1.2mm; }
  h1 .sub { font-size: 7.5pt; font-weight: normal; letter-spacing: 0; color: #444; margin-left: .3em; }
  p.lead { margin: 0 0 2.5mm; }
  h2 { font-size: 8.5pt; font-weight: bold; margin: 3.2mm 0 .8mm; break-after: avoid; page-break-after: avoid; }
  h2 .ref { font-size: 6.5pt; font-weight: normal; color: #6b7178; margin-left: .8em; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: .6pt solid #b9bec5; padding: .5mm 1.5mm; vertical-align: top; text-align: left; font-weight: normal; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  .titles th { background: #EFF1F3; font-weight: bold; }
  .titles col.no { width: 11.5%; } .titles col.name { width: 33%; } .titles col.cr { width: 14.5%; }
  .titles col.jt { width: 19%; } .titles col.nt { width: 22%; }
  .titles td.no { color: #6b7178; }
  .titles td.jt { text-align: left; }
  .titles td.nt { color: #6b7178; }
  .kv col.k { width: 16.6%; } .kv col.v { width: 83.4%; }
  .kv th { background: #EFF1F3; font-weight: bold; }
  ol { margin: 0; padding-left: 0; list-style: none; counter-reset: n; }
  ol > li { counter-increment: n; }
  ol > li::before { content: counter(n) ". "; }
  .special { margin: .5mm 0 0; }
  .special li { margin: 0; }
  /* 署名欄（末尾）。許諾者・被許諾者を左右に並べ、署名（記名押印）の線を引く。ページをまたがせない。 */
  .sign { display: flex; gap: 12mm; margin-top: 5mm; break-inside: avoid; page-break-inside: avoid; }
  .sign .party { flex: 1; display: flex; flex-direction: column; }
  .sign .who { font-size: 8.5pt; font-weight: bold; margin: 0 0 1mm; }
  .sign .row { display: flex; align-items: flex-end; min-height: 5.2mm; border-bottom: .6pt solid #b9bec5; }
  .sign .row .k { flex: 0 0 22mm; color: #6b7178; font-size: 6.5pt; padding-bottom: .6mm; }
  .sign .row .v { flex: 1; font-size: 8.5pt; padding-bottom: .4mm; }
  /* 代表者の行が片方だけのときも、署名の線を左右でそろえる（下に寄せる）。 */
  .sign .row.signature { min-height: 11mm; margin-top: auto; }
  .sign .row .seal { flex: 0 0 auto; color: #9aa0a6; font-size: 7pt; padding: 0 2mm .8mm; }
</style>
</head>
<body>
  <div class="meta">締結日：{{#if multiSignDate}}{{formatDate multiSignDate}}{{else}}{{signYear}}年　　月　　日{{/if}}　／　基本契約番号：{{agreementNo}}　／　個別利用許諾番号：{{termsNoRange}}</div>
  <h1>出　版　等　利　用　許　諾　条　件　書{{#if subtitle}}<span class="sub">（{{subtitle}}）</span>{{/if}}</h1>
  <p class="lead">{{licenseeName}}（以下「被許諾者」という）と{{licensorName}}（以下「許諾者」という）は、{{agreementTitle}}（以下「基本契約」という）第3条に基づき、以下のとおり本著作物の出版等に係る利用許諾条件を定める。対象著作物は下記一覧に掲げる{{titleCount}}点とし、{{preambleExtra}}</p>

  <h2>対象著作物<span class="ref">基本契約第2条</span></h2>
  <table class="titles">
    <colgroup><col class="no"><col class="name"><col class="cr"><col class="jt"><col class="nt"></colgroup>
    <thead><tr><th>条件書番号</th><th>原著作物名／対象出版物名</th><th>著作権表示</th><th>共著者等（編集者印税対象者含む）</th><th>備考</th></tr></thead>
    <tbody>
    {{#each titles}}
      <tr><td class="no">{{termsNo}}</td><td>{{title}}{{#if edition}}／{{edition}}{{/if}}</td><td>{{copyright}}</td><td class="jt">{{jointNames}}</td><td class="nt">{{#if shareNote}}{{shareNote}}{{#if note}}／{{/if}}{{/if}}{{note}}</td></tr>
    {{/each}}
    </tbody>
  </table>

  <h2>許諾内容<span class="ref">基本契約第5条から第8条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    {{#if hasPrintMedia}}<tr><th>紙媒体出版</th><td>{{grantPrint}}</td></tr>{{/if}}
    {{#if hasDigitalMedia}}<tr><th>電子書籍配信</th><td>{{grantDigital}}</td></tr>{{/if}}
    {{#if multiHasTranslation}}<tr><th>翻訳版</th><td>{{grantTranslation}}</td></tr>{{/if}}
    <tr><th>販促・広告利用</th><td>{{grantPromo}}</td></tr>
    <tr><th>二次利用（商品化・映像化・ゲーム化等）</th><td>{{grantSecondary}}</td></tr>
  </table>

  <h2>出版条件<span class="ref">基本契約第2条・第10条・第30条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>許諾期間</th><td>許諾開始日：{{termStart}}　許諾終了日：{{#if termEnd}}{{termEnd}}{{else}}定めなし{{/if}}{{#if autoRenew}}／自動更新：あり（更新単位：{{renewPeriod}}／終了通知期限：{{noticeBefore}}前）{{else}}／自動更新：なし{{/if}}</td></tr>
    <tr><th>許諾地域・言語</th><td>許諾地域：{{region}}　／　言語：{{language}}</td></tr>
  </table>

  <h2>対価・支払条件<span class="ref">基本契約第12条・第14条から第16条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    {{#if hasPrintMedia}}<tr><th>紙媒体出版</th><td>税抜定価 × 印税対象部数 × 料率（{{printRateAll}}）／印税対象部数：刷部数　※サンプル・献本その他の無償配布分は、印税対象部数に含めない。{{#if exemptFirstCopies}}なお、初版の非印税対象部数は{{exemptFirstCopies}}部とする。{{/if}}</td></tr>{{/if}}
    {{#if hasDigitalMedia}}<tr><th>電子書籍配信</th><td>{{#if digitalReceiptBasis}}被許諾者の受領額 × 料率（{{digitalRateAll}}）{{else}}配信価格 × ダウンロード数 × 料率（{{digitalRateAll}}）{{/if}}</td></tr>{{/if}}
    {{#if multiHasTranslation}}<tr><th>翻訳版</th><td>被許諾者が再許諾先から受領した許諾料の{{translationRateAll}}。{{translationBasis}}</td></tr>{{/if}}
    <tr><th>支払時期・方法</th><td>{{payTiming}}</td></tr>
    {{#if hasCoAuthorPay}}<tr><th>共著者分の支払</th><td><ol>{{#each coAuthorPay}}<li>{{this}}</li>{{/each}}</ol></td></tr>{{/if}}
    <tr><th>消費税・源泉徴収</th><td>消費税：外税{{taxRate}}％／源泉徴収：{{#if withholding}}あり{{else}}なし{{/if}}{{#if licensorInvoiceNo}}　インボイス登録番号：{{licensorInvoiceNo}}{{/if}}</td></tr>
    {{#if hasBank}}<tr><th>振込口座</th><td>{{BANK_INFO}}</td></tr>{{/if}}
  </table>

  <h2>第三者知的財産権<span class="ref">基本契約第11条・第22条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>第三者IPの関与</th><td>対象著作物ごとに上記一覧の「共著者等（編集者印税対象者含む）」欄および「備考」欄に記載のとおり。</td></tr>
  </table>

  <h2>著作権表示<span class="ref">基本契約第19条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>表示内容</th><td>{{copyrightNoticeText}}</td></tr>
  </table>

  {{#if hasPriorAgreements}}
  <h2>旧合意・過去利用<span class="ref">基本契約第32条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>旧契約等の統合</th><td><ol>{{#each priorAgreements}}<li>{{this}}</li>{{/each}}</ol></td></tr>
  </table>
  {{/if}}

  <h2>通知先<span class="ref">基本契約第38条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>許諾者</th><td>{{licensorContact}}</td></tr>
    <tr><th>被許諾者</th><td>{{licenseeContact}}</td></tr>
  </table>

  <h2>特記事項</h2>
  <ol class="special">{{#each multiSpecial}}<li>{{this}}</li>{{/each}}</ol>

  {{#if showSignature}}
  <div class="sign">
    <div class="party">
      <div class="who">許諾者</div>
      <div class="row"><span class="k">住所</span><span class="v">{{licensorAddress}}</span></div>
      <div class="row"><span class="k">氏名・名称</span><span class="v">{{licensorName}}</span></div>
      {{#if licensorRep}}<div class="row"><span class="k">代表者</span><span class="v">{{licensorRep}}</span></div>{{/if}}
      <div class="row signature"><span class="k">署名／記名押印</span><span class="v"></span><span class="seal">印</span></div>
    </div>
    <div class="party">
      <div class="who">被許諾者</div>
      <div class="row"><span class="k">住所</span><span class="v">{{licenseeAddress}}</span></div>
      <div class="row"><span class="k">氏名・名称</span><span class="v">{{licenseeName}}</span></div>
      {{#if licenseeRep}}<div class="row"><span class="k">代表者</span><span class="v">{{licenseeRep}}</span></div>{{/if}}
      <div class="row signature"><span class="k">署名／記名押印</span><span class="v"></span><span class="seal">印</span></div>
    </div>
  </div>
  {{/if}}
</body>
</html>$html$,
         '[]'::jsonb,
         '6 版目：一覧の欄名を「共著者等（編集者印税対象者含む）」にする',
         'infra/v3/220'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_multi r6 -->' in v.html_source) > 0)
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d SET current_version_id = m.id FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号 FROM pointed p
UNION ALL
SELECT '—', '0 件', '同じ本文が既に使われています。何もしていません' WHERE NOT EXISTS (SELECT 1 FROM pointed);
