import { useState } from "react";
import { money } from "./api.js";
import type { TeardownPlan } from "../server/documents/teardown-types.js";

/**
 * 旧分を畳む下見。
 *
 * 支払 → 決済文書 → 発注書 → 実績 の順でしか外せない（文書に繋がったままの
 * 実績は取り消せない）。その順を画面にも出す。理由は必須で、監査に残る。
 *
 * 案件の文書タブと「決済済みを作り直す」の④から同じものを使う。
 */
export function TeardownPanel({ plan, busy, onRun, onCancel }: {
  plan: TeardownPlan; busy: boolean;
  onRun: (reason: string, voidConditions: boolean) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [voidConditions, setVoidConditions] = useState(false);
  const [allDocs, setAllDocs] = useState(false);
  // 決済文書が先。無効にすると実績が解放され、実績を取り消せる。
  const ordered = [...plan.documents]
    .sort((a, b) => Number(b.settlement) - Number(a.settlement) || a.id - b.id);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>旧分を畳みます</h2>
        <span className="faint">{plan.matter.matterNo} {plan.matter.title}</span>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ gap: 22 }}>
          <div><div className="faint">支払を取り消す</div>
            <div className="num">{plan.summary.payments}</div></div>
          <div><div className="faint">文書を無効にする</div>
            <div className="num">{plan.summary.documents}</div></div>
          <div><div className="faint">実績を取り消す</div>
            <div className="num">{plan.summary.events}</div></div>
          <div><div className="faint">畳む額（税抜）</div>
            <div className="num">{money(plan.summary.amount)}</div></div>
          {plan.summary.blocked > 0 && (
            <div><div className="faint">触らない</div>
              <div className="num" style={{ color: "var(--out)" }}>{plan.summary.blocked}</div></div>
          )}
        </div>

        {plan.warnings.map((w, i) => (
          <div key={i} className={/新しい条件番号|番号も戻りません/.test(w) ? "alert" : "note"}>{w}</div>
        ))}

        {plan.documents.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead><tr><th>文書</th><th>種別</th><th>順</th></tr></thead>
              <tbody>
                {ordered.slice(0, allDocs ? ordered.length : 12).map((d) => (
                    <tr key={d.id}>
                      <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                      <td>{d.templateLabel ?? "—"}</td>
                      <td className="faint">
                        {/* 決済文書が先。無効にすると実績が解放され、実績を取り消せる。 */}
                        {d.settlement ? "先（実績を解放する）" : "あと"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {/* 案件が大きいと数十枚出る。全部並べると理由の欄まで届かない。 */}
            {ordered.length > 12 && (
              <button className="btn btn-sm" onClick={() => setAllDocs(!allDocs)}>
                {allDocs ? "畳む" : `ほか ${ordered.length - 12} 枚を出す`}
              </button>
            )}
          </div>
        )}

        {plan.payments.filter((p) => p.blocked).length > 0 && (
          <div className="note warn">
            触らない支払：
            {plan.payments.filter((p) => p.blocked)
              .map((p) => `${p.paymentNo ?? `#${p.id}`}（${p.blocked}）`).join("／")}
          </div>
        )}

        <label className="field">
          <span className="flabel">畳む理由（必須。監査に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="例：発注金額の誤りのため、正しい金額で作り直す" />
        </label>

        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={voidConditions}
            onChange={(e) => setVoidConditions(e.target.checked)} />
          <span>条件明細も無効にする（入れ直しは新しい条件番号になります）</span>
        </label>

        <div className="row">
          <button className="btn" onClick={onCancel}>やめる</button>
          <button className="btn danger" disabled={busy || !reason.trim()}
            onClick={() => onRun(reason.trim(), voidConditions)}>
            {busy ? "畳んでいます…" : "畳む"}
          </button>
        </div>
      </div>
    </div>
  );
}
