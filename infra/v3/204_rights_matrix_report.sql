-- =====================================================================
-- 204 許諾地域・許諾言語レポート（rights_matrix_report）の登録
--
--   作品の「地域×言語」の表（ライセンスマトリクス。作品 › 地域×言語、作品台帳 › 地域×言語の一覧）を
--   紙（HTML・PDF）にする帳票。A4 横。
--
--   ・1 通のひな形で 2 つの形を描く：作品 1 点（行＝許諾地域・列＝許諾言語）と、
--     作品をまたぐ一覧（行＝作品・列＝許諾言語。地域を選ぶか、全地域を畳む）。
--   ・マス＝そこを覆う OUT の利用許諾（取引先名）。作者から取った範囲と照らし、
--     独占のぶつかり・範囲外・空きを色と印（✕ △ ◉ ○）で出す。作品 1 点には「要確認」と「許諾の一覧」も付く。
--   ・値は apps/legalbridge-v3/src/server/works/rights-matrix-report.ts が組み立てる（集計は画面と同じ rights-matrix.ts）。
--   ・登録しなくても画面は既定の本文（works/rights-matrix-report-template.ts）で描ける。
--     登録すると DB の現行版で描く（本文の手直しを版で残せる）。
--
--   本文は infra/v3/templates/rights_matrix_report.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/204_rights_matrix_report.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'rights_matrix_report';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!DOCTYPE html>
{{!-- 許諾地域・許諾言語レポート（rights_matrix_report）。作品の「地域×言語」の表（ライセンスマトリクス）を紙にする。
     1 通で 2 つの形を描く：
       isWork  … 作品 1 点。行＝許諾地域・列＝許諾言語・マス＝そこを覆う OUT の利用許諾。作者から取った範囲と照らす。
       それ以外 … 作品をまたぐ一覧。行＝作品・列＝許諾言語。地域を選べばその地域、選ばなければ全地域を畳む。
     値は apps/legalbridge-v3/src/server/works/rights-matrix-report.ts が組み立てる（画面と同じ集計 rights-matrix.ts）。
     本文は infra/v3/templates/rights_matrix_report.html（204 で登録）。 --}}
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>許諾地域・許諾言語レポート</title>
<style>
  @page { size: A4 landscape; margin: 11mm 12mm 13mm; }
  body { font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; font-size: 9pt; line-height: 1.5; color: #222; margin: 0; padding: 14px;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1.doc-title { font-size: 16pt; margin: 0 0 2px; letter-spacing: .2em; font-weight: 700; text-align: center; border: 0; }
  .doc-head { text-align: center; margin-bottom: 6px; }
  .doc-sub { font-size: 9pt; color: #444; }
  .doc-meta { font-size: 8.5pt; text-align: right; margin: 0 0 6px; color: #444; }
  .doc-meta b { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  hr.rule { border: none; border-top: 1px solid #333; margin: 0 0 10px; }
  table { border-collapse: collapse; }
  p.section-mark { font-size: 9.5pt; font-weight: 700; margin: 10px 0 4px; padding: 0 0 2px; border: 0; border-bottom: 1px solid #bdbdbd; page-break-after: avoid; }
  table.summary { width: 100%; font-size: 8.5pt; margin: 0; }
  table.summary th, table.summary td { border: 1px solid #d9d9d9; padding: 4px 7px; vertical-align: top; text-align: left; }
  table.summary th { background: #f4f4f2; width: 14%; font-weight: 600; color: #333; white-space: nowrap; }
  table.summary td { width: 36%; }
  .muted { color: #666; }
  .count { display: inline-block; padding: 0 6px; margin-right: 6px; border: 1px solid #bbb; border-radius: 3px; font-size: 8pt; white-space: nowrap; }
  .count.conflict { border-color: #c04040; color: #a12020; background: #fbe1e1; }
  .count.outside { border-color: #c48a1a; color: #8a5a00; background: #fdf0d5; }
  .count.open { border-color: #7aa83c; color: #4d7a1f; background: #f1f7e8; }
  .alert { border: 1px solid #e0b0b0; background: #fdf3f3; padding: 5px 8px; margin: 0 0 6px; font-size: 8.5pt; }
  .alert ul { margin: 2px 0 0; padding-left: 1.3em; }
  .alert li { margin: 1px 0; }
  table.matrix { width: 100%; font-size: 8pt; margin: 0; table-layout: auto; }
  table.matrix th, table.matrix td { border: 1px solid #c9c9c9; padding: 3px 5px; vertical-align: top; line-height: 1.35; }
  table.matrix thead th { background: #f4f4f2; font-weight: 600; color: #333; text-align: center; white-space: nowrap; }
  table.matrix thead { display: table-header-group; }
  table.matrix tbody th { background: #fafaf8; font-weight: 600; text-align: left; white-space: nowrap; }
  table.matrix tbody th.work { white-space: normal; min-width: 11em; max-width: 18em; }
  table.matrix th.other { color: #777; font-weight: 400; font-style: italic; }
  table.matrix tr { page-break-inside: avoid; }
  td.cell { min-width: 6.5em; }
  td.cell .mark { display: block; font-size: 7pt; font-weight: 700; letter-spacing: .02em; }
  td.cell .name { display: block; white-space: nowrap; }
  td.cell .more { display: block; font-size: 7pt; color: #666; }
  td.cell .open-regions { display: block; font-size: 7pt; color: #4d7a1f; }
  td.cell.exclusive { background: #dde8f7; } td.cell.exclusive .mark { color: #1f4e96; }
  td.cell.non_exclusive { background: #e6f1ea; } td.cell.non_exclusive .mark { color: #2f6b45; }
  td.cell.open { background: #f1f7e8; } td.cell.open .mark { color: #4d7a1f; }
  td.cell.conflict { background: #fbe1e1; } td.cell.conflict .mark { color: #a12020; }
  td.cell.outside { background: #fdf0d5; } td.cell.outside .mark { color: #8a5a00; }
  td.cell.none { background: #fff; color: #999; } td.cell.none .mark { color: #999; font-weight: 400; }
  td.cell.dim { opacity: .4; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 8pt; color: #444; margin: 5px 0 0; }
  .legend .sw { display: inline-block; width: 11px; height: 11px; border: 1px solid #999; border-radius: 2px; vertical-align: -1px; margin-right: 4px; }
  .sw.exclusive { background: #dde8f7; } .sw.non_exclusive { background: #e6f1ea; } .sw.open { background: #f1f7e8; }
  .sw.conflict { background: #fbe1e1; } .sw.outside { background: #fdf0d5; } .sw.none { background: #fff; }
  .work-code { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-size: 7.5pt; color: #555; font-weight: 400; }
  .tag { display: inline-block; font-size: 7pt; padding: 0 4px; border: 1px solid #bbb; border-radius: 2px; color: #444; margin-right: 3px; font-weight: 400; }
  .tag.conflict { border-color: #c04040; color: #a12020; } .tag.outside { border-color: #c48a1a; color: #8a5a00; } .tag.warn { border-color: #c48a1a; color: #8a5a00; }
  table.items { width: 100%; font-size: 8pt; margin: 0; }
  table.items th, table.items td { border: 1px solid #d9d9d9; padding: 3px 6px; vertical-align: top; line-height: 1.4; }
  table.items th { background: #f4f4f2; font-weight: 600; color: #333; text-align: center; white-space: nowrap; }
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }
  td.center { text-align: center; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }
  .no { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-weight: 500; }
  .sub { font-size: 7.5pt; color: #666; }
  .remarks { font-size: 8pt; color: #555; margin-top: 10px; }
  .remarks ol { margin: 2px 0 0; padding-left: 1.4em; }
  .remarks li { margin: 1px 0; }
</style>
</head>
<body data-layout="rmr-v1-2026-11">

<!-- ===== ヘッダ ===== -->
<div class="doc-head">
  <h1 class="doc-title">許諾地域・許諾言語レポート</h1>
  <div class="doc-sub">{{SUBTITLE}}</div>
</div>
<div class="doc-meta">{{#if DOC_NO}}文書番号: <b>{{DOC_NO}}</b>　　{{/if}}基準日: {{formatDate today}}　　作成日: {{formatDate documentDate}}{{#if COMPANY_NAME}}　　{{COMPANY_NAME}}{{/if}}</div>
<hr class="rule">

{{#if isWork}}
<!-- ===== 作品 1 点 ===== -->
<p class="section-mark">■ 概要</p>
<table class="summary">
  <tr>
    <th>作品</th><td>{{work.title}}{{#if work.derivedNote}}<div class="sub">{{work.derivedNote}}</div>{{/if}}</td>
    <th>許諾</th><td>{{summary.grants}} 本（取引先 {{summary.parties}} 社）{{#if includeEnded}}　<span class="muted">終わった許諾を含む</span>{{/if}}</td>
  </tr>
  <tr>
    <th>作者から取った範囲</th>
    <td>{{#if acquired.known}}地域 {{acquired.regions}} ／ 言語 {{acquired.languages}}{{else}}<span class="muted">作者の条件（IN）が無いので分かりません。空き・範囲外は出していません</span>{{/if}}</td>
    <th>マスの内訳</th>
    <td>
      <span class="count">許諾あり {{summary.granted}}</span>{{#if acquired.known}}<span class="count open">空き {{summary.open}}</span>{{/if}}{{#if summary.conflict}}<span class="count conflict">ぶつかり {{summary.conflict}}</span>{{/if}}{{#if summary.outside}}<span class="count outside">範囲外 {{summary.outside}}</span>{{/if}}
    </td>
  </tr>
  {{#if partyFilter}}
  <tr><th>取引先で絞る</th><td colspan="3">{{partyFilter}}（ほかの取引先だけのマスは薄く出しています）</td></tr>
  {{/if}}
</table>

{{#if issues.length}}
<p class="section-mark">■ 要確認</p>
<div class="alert">
  <ul>
    {{#each issues}}<li><b>{{place}}</b>　{{text}}</li>{{/each}}
  </ul>
</div>
{{/if}}

<p class="section-mark">■ 許諾地域 × 許諾言語</p>
{{#if rows.length}}
<table class="matrix">
  <thead>
    <tr>
      <th>地域 ＼ 言語</th>
      {{#each languages}}<th{{#if other}} class="other"{{/if}}>{{label}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each rows}}
    <tr>
      <th{{#if other}} class="other"{{/if}}>{{label}}</th>
      {{#each cells}}
      <td class="cell {{state}}{{#if dim}} dim{{/if}}">
        <span class="mark">{{mark}}</span>
        {{#each names}}<span class="name">{{this}}</span>{{/each}}
        {{#if more}}<span class="more">ほか {{more}}</span>{{/if}}
      </td>
      {{/each}}
    </tr>
    {{/each}}
  </tbody>
</table>
{{else}}
<p class="muted">この作品には、許諾（OUT の利用許諾の条件）も作者の条件もありません。</p>
{{/if}}
<div class="legend">
  {{#each legend}}<span><span class="sw {{state}}"></span>{{mark}}：{{label}}</span>{{/each}}
</div>

{{#if grants.length}}
<p class="section-mark">■ 許諾の一覧</p>
<table class="items">
  <thead>
    <tr>
      <th style="width:3%">No.</th>
      <th style="width:16%">取引先</th>
      <th style="width:16%">条件</th>
      <th style="width:9%">利用形態</th>
      <th style="width:7%">独占</th>
      <th style="width:15%">期間</th>
      <th>許諾地域</th>
      <th>許諾言語</th>
    </tr>
  </thead>
  <tbody>
    {{#each grants}}
    <tr>
      <td class="center">{{index}}</td>
      <td><b>{{partyName}}</b>{{#if workTitle}}<div class="sub">作品：{{workTitle}}</div>{{/if}}</td>
      <td><span class="no">{{conditionNo}}</span><div class="sub">{{name}}</div></td>
      <td class="center">{{usageLabel}}</td>
      <td class="center">{{exclText}}</td>
      <td class="nowrap">{{termText}}{{#if flag}}<div class="sub">{{flag}}</div>{{/if}}</td>
      <td>{{regionsText}}</td>
      <td>{{languagesText}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>
{{/if}}

{{else}}
<!-- ===== 作品をまたぐ一覧 ===== -->
<p class="section-mark">■ 概要</p>
<table class="summary">
  <tr>
    <th>作品</th><td>{{summary.works}} 作品{{#if summary.truncated}}<span class="muted">（多いので先頭 {{summary.shown}} 作品だけ載せています）</span>{{/if}}</td>
    <th>内訳</th>
    <td>
      {{#if summary.conflict}}<span class="count conflict">ぶつかりのある作品 {{summary.conflict}}</span>{{/if}}{{#if summary.outside}}<span class="count outside">範囲外のある作品 {{summary.outside}}</span>{{/if}}<span class="count open">空きのある作品 {{summary.open}}</span>
    </td>
  </tr>
  <tr>
    <th>絞り込み</th>
    <td colspan="3">{{#each filters}}<span class="count">{{label}}：{{value}}</span>{{/each}}</td>
  </tr>
</table>

<p class="section-mark">■ 作品 × 許諾言語{{#if regionLabel}}（地域：{{regionLabel}}）{{else}}（全地域を畳む）{{/if}}</p>
{{#if rows.length}}
<table class="matrix">
  <thead>
    <tr>
      <th>作品 ＼ 言語</th>
      {{#each languages}}<th{{#if other}} class="other"{{/if}}>{{label}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each rows}}
    <tr>
      <th class="work">
        {{title}}
        <div>{{#if workCode}}<span class="work-code">{{workCode}}</span> {{/if}}<span class="tag">{{categoryLabel}}</span>{{#if derived}}<span class="tag">派生 {{derived}}</span>{{/if}}{{#if conflict}}<span class="tag conflict">ぶつかり</span>{{/if}}{{#if outside}}<span class="tag outside">範囲外</span>{{/if}}{{#unless acquiredKnown}}<span class="tag warn">取った範囲不明</span>{{/unless}}</div>
      </th>
      {{#each cells}}
      <td class="cell {{state}}{{#if dim}} dim{{/if}}">
        <span class="mark">{{mark}}</span>
        {{#each names}}<span class="name">{{this}}</span>{{/each}}
        {{#if more}}<span class="more">ほか {{more}}</span>{{/if}}
        {{#if openRegions}}<span class="open-regions">空き {{openRegions}} 地域</span>{{/if}}
      </td>
      {{/each}}
    </tr>
    {{/each}}
  </tbody>
</table>
{{else}}
<p class="muted">当てはまる作品がありません。</p>
{{/if}}
<div class="legend">
  {{#each legend}}<span><span class="sw {{state}}"></span>{{mark}}：{{label}}</span>{{/each}}
</div>
{{/if}}

{{#if remarks}}
<div class="remarks">
  <b>備考</b>
  <div style="white-space:pre-wrap;">{{remarks}}</div>
</div>
{{/if}}

<div class="remarks">
  <ol>
    <li>許諾は、作品と派生作品（言語版など）の OUT の利用許諾の条件（有効・予定）です。{{#unless includeEnded}}基準日より前に終わった許諾は載せていません。{{/unless}}</li>
    <li>地域・言語を挙げていない条件は、その次元が無制限（全世界・全言語）として全部のマスを覆います。「その他の地域」「その他の言語」は表に出ていない国・言語のまとめで、全世界・全言語の許諾だけが覆います。</li>
    <li>「ぶつかり」は、独占の許諾が期間の重なるほかの取引先の許諾と同じマスにあること。「範囲外」は、作者から取った範囲（作者の条件の地域・言語）の外で許諾していること。「空き」は、取った範囲の内でまだ誰にも許諾していないマスです。</li>
    {{#unless isWork}}<li>地域を選ばないときは、その言語の全地域を畳んで、いちばん気にすべき状態（ぶつかり → 範囲外 → 独占 → 非独占 → 空き）で出します。派生作品の許諾は元の作品の行にまとめています。</li>{{/unless}}
  </ol>
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[{"name":"remarks","label":"備考","type":"textarea","group":"備考","helpText":"表の下に出る。画面（作品台帳 › 地域×言語 → レポート）で入れる"}]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'payment_report';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'rights_matrix_report';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('rights_matrix_report', '許諾地域・許諾言語レポート', base_category, 'RMR', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'RMR'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '204: 許諾地域・許諾言語レポートは登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '204: 許諾地域・許諾言語レポート', 'sql:204')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '204: 許諾地域・許諾言語レポートを版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, 'data-layout="rmr-v1') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'rights_matrix_report';
