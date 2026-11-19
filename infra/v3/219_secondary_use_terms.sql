-- =====================================================================
-- 219 二次利用追加条件書（secondary_use_terms）の登録
--
--   商品化・映像化・デジタルゲーム化その他の二次利用と、その再許諾の条件を定める追加条件書。
--   出版の基本契約は、これらの利用を「別途合意したときに限り許諾する」と定める。その別途合意を 1 枚にする。
--     ・出版等許諾基本契約書（pub_master_*）… 第4条第1項の「追加条件書」
--     ・著作物利用許諾基本契約書V5（license_master_v5）… 第3条の個別条件書（個別条件書の「二次利用」の行の別途合意）
--   当事者の呼び方（許諾者・被許諾者／甲・乙）と参照する条は、基本契約が V5 かどうかで出し分ける。
--
--   ・契約の画面で基本契約を開き、「二次利用追加条件書を作る」から作る（条件明細は先に要らない）。
--   ・利用（商品化・映像化 …）を 1 行ずつ並べる。決定のとき、行から条件明細（取得 IN の利用許諾）を作り、
--     この紙の個別契約（基本契約の下。番号は紙の番号）に載せる。
--   ・項目（入力欄）はコードが持つ（documents/secondary-use.ts の SECONDARY_USE_VARIABLES）。variables は空。
--   ・採番は SUT（ARC-SUT-年-連番）。分類は出版の条件書と同じ。
--   ・アプリ側は secondary_use_terms を扱う版が先に出ていること。
--
--   本文は infra/v3/templates/secondary_use_terms.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/219_secondary_use_terms.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'secondary_use_terms';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!-- secondary_use_terms r1 -->
<!--
  二次利用追加条件書（secondary_use_terms）。商品化・映像化・デジタルゲーム化その他の二次利用と、その再許諾の条件を定める。
  出版等許諾基本契約書（pub_master_*）では第4条第1項の「追加条件書」、著作物利用許諾基本契約書V5（license_master_v5）では
  第3条の個別条件書（個別利用許諾条件書の「二次利用」の行にいう別途合意）。当事者の呼び方と参照する条は isV5 で出し分ける。
  本番へは infra/v3/219 が運ぶ（infra/v3/tools/make-template-sql.mjs で本文から作る）。
  体裁は個別利用許諾条件書V5 と同じ（CSS を共有）。差し込みは secondaryUsePatch（documents/secondary-use.ts）の値。
-->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>二次利用追加条件書 {{docNo}}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 12mm 14mm 11mm;
    @top-right {
      content: "ARC-LICENSE / SECONDARY USE TERMS";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #888;
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-right {
      content: "{{docNo}}　二次利用追加条件書";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #777;
      vertical-align: top; padding-top: 3mm;
    }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif;
    font-size: 7pt; line-height: 1.5; color: #1c1c1c;
  }
  p { margin: 0 0 1.2mm; }
  .en { color: #777; font-weight: normal; letter-spacing: .04em; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .04em; }
  .title-en { font-size: 7pt; color: #777; margin: 0 0 3mm; letter-spacing: .08em; }

  /* 罫線は上の濃い線と行の下の薄い線だけ（縦線なし）。 */
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: .6mm 1.2mm; vertical-align: top; text-align: left; font-weight: normal; }
  .meta td { border-top: 1px solid #222; border-bottom: .5px solid #bebebe; }
  .meta .k, .party .k { color: #888; font-weight: bold; margin-right: 1.5em; }
  .meta b { font-weight: bold; }
  .parties { margin: 1.5mm 0 2mm; }
  .parties td { width: 50%; border-top: 1px solid #222; border-bottom: .5px solid #bebebe; padding: 1.2mm 1.5mm; }
  .party .k { display: block; margin: 0 0 .5mm; letter-spacing: .06em; }
  .party .name { font-weight: bold; }

  h2 { font-size: 9pt; margin: 3mm 0 1.2mm; padding-bottom: .6mm; border-bottom: 1px solid #222;
       break-after: avoid; page-break-after: avoid; }
  h2 .no { color: #999; font-size: 7.5pt; margin-right: 1.2em; }
  h2 .en { font-size: 6.5pt; margin-left: 1.2em; }
  h3 { font-size: 7pt; margin: 2.5mm 0 1mm; break-after: avoid; }

  .kv td { border-bottom: .5px solid #d0d0d0; }
  .kv tr:first-child td { border-top: .5px solid #555; }
  .kv td.k { width: 22mm; background: #f5f5f5; font-weight: bold; white-space: nowrap; }
  .kv tr { break-inside: avoid; page-break-inside: avoid; }

  .grid th { background: #f2f2f2; font-weight: bold; border-top: 1px solid #555; border-bottom: .5px solid #999; }
  .grid td { border-bottom: .5px solid #d0d0d0; }
  .grid td.c, .grid th.c { text-align: center; }
  .grid tr { break-inside: avoid; page-break-inside: avoid; }
  .grid thead { display: table-header-group; }
  .grid tfoot td { background: #f5f5f5; font-weight: bold; border-top: .5px solid #555; }
  .grid td.sub { color: #555; border-bottom: .5px solid #d0d0d0; }
  .grid tr.has-sub td { border-bottom: none; }
  .grid tr.memo td { background: #fafafa; color: #555; }
  .role { color: #777; display: block; }

  /* 許諾料の欄。取引モデルごとのカードを横に並べる。 */
  .cards { display: flex; gap: 2mm; margin: 1mm 0 2mm; break-inside: avoid; }
  .card { flex: 1; border-top: 1px solid #555; border-bottom: .5px solid #d0d0d0; padding: 1mm 1.5mm; }
  .card .en { display: block; color: #1c1c1c; font-weight: bold; letter-spacing: .06em; }
  .card .name { font-weight: bold; }
  .card .rate { margin-top: .6mm; }
  .card .rate b { font-size: 10pt; margin-left: .6em; }
  .card .f { color: #555; }

  .sign { margin-top: 4mm; break-inside: avoid; page-break-inside: avoid; }
  .sign td { width: 50%; border-top: 1px solid #222; padding: 1.5mm 1.5mm 2mm; }
  .sign td + td { padding-left: 5mm; }
  .sign .who { color: #888; font-weight: bold; letter-spacing: .06em; }
  .party-sign { display: flex; align-items: flex-start; gap: 3mm; min-height: 9mm; }
  .party-sign .names { flex: 1; }
  /* 印の枠。 */
  .stamp { width: 15mm; height: 15mm; border: .5px dashed #888; border-radius: 50%;
           display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 8pt; }
  /* 署名日・署名の枠。高さは 12pt 固定（CloudSign の入力欄をこの枠に合わせる）。 */
  .field { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
  .field .lbl { width: 10mm; color: #555; }
  .field .box { flex: 1; height: 12pt; box-sizing: border-box; border: .5px solid #999; }
  /* 記名＋署名／押印の枠（ハイブリッド）。名称・代表者を左に刷り、右に印の丸。署名はこの枠に重ねる。 */
  .field.seal-row { align-items: stretch; }
  .sign .field .lbl { width: 14mm; }
  .field.seal-row .lbl { line-height: 1.3; align-self: center; white-space: nowrap; }
  .field .sign-box { height: 17mm; display: flex; align-items: center; justify-content: space-between; padding: 0 2mm; }
  .sign-box .pname { line-height: 1.45; }
  .sign-box .stamp { width: 13mm; height: 13mm; flex: none; }
  /* 通知先は 12pt 固定の枠（1行。長い連絡先ははみ出さず切る）。 */
  .notice td { padding-top: 0; padding-bottom: 0; vertical-align: middle; }
  .notice .fix { height: 12pt; line-height: 12pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 通知先と署名欄は割らない（署名欄だけが次のページに送られないように）。 */
  .tail { break-inside: avoid; page-break-inside: avoid; }

  .annex { break-before: page; page-break-before: always; }
  /* 別紙の見出しは3つとも同じ形（本文の 01〜04 と同じ組み方で、少し大きく）。 */
  .annex h2 { font-size: 10pt; margin: 0 0 1.5mm; }
  .annex h2 .no { font-size: 8pt; }
  .annex .part + .part { margin-top: 6mm; }
  .lead { color: #555; }
  .grid th .l2 { display: block; font-weight: normal; font-size: 6.5pt; white-space: nowrap; }

  .grid td.s { white-space: nowrap; }
</style>
</head>
<body>

<h1>二次利用追加条件書</h1>
<p class="title-en">SECONDARY USE TERMS ／ 商品化・映像化・ゲーム化その他の二次利用と再許諾</p>

<table class="meta">
  <tr>
    <td><span class="k">ISSUED</span><b>{{formatDateDot signDate}}</b></td>
    <td><span class="k">NO.</span><b>{{docNo}}</b></td>
    <td>{{#if agreementNo}}<span class="k">MASTER</span><b>{{agreementNo}}</b>{{/if}}</td>
  </tr>
</table>

<table class="parties">
  <tr>
    <td class="party">
      <span class="k">LICENSOR / 許諾者{{#if isV5}}（甲）{{/if}}</span>
      <div class="name">{{licensorName}}</div>
      <div>{{licensorAddress}}</div>
      {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
      {{#if licensorInvoiceNo}}<div>登録番号 {{licensorInvoiceNo}}</div>{{/if}}
    </td>
    <td class="party">
      <span class="k">LICENSEE / 被許諾者{{#if isV5}}（乙）{{/if}}</span>
      <div class="name">{{licenseeName}}</div>
      <div>{{licenseeAddress}}</div>
      {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
      {{#if licenseeInvoiceNo}}<div>登録番号 {{licenseeInvoiceNo}}</div>{{/if}}
    </td>
  </tr>
</table>

<p>{{partyA}}と{{partyB}}は、両者間の{{agreementTitle}}{{#if agreementNo}}（{{agreementNo}}）{{/if}}（以下「基本契約」という。）に基づき、{{#if isV5}}基本契約第3条の個別条件書として{{else}}基本契約第4条第1項に定める追加条件書として{{/if}}、対象著作物の二次利用およびその再許諾の条件を以下のとおり定める。本書に定めのない事項は基本契約による。本書と基本契約が矛盾するときは本書が優先する。</p>

<h2><span class="no">01</span>対象著作物<span class="en">LICENSED WORKS</span></h2>
<table class="grid">
  <thead>
    <tr>
      <th class="c" style="width:7mm">No.</th>
      <th>原著作物名</th>
      <th style="width:42mm">著作権表示</th>
      <th style="width:40mm">出版の個別条件書</th>
    </tr>
  </thead>
  <tbody>
  {{#each works}}
    <tr><td class="c">{{no}}</td><td><b>{{title}}</b></td><td>{{copyright}}</td><td>{{termsNo}}</td></tr>
  {{/each}}
  </tbody>
</table>

<h2><span class="no">02</span>許諾する二次利用<span class="en">LICENSED SECONDARY USES</span></h2>
<p class="lead">{{#if isV5}}対象著作物の二次利用のうち、下表に記載したものに限り許諾する。下表に記載のない利用区分および利用態様は、本書の対象外とし、別途の合意による。本書は、対象著作物に係る個別利用許諾条件書の「二次利用」の行にいう別途合意とする。{{else}}基本契約第4条第1項各号の二次利用のうち、下表に記載したものに限り許諾する。下表に記載のない利用区分および利用態様は、本書の対象外とし、別途の追加条件書による（基本契約第4条第2項）。{{/if}}</p>
<table class="grid">
  <thead>
    <tr>
      <th class="c" style="width:7mm">No.</th>
      <th style="width:20mm">利用区分</th>
      <th>利用の内容（企画・商品）{{#if multiWorks}}／対象著作物{{/if}}</th>
      <th style="width:22mm">実施する者</th>
      <th class="c" style="width:13mm">独占区分</th>
      <th style="width:24mm">地域／言語</th>
      <th style="width:25mm">許諾期間</th>
    </tr>
  </thead>
  <tbody>
  {{#each uses}}
    <tr>
      <td class="c">{{code}}</td>
      <td><b>{{category}}</b>{{#if sublicensed}}<span class="role">再許諾</span>{{/if}}</td>
      <td>{{content}}{{#if workRef}}<span class="role">対象：{{workRef}}</span>{{/if}}</td>
      <td>{{actor}}</td>
      <td class="c">{{exclusivity}}</td>
      <td>{{scope}}</td>
      <td class="s">{{term}}</td>
    </tr>
  {{/each}}
  </tbody>
</table>

{{#if hasSublicense}}
<h2><span class="no">03</span>再許諾<span class="en">SUBLICENSE</span></h2>
<table class="kv">
  <tr><td class="k">再許諾の可否</td><td>{{partyB}}は、02 の {{subCodes}} について、下記の再許諾先に再許諾することができる（{{#if isV5}}基本契約第5条第1項{{else}}基本契約第4条第3項{{/if}}）。{{#if ownAllCodes}}{{ownAllCodes}} については、製造・流通の委託を除き、再許諾しない。{{/if}}</td></tr>
  <tr><td class="k">再許諾先</td><td>{{sublicensees}}</td></tr>
  {{#if mainTerms}}<tr><td class="k">主要条件</td><td>{{mainTerms}}</td></tr>{{/if}}
  <tr><td class="k">承諾</td><td>{{#if isV5}}本書は、上記の再許諾先および主要条件による再許諾について、基本契約第5条第1項に定める個別条件書の定め（甲の事前の書面承諾）とする。再許諾先、または主要条件のうち対価・地域・期間・媒体を変更するときは、乙は、あらためて甲の書面による承諾を得る。{{else}}本書の締結をもって、上記の再許諾先および主要条件について、基本契約第4条第4項に定める許諾者の書面による承諾があったものとする。再許諾先、または主要条件のうち対価・地域・期間・媒体を変更するときは、被許諾者は、あらためて同項の承諾を得る。{{/if}}</td></tr>
  <tr><td class="k">再許諾先の義務</td><td>{{#if isV5}}乙は、再許諾先に対し、基本契約と同等の義務（著作権表示の維持、生成AIの学習利用の制限を含む。）を課し、その行為について甲に対し責任を負う（基本契約第5条第2項）。{{else}}被許諾者は、再許諾先に対し、対象著作物の著作権および著作者人格権が許諾者に帰属する旨を契約書に明示し、著作権表示を維持する義務を課す（基本契約第4条第3項第1号・第2号）。再許諾先の行為について、被許諾者は許諾者に対し責任を負う（同条第6項）。{{/if}}</td></tr>
  <tr><td class="k">報告</td><td>{{partyB}}は、再許諾契約の締結後30日以内に、相手方・利用態様・条件の概要を{{partyA}}に書面（{{#if isV5}}電子メールを含む。{{else}}電磁的方法を含む。{{/if}}）で報告する{{#if isV5}}{{else}}（基本契約第4条第3項第3号）{{/if}}。</td></tr>
</table>
{{/if}}

<h2><span class="no">04</span>対価<span class="en">CONSIDERATION</span></h2>
<table class="kv">
  {{#each uses}}
  <tr><td class="k">{{code}}　{{feeLabel}}</td><td>{{feeText}}</td></tr>
  {{/each}}
  {{#if hasSublicense}}<tr><td class="k">受領した金額</td><td>再許諾先の所在国で源泉徴収された税額、海外送金に係る手数料および消費税相当額を控除した後の、{{partyB}}の実受領額とする。外貨で受領したときは、{{partyB}}の口座への着金額（円）による。</td></tr>{{/if}}
  <tr><td class="k">前払金</td><td>{{#if advanceText}}{{advanceText}}{{else}}なし。{{/if}}</td></tr>
</table>

<h2><span class="no">05</span>支払・報告<span class="en">PAYMENT / REPORT</span></h2>
<table class="kv">
  {{#if hasOwn}}<tr><td class="k">{{ownCodes}}　自社</td><td>製造のつど、{{payOwn}}までに支払う。</td></tr>{{/if}}
  {{#if hasSublicense}}<tr><td class="k">{{subCodes}}　再許諾</td><td>{{partyB}}が再許諾先から対価を受領した日を含む月の{{paySub}}までに支払う。</td></tr>{{/if}}
  {{#if hasFlat}}<tr><td class="k">{{flatCodes}}　定額</td><td>{{payFlat}}までに支払う。</td></tr>{{/if}}
  <tr><td class="k">報告・税</td><td>{{partyB}}は、支払のつど、利用区分ごとの数量・単価・受領額・料率を記載した明細を{{partyA}}に提出する。再許諾に係るものは、再許諾先から受領した報告の対象期間を併記する。消費税・源泉徴収・振込先・異議および監査は{{#if isV5}}基本契約第13条および第14条{{else}}基本契約第15条{{/if}}による。</td></tr>
</table>

<h2><span class="no">06</span>監修・承認<span class="en">APPROVAL</span></h2>
<table class="kv">
  <tr><td class="k">監修の対象</td><td>{{approvalTargets}}</td></tr>
  <tr><td class="k">回答の期限</td><td>{{partyA}}は、提出を受けた日から{{approvalDays}}営業日以内に、承認または修正の求め（理由を付す。）を回答する。{{#if approvalDeemed}}期限までに回答がないときは、{{partyB}}は書面で催告し、催告から{{approvalDeemedDays}}営業日以内に回答がないときは承認があったものとみなす。{{else}}期限までに回答がないときは、{{partyB}}は書面で催告し、{{partyA}}および{{partyB}}は、制作・発売の日程を踏まえて速やかに協議する。回答がないことのみをもって承認があったものとはみなさない。{{/if}}</td></tr>
  <tr><td class="k">人格権への配慮</td><td>二次利用に伴う改変は、対象著作物の本質的な特徴および{{partyA}}の名誉・声望を害しない範囲で行う（{{#if isV5}}基本契約第7条{{else}}基本契約第5条および第26条{{/if}}）。監修で承認した内容に従った改変について、{{partyA}}は異議を述べない。</td></tr>
</table>

<h2><span class="no">07</span>権利の帰属・著作権表示<span class="en">OWNERSHIP / CREDIT</span></h2>
<table class="kv">
  <tr><td class="k">原著作物の権利</td><td>対象著作物の著作権（著作権法第27条および第28条の権利を含む。）は{{partyA}}に留保される。本書による許諾は、02 に記載した範囲に限る。</td></tr>
  <tr><td class="k">二次的著作物</td><td>二次利用により{{partyB}}または再許諾先が新たに創作した部分（商品のデザイン、映像、脚本、音楽等）の権利は、その創作者または{{partyB}}・再許諾先間の契約の定める者に帰属する。ただし、対象著作物に係る{{partyA}}の権利を制限しない。</td></tr>
  <tr><td class="k">著作権表示</td><td>{{partyB}}は、商品・映像その他の成果物および宣伝素材に、01 の著作権表示{{#if creditText}}および「{{creditText}}」の表示{{/if}}を行い、再許諾先にも行わせる（{{#if isV5}}基本契約第16条{{else}}基本契約第24条{{/if}}）。</td></tr>
</table>

<h2><span class="no">08</span>終了時の取扱い<span class="en">TERMINATION</span></h2>
<table class="kv">
  {{#if isV5}}
  <tr><td class="k">在庫・配信</td><td>基本契約または本書が期間満了により終了したときの取扱いは、基本契約第24条による（製造済みの商品は終了日から{{sellOffMonths}}か月間販売できる。終了日以後の新規の配信は停止し、終了日までの購入者の利用の維持は継続できる）。</td></tr>
  <tr><td class="k">再許諾先</td><td>乙は、終了を再許諾先に通知し、前行と同じ取扱いを求める（基本契約第24条第1項第3号）。</td></tr>
  {{else}}
  <tr><td class="k">在庫・配信</td><td>基本契約または本書が期間満了により終了したときは、被許諾者は、終了日に製造済みの商品を終了日から{{sellOffMonths}}か月間販売することができる。終了日以後の新規の放送・配信は停止し、終了日までの購入者の利用の維持（再ダウンロード、更新データの提供等）は継続することができる。これらの対価は 04 による。被許諾者は、終了日から30日以内に在庫数を許諾者に報告する。</td></tr>
  <tr><td class="k">再許諾先</td><td>被許諾者は、再許諾先に速やかに許諾の終了を通知し、前行と同じ取扱いを求める（基本契約第4条第5項）。</td></tr>
  {{/if}}
</table>

<h2><span class="no">09</span>特約事項<span class="en">SPECIAL TERMS</span></h2>
{{#if specialNotes}}<p>{{specialNotes}}</p>{{else}}<p>なし</p>{{/if}}

<div class="tail">
<h2><span class="no">10</span>通知先<span class="en">NOTICES</span></h2>
<table class="kv notice">
  <tr><td class="k"><div class="fix">{{partyA}}</div></td><td><div class="fix">{{licensorContact}}</div></td></tr>
  <tr><td class="k"><div class="fix">{{partyB}}</div></td><td><div class="fix">{{licenseeContact}}</div></td></tr>
</table>

{{#if showSignature}}
<table class="sign">
  <tr>
    <td>
      <span class="who">LICENSOR / 許諾者{{#if isV5}}（甲）{{/if}}</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licensorName}}</b>{{#if licensorRep}}<br>{{licensorRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
    <td>
      <span class="who">LICENSEE / 被許諾者{{#if isV5}}（乙）{{/if}}</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licenseeName}}</b>{{#if licenseeRep}}<br>{{licenseeRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
  </tr>
</table>
{{/if}}
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'pub_license_terms_v3';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'secondary_use_terms';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('secondary_use_terms', '二次利用追加条件書', base_category, 'SUT', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'SUT'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '219: 二次利用追加条件書は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '219: 二次利用追加条件書', 'sql:219')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '219: 二次利用追加条件書を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '<!-- secondary_use_terms r1 -->') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'secondary_use_terms';
