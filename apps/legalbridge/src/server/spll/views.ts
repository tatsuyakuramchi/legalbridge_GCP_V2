/**
 * SPLL 公開サイトのHTML描画。
 *
 * クリエーター（申請する側）向けの画面なので、LegalBridgeの管理UIとは切り離した
 * 独立ページとして配信する。外部CDNへ依存せず、CSSはこのファイル内で完結させる。
 */

import {
  SAMPLE_FEES, type SpllCertificate, type SpllFeeRule, type SpllWork
} from "./sample-data.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character] as string));
}

const STYLES = `
:root{
  --ink:#14201D;--paper:#ECEFEE;--surface:#FFFFFF;--surface2:#F5F7F6;
  --line:#D2D9D6;--line2:#E6EBEA;--soft:#5C6663;--faint:#8A9491;
  --teal:#0E6E63;--teal-bg:#E2F0ED;
  --pass:#2F7D5B;--pass-bg:#E2F0E9;--review:#B6661E;--review-bg:#F6E7D6;
  --fail:#A6342F;--fail-bg:#F3DEDC;
  --sans:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic Medium","Yu Gothic",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --ink:#DFE7E4;--paper:#0E1614;--surface:#16211E;--surface2:#1C2825;
    --line:#2A3835;--line2:#233330;--soft:#93A19D;--faint:#6E7C79;
    --teal:#5CB8A8;--teal-bg:#12332E;
    --pass:#6BC095;--pass-bg:#123026;--review:#E0A063;--review-bg:#33240F;
    --fail:#E38A83;--fail-bg:#361A18;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--teal)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
header.site{background:#14201D;color:#E7EEEC}
header.site .in{max-width:1000px;margin:0 auto;padding:14px 22px;display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}
header.site a{color:#E7EEEC;text-decoration:none}
.brand{display:flex;align-items:center;gap:10px;font-weight:700}
.brand .mark{width:30px;height:30px;border:2px solid #4FB3A3;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#4FB3A3;font-size:11px;font-family:var(--mono)}
.brand small{display:block;font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:#7FA39C;font-weight:400}
header.site nav{display:flex;gap:16px;font-size:13px}
header.site nav a[aria-current="page"]{border-bottom:2px solid #4FB3A3}
main{max-width:1000px;margin:0 auto;padding:26px 22px 72px}
h1{font-size:22px;margin:0 0 6px;text-wrap:balance}
h2{font-size:17px;margin:28px 0 8px}
h3{font-size:14px;margin:0}
p.lede{color:var(--soft);margin:0 0 20px;max-width:70ch}
.demo{background:var(--review-bg);color:var(--review);border-radius:8px;padding:9px 13px;font-size:12px;margin-bottom:20px;font-weight:600}
.card{background:var(--surface);border:1px solid var(--line);border-radius:11px;margin-bottom:14px;overflow:hidden}
.card .head{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--surface2);display:flex;gap:10px;align-items:center;justify-content:space-between}
.card .body{padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 8px;padding:0;list-style:none;counter-reset:step}
.steps li{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.steps li b{display:block;margin-bottom:4px}
.steps li span{color:var(--soft);font-size:12.5px}
.steps li::before{counter-increment:step;content:"STEP " counter(step);display:block;font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--faint);margin-bottom:6px}
.tblwrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:460px}
th{background:var(--surface2);text-align:left;padding:9px 13px;font-family:var(--mono);font-size:11px;color:var(--soft);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 13px;border-bottom:1px solid var(--line2);font-size:13px;vertical-align:top}
tr:last-child td{border-bottom:none}
td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.tag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:20px;padding:2px 9px;margin:0 4px 4px 0;color:var(--soft)}
.tag.ok{background:var(--pass-bg);color:var(--pass);border-color:transparent}
.tag.no{background:var(--fail-bg);color:var(--fail);border-color:transparent}
.pill{display:inline-block;font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px}
.pill.ok{background:var(--pass-bg);color:var(--pass)}
.pill.hold{background:var(--review-bg);color:var(--review)}
.pill.no{background:var(--fail-bg);color:var(--fail)}
.btn{display:inline-block;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;text-decoration:none}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff}
form.search{display:flex;gap:8px;flex-wrap:wrap}
form.search input{flex:1;min-width:200px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit;background:var(--surface);color:var(--ink)}
.note{background:var(--teal-bg);border-left:3px solid var(--teal);border-radius:8px;padding:11px 14px;font-size:12.5px;margin-top:14px}
.verdict{text-align:center;padding:36px 20px}
.verdict .glyph{font-size:38px;line-height:1}
.verdict h1{margin:10px 0 4px}
.meta{display:inline-block;text-align:left;border:1px solid var(--line);border-radius:10px;padding:14px 18px;background:var(--surface2);margin-top:18px}
.meta dt{font-family:var(--mono);font-size:11px;color:var(--soft);margin-top:10px}
.meta dt:first-child{margin-top:0}
.meta dd{margin:2px 0 0;font-size:14px}
footer.site{border-top:1px solid var(--line);margin-top:40px}
footer.site .in{max-width:1000px;margin:0 auto;padding:20px 22px;color:var(--soft);font-size:12px;display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between}
@media(max-width:640px){main{padding:20px 16px 56px}header.site .in{padding:12px 16px}}
`;

export interface LayoutOptions {
  basePath: string;
  title: string;
  current?: string;
  demo?: boolean;
}

export function layout(options: LayoutOptions, content: string): string {
  const base = options.basePath;
  const nav = [
    { href: `${base}/`, label: "ホーム", key: "home" },
    { href: `${base}/works`, label: "原作をさがす", key: "works" },
    { href: `${base}/apply`, label: "申込の流れ", key: "apply" },
    { href: `${base}/verify`, label: "認証の確認", key: "verify" }
  ];
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} | SPLL</title>
<style>${STYLES}</style>
</head>
<body>
<header class="site"><div class="in">
  <a class="brand" href="${escapeHtml(base)}/">
    <span class="mark">SPLL</span>
    <span>TRPG二次創作ライセンス<small>SPLL LICENSE PORTAL</small></span>
  </a>
  <nav>${nav.map((item) =>
    `<a href="${escapeHtml(item.href)}"${options.current === item.key ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`
  ).join("")}</nav>
</div></header>
<main>
${options.demo === false ? "" : '<div class="demo">デモ環境です。表示している原作・料金・認証はサンプルで、実際の申込はできません。</div>'}
${content}
</main>
<footer class="site"><div class="in">
  <span>SPLL ― TRPGライツ事務局</span>
  <span class="mono">demo build</span>
</div></footer>
</body>
</html>`;
}

export function homePage(basePath: string, works: SpllWork[]): string {
  return layout({ basePath, title: "TRPG二次創作ライセンス", current: "home" }, `
<h1>二次創作を、権利者の許諾を受けて頒布する</h1>
<p class="lede">SPLLは、TRPG作品の二次創作について権利者との利用許諾契約をオンラインで結べる制度です。申込から契約締結までクラウドサイン上で完結し、締結後は作品の提出と認証バッジの受け取りまでご案内します。</p>

<h2>お手続きの流れ</h2>
<ol class="steps">
  <li><b>原作と利用目的を選ぶ</b><span>利用できる要素と利用許諾料が、選んだ時点で確定します。</span></li>
  <li><b>契約書に署名する</b><span>条件が反映された契約書がクラウドサインから届きます。同意した時点で契約成立です。</span></li>
  <li><b>利用許諾料をお支払い</b><span>締結後、お手続き案内ページのURLをメールでお送りします。</span></li>
  <li><b>作品を提出・認証を受け取る</b><span>審査を通ると、SPLL番号入りの認証バッジとQRを発行します。</span></li>
</ol>
<div class="note"><b>法人のお客様へ：</b>本窓口は個人（個人事業主を含む）専用です。法人でのご利用は個別契約となりますので、事務局までお問い合わせください。</div>

<h2>受付中の原作</h2>
<div class="grid">
${works.map((work) => `
  <div class="card"><div class="head"><h3>${escapeHtml(work.workName)}</h3></div><div class="body">
    <p style="margin:0 0 8px;color:var(--soft);font-size:12.5px">${escapeHtml(work.publisher)}</p>
    ${work.okElements.map((element) => `<span class="tag ok">${escapeHtml(element)}</span>`).join("")}
    <p style="margin:12px 0 0"><a class="btn" href="${escapeHtml(basePath)}/works/${encodeURIComponent(work.workId)}">条件を見る</a></p>
  </div></div>`).join("")}
</div>
<p style="margin-top:16px"><a class="btn primary" href="${escapeHtml(basePath)}/works">すべての原作をさがす →</a></p>
`);
}

export function worksPage(basePath: string, works: SpllWork[], query: string): string {
  return layout({ basePath, title: "原作をさがす", current: "works" }, `
<h1>原作をさがす</h1>
<p class="lede">作品名・権利者・利用できる要素から検索できます。原作ごとに、利用できる要素とできないこと、必要なクレジット表記が定められています。</p>

<div class="card"><div class="body">
  <form class="search" method="get" action="${escapeHtml(basePath)}/works">
    <input type="search" name="q" value="${escapeHtml(query)}" placeholder="作品名・権利者で検索" aria-label="原作を検索">
    <button class="btn primary" type="submit">検索</button>
  </form>
</div></div>

${works.length === 0
    ? `<div class="card"><div class="body">「${escapeHtml(query)}」に一致する原作は見つかりませんでした。</div></div>`
    : `<div class="card"><div class="tblwrap"><table>
  <thead><tr><th>原作</th><th>権利者</th><th>利用できる要素</th><th>できないこと</th><th></th></tr></thead>
  <tbody>${works.map((work) => `
    <tr>
      <td><b>${escapeHtml(work.workName)}</b><br><span class="mono" style="font-size:11px;color:var(--soft)">${escapeHtml(work.workId)}</span></td>
      <td>${escapeHtml(work.publisher)}</td>
      <td>${work.okElements.map((element) => `<span class="tag ok">${escapeHtml(element)}</span>`).join("")}</td>
      <td>${work.noElements.map((element) => `<span class="tag no">${escapeHtml(element)}</span>`).join("")}</td>
      <td><a class="btn" href="${escapeHtml(basePath)}/works/${encodeURIComponent(work.workId)}">詳細</a></td>
    </tr>`).join("")}</tbody>
</table></div></div>`}
`);
}

export function workDetailPage(basePath: string, work: SpllWork): string {
  return layout({ basePath, title: work.workName, current: "works" }, `
<h1>${escapeHtml(work.workName)}</h1>
<p class="lede">${escapeHtml(work.publisher)}　／　権利者：${escapeHtml(work.licensor)}　／　${escapeHtml(work.category)}</p>

<div class="grid">
  <div class="card"><div class="head"><h3>利用できる要素</h3></div><div class="body">
    ${work.okElements.map((element) => `<span class="tag ok">${escapeHtml(element)}</span>`).join("")}
  </div></div>
  <div class="card"><div class="head"><h3>できないこと</h3></div><div class="body">
    ${work.noElements.map((element) => `<span class="tag no">${escapeHtml(element)}</span>`).join("")}
  </div></div>
</div>

<div class="card"><div class="head"><h3>クレジット表記</h3></div><div class="body">
  ${escapeHtml(work.creditText)}
  <div class="note">頒布物には、権利者が指定するクレジット表記と<b>SPLL番号</b>を掲載していただきます。認証バッジにはSPLL番号とQRが入ります。</div>
</div></div>

<h2>利用目的と利用許諾料</h2>
${feeTable(SAMPLE_FEES)}
<p style="margin-top:16px"><a class="btn primary" href="${escapeHtml(basePath)}/apply?work=${encodeURIComponent(work.workId)}">この原作で申込の流れを見る →</a></p>
`);
}

export function feeTable(fees: SpllFeeRule[]): string {
  return `<div class="card"><div class="tblwrap"><table>
  <thead><tr><th>利用目的</th><th>利用許諾料</th><th>許諾される利用</th><th>お支払い</th><th>報告</th></tr></thead>
  <tbody>${fees.map((fee) => `
    <tr>
      <td><b>${escapeHtml(fee.usageCategory)}</b></td>
      <td class="num">${escapeHtml(fee.feeLabel)}</td>
      <td>${escapeHtml(fee.licensedUses)}</td>
      <td>${escapeHtml(fee.paymentDue)}</td>
      <td>${escapeHtml(fee.reportingRequirement)}<br><span style="color:var(--soft);font-size:12px">期限：${escapeHtml(fee.reportDue)}</span></td>
    </tr>`).join("")}</tbody>
</table></div></div>`;
}

export function applyPage(basePath: string, work: SpllWork | undefined): string {
  return layout({ basePath, title: "申込の流れ", current: "apply" }, `
<h1>申込の流れ</h1>
<p class="lede">SPLLの申込は、条件の確認からクラウドサインでの署名までを一度に行います。契約はクラウドサイン上で同意した時点で成立します。</p>

${work ? `<div class="card"><div class="head"><h3>選択中の原作</h3></div><div class="body">
  <b>${escapeHtml(work.workName)}</b>　<span style="color:var(--soft)">${escapeHtml(work.publisher)}</span>
</div></div>` : ""}

<ol class="steps">
  <li><b>条件を確認する</b><span>原作ごとの利用できる要素・クレジット表記・利用許諾料をご確認ください。</span></li>
  <li><b>同意して契約者情報を入力</b><span>個人情報の取得同意・ガイドライン・利用規約に同意のうえ、クラウドサインのフォームでお名前とご連絡先を入力します。</span></li>
  <li><b>契約書に署名</b><span>選んだ条件が反映された契約書が届きます。内容をご確認のうえ同意してください。</span></li>
  <li><b>案内メールを受け取る</b><span>締結後、お支払い・作品提出・認証バッジをまとめたご案内ページのURLをお送りします。</span></li>
</ol>

<div class="card"><div class="head"><h3>申込に進む</h3></div><div class="body">
  <p style="margin:0 0 12px">デモ環境では、契約の作成とクラウドサインへの引き渡しは行いません。実運用では、ここから契約者情報の入力画面へ進みます。</p>
  <a class="btn" aria-disabled="true" href="${escapeHtml(basePath)}/apply">契約者情報の入力へ（デモでは無効）</a>
  <div class="note"><b>ご注意：</b>本窓口は<b>個人（個人事業主を含む）</b>専用です。法人でのご利用は標準契約とは別の個別契約となるため、事務局へお問い合わせください。</div>
</div></div>

<h2>利用目的別の利用許諾料</h2>
${feeTable(SAMPLE_FEES)}
<div class="note">定額の区分は<b>契約単位</b>です。原作を複数選んでも料金は増えず、権利者へ均等に分配されます。</div>
`);
}

export function verifyIndexPage(basePath: string, certificates: SpllCertificate[]): string {
  return layout({ basePath, title: "認証の確認", current: "verify" }, `
<h1>認証の確認</h1>
<p class="lede">頒布物に掲載されたSPLL番号が有効な許諾に基づくものかを確認できます。通常は認証バッジのQRコードから直接開きます。</p>
<div class="card"><div class="head"><h3>デモ用の認証</h3></div><div class="body">
  <p style="margin:0 0 10px">動作確認用に、状態の異なる認証を用意しています。</p>
  ${certificates.map((certificate) => `
    <p style="margin:0 0 8px"><a class="btn" href="${escapeHtml(basePath)}/v/${encodeURIComponent(certificate.certificateId)}">${escapeHtml(certificate.licenseId)}（${certificate.status === "ACTIVE" ? "有効" : "停止中"}）</a></p>`).join("")}
</div></div>
`);
}

export function verifyPage(basePath: string, certificate: SpllCertificate | undefined): string {
  if (!certificate) {
    return layout({ basePath, title: "認証を確認できません", current: "verify" }, `
<div class="card"><div class="body verdict">
  <div class="glyph">？</div>
  <h1>認証を確認できません</h1>
  <p class="lede" style="margin:0 auto">お手元のQRコード・SPLL番号をもう一度お確かめください。番号が正しい場合は事務局までお問い合わせください。</p>
</div></div>`);
  }
  const active = certificate.status === "ACTIVE";
  return layout({ basePath, title: active ? "確認済み" : "現在は無効です", current: "verify" }, `
<div class="card"><div class="body verdict">
  <div class="glyph">${active ? "✓" : "！"}</div>
  <h1 style="color:${active ? "var(--pass)" : "var(--review)"}">${active ? "確認済み" : "現在は無効です"}</h1>
  <p class="lede" style="margin:0 auto">${active
    ? "この作品はSPLLの利用許諾を受けています。"
    : "この認証は現在有効ではありません。事務局までお問い合わせください。"}</p>
  <dl class="meta">
    <dt>SPLL番号</dt><dd class="mono">${escapeHtml(certificate.licenseId)}</dd>
    <dt>許諾対象</dt><dd>${escapeHtml(certificate.workNames.join("／"))}</dd>
    <dt>利用目的</dt><dd>${escapeHtml(certificate.usageCategory)}</dd>
    <dt>状態</dt><dd><span class="pill ${active ? "ok" : "hold"}">${active ? "有効" : "停止中"}</span>　<span class="mono" style="font-size:12px;color:var(--soft)">${escapeHtml(certificate.issuedAt)} 発行</span></dd>
  </dl>
  ${active ? "" : '<div class="note" style="max-width:52ch;margin:18px auto 0;text-align:left">停止の理由は公開していません。掲載者ご本人の場合は、事務局からのご連絡をご確認ください。</div>'}
</div></div>`);
}

export function notFoundPage(basePath: string): string {
  return layout({ basePath, title: "ページが見つかりません" }, `
<div class="card"><div class="body verdict">
  <div class="glyph">404</div>
  <h1>ページが見つかりません</h1>
  <p class="lede" style="margin:0 auto">URLをお確かめのうえ、もう一度お試しください。</p>
  <p style="margin-top:18px"><a class="btn primary" href="${escapeHtml(basePath)}/">ホームへ戻る</a></p>
</div></div>`);
}
