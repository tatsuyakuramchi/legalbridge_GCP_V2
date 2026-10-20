import type { IntakeRow } from "./repository.js";

/**
 * 依頼の原票を 1 枚の HTML で（別タブで開く読むだけの画面）。
 *
 * 作業テーブルで条件明細を登録しているとき、もともとの依頼（件名・本文・相手先・期日・
 * 添付の名前・やり取り）を横に置いて見比べたい。画面の中に出すと条件のフォームが
 * 押し下げられるので、別タブにする。URL は /api/v3/intake/:id/view。
 */
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "—");
const when = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

export function intakeViewHtml(
  d: { request: IntakeRow; replies: Array<{ at: string; user: string; text: string }>;
       conditions: Array<{ id: number; conditionNo: string | null; name: string; workTitle: string | null }> }
): string {
  const r = d.request;
  const rows: Array<[string, string]> = [
    ["依頼番号", r.requestNo ?? `#${r.id}`],
    ["受け付けた経路", r.source],
    ["内容", r.purposeLabel ?? (r.kind ?? "—")],
    ["対象の番号", r.targetDocNo ?? "—"],
    ["相手先", r.counterpartyName ?? "—"],
    ["依頼者", [r.requesterName, r.requesterEmail].filter(Boolean).join("　") || "—"],
    ["期日", day(r.dueOn)],
    ["案件", r.matterNo ? `${r.matterNo}　${r.matterTitle ?? ""}` : "（案件にしていない）"],
    ["Backlog", r.backlogIssueKey ? `${r.backlogIssueKey}（${r.backlogStatus ?? ""}）` : "—"]
  ];
  const mail = r.mail
    ? `<h2>メールの原票</h2><table>${[
        ["差出人", r.mail.from ?? "—"], ["宛先", r.mail.to.join("、") || "—"],
        ["添付", r.mail.attachments.join("、") || "—"]
      ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
      ${r.mail.followUps.length ? `<p class="faint">続きのメール：${r.mail.followUps.map((f) => `${esc(f.subject ?? "")}（${esc(f.from ?? "")}、${esc(when(f.receivedAt))}）`).join("／")}</p>` : ""}`
    : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.requestNo ?? "依頼")} ${esc(r.title)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:20px 24px;color:#1f2430;background:#f7f7f5;font-size:14px;line-height:1.6}
  main{max-width:860px;margin:0 auto;background:#fff;border:1px solid #e3e3df;border-radius:8px;padding:18px 22px}
  h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;color:#555}
  .no{font-family:ui-monospace,Menlo,Consolas,monospace;color:#555}
  table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #eee}th{width:9em;color:#666;font-weight:600;white-space:nowrap}
  pre{white-space:pre-wrap;word-break:break-word;background:#fafaf8;border:1px solid #eee;border-radius:6px;padding:10px 12px;margin:0;font:inherit}
  .faint{color:#777}.reply{border-left:3px solid #ddd;padding:4px 10px;margin:6px 0}
  @media print{body{background:#fff;padding:0}main{border:0}}
</style></head><body><main>
<div class="no">${esc(r.requestNo ?? `#${r.id}`)}</div>
<h1>${esc(r.title)}</h1>
<p class="faint">もともとの依頼の原票です（読むだけ）。作業テーブルで条件明細や文書を作るときの見比べ用。</p>
<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
<h2>依頼の本文</h2>
<pre>${esc(r.detail ?? "（本文なし）")}</pre>
${mail}
${d.conditions.length ? `<h2>繋いである条件明細</h2><ul>${d.conditions.map((c) => `<li><span class="no">${esc(c.conditionNo ?? `#${c.id}`)}</span>　${esc(c.name)}${c.workTitle ? `　<span class="faint">${esc(c.workTitle)}</span>` : ""}</li>`).join("")}</ul>` : ""}
${d.replies.length ? `<h2>やり取り</h2>${d.replies.map((x) => `<div class="reply"><div class="faint">${esc(when(x.at))}　${esc(x.user)}</div><div>${esc(x.text)}</div></div>`).join("")}` : ""}
</main></body></html>`;
}
