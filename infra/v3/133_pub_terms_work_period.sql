-- =====================================================================
-- 133_pub_terms_work_period.sql（ops sql / Cloud SQL Studio 用）
--
--   作品ごとの許諾期間と更新の回数を一覧に出す（A-039）。
--
--   これまで許諾期間は第３条に1つだけで、載せた条件明細の期間を外側で
--   包んだもの（いちばん早い開始〜いちばん遅い終了）だった。出版は作品ごとに
--   期間も更新も違うので、それだけでは作品ごとの満了日が紙から読めない。
--
--   条件明細が持つようになった期間と自動更新（004_amend の A-039）を、
--   備考と同じ全幅の行に1文で出す。
--     許諾期間 2026.10.1〜2033.9.30（更新 2回）　翻訳版再許諾 紙 50%…　備考 …
--   「更新 n 回」は終了日・更新の単位・締結日から数える（列には持たない）。
--   自動更新しない作品は「更新なし」、止めた作品は「以後更新しない」と付す。
--   決定した文書は値を保存するので、あとから回数が増えても紙は変わらない。
--
--   第３条の許諾期間はこれまでどおり外側を包んだ期間で、作品ごとの期間が
--   一覧にあるときは「一覧の「許諾期間」の行による」と添える。
--
--   2 本のひな形の両方を改訂する。
--     pub_license_terms_v3        … 一覧形式（作品が数点）      r9 → r10
--     pub_license_terms_v3_annex  … 別紙形式（作品が数十点）    r5 → r6
--
--   先に 004_amend（確認 34）と 131 を流しておくこと。
--
--   何度流しても同じ結果（目印の版が current なら何もしない）。実行:
--     Cloud SQL Studio にそのまま貼る／ローカルは
--     docker compose run --rm ops sql /v3/133_pub_terms_work_period.sql
--
--   戻すとき（版id は【3】の一覧に出る）:
--     UPDATE v3.document_templates SET current_version_id = <前の版id>
--      WHERE template_key = 'pub_license_terms_v3';         -- 一覧形式
--     UPDATE v3.document_templates SET current_version_id = <前の版id>
--      WHERE template_key = 'pub_license_terms_v3_annex';   -- 別紙形式
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】一覧形式（pub_license_terms_v3）。目印の版が current でなければ新しい版を作って向ける。
-- ---------------------------------------------------------------------
WITH t AS (
  SELECT d.id, d.current_version_id
    FROM v3.document_templates d
   WHERE d.template_key = 'pub_license_terms_v3'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = t.id),
         $html$<!-- pub_license_terms_v3 r10 -->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>出版等利用許諾条件書 {{docNo}}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
    font-size: 10.5pt; line-height: 1.55; color: #111;
  }
  h1 { text-align: center; font-size: 16pt; letter-spacing: .12em; margin: 0 0 2mm; }
  .sub { text-align: center; font-size: 9pt; color: #444; margin: 0 0 4mm; }
  .meta { display: flex; gap: 10mm; margin-bottom: 3mm; font-size: 10pt; }
  .meta span b { font-weight: normal; color: #444; margin-right: 1em; }
  .parties { display: flex; gap: 6mm; margin-bottom: 3mm; }
  .party { flex: 1; border: 1px solid #bbb; padding: 2mm 3mm; }
  .party .role { font-size: 8.5pt; letter-spacing: .1em; color: #444; }
  .party .name { font-weight: bold; font-size: 11.5pt; }
  h2 { font-size: 11pt; margin: 4mm 0 1.5mm; padding-bottom: .5mm; border-bottom: 1.2px solid #222; }
  h2 .no { color: #444; font-weight: normal; margin-right: .6em; }
  p { margin: 1mm 0; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { border: 1px solid #333; padding: 1mm 1.6mm; vertical-align: top; text-align: left; }
  th { background: #f1efe8; font-weight: bold; white-space: nowrap; }
  td.c { text-align: center; white-space: nowrap; }
  .kv th { width: 24mm; }
  .titles th.n { width: 7mm; }
  .titles th.rate { width: 19mm; }
  .titles th.credit { width: 46mm; }
  .titles th.third { width: 28mm; }
  /* 作品の下に続ける行（再許諾版の料率・備考）。全幅なので 1 文で読める。
     列にすると 22mm に紙・電子・要否の 3 行を押し込むことになり、そのぶん
     著作権表示と作品名を削ることになる（A-035）。 */
  .titles td.note .lbl:not(:first-child) { margin-left: 1em; }
  .titles tr { page-break-inside: avoid; }
  /* 作品 1 点（1 行目＋備考の行）は tbody ごとにまとめ、ページをまたがない。 */
  .titles tbody { break-inside: avoid; page-break-inside: avoid; }
  .titles thead { display: table-header-group; }
  .titles td.note { font-size: 9pt; color: #333; }
  .titles td.note .lbl { color: #666; margin-right: .6em; }
  /* 条文は 1 段。上から流し、表の行と、見出しとその直後は割らない。 */
  .two { margin-top: 2mm; }
  .two .art { margin-bottom: 3mm; }
  .two h2 { margin: 0 0 1.2mm; break-after: avoid; page-break-after: avoid; }
  .two tr { break-inside: avoid; page-break-inside: avoid; }
  .two thead { display: table-header-group; }
  .titles { page-break-inside: auto; }
  .titles tr { page-break-inside: avoid; }
  .lead { font-size: 9pt; color: #444; margin: 0 0 1.5mm; }
  .sign { display: flex; gap: 10mm; margin-top: 6mm; page-break-inside: avoid; break-inside: avoid; }
  .sign > div .name { font-size: 11pt; }
  .sign > div { flex: 1; border-top: 1px solid #333; padding-top: 2mm; }
  .sign .who { font-size: 8.5pt; color: #444; letter-spacing: .1em; }
  .footer { margin-top: 3mm; font-size: 8pt; color: #555; text-align: right; }
</style>
</head>
<body>

<h1>出版等利用許諾条件書</h1>
<p class="sub">{{agreementTitle}}に基づく個別許諾条件</p>

<div class="meta">
  <span><b>締結日</b>{{formatDate signDate}}</span>
  <span><b>基本契約番号</b>{{agreementNo}}</span>
  <span><b>条件書番号</b>{{docNo}}</span>
</div>

<div class="parties">
  <div class="party">
    <div class="role">許諾者（甲）</div>
    <div class="name">{{licensorName}}</div>
    <div>{{licensorAddress}}</div>
    {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
    {{#if licensorInvoiceNo}}<div>登録番号 {{licensorInvoiceNo}}</div>{{/if}}
  </div>
  <div class="party">
    <div class="role">被許諾者（乙）</div>
    <div class="name">{{licenseeName}}</div>
    <div>{{licenseeAddress}}</div>
    {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
    {{#if licenseeInvoiceNo}}<div>登録番号 {{licenseeInvoiceNo}}</div>{{/if}}
  </div>
</div>

<p>甲と乙は、両者間の{{agreementTitle}}{{#if agreementNo}}（{{agreementNo}}）{{/if}}（以下「基本契約」という。）に基づき、以下のとおり個別の利用許諾条件を定める。本条件書に定めのない事項は基本契約による。</p>

<h2><span class="no">第１条</span>対象著作物</h2>
<p class="lead">一覧の1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。許諾期間は作品ごとに同じNo.の下の行に示し、「更新 n 回」は本条件書の締結後に自動更新した回数を示す（第３条）。自動更新しない作品は「更新なし」、更新を止めた作品は「以後更新しない」と付す。{{#if hasTranslationConditions}}{{#if translationDerivative}}翻訳の条件を定めた作品は、同じNo.の下の「{{translationLabel}}」の行に、翻訳について別途合意するときの料率の目安を示す（第２条）。{{else}}翻訳版の再許諾がある作品は、同じNo.の下の「{{translationLabel}}」の行に、紙・電子の料率と別途合意の要否を示す（第２条・第４条）。{{/if}}{{/if}}</p>
<table class="titles">
  <thead>
    <tr>
      <th class="n">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th class="credit">著作権表示</th>
      <th class="third">共同著作・第三者権利</th>
      <th class="rate">紙<br>料率／独占区分</th>
      <th class="rate">電子<br>料率／独占区分</th>
    </tr>
  </thead>
  {{#each titles}}
  <tbody>
    <tr>
      <td class="c">{{no}}</td>
      <td>{{title}}{{#if edition}}<br>{{edition}}{{/if}}</td>
      <td>{{copyright}}</td>
      <td>{{thirdParty}}</td>
      <td class="c">{{printRate}}{{#if hasPrint}}／{{printExclusivity}}{{/if}}</td>
      <td class="c">{{digitalRate}}{{#if hasDigital}}／{{digitalExclusivity}}{{/if}}</td>
    </tr>
    {{#if hasNoteRow}}
    <tr>
      <td class="c"></td>
      <td class="note" colspan="5">{{#if hasTerm}}<span class="lbl">許諾期間</span>{{term}}{{/if}}{{#if hasTranslation}}<span class="lbl">{{translationLabel}}</span>{{translation}}{{#unless translationDerivative}}（別途合意 {{translationConsent}}）{{/unless}}{{/if}}{{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>
    </tr>
    {{/if}}
  </tbody>
  {{/each}}
  {{#unless titles.length}}
  <tbody><tr><td colspan="6">（対象著作物がありません。条件明細を選んでください）</td></tr></tbody>
  {{/unless}}
</table>

<div class="two">

<div class="art">
<h2><span class="no">第２条</span>許諾内容</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>対象出版物の複製・頒布。独占・非独占の別は第１条一覧「紙」欄による。</td></tr>
  <tr><th>電子書籍配信</th><td>主要電子書店における配信（DRM付き）。独占・非独占の別は第１条一覧「電子」欄による。「電子」欄が「—」の作品は対象外とする。</td></tr>
  {{#if hasTranslation}}{{#unless translationDerivative}}
  <tr><th>翻訳版</th><td>乙が第三者に再許諾して行わせる翻訳版の出版。{{#if hasTranslationConditions}}対象作品と料率は第１条一覧の各作品の「{{translationLabel}}」の行による。{{/if}}{{#if translationConsentMixed}}同行に「別途合意 要」とある作品は、再許諾ごとに再許諾先・言語・条件について甲乙が別途書面で合意する。同行に「別途合意 不要」とある作品は、本条件書に定める条件の範囲内であれば甲の個別の事前承諾を要しない。{{else}}{{#if translationConsentRequired}}再許諾ごとに、再許諾先・言語・条件について甲乙が別途書面で合意する。{{else}}本条件書に定める条件の範囲内で行う再許諾については、甲の個別の事前承諾を要しない。{{/if}}{{/if}}いずれの場合も、乙は再許諾ごとに再許諾先・言語・受領する対価を甲へ通知する。</td></tr>
  {{/unless}}{{/if}}
  <tr><th>販促・広告利用</th><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><th>二次利用</th><td>{{#if translationDerivative}}翻訳（二次的著作物の作成）及び翻訳物の出版・配信、映像化・商品化その他の二次利用は、いずれも本条件書の対象外とし、甲乙の別途合意による。翻訳権その他著作権法第27条・第28条に定める権利は甲に留保され、本条件書による許諾には含まれない。{{#if hasTranslationConditions}}翻訳について別途合意するときの許諾料の料率は、第１条一覧の各作品の「{{translationLabel}}」の行を目安とする。{{/if}}{{else}}映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。{{/if}}</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第３条</span>許諾期間・地域・言語</h2>
<table class="kv">
  <tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{#if hasWorkTerms}}（対象著作物ごとの許諾期間と更新は一覧の「許諾期間」の行による）{{/if}}</td></tr>
  {{#if termEnd}}
  <tr><th>更新</th><td>{{#if autoRenew}}期間満了の{{noticeBefore}}前までにいずれの当事者からも書面による終了の通知がない場合、同一条件で{{renewPeriod}}ごとに自動更新する。{{else}}自動更新しない。延長は甲乙協議のうえ書面で定める。{{/if}}</td></tr>
  {{/if}}
  <tr><th>地域</th><td>{{region}}</td></tr>
  <tr><th>言語</th><td>{{language}}{{#if hasTranslation}}（翻訳版は第２条による）{{/if}}</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第４条</span>許諾料</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>税抜定価 × 印税対象部数 × 料率（第１条一覧「紙」欄）。印税対象部数は刷部数とし、見本・献本・破損分を除く。初版部数その他の個別の取り決めは一覧の備考欄による。</td></tr>
  <tr><th>電子書籍配信</th><td>配信価格（税抜）× ダウンロード数 × 料率（第１条一覧「電子」欄）。「電子」欄が「—」の作品には電子書籍配信の許諾料は発生しない。</td></tr>
  {{#unless translationDerivative}}{{#if hasTranslationConditions}}
  <tr><th>{{translationLabel}}</th><td>乙が再許諾先から受領する対価（税抜）× 料率（第１条一覧の「{{translationLabel}}」の行）。紙と電子で料率が異なる場合は、同行の媒体ごとの率による。当該の行が無い作品には翻訳版の許諾料は発生しない。算定の細目に別段の定めをするときは、一覧の備考欄又は特記事項による。</td></tr>
  {{else}}{{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から受領する対価（税抜）の {{translationShare}}。</td></tr>
  {{/if}}{{/if}}{{/unless}}
</table>


</div>
<div class="art">
<h2><span class="no">第５条</span>支払時期・方法</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>
  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>
  {{#if hasTranslation}}{{#unless translationDerivative}}
  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>
  {{/unless}}{{/if}}
  <tr><th>消費税</th><td>上記金額は税抜とし、消費税（{{taxRate}}%）を別途加算する。</td></tr>
  <tr><th>源泉徴収</th><td>{{#if withholding}}乙は法令に基づき所得税及び復興特別所得税を源泉徴収し、その残額を支払う。{{else}}甲が法人であるため源泉徴収は行わない。{{/if}}</td></tr>
  <tr><th>報告</th><td>乙は支払の際、作品ごとの刷部数・定価・ダウンロード数・配信価格を記載した明細を甲に提出する。</td></tr>
  <tr><th>振込先</th><td>{{#if hasBank}}{{BANK_INFO}}<br>{{/if}}振込手数料は乙の負担とする。</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第６条</span>第三者の知的財産</h2>
<p>一覧の「共同著作・第三者権利」欄に記載のある作品について、当該第三者の権利処理は甲が行い、甲は当該第三者に対する対価の支払について乙に責任が及ばないことを保証する。</p>

</div>
<div class="art">
<h2><span class="no">第７条</span>著作権表示</h2>
<p>乙は対象出版物の奥付その他甲乙が合意した位置に、一覧の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は備考欄による。{{#if translationDerivative}}別途合意により翻訳物を出版するときは、原著作物の題号及び原著作者名を、翻訳物であることが分かる形で表示する。{{/if}}</p>

</div>
<div class="art">
<h2><span class="no">第８条</span>旧合意との関係</h2>
<p>本条件書は、対象著作物に関する甲乙間の従前の合意（覚書・電子メールその他形式を問わない）に優先し、これらを本条件書に統合する。本条件書と基本契約が矛盾する場合は本条件書が優先する。</p>

</div>
<div class="art">
<h2><span class="no">第９条</span>通知先</h2>
<table class="kv">
  <tr><th>甲</th><td>{{licensorContact}}</td></tr>
  <tr><th>乙</th><td>{{licenseeContact}}</td></tr>
</table>

</div>

{{#if specialNotes}}
<div class="art">
<h2><span class="no">第１０条</span>特記事項</h2>
<p>{{specialNotes}}</p>
</div>
{{/if}}

{{#if showSignature}}
<div class="sign">
  <div><div class="who">甲</div><div class="name">{{licensorName}}{{#if licensorRep}}　{{licensorRep}}{{/if}}</div></div>
  <div><div class="who">乙</div><div class="name">{{licenseeName}}{{#if licenseeRep}}　{{licenseeRep}}{{/if}}</div></div>
</div>
{{/if}}

</div>

<div class="footer">{{docNo}}　出版等利用許諾条件書</div>

</body>
</html>$html$,
         '[]'::jsonb,
         'r10：作品ごとの許諾期間と更新の回数を、備考と同じ行に出す',
         'infra/v3/133'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_v3 r10 -->' in v.html_source) > 0)
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
SELECT '—', '0 件', '同じ本文（r10）が既に使われています。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【2】別紙形式（pub_license_terms_v3_annex）。目印の版が current でなければ新しい版を作って向ける。
-- ---------------------------------------------------------------------
WITH t AS (
  SELECT d.id, d.current_version_id
    FROM v3.document_templates d
   WHERE d.template_key = 'pub_license_terms_v3_annex'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = t.id),
         $html$<!-- pub_license_terms_v3_annex r6 -->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>出版等利用許諾条件書 {{docNo}}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
    font-size: 10.5pt; line-height: 1.55; color: #111;
  }
  h1 { text-align: center; font-size: 16pt; letter-spacing: .12em; margin: 0 0 2mm; }
  .sub { text-align: center; font-size: 9pt; color: #444; margin: 0 0 4mm; }
  .meta { display: flex; gap: 10mm; margin-bottom: 3mm; font-size: 10pt; }
  .meta span b { font-weight: normal; color: #444; margin-right: 1em; }
  .parties { display: flex; gap: 6mm; margin-bottom: 3mm; }
  .party { flex: 1; border: 1px solid #bbb; padding: 2mm 3mm; }
  .party .role { font-size: 8.5pt; letter-spacing: .1em; color: #444; }
  .party .name { font-weight: bold; font-size: 11.5pt; }
  h2 { font-size: 11pt; margin: 4mm 0 1.5mm; padding-bottom: .5mm; border-bottom: 1.2px solid #222; }
  h2 .no { color: #444; font-weight: normal; margin-right: .6em; }
  p { margin: 1mm 0; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { border: 1px solid #333; padding: 1mm 1.6mm; vertical-align: top; text-align: left; }
  th { background: #f1efe8; font-weight: bold; white-space: nowrap; }
  td.c { text-align: center; white-space: nowrap; }
  .kv th { width: 24mm; }
  .titles th.n { width: 7mm; }
  .titles th.rate { width: 19mm; }
  .titles th.credit { width: 46mm; }
  .titles th.third { width: 28mm; }
  /* 作品の下に続ける行（再許諾版の料率・備考）。全幅なので 1 文で読める。
     列にすると 22mm に紙・電子・要否の 3 行を押し込むことになり、そのぶん
     著作権表示と作品名を削ることになる（A-035）。 */
  .titles td.note .lbl:not(:first-child) { margin-left: 1em; }
  .titles tr { page-break-inside: avoid; }
  /* 作品 1 点（1 行目＋備考の行）は tbody ごとにまとめ、ページをまたがない。 */
  .titles tbody { break-inside: avoid; page-break-inside: avoid; }
  .titles thead { display: table-header-group; }
  .titles td.note { font-size: 9pt; color: #333; }
  .titles td.note .lbl { color: #666; margin-right: .6em; }
  /* 条文は 1 段。上から流し、表の行と、見出しとその直後は割らない。 */
  .two { margin-top: 2mm; }
  .two .art { margin-bottom: 3mm; }
  .two h2 { margin: 0 0 1.2mm; break-after: avoid; page-break-after: avoid; }
  .two tr { break-inside: avoid; page-break-inside: avoid; }
  .two thead { display: table-header-group; }
  .titles { page-break-inside: auto; }
  .titles tr { page-break-inside: avoid; }
  .lead { font-size: 9pt; color: #444; margin: 0 0 1.5mm; }
  .sign { display: flex; gap: 10mm; margin-top: 6mm; page-break-inside: avoid; break-inside: avoid; }
  /* 別紙。本文（条文と署名欄）のあとに、改ページして続ける。 */
  .annex { page-break-before: always; }
  .annex h2 { margin-top: 0; }
  .annex .cap { font-size: 9pt; color: #444; margin: 0 0 2mm; }
  .sign > div .name { font-size: 11pt; }
  .sign > div { flex: 1; border-top: 1px solid #333; padding-top: 2mm; }
  .sign .who { font-size: 8.5pt; color: #444; letter-spacing: .1em; }
  .footer { margin-top: 3mm; font-size: 8pt; color: #555; text-align: right; }
  /* 紙では全ページの右下に出す。別紙だけ抜き取られても、どの条件書のものか分かる。
     画面（プレビュー）では本文の流れのまま。 */
  @media print { .footer { position: fixed; bottom: 0; right: 0; margin: 0; } }
</style>
</head>
<body>

<h1>出版等利用許諾条件書</h1>
<p class="sub">{{agreementTitle}}に基づく個別許諾条件</p>

<div class="meta">
  <span><b>締結日</b>{{formatDate signDate}}</span>
  <span><b>基本契約番号</b>{{agreementNo}}</span>
  <span><b>条件書番号</b>{{docNo}}</span>
</div>

<div class="parties">
  <div class="party">
    <div class="role">許諾者（甲）</div>
    <div class="name">{{licensorName}}</div>
    <div>{{licensorAddress}}</div>
    {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
    {{#if licensorInvoiceNo}}<div>登録番号 {{licensorInvoiceNo}}</div>{{/if}}
  </div>
  <div class="party">
    <div class="role">被許諾者（乙）</div>
    <div class="name">{{licenseeName}}</div>
    <div>{{licenseeAddress}}</div>
    {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
    {{#if licenseeInvoiceNo}}<div>登録番号 {{licenseeInvoiceNo}}</div>{{/if}}
  </div>
</div>

<p>甲と乙は、両者間の{{agreementTitle}}{{#if agreementNo}}（{{agreementNo}}）{{/if}}（以下「基本契約」という。）に基づき、以下のとおり個別の利用許諾条件を定める。本条件書に定めのない事項は基本契約による。</p>

<h2><span class="no">第１条</span>対象著作物</h2>
<p>本条件書の対象著作物および対象出版物は、末尾の<b>別紙1「対象著作物一覧」</b>（全 {{titleCount}} 点）のとおりとする。紙媒体出版・電子書籍配信の料率および独占・非独占の別は、作品ごとに別紙1の各欄による。</p>

<div class="two">

<div class="art">
<h2><span class="no">第２条</span>許諾内容</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>対象出版物の複製・頒布。独占・非独占の別は別紙1の「紙」欄による。</td></tr>
  <tr><th>電子書籍配信</th><td>主要電子書店における配信（DRM付き）。独占・非独占の別は別紙1の「電子」欄による。「電子」欄が「—」の作品は対象外とする。</td></tr>
  {{#if hasTranslation}}{{#unless translationDerivative}}
  <tr><th>翻訳版</th><td>乙が第三者に再許諾して行わせる翻訳版の出版。{{#if hasTranslationConditions}}対象作品と料率は別紙1の各作品の「{{translationLabel}}」の行による。{{/if}}{{#if translationConsentMixed}}同行に「別途合意 要」とある作品は、再許諾ごとに再許諾先・言語・条件について甲乙が別途書面で合意する。同行に「別途合意 不要」とある作品は、本条件書に定める条件の範囲内であれば甲の個別の事前承諾を要しない。{{else}}{{#if translationConsentRequired}}再許諾ごとに、再許諾先・言語・条件について甲乙が別途書面で合意する。{{else}}本条件書に定める条件の範囲内で行う再許諾については、甲の個別の事前承諾を要しない。{{/if}}{{/if}}いずれの場合も、乙は再許諾ごとに再許諾先・言語・受領する対価を甲へ通知する。</td></tr>
  {{/unless}}{{/if}}
  <tr><th>販促・広告利用</th><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><th>二次利用</th><td>{{#if translationDerivative}}翻訳（二次的著作物の作成）及び翻訳物の出版・配信、映像化・商品化その他の二次利用は、いずれも本条件書の対象外とし、甲乙の別途合意による。翻訳権その他著作権法第27条・第28条に定める権利は甲に留保され、本条件書による許諾には含まれない。{{#if hasTranslationConditions}}翻訳について別途合意するときの許諾料の料率は、別紙1の各作品の「{{translationLabel}}」の行を目安とする。{{/if}}{{else}}映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。{{/if}}</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第３条</span>許諾期間・地域・言語</h2>
<table class="kv">
  <tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{#if hasWorkTerms}}（対象著作物ごとの許諾期間と更新は一覧の「許諾期間」の行による）{{/if}}</td></tr>
  {{#if termEnd}}
  <tr><th>更新</th><td>{{#if autoRenew}}期間満了の{{noticeBefore}}前までにいずれの当事者からも書面による終了の通知がない場合、同一条件で{{renewPeriod}}ごとに自動更新する。{{else}}自動更新しない。延長は甲乙協議のうえ書面で定める。{{/if}}</td></tr>
  {{/if}}
  <tr><th>地域</th><td>{{region}}</td></tr>
  <tr><th>言語</th><td>{{language}}{{#if hasTranslation}}（翻訳版は第２条による）{{/if}}</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第４条</span>許諾料</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>税抜定価 × 印税対象部数 × 料率（別紙1の「紙」欄）。印税対象部数は刷部数とし、見本・献本・破損分を除く。初版部数その他の個別の取り決めは別紙1の備考による。</td></tr>
  <tr><th>電子書籍配信</th><td>配信価格（税抜）× ダウンロード数 × 料率（別紙1の「電子」欄）。「電子」欄が「—」の作品には電子書籍配信の許諾料は発生しない。</td></tr>
  {{#unless translationDerivative}}{{#if hasTranslationConditions}}
  <tr><th>{{translationLabel}}</th><td>乙が再許諾先から受領する対価（税抜）× 料率（別紙1の「{{translationLabel}}」の行）。紙と電子で料率が異なる場合は、同行の媒体ごとの率による。当該の行が無い作品には翻訳版の許諾料は発生しない。算定の細目に別段の定めをするときは、一覧の備考欄又は特記事項による。</td></tr>
  {{else}}{{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から受領する対価（税抜）の {{translationShare}}。</td></tr>
  {{/if}}{{/if}}{{/unless}}
</table>


</div>
<div class="art">
<h2><span class="no">第５条</span>支払時期・方法</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>
  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>
  {{#if hasTranslation}}{{#unless translationDerivative}}
  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>
  {{/unless}}{{/if}}
  <tr><th>消費税</th><td>上記金額は税抜とし、消費税（{{taxRate}}%）を別途加算する。</td></tr>
  <tr><th>源泉徴収</th><td>{{#if withholding}}乙は法令に基づき所得税及び復興特別所得税を源泉徴収し、その残額を支払う。{{else}}甲が法人であるため源泉徴収は行わない。{{/if}}</td></tr>
  <tr><th>報告</th><td>乙は支払の際、作品ごとの刷部数・定価・ダウンロード数・配信価格を記載した明細を甲に提出する。</td></tr>
  <tr><th>振込先</th><td>{{#if hasBank}}{{BANK_INFO}}<br>{{/if}}振込手数料は乙の負担とする。</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第６条</span>第三者の知的財産</h2>
<p>別紙1の「共同著作・第三者権利」欄に記載のある作品について、当該第三者の権利処理は甲が行い、甲は当該第三者に対する対価の支払について乙に責任が及ばないことを保証する。</p>

</div>
<div class="art">
<h2><span class="no">第７条</span>著作権表示</h2>
<p>乙は対象出版物の奥付その他甲乙が合意した位置に、別紙1の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は別紙1の備考による。{{#if translationDerivative}}別途合意により翻訳物を出版するときは、原著作物の題号及び原著作者名を、翻訳物であることが分かる形で表示する。{{/if}}</p>

</div>
<div class="art">
<h2><span class="no">第８条</span>旧合意との関係</h2>
<p>本条件書は、対象著作物に関する甲乙間の従前の合意（覚書・電子メールその他形式を問わない）に優先し、これらを本条件書に統合する。本条件書と基本契約が矛盾する場合は本条件書が優先する。</p>

</div>
<div class="art">
<h2><span class="no">第９条</span>通知先</h2>
<table class="kv">
  <tr><th>甲</th><td>{{licensorContact}}</td></tr>
  <tr><th>乙</th><td>{{licenseeContact}}</td></tr>
</table>

</div>

{{#if specialNotes}}
<div class="art">
<h2><span class="no">第１０条</span>特記事項</h2>
<p>{{specialNotes}}</p>
</div>
{{/if}}

{{#if showSignature}}
<div class="sign">
  <div><div class="who">甲</div><div class="name">{{licensorName}}{{#if licensorRep}}　{{licensorRep}}{{/if}}</div></div>
  <div><div class="who">乙</div><div class="name">{{licenseeName}}{{#if licenseeRep}}　{{licenseeRep}}{{/if}}</div></div>
</div>
{{/if}}

</div>


<div class="annex">
<h2>別紙1　対象著作物一覧</h2>
<p class="cap">{{docNo}}　全 {{titleCount}} 点。1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。許諾期間は作品ごとに同じNo.の下の行に示し、「更新 n 回」は本条件書の締結後に自動更新した回数を示す（第３条）。自動更新しない作品は「更新なし」、更新を止めた作品は「以後更新しない」と付す。{{#if hasTranslationConditions}}{{#if translationDerivative}}翻訳の条件を定めた作品は、同じNo.の下の「{{translationLabel}}」の行に、翻訳について別途合意するときの料率の目安を示す（第２条）。{{else}}翻訳版の再許諾がある作品は、同じNo.の下の「{{translationLabel}}」の行に、紙・電子の料率と別途合意の要否を示す（第２条・第４条）。{{/if}}{{/if}}</p>
<table class="titles">
  <thead>
    <tr>
      <th class="n">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th class="credit">著作権表示</th>
      <th class="third">共同著作・第三者権利</th>
      <th class="rate">紙<br>料率／独占区分</th>
      <th class="rate">電子<br>料率／独占区分</th>
    </tr>
  </thead>
  {{#each titles}}
  <tbody>
    <tr>
      <td class="c">{{no}}</td>
      <td>{{title}}{{#if edition}}<br>{{edition}}{{/if}}</td>
      <td>{{copyright}}</td>
      <td>{{thirdParty}}</td>
      <td class="c">{{printRate}}{{#if hasPrint}}／{{printExclusivity}}{{/if}}</td>
      <td class="c">{{digitalRate}}{{#if hasDigital}}／{{digitalExclusivity}}{{/if}}</td>
    </tr>
    {{#if hasNoteRow}}
    <tr>
      <td class="c"></td>
      <td class="note" colspan="5">{{#if hasTerm}}<span class="lbl">許諾期間</span>{{term}}{{/if}}{{#if hasTranslation}}<span class="lbl">{{translationLabel}}</span>{{translation}}{{#unless translationDerivative}}（別途合意 {{translationConsent}}）{{/unless}}{{/if}}{{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>
    </tr>
    {{/if}}
  </tbody>
  {{/each}}
  {{#unless titles.length}}
  <tbody><tr><td colspan="6">（対象著作物がありません。条件明細を選んでください）</td></tr></tbody>
  {{/unless}}
</table>
</div>

<div class="footer">{{docNo}}　出版等利用許諾条件書</div>

</body>
</html>$html$,
         '[]'::jsonb,
         'r6：作品ごとの許諾期間と更新の回数を、備考と同じ行に出す',
         'infra/v3/133'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_v3_annex r6 -->' in v.html_source) > 0)
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
SELECT '—', '0 件', '同じ本文（r6）が既に使われています。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【3】確認。2 本とも「許諾期間の行あり」「第３条が一覧を指す」が true になっていること。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, t.label AS 名前, v.id AS 版id, v.version_no AS 版番号,
       length(v.html_source) AS 本文の長さ,
       (position('translationDerivative' in v.html_source) > 0) AS 立て付けの切替あり,
       (position('<span class="lbl">許諾期間</span>' in v.html_source) > 0) AS 許諾期間の行あり,
       (position('hasWorkTerms' in v.html_source) > 0)                      AS 第３条が一覧を指す
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex')
 ORDER BY t.template_key;

SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号, v.comment AS 備考,
       (v.id = t.current_version_id) AS いま使っている
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.template_id = t.id
 WHERE t.template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex')
 ORDER BY t.template_key, v.version_no DESC
 LIMIT 12;
