-- =====================================================================
-- 207_pub_license_terms_multi_r2.sql（ops sql / Cloud SQL Studio 用）
--
--   出版等利用許諾条件書（作品ごとに番号・A4 横）の 2 版目。206 を流したあとに流す。
--     ・一覧の「備考」の頭に、許諾者の取り分を料率で出す
--       （「紙 取り分 10.3125%（全体 11%）／電子 取り分 15%（全体 16%）」。だれに按分するかは書かない）
--     ・取り分は条件明細の按分のうち、許諾者（条件の相手先）の分。按分の無い作品は今までどおり
--
--   何度流しても同じ結果。ローカルは docker compose run --rm ops sql /v3/207_pub_license_terms_multi_r2.sql
--   戻すとき：206 の版（1 版目）に current_version_id を戻す
--     UPDATE v3.document_templates d SET current_version_id = v.id FROM v3.document_template_versions v
--      WHERE d.template_key = 'pub_license_terms_multi' AND v.template_id = d.id
--        AND position('<!-- pub_license_terms_multi r1 -->' in v.html_source) > 0;
-- =====================================================================
\pset pager off

WITH t AS (
  SELECT d.id, d.current_version_id FROM v3.document_templates d WHERE d.template_key = 'pub_license_terms_multi'
),
made AS (
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1 FROM v3.document_template_versions x WHERE x.template_id = t.id),
         $html$<!-- pub_license_terms_multi r2 -->
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
  .titles col.no { width: 12.7%; } .titles col.name { width: 39.5%; } .titles col.cr { width: 16.6%; }
  .titles col.jt { width: 8.3%; } .titles col.nt { width: 22.9%; }
  .titles td.no { color: #6b7178; }
  .titles td.jt { text-align: center; }
  .titles td.nt { color: #6b7178; }
  .kv col.k { width: 16.6%; } .kv col.v { width: 83.4%; }
  .kv th { background: #EFF1F3; font-weight: bold; }
  ol { margin: 0; padding-left: 0; list-style: none; counter-reset: n; }
  ol > li { counter-increment: n; }
  ol > li::before { content: counter(n) ". "; }
  .special { margin: .5mm 0 0; }
  .special li { margin: 0; }
</style>
</head>
<body>
  <div class="meta">締結日：{{#if multiSignDate}}{{formatDate multiSignDate}}{{else}}{{signYear}}年　　月　　日{{/if}}　／　基本契約番号：{{agreementNo}}　／　個別利用許諾番号：{{termsNoRange}}</div>
  <h1>出　版　等　利　用　許　諾　条　件　書{{#if subtitle}}<span class="sub">（{{subtitle}}）</span>{{/if}}</h1>
  <p class="lead">{{licenseeName}}（以下「被許諾者」という）と{{licensorName}}（以下「許諾者」という）は、{{agreementTitle}}（以下「基本契約」という）第3条に基づき、以下のとおり本著作物の出版等に係る利用許諾条件を定める。対象著作物は下記一覧に掲げる{{titleCount}}点とし、{{preambleExtra}}</p>

  <h2>対象著作物<span class="ref">基本契約第2条</span></h2>
  <table class="titles">
    <colgroup><col class="no"><col class="name"><col class="cr"><col class="jt"><col class="nt"></colgroup>
    <thead><tr><th>条件書番号</th><th>原著作物名／対象出版物名</th><th>著作権表示</th><th>共同著作<br>第三者権利</th><th>備考</th></tr></thead>
    <tbody>
    {{#each titles}}
      <tr><td class="no">{{termsNo}}</td><td>{{title}}{{#if edition}}／{{edition}}{{/if}}</td><td>{{copyright}}</td><td class="jt">{{jointLabel}}</td><td class="nt">{{#if shareNote}}{{shareNote}}{{#if note}}／{{/if}}{{/if}}{{note}}</td></tr>
    {{/each}}
    </tbody>
  </table>

  <h2>許諾内容<span class="ref">基本契約第5条から第8条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    {{#if hasPrintMedia}}<tr><th>紙媒体出版</th><td>{{grantPrint}}</td></tr>{{/if}}
    {{#if hasDigitalMedia}}<tr><th>電子書籍配信</th><td>{{grantDigital}}</td></tr>{{/if}}
    {{#if hasTranslation}}<tr><th>翻訳版</th><td>{{grantTranslation}}</td></tr>{{/if}}
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
    {{#if hasTranslation}}<tr><th>翻訳版</th><td>被許諾者が再許諾先から受領した許諾料の{{translationRateAll}}。{{translationBasis}}</td></tr>{{/if}}
    <tr><th>支払時期・方法</th><td>{{payTiming}}</td></tr>
    {{#if hasCoAuthorPay}}<tr><th>共著者分の支払</th><td><ol>{{#each coAuthorPay}}<li>{{this}}</li>{{/each}}</ol></td></tr>{{/if}}
    <tr><th>消費税・源泉徴収</th><td>消費税：外税{{taxRate}}％／源泉徴収：{{#if withholding}}あり{{else}}なし{{/if}}{{#if licensorInvoiceNo}}　インボイス登録番号：{{licensorInvoiceNo}}{{/if}}</td></tr>
    {{#if hasBank}}<tr><th>振込口座</th><td>{{BANK_INFO}}</td></tr>{{/if}}
  </table>

  <h2>第三者知的財産権<span class="ref">基本契約第11条・第22条</span></h2>
  <table class="kv"><colgroup><col class="k"><col class="v"></colgroup>
    <tr><th>第三者IPの関与</th><td>{{thirdPartyIp}}</td></tr>
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
</body>
</html>$html$,
         '[]'::jsonb,
         '2 版目：備考の頭に許諾者の取り分（料率）',
         'infra/v3/207'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_multi r2 -->' in v.html_source) > 0)
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d SET current_version_id = m.id FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号 FROM pointed p
UNION ALL
SELECT '—', '0 件', '同じ本文が既に使われています。何もしていません' WHERE NOT EXISTS (SELECT 1 FROM pointed);
