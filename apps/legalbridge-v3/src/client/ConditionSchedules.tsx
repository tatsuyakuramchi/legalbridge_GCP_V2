import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

/**
 * 条件の予定明細。
 *
 * 毎月28万円の1年契約は12行として並ぶ。契約1件を1行の金額でしか持てないと、
 * 「いつ・いくら・何回」が画面に出ず、検収も支払もどの月の分か分からない。
 *
 * 予定と実績は分けて出す。同じ行に並べるが、左が予定（変えられる）、右が
 * 実績（記録なので変えられない）。V2 は1枚のフォームに混ぜていて、あとから
 * どちらか読めなくなっていた。
 */

interface Row {
  id: number; seq: number; label: string | null; triggerKind: string;
  plannedAmount: number; dueOn: string | null; payOn: string | null;
  eventId: number | null; eventOn: string | null; eventAmount: number | null;
  paidAmount: number; status: "planned" | "recorded" | "paid";
}
interface Trigger { value: string; label: string; hint: string }
interface View {
  conditionId: number; currency: string; lines: Row[];
  total: { planned: number; recorded: number; paid: number };
  triggers: Trigger[];
  eventTypes: Array<{ value: string; label: string }>;
  /** 予定の起点から実績の種別を決める既定値。画面では変えられる。 */
  eventTypeByTrigger: Record<string, string>;
}
type Draft = {
  seq: number; label: string; triggerKind: string; plannedAmount: string;
  dueOn: string; payOn: string;
};

const STATUS: Record<Row["status"], { label: string; tone: string }> = {
  planned: { label: "予定", tone: "" },
  recorded: { label: "実績あり", tone: "accent" },
  paid: { label: "支払済み", tone: "ok" }
};

export function ConditionSchedules(
  { conditionId, editable, reloadKey, onChanged, flatAmount, currency, onRecord }:
  { conditionId: number; editable: boolean; reloadKey?: number; onChanged: () => void;
    /** 条件の定額。予定の合計がこれと合っていなければ注意を出す。 */
    flatAmount?: number | null; currency?: string;
    /**
     * 「実績にする」を押したとき。実績のフォームをこの回で開く。
     * 記録の入力は実績の欄ひとつに寄せる。同じものを2か所で書くと、
     * どちらかに欄を足し忘れて片方だけ入らなくなる。
     */
    onRecord?: (scheduleId: number) => void }
) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 定期の組み立て
  const [gen, setGen] = useState({ startOn: "", count: "12", everyMonths: "1", amount: "" });

  function load() {
    api.get<View>(`/conditions/${conditionId}/schedules`)
      .then(setView).catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => {
    load(); setDraft(null); setError(null);
  }, [conditionId, reloadKey]);
  if (!view) return null;
  const cur = view.currency;

  function startEdit() {
    setDraft((view!.lines).map((l) => ({
      seq: l.seq, label: l.label ?? "", triggerKind: l.triggerKind,
      plannedAmount: String(l.plannedAmount), dueOn: l.dueOn ?? "", payOn: l.payOn ?? ""
    })));
    setError(null);
  }

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ lines: Array<Omit<Draft, "plannedAmount"> & { plannedAmount: number }> }>(
        `/conditions/${conditionId}/schedules/generate`, {
          startOn: gen.startOn, count: Number(gen.count),
          everyMonths: Number(gen.everyMonths), amount: Number(gen.amount)
        });
      setDraft(r.lines.map((l) => ({
        seq: l.seq, label: l.label ?? "", triggerKind: l.triggerKind,
        plannedAmount: String(l.plannedAmount), dueOn: l.dueOn ?? "", payOn: l.payOn ?? ""
      })));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      await api.put(`/conditions/${conditionId}/schedules`, {
        lines: draft.map((d) => ({
          seq: d.seq, label: d.label.trim() || null, triggerKind: d.triggerKind,
          plannedAmount: Math.round(Number(d.plannedAmount) || 0),
          dueOn: d.dueOn || null, payOn: d.payOn || null
        }))
      });
      setDraft(null); load(); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const draftTotal = draft?.reduce((s, d) => s + (Number(d.plannedAmount) || 0), 0) ?? 0;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>予定明細</h2>
        <span className="faint">
          {view.lines.length} 行　予定 {money(view.total.planned, cur)}
          {view.total.recorded > 0 && `　実績 ${money(view.total.recorded, cur)}`}
          {view.total.paid > 0 && `　支払済み ${money(view.total.paid, cur)}`}
        </span>
        {editable && !draft && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={startEdit}>
            {view.lines.length ? "明細を直す" : "明細を作る"}
          </button>
        )}
      </div>

      {draft && (
        <div className="panel-bd stack" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row">
            <span className="faint">定期の明細をまとめて作る：</span>
            <input className="inline-input" type="date" value={gen.startOn}
              aria-label="初回の期日" onChange={(e) => setGen({ ...gen, startOn: e.target.value })} />
            <input className="inline-input" style={{ width: 70 }} value={gen.count}
              aria-label="回数" onChange={(e) => setGen({ ...gen, count: e.target.value })} />
            <span className="faint">回</span>
            <input className="inline-input" style={{ width: 60 }} value={gen.everyMonths}
              aria-label="間隔（月）" onChange={(e) => setGen({ ...gen, everyMonths: e.target.value })} />
            <span className="faint">ヶ月ごと</span>
            <input className="inline-input" value={gen.amount} placeholder="280000"
              aria-label="1回あたりの金額"
              onChange={(e) => setGen({ ...gen, amount: e.target.value })} />
            <button className="btn btn-sm" disabled={busy || !gen.startOn || !gen.amount}
                    onClick={() => void generate()}>並べる</button>
          </div>
          <div className="faint">
            並べたあと1行ずつ直せます。作った時点では保存されません。
          </div>
        </div>
      )}

      {error && <div className="panel-bd"><div className="alert">{error}</div></div>}

      {/* 条件の詳細は画面の右半分なので、編集中の列は入りきらない。
          潰すのではなく横に流す（.tablewrap が overflow-x を持っている）。 */}

      <div className="tablewrap">
        <table style={draft ? { minWidth: 820 } : undefined}>
          <thead><tr>
            <th style={{ width: 36 }}>回</th>
            <th style={{ minWidth: draft ? 150 : 120 }}>名前</th>
            {draft && <th style={{ width: 92 }}>起点</th>}
            <th style={{ width: draft ? 140 : 96 }}>発生予定</th>
            <th style={{ width: draft ? 140 : 96 }}>支払期日</th>
            <th className="num" style={{ width: draft ? 116 : 100 }}>予定額</th>
            <th className="num" style={{ width: draft ? 118 : 104 }}>実績</th>
            <th style={{ width: draft ? 62 : 98 }}>状態</th>
          </tr></thead>
          <tbody>
            {draft ? draft.map((d, i) => (
              <tr key={i}>
                <td className="code">{d.seq}</td>
                <td><input className="inline-input" style={{ width: "100%", minWidth: 0 }} value={d.label}
                  aria-label={`${d.seq} 行目の名前`} placeholder="2026年4月分"
                  onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></td>
                <td>
                  <select value={d.triggerKind} aria-label={`${d.seq} 行目の起点`}
                    style={{ width: "100%", minWidth: 0 }}
                    onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, triggerKind: e.target.value } : x))}>
                    {view.triggers.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </td>
                <td><input className="inline-input" type="date" style={{ width: "100%", minWidth: 0 }} value={d.dueOn}
                  aria-label={`${d.seq} 行目の発生予定日`}
                  onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, dueOn: e.target.value } : x))} /></td>
                <td><input className="inline-input" type="date" style={{ width: "100%", minWidth: 0 }} value={d.payOn}
                  aria-label={`${d.seq} 行目の支払期日`}
                  onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, payOn: e.target.value } : x))} /></td>
                <td className="num"><input className="inline-input" style={{ width: "100%", minWidth: 0, textAlign: "right" }}
                  value={d.plannedAmount} aria-label={`${d.seq} 行目の予定額`}
                  onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, plannedAmount: e.target.value.replace(/[^0-9]/g, "") } : x))} /></td>
                <td className="num faint">—</td>
                <td className="faint">—</td>
                <td>
                  <button className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                    onClick={() => setDraft(draft.filter((_, j) => j !== i)
                      .map((x, j) => ({ ...x, seq: j + 1 })))}>外す</button>
                </td>
              </tr>
            )) : view.lines.map((l) => (
              <tr key={l.id}>
                <td className="code">{l.seq}</td>
                <td>
                  {l.label ?? <span className="faint">（名前なし）</span>}
                  <div className="faint">
                    {view.triggers.find((t) => t.value === l.triggerKind)?.label ?? l.triggerKind}
                  </div>
                </td>
                <td className="code">{l.dueOn ?? "—"}</td>
                <td className="code">
                  {l.payOn ?? <span className="faint">未設定</span>}
                </td>
                <td className="num">{money(l.plannedAmount, cur)}</td>
                <td className="num">
                  {l.eventAmount === null ? <span className="faint">—</span> : (
                    <>
                      {money(l.eventAmount, cur)}
                      {l.eventAmount !== l.plannedAmount && (
                        <div className="faint" style={{ color: "var(--out)" }}>
                          予定と差 {money(l.eventAmount - l.plannedAmount, cur)}
                        </div>
                      )}
                      {l.eventOn && <div className="faint">{l.eventOn}</div>}
                    </>
                  )}
                </td>
                <td>
                  {/* 予定の行に必要なのは「状態」ではなく「次にやること」なので、
                      未消化なら状態タグの代わりにそのままボタンを出す。 */}
                  {editable && l.status === "planned" ? (
                    <button className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                      onClick={() => onRecord?.(l.id)}>実績にする</button>
                  ) : (
                    <span className={STATUS[l.status].tone ? `tag ${STATUS[l.status].tone}` : "tag"}
                          style={{ whiteSpace: "nowrap" }}>
                      {STATUS[l.status].label}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!view.lines.length && !draft && (
              <tr><td colSpan={7} className="faint">
                予定明細がありません。毎月払いの契約なら、ここに回数分の行を作ります。
              </td></tr>
            )}
          </tbody>
          {draft && (
            <tfoot><tr>
              <td colSpan={5} className="faint">{draft.length} 行</td>
              <td className="num"><b>{money(draftTotal, cur)}</b></td>
              <td colSpan={3}></td>
            </tr></tfoot>
          )}
        </table>
      </div>
      {/* 予定の割り方が条件の定額と合っていないと、発注書の合計と検収の進捗が狂う。 */}
      {flatAmount != null && flatAmount > 0 && (draft ? draft.length > 0 : view.lines.length > 0)
        && (draft ? draftTotal : view.total.planned) !== flatAmount && (
        <div className="panel-bd" style={{ paddingBottom: 0 }}>
          <div className="note warn">
            予定の合計 {money(draft ? draftTotal : view.total.planned, cur)} が、条件の定額 {money(flatAmount, currency ?? cur)} と合っていません
            （差 {money((draft ? draftTotal : view.total.planned) - flatAmount, cur)}）。
            分割の割り方を見直すか、条件の定額を直してください。
          </div>
        </div>
      )}

      {draft && (
        <div className="panel-bd row">
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存する"}
          </button>
          <button className="btn" disabled={busy} onClick={() => setDraft(null)}>やめる</button>
          <button className="btn" disabled={busy}
            onClick={() => setDraft([...draft, {
              seq: draft.length + 1, label: "", triggerKind: "periodic",
              plannedAmount: "", dueOn: "", payOn: ""
            }])}>行を足す</button>
          <span className="faint">
            いまの明細をすべて置き換えます。実績が付いている行は外せません
          </span>
        </div>
      )}
    </div>
  );
}
