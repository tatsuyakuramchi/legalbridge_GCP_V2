import { useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { ClosingRun } from "./ClosingRun.js";
import type { CloseResult, PeriodRow } from "./closing-types.js";

/**
 * 支払文書を通しで進める：対象 → 実績 → 決済文書と支払 → 送る。
 *
 * 「まとめて締める」は予定どおりの額で実績を立てる。納品日・成果物・数量・検収者が
 * 要る回（検収書）や、売上の報告が要る回（計算書）は、ここで行ごとに入れてから
 * 同じ締めに流す。終わったら決済文書を開いて送る（メール／CloudSign）。
 * 支払は締めで立つ（文書 1 枚に 1 件）。
 */

interface Draft {
  skip: boolean;             // 予定どおり（締めに任せる）
  occurredOn: string;        // 納品日／売上の締め日
  quantity: string;
  amount: string;            // 税抜。料率の回は売上（税抜）
  deductions: string;        // 料率の回の控除
  deliverable: string;
  inspectedOn: string;
  inspectorName: string;
  note: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const num = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const isRoyalty = (r: PeriodRow) => r.pricingModel === "revenue_rate";

export function ClosingFlow({ rows: initialRows, onOpenDocument, onRan, onDone, onCancel }: {
  /** 選んだ回（予定の回だけ）。開いた時点のものを持つ（親が表を引き直して選択を空にしても消えない）。 */
  rows: PeriodRow[];
  onOpenDocument: (id: number) => void;
  /** 締め終わった直後。親が表を引き直す。 */
  onRan?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [rows] = useState<PeriodRow[]>(initialRows);
  const [stage, setStage] = useState<1 | 2 | 3 | 4>(rows.every((r) => r.eventId !== null) ? 3 : 2);
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() => Object.fromEntries(rows.map((r) => [r.scheduleId!, {
    skip: false, occurredOn: r.closingOn ?? today(), quantity: "1",
    amount: r.plannedAmount != null ? String(r.plannedAmount) : "", deductions: "0",
    deliverable: "", inspectedOn: r.closingOn ?? today(), inspectorName: "", note: ""
  }])));
  const [recorded, setRecorded] = useState<Record<number, number>>({});   // scheduleId → eventId
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);
  const pending = useMemo(() => rows.filter((r) => r.eventId === null && !recorded[r.scheduleId!]), [rows, recorded]);
  const ids = rows.map((r) => r.scheduleId!);

  const set = (id: number, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  async function saveEvents() {
    setBusy(true); setErrors({});
    const errs: Record<number, string> = {};
    for (const r of pending) {
      const d = drafts[r.scheduleId!];
      if (d.skip) continue;
      try {
        if (isRoyalty(r)) {
          const made = await api.post<{ id: number }>(`/conditions/${r.conditionId}/events`, {
            eventType: "sales", occurredOn: d.occurredOn, scheduleId: r.scheduleId,
            grossAmount: Math.round(num(d.amount)), deductions: Math.round(num(d.deductions)),
            quantity: d.quantity.trim() ? num(d.quantity) : null, amount: 0, note: d.note.trim() || null
          });
          setRecorded((x) => ({ ...x, [r.scheduleId!]: made.id }));
        } else {
          const made = await api.post<{ eventId: number }>(`/conditions/${r.conditionId}/schedules/${r.scheduleId}/record`, {
            occurredOn: d.occurredOn, amount: d.amount.trim() ? Math.round(num(d.amount)) : null,
            quantity: d.quantity.trim() ? num(d.quantity) : null,
            deliverable: d.deliverable.trim() || null, inspectedOn: d.inspectedOn || null,
            inspectorName: d.inspectorName.trim() || null, note: d.note.trim() || null
          });
          setRecorded((x) => ({ ...x, [r.scheduleId!]: made.eventId }));
        }
      } catch (e) { errs[r.scheduleId!] = e instanceof ApiError ? e.message : String(e); }
    }
    setErrors(errs); setBusy(false);
    if (!Object.keys(errs).length) setStage(3);
  }

  const docs = result ? [...new Map(result.outcomes.filter((o) => o.documentId).map((o) => [o.documentId!, o])).values()] : [];

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>通しで進める</h2>
        <span className="faint">対象 {rows.length} 行 → 実績 → 決済文書と支払 → 送る</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>やめる</button>
      </div>
      <div className="panel-bd stack">
        <div className="pipe">
          {[["1", "対象", true], ["2", "実績を立てる", pending.length === 0], ["3", "決済文書と支払", Boolean(result)], ["4", "送る", false]].map(([no, name, done], i) => (
            <button key={String(no)} type="button" className={`pipe-step${stage === i + 1 ? " open" : ""}`}
                    style={done ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}
                    onClick={() => setStage((i + 1) as 1 | 2 | 3 | 4)} disabled={i + 1 > 2 && !result && i + 1 === 4}>
              <span className="st">{done ? "済" : String(no)}</span><span className="nm">{String(name)}</span>
            </button>
          ))}
        </div>

        {stage === 1 && (
          <div className="stack" style={{ gap: 6 }}>
            {rows.map((r) => (
              <div key={r.scheduleId} className="row" style={{ gap: 8 }}>
                <span>{r.party?.name ?? "—"}</span><span className="code faint">{r.conditionNo}</span>
                <span>{r.conditionName}</span><span className="faint">{r.label ?? (r.seq ? `第${r.seq}回` : "")}</span>
                <span className="faint">締め {r.closingOn ?? "—"}</span>
                <span className="num">{r.plannedAmount != null ? money(r.plannedAmount, r.currency) : ""}</span>
                <span className="tag">{r.eventId ? "実績あり" : "実績なし"}</span>
              </div>
            ))}
            <div className="row"><button className="btn primary" onClick={() => setStage(2)}>次へ：実績を立てる</button></div>
          </div>
        )}

        {stage === 2 && (
          <div className="stack">
            {!pending.length && <div className="note ok">選んだ回はすべて実績が立っています。次へ進めます。</div>}
            {pending.length > 0 && (
              <>
                <span className="faint">行ごとに「いつ・何を・いくら」。「予定どおり」にすると締めが予定額で実績を立てます。料率の回は売上（税抜）の報告を入れます。</span>
                <div className="tablewrap">
                  <table>
                    <thead><tr>
                      <th>回</th><th>予定どおり</th><th>{pending.some(isRoyalty) ? "納品日／売上の締め日" : "納品日"}</th>
                      <th className="num">数量</th><th className="num">金額（税抜）</th><th>成果物・摘要</th><th>検収日</th><th>検収者</th><th>差異の理由・備考</th>
                    </tr></thead>
                    <tbody>
                      {pending.map((r) => {
                        const d = drafts[r.scheduleId!]; const roy = isRoyalty(r);
                        return (
                          <tr key={r.scheduleId} className={errors[r.scheduleId!] ? "overdue" : ""}>
                            <td><div>{r.conditionName}</div><div className="faint">{r.label ?? (r.seq ? `第${r.seq}回` : "")}{roy ? "（売上報告）" : ""}</div>
                              {errors[r.scheduleId!] && <div className="danger">{errors[r.scheduleId!]}</div>}</td>
                            <td><input type="checkbox" checked={d.skip} disabled={roy} onChange={(e) => set(r.scheduleId!, { skip: e.target.checked })} /></td>
                            <td><input type="date" value={d.occurredOn} disabled={d.skip} onChange={(e) => set(r.scheduleId!, { occurredOn: e.target.value })} /></td>
                            <td><input value={d.quantity} disabled={d.skip} style={{ width: 60, textAlign: "right" }} onChange={(e) => set(r.scheduleId!, { quantity: e.target.value })} /></td>
                            <td>
                              <input value={d.amount} disabled={d.skip} style={{ width: 110, textAlign: "right" }} placeholder={roy ? "売上（税抜）" : ""}
                                     onChange={(e) => set(r.scheduleId!, { amount: e.target.value })} />
                              {roy && <input value={d.deductions} style={{ width: 110, textAlign: "right", marginTop: 3 }} placeholder="控除"
                                             onChange={(e) => set(r.scheduleId!, { deductions: e.target.value })} />}
                            </td>
                            <td><input value={d.deliverable} disabled={d.skip || roy} style={{ minWidth: 160 }} placeholder={roy ? "—" : "納品物"} onChange={(e) => set(r.scheduleId!, { deliverable: e.target.value })} /></td>
                            <td><input type="date" value={d.inspectedOn} disabled={d.skip || roy} onChange={(e) => set(r.scheduleId!, { inspectedOn: e.target.value })} /></td>
                            <td><input value={d.inspectorName} disabled={d.skip || roy} style={{ width: 100 }} placeholder="検収者" onChange={(e) => set(r.scheduleId!, { inspectorName: e.target.value })} /></td>
                            <td><input value={d.note} disabled={d.skip} style={{ minWidth: 160 }} onChange={(e) => set(r.scheduleId!, { note: e.target.value })} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="row">
              <button className="btn" onClick={() => setStage(1)}>戻る</button>
              <button className="btn primary" disabled={busy} onClick={() => (pending.length ? void saveEvents() : setStage(3))}>
                {busy ? "記録しています…" : pending.length ? "実績を保存して次へ：決済文書と支払" : "次へ：決済文書と支払"}
              </button>
            </div>
          </div>
        )}

        {stage === 3 && (
          <ClosingRun scheduleIds={ids} onRan={onRan} onResult={setResult}
            onDone={() => setStage(4)} onCancel={() => setStage(2)} />
        )}

        {stage === 4 && (
          <div className="stack">
            {!docs.length && <span className="faint">まだ決済文書ができていません。段階 3 で締めてください。</span>}
            {result?.outcomes.filter((o) => o.error).map((o) => (
              <div key={o.scheduleId} className="alert">{o.conditionName} {o.seq ? `第${o.seq}回` : ""}：{o.error}</div>
            ))}
            {docs.map((o) => (
              <div key={o.documentId} className="row" style={{ gap: 8 }}>
                <span className="code">{o.documentNo ?? `#${o.documentId}`}</span>
                <span>{o.conditionName}</span>
                {o.paymentNo && <span className="tag ok">支払 {o.paymentNo}</span>}
                <button className="btn btn-sm primary" onClick={() => onOpenDocument(o.documentId!)}>開いて送る</button>
              </div>
            ))}
            <span className="faint">文書の「送る」で、担当者への確認 → 取引先への送付（メール・PDF 添付）／CloudSign と進みます。支払は締めで立っており、お金の画面の経理提出用の一覧に出ます。</span>
            <div className="row"><button className="btn" onClick={onDone}>表に戻る</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
