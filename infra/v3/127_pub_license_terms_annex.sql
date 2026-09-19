-- =====================================================================
-- 127_pub_license_terms_annex.sql（ops sql / Cloud SQL Studio 用）
--
--   出版等利用許諾条件書を「一覧形式」と「別紙形式」の2本立てにする。
--
--   作品が数点なら、一覧が第１条にあるほうが1枚で読める（一覧形式＝これまでの
--   pub_license_terms_v3）。作品が数十点になると、条文の前に表が何ページも
--   続いて読み順が逆になるので、一覧を別紙1に出す（別紙形式）。
--   どちらで出すかは文書作成のひな形の選択で決める。中身（項目・値の出どころ・
--   一覧の組み方）は同じで、本文の組み方だけが違う。
--
--   【1】別紙形式のひな形（pub_license_terms_v3_annex）を登録する。
--        本文は 126 の r5 と同じ。採番は同じ PUBT を使うので、条件書番号は
--        どちらで出しても1本の連番になる。
--   【2】一覧形式（pub_license_terms_v3）を r4（一覧が第１条）に戻す。
--        126 を流していれば r5（別紙）を向いているので、r4 の版に向け直す。
--        126 を流していなければ何もしない。
--
--   何度流しても同じ結果。実行:
--     Cloud SQL Studio にそのまま貼る／ローカルは
--     docker compose run --rm ops sql /v3/127_pub_license_terms_annex.sql
--
--   戻すとき:
--     ・別紙形式を選択肢から消す
--       UPDATE v3.document_templates SET is_active = false
--        WHERE template_key = 'pub_license_terms_v3_annex';
--     ・一覧形式を別紙の本文に戻す（126 を流し直す）
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】別紙形式のひな形。
-- ---------------------------------------------------------------------
INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
VALUES ('pub_license_terms_v3_annex', '出版等利用許諾条件書（V3・別紙形式／作品が多いとき）',
        'license', 'PUBT', true)
ON CONFLICT (template_key) DO UPDATE
   SET label = EXCLUDED.label, number_prefix = EXCLUDED.number_prefix, is_active = true;

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
         $html$<!-- pub_license_terms_v3_annex r1 -->
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
  <tr><th>翻訳版</th><td>乙が第三者に再許諾する翻訳版の出版。再許諾ごとに甲へ事前に通知する。</td></tr>
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
  {{#if hasTranslation}}
  <tr><th>翻訳版</th><td>乙が再許諾先から受領する対価（税抜）の {{translationShare}}。</td></tr>
  {{/if}}
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
<p class="cap">{{docNo}}　全 {{titleCount}} 点。1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。</p>
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
    {{#if note}}
    <tr>
      <td class="c"></td>
      <td class="note" colspan="5"><span class="lbl">備考</span>{{note}}</td>
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
         '初版：別紙形式（本文は条文だけで2ページ、一覧は別紙1）',
         'infra/v3/127'
    FROM t
   WHERE NOT EXISTS (
           SELECT 1 FROM v3.document_template_versions v
            WHERE v.id = t.current_version_id
              AND position('<!-- pub_license_terms_v3_annex r1 -->' in v.html_source) > 0)
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

-- ---------------------------------------------------------------------
-- 【2】一覧形式は r4（一覧が第１条）に戻す。
--      126 で r5（別紙）に向けていたときだけ動く。
-- ---------------------------------------------------------------------
WITH t AS (
  SELECT d.id, d.current_version_id FROM v3.document_templates d
   WHERE d.template_key = 'pub_license_terms_v3'
),
r4 AS (
  SELECT v.id FROM v3.document_template_versions v, t
   WHERE v.template_id = t.id
     AND position('<!-- pub_license_terms_v3 r4 -->' in v.html_source) > 0
   ORDER BY v.version_no DESC LIMIT 1
),
back AS (
  UPDATE v3.document_templates d
     SET label = '出版等利用許諾条件書（V3・一覧形式／作品が少ないとき）',
         current_version_id = r4.id
    FROM r4, t
   WHERE d.id = t.id
     AND t.current_version_id IS DISTINCT FROM r4.id
     AND EXISTS (SELECT 1 FROM v3.document_template_versions v
                  WHERE v.id = t.current_version_id
                    AND position('<!-- pub_license_terms_v3 r5 -->' in v.html_source) > 0)
  RETURNING d.template_key, r4.id AS 戻した版id
)
SELECT b.template_key AS キー, b.戻した版id::text AS 戻した版id
  FROM back b
UNION ALL
SELECT '—', 'r5 を向いていないので、そのまま（名前だけ揃えます）'
 WHERE NOT EXISTS (SELECT 1 FROM back);

-- 名前は常に揃える（どちらを選ぶのか画面で分かるように）。
UPDATE v3.document_templates
   SET label = '出版等利用許諾条件書（V3・一覧形式／作品が少ないとき）'
 WHERE template_key = 'pub_license_terms_v3'
   AND label <> '出版等利用許諾条件書（V3・一覧形式／作品が少ないとき）';

-- ---------------------------------------------------------------------
-- 【3】確認。2本とも有効で、本文の組み方が違うこと。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版番号,
       (position('別紙1　対象著作物一覧' in v.html_source) > 0) AS 別紙形式,
       (position('{{#each titles}}' in v.html_source) > 0)      AS 一覧あり,
       length(v.html_source) AS 本文の長さ
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex')
 ORDER BY t.template_key;
