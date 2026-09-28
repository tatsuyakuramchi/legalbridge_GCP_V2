import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { LedgerCondition } from "../server/royalty/ledger-service.js";

/**
 * 許諾料の締め（時限式の回）を作る。docs/royalty-ledger.md §2
 *
 * 許諾料は報告が来るまで中身（数量・金額）が分からない。先に決まっているのは
 * 「いつ締めて、いつ払うか」だけなので、ここで立てるのは時期だけ。
 * 汎用の予定明細（ConditionSchedules）は金額・契約形式・役務提供期間まで
 * 入れさせるので、許諾料には合わない。保存先は同じ予定明細（金額 0）。
 *
 * 既に締めがあれば、その後ろに足す（実績の付いた回は触らない）。
 */

interface ScheduleRow {
  seq: number; label: string | null; triggerKind: string; plannedAmount: number;
  dueOn: string | null; payOn: string | null; contractForm: string | null;
  serviceFrom: string | null; serviceTo: string | null;
}
interface Generated {
  seq: number; dueOn: string | null; payOn: string | null;
  serviceFrom?: string | null; serviceTo?: string | null;
}
interface Draft { from: string | null; dueOn: string; payOn: string; label: string }

const CYCLES = [
  { months: 3, label: "四半期ごと", count: 4 },
  { months: 6, label: "半年ごと", count: 2 },
  { months: 12, label: "年1回", count: 1 },
  { months: 1, label: "毎月", count: 12 }
];
/** 支払日の決め方。「条件どおり」はサーバが条件の支払条件から出す。 */
const PAY_RULES = [
  { value: "terms", label: "条件の支払条件どおり" },
  { value: "1", label: "締め月の翌月末" },
  { value: "2", label: "締め月の翌々月末" },
  { value: "3", label: "締め月の3か月後の月末" }
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));
/** 締めの N か月後の月末。 */
const payAfter = (dueOn: string, months: number) => {
  const d = new Date(`${dueOn}T00:00:00Z`);
  return iso(monthEnd(d.getUTCFullYear(), d.getUTCMonth() + months));
};
/** 次の締め日の既定値。前の締めがあればその次、無ければ今日を含む期の終わり。 */
function nextClose(last: string | null, months: number): string {
  if (last) {
    const d = new Date(`${last}T00:00:00Z`);
    return iso(monthEnd(d.getUTCFullYear(), d.getUTCMonth() + months));
  }
  const now = new Date();
  const m = now.getUTCMonth();
  const end = months >= 12 ? 11 : Math.floor(m / months) * months + months - 1;
  return iso(monthEnd(now.getUTCFullYear(), end));
}
/** 対象期間の呼び名。2026年7〜9月・2026年10月〜2027年3月・2026年7月。 */
export function periodLabel(from: string | null, to: string): string {
  const t = new Date(`${to}T00:00:00Z`);
  const ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
  if (!from) return `${ty}年${tm}月締め`;
  const f = new Date(`${from}T00:00:00Z`);
  const fy = f.getUTCFullYear(), fm = f.getUTCMonth() + 1;
  if (fy === ty && fm === tm) return `${ty}年${tm}月`;
  return fy === ty ? `${fy}年${fm}〜${tm}月` : `${fy}年${fm}月〜${ty}年${tm}月`;
}

export function RoyaltyCloses(
  { condition, onSaved, onCancel }: {
    condition: LedgerCondition; onSaved: (message: string) => void; onCancel: () => void;
  }
) {
  const [existing, setExisting] = useState<ScheduleRow[] | null>(null);
  const [months, setMonths] = useState(3);
  const [count, setCount] = useState("4");
  const [start, setStart] = useState("");
  const [payRule, setPayRule] = useState(condition.paymentTerms ? "terms" : "1");
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ lines: ScheduleRow[] }>(`/conditions/${condition.id}/schedules`)
      .then((r) => setExisting(r.lines))
      .catch((e: ApiError) => setError(e.message));
  }, [condition.id]);
  const lastClose = existing?.map((l) => l.dueOn ?? l.serviceTo).filter((x): x is string => !!x).sort().slice(-1)[0] ?? null;
  useEffect(() => { if (existing) setStart(nextClose(lastClose, months)); }, [existing, months]);

  async function lay() {
    setError(null); setBusy(true);
    try {
      const r = await api.post<{ lines: Generated[] }>(`/conditions/${condition.id}/schedules/generate`, {
        startOn: start, count: Number(count) || 1, everyMonths: months, amount: 0, triggerKind: "periodic"
      });
      setDraft(r.lines.map((l, i) => {
        const dueOn = l.dueOn ?? "";
        // 前の締めがあれば、1回目はその翌日から（締めの間に穴を空けない）。
        const from = i === 0 && lastClose
          ? iso(new Date(new Date(`${lastClose}T00:00:00Z`).getTime() + 86_400_000))
          : l.serviceFrom ?? null;
        const payOn = payRule === "terms" ? (l.payOn ?? "") : (dueOn ? payAfter(dueOn, Number(payRule)) : "");
        return { from, dueOn, payOn, label: dueOn ? periodLabel(from, dueOn) : "" };
      }));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft || !existing) return;
    if (draft.some((d) => !d.dueOn)) { setError("締め日が空の回があります"); return; }
    setError(null); setBusy(true);
    try {
      const top = existing.reduce((m, l) => Math.max(m, l.seq), 0);
      await api.put(`/conditions/${condition.id}/schedules`, {
        lines: [
          // いまある回はそのまま送り返す（外すと消える）。
          ...existing.map((l) => ({
            seq: l.seq, label: l.label, triggerKind: l.triggerKind, plannedAmount: l.plannedAmount,
            dueOn: l.dueOn, payOn: l.payOn, contractForm: l.contractForm,
            serviceFrom: l.serviceFrom, serviceTo: l.serviceTo
          })),
          ...draft.map((d, i) => ({
            seq: top + i + 1, label: d.label.trim() || null, triggerKind: "periodic", plannedAmount: 0,
            dueOn: d.dueOn, payOn: d.payOn || null, serviceFrom: d.from, serviceTo: d.dueOn
          }))
        ]
      });
      onSaved(`${condition.usageLabel} の締めを ${draft.length} 回作りました`);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const set = (i: number, patch: Partial<Draft>) =>
    setDraft((cur) => cur && cur.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>締めを{existing?.length ? "足す" : "作る"}</h2>
        <span className="faint">{condition.workTitle ?? ""} · {condition.usageLabel}</span>
      </div>
      <div className="panel-bd stack">
        <div className="faint">
          立てるのは締めと支払の時期だけです。数量・金額は報告が来てから「実績を入れる」で入れます。
          {condition.paymentTerms && <> 条件の支払条件：<b>{condition.paymentTerms}</b></>}
        </div>
        {existing && existing.length > 0 && (
          <div className="faint">いまの締め：{existing.length} 回（最後 {lastClose ?? "—"}）。この後ろに足します。</div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <label className="stack" style={{ gap: 2 }}>
            <span className="faint">周期</span>
            <select value={months} onChange={(e) => {
              const m = Number(e.target.value);
              setMonths(m); setCount(String(CYCLES.find((c) => c.months === m)?.count ?? 4)); setDraft(null);
            }}>
              {CYCLES.map((c) => <option key={c.months} value={c.months}>{c.label}</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="faint">最初の締め日</span>
            <input type="date" value={start} onChange={(e) => { setStart(e.target.value); setDraft(null); }} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="faint">回数</span>
            <input type="number" min={1} max={40} style={{ width: 70 }} value={count}
                   onChange={(e) => { setCount(e.target.value); setDraft(null); }} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="faint">支払日</span>
            <select value={payRule} onChange={(e) => { setPayRule(e.target.value); setDraft(null); }}>
              {PAY_RULES.filter((p) => p.value !== "terms" || condition.paymentTerms)
                .map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <button className="btn btn-sm" disabled={busy || !start} onClick={() => void lay()}>並べる</button>
        </div>

        {draft && (
          <table className="table">
            <thead><tr><th>回</th><th>対象期間</th><th>締め日</th><th>支払日</th></tr></thead>
            <tbody>
              {draft.map((d, i) => (
                <tr key={i}>
                  <td className="faint">{(existing?.length ?? 0) + i + 1}</td>
                  <td><input className="inline-input" value={d.label} aria-label={`${i + 1} 回目の対象期間`}
                             onChange={(e) => set(i, { label: e.target.value })} /></td>
                  <td><input className="inline-input" type="date" value={d.dueOn} aria-label={`${i + 1} 回目の締め日`}
                             onChange={(e) => set(i, { dueOn: e.target.value })} /></td>
                  <td><input className="inline-input" type="date" value={d.payOn} aria-label={`${i + 1} 回目の支払日`}
                             onChange={(e) => set(i, { payOn: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {draft && draft.some((d) => !d.payOn) && (
          <div className="note warn">支払日が空の回があります。条件の支払条件が読めませんでした。支払日の決め方を選び直すか、手で入れてください。</div>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" disabled={busy || !draft?.length} onClick={() => void save()}>保存する</button>
          <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
        </div>
      </div>
    </div>
  );
}
