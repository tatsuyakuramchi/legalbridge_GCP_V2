-- =====================================================================
-- 128_pub_license_terms_translation.sql（ops sql / Cloud SQL Studio 用）
--
--   翻訳版再許諾（A-033）を出版等利用許諾条件書に出す。
--
--   翻訳版は「乙が第三者に再許諾して出させ、受け取った対価から甲へ払う」
--   もので、自社が出す紙・電子とは料率が違う。作品ごとに率が違うので、
--   条文に 1 つの取り分を書くのではなく、対象著作物の一覧に「翻訳版再許諾」
--   の列を足して作品ごとに出す。再許諾ごとに甲乙の別途合意が要るかどうかも
--   条件が持つようになったので、同じ欄に「別途合意 要／不要」を添える。
--
--   ・一覧（第１条／別紙1）に「翻訳版再許諾　料率／別途合意」の列
--     ＝ 翻訳版の条件が 1 点でもあるときだけ出る。「紙 50%／電子 40%」
--   ・第２条 許諾内容の「翻訳版」… 別途合意が 要／不要／作品ごとに混在 で
--     書き分ける
--   ・第４条 許諾料の「翻訳版」… 条件明細があれば一覧の欄を指す。無ければ
--     これまでどおり手入力の「翻訳版取り分」を書く（従来の条件書はそのまま）
--
--   2 本のひな形の両方を改訂する。
--     pub_license_terms_v3        … 一覧形式（作品が数点）      r4 → r6
--     pub_license_terms_v3_annex  … 別紙形式（作品が数十点）    r1 → r2
--   本文の組み方・項目・値の出どころは、翻訳版の追加ぶん以外は変えていない。
--
--   先に 004_amend（v3.conditions.sublicense_consent。確認 33）を流して
--   おくこと。列が無いと、条件の側に別途合意の要否を持てない。
--
--   何度流しても同じ結果（目印の版が current なら何もしない）。実行:
--     Cloud SQL Studio にそのまま貼る／ローカルは
--     docker compose run --rm ops sql /v3/128_pub_license_terms_translation.sql
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
         $html$<!-- pub_license_terms_v3 r6 -->
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
  /* 再許諾版（乙が第三者に出させる版）の列（A-033）。紙・電子の率と別途合意の
     要否を 1 列にまとめる。この列があるときだけ、著作権表示と第三者権利を
     詰めて作品名の幅を残す。 */
  .titles th.trans { width: 22mm; }
  .titles td.trans { text-align: center; }
  .titles td.trans .m { display: block; white-space: nowrap; }
  .titles td.trans .con { display: block; font-size: 8.5pt; color: #444; }
  .titles.withtrans th.credit { width: 38mm; }
  .titles.withtrans th.third { width: 24mm; }
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
<p class="lead">一覧の1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。{{#if hasTranslationConditions}}「翻訳版再許諾」欄は、乙が第三者に再許諾して行わせる翻訳版の料率と、再許諾ごとの別途合意の要否を示す（第２条・第４条）。{{/if}}</p>
<table class="titles{{#if hasTranslationConditions}} withtrans{{/if}}">
  <thead>
    <tr>
      <th class="n">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th class="credit">著作権表示</th>
      <th class="third">共同著作・第三者権利</th>
      <th class="rate">紙<br>料率／独占区分</th>
      <th class="rate">電子<br>料率／独占区分</th>
      {{#if hasTranslationConditions}}<th class="trans">翻訳版再許諾<br>料率／別途合意</th>{{/if}}
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
      {{#if showTranslation}}<td class="trans">{{#if hasTranslation}}{{#each translationLines}}<span class="m">{{this}}</span>{{/each}}<span class="con">別途合意 {{translationConsent}}</span>{{else}}—{{/if}}</td>{{/if}}
    </tr>
    {{#if note}}
    <tr>
      <td class="c"></td>
      <td class="note" colspan="{{#if showTranslation}}6{{else}}5{{/if}}"><span class="lbl">備考</span>{{note}}</td>
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
  {{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が第三者に再許諾して行わせる翻訳版の出版{{#if hasTranslationConditions}}（対象作品と料率は第１条一覧「翻訳版再許諾」欄による）{{/if}}。{{#if translationConsentMixed}}同欄に「別途合意 要」とある作品は、再許諾ごとに再許諾先・言語・条件について甲乙が別途書面で合意する。「別途合意 不要」とある作品は、本条件書に定める条件の範囲内であれば甲の個別の事前承諾を要しない。{{else}}{{#if translationConsentRequired}}再許諾ごとに、再許諾先・言語・条件について甲乙が別途書面で合意する。{{else}}本条件書に定める条件の範囲内で行う再許諾については、甲の個別の事前承諾を要しない。{{/if}}{{/if}}いずれの場合も、乙は再許諾ごとに再許諾先・言語・受領する対価を甲へ通知する。</td></tr>
  {{/if}}
  <tr><th>販促・広告利用</th><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><th>二次利用</th><td>映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第３条</span>許諾期間・地域・言語</h2>
<table class="kv">
  <tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}</td></tr>
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
  {{#if hasTranslationConditions}}
  <tr><th>翻訳版再許諾</th><td>乙が再許諾先から受領する対価（税抜）× 料率（第１条一覧「翻訳版再許諾」欄）。紙と電子で料率が異なる場合は、同欄の媒体ごとの率による。同欄が「—」の作品には翻訳版再許諾の許諾料は発生しない。</td></tr>
  {{else}}{{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から受領する対価（税抜）の {{translationShare}}。</td></tr>
  {{/if}}{{/if}}
</table>


</div>
<div class="art">
<h2><span class="no">第５条</span>支払時期・方法</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>
  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>
  {{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>
  {{/if}}
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
<p>乙は対象出版物の奥付その他甲乙が合意した位置に、一覧の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は備考欄による。</p>

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
         'r6：一覧に翻訳版再許諾（料率／別途合意）の列。第２条・第４条を条件から書き分け',
         'infra/v3/128'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_v3 r6 -->' in v.html_source) > 0)
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
         $html$<!-- pub_license_terms_v3_annex r2 -->
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
  /* 再許諾版（乙が第三者に出させる版）の列（A-033）。紙・電子の率と別途合意の
     要否を 1 列にまとめる。この列があるときだけ、著作権表示と第三者権利を
     詰めて作品名の幅を残す。 */
  .titles th.trans { width: 22mm; }
  .titles td.trans { text-align: center; }
  .titles td.trans .m { display: block; white-space: nowrap; }
  .titles td.trans .con { display: block; font-size: 8.5pt; color: #444; }
  .titles.withtrans th.credit { width: 38mm; }
  .titles.withtrans th.third { width: 24mm; }
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
  {{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が第三者に再許諾して行わせる翻訳版の出版{{#if hasTranslationConditions}}（対象作品と料率は別紙1「翻訳版再許諾」欄による）{{/if}}。{{#if translationConsentMixed}}同欄に「別途合意 要」とある作品は、再許諾ごとに再許諾先・言語・条件について甲乙が別途書面で合意する。「別途合意 不要」とある作品は、本条件書に定める条件の範囲内であれば甲の個別の事前承諾を要しない。{{else}}{{#if translationConsentRequired}}再許諾ごとに、再許諾先・言語・条件について甲乙が別途書面で合意する。{{else}}本条件書に定める条件の範囲内で行う再許諾については、甲の個別の事前承諾を要しない。{{/if}}{{/if}}いずれの場合も、乙は再許諾ごとに再許諾先・言語・受領する対価を甲へ通知する。</td></tr>
  {{/if}}
  <tr><th>販促・広告利用</th><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><th>二次利用</th><td>映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。</td></tr>
</table>

</div>
<div class="art">
<h2><span class="no">第３条</span>許諾期間・地域・言語</h2>
<table class="kv">
  <tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}</td></tr>
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
  {{#if hasTranslationConditions}}
  <tr><th>翻訳版再許諾</th><td>乙が再許諾先から受領する対価（税抜）× 料率（別紙1「翻訳版再許諾」欄）。紙と電子で料率が異なる場合は、同欄の媒体ごとの率による。同欄が「—」の作品には翻訳版再許諾の許諾料は発生しない。</td></tr>
  {{else}}{{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から受領する対価（税抜）の {{translationShare}}。</td></tr>
  {{/if}}{{/if}}
</table>


</div>
<div class="art">
<h2><span class="no">第５条</span>支払時期・方法</h2>
<table class="kv">
  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>
  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>
  {{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>
  {{/if}}
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
<p>乙は対象出版物の奥付その他甲乙が合意した位置に、別紙1の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は別紙1の備考による。</p>

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
<p class="cap">{{docNo}}　全 {{titleCount}} 点。1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。{{#if hasTranslationConditions}}「翻訳版再許諾」欄は、乙が第三者に再許諾して行わせる翻訳版の料率と、再許諾ごとの別途合意の要否を示す（第２条・第４条）。{{/if}}</p>
<table class="titles{{#if hasTranslationConditions}} withtrans{{/if}}">
  <thead>
    <tr>
      <th class="n">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th class="credit">著作権表示</th>
      <th class="third">共同著作・第三者権利</th>
      <th class="rate">紙<br>料率／独占区分</th>
      <th class="rate">電子<br>料率／独占区分</th>
      {{#if hasTranslationConditions}}<th class="trans">翻訳版再許諾<br>料率／別途合意</th>{{/if}}
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
      {{#if showTranslation}}<td class="trans">{{#if hasTranslation}}{{#each translationLines}}<span class="m">{{this}}</span>{{/each}}<span class="con">別途合意 {{translationConsent}}</span>{{else}}—{{/if}}</td>{{/if}}
    </tr>
    {{#if note}}
    <tr>
      <td class="c"></td>
      <td class="note" colspan="{{#if showTranslation}}6{{else}}5{{/if}}"><span class="lbl">備考</span>{{note}}</td>
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
         'r2：別紙1に翻訳版再許諾（料率／別途合意）の列。第２条・第４条を条件から書き分け',
         'infra/v3/128'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_v3_annex r2 -->' in v.html_source) > 0)
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
SELECT '—', '0 件', '同じ本文（r2）が既に使われています。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【3】確認。2 本とも「翻訳版の列あり」が true になっていること。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番,
       t.is_active AS 有効, v.id AS 版id, v.version_no AS 版番号,
       length(v.html_source) AS 本文の長さ,
       (position('翻訳版再許諾<br>料率／別途合意' in v.html_source) > 0) AS 翻訳版の列あり,
       (position('translationConsentMixed' in v.html_source) > 0)       AS 別途合意の書き分けあり
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
