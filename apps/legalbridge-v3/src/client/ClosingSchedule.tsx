import { useMemo, useState } from "react";
import { api, ApiError, rate } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { RoyaltyGap } from "./closing-types.js";

/**
 * 料率の算定期間を並べる。
 *
 * 周期は条件に持たせず、並べるたびに選ぶ。conditions.cycle は料率85本すべて
 * 空で、半期か年次かは台帳のどこにも無い。一度で済まない代わりに、間違った
 * 周期が条件に焼き付くことがない。契約が変われば次から選び直せる。
 *
 * 金額は入れない。売上報告が来るまで決まらないので 0 で並ぶ。
 */

const CYCLES: Array<{ value: number; label: string }> = [
  { value: 1, label: "毎月" },
  { value: 3, label: "四半期" },
  { value: 6, label: "半期" },
  { value: 12, label: "年次" }
];

interface Line { seq: number; label: string | null; dueOn: string | null; payOn: string | null }

export function ClosingSchedule({ gap, onDone, onCancel }: {
  gap: RoyaltyGap; onDone: () => void; onCancel: () => void;
}) {
  const readOnly = useReadOnly();
  const [every, setEvery] = useState(6);
  const [startOn, setStartOn] = useState(firstClosing(gap.termStart, 6));
  const [terms, setTerms] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 契約期間から何回ぶん並ぶか。周期を変えると回数も変わる。
  const count = useMemo(
    () => (gap.monthSpan ? Math.max(1, Math.ceil(gap.monthSpan / every)) : 1),
    [gap.monthSpan, every]);

  const pickCycle = (months: number) => {
    setEvery(months);
    setStartOn(firstClosing(gap.termStart, months));
    setLines(null);
  };

  async function build() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ lines: Line[] }>(`/conditions/${gap.id}/schedules/generate`, {
        startOn, count, everyMonths: every,
        // 金額は入れない。売上報告が来るまで決まらない。
        amount: 0, triggerKind: "periodic",
        paymentTerms: terms.trim() || null
      });
      setLines(r.lines);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!lines) return;
    setBusy(true); setError(null);
    try {
      await api.put(`/conditions/${gap.id}/schedules`, {
        lines: lines.map((l) => ({
          seq: l.seq, label: l.label, triggerKind: "periodic",
          plannedAmount: 0, dueOn: l.dueOn, payOn: l.payOn
        }))
      });
      onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{gap.name} の算定期間を並べます</h2>
        <span className="faint">{gap.conditionNo ?? `#${gap.id}`}　料率 {rate(gap.ratePpm)}</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}

        <div className="form-grid">
          <label className="field">
            <span className="flabel">契約期間</span>
            <span className="code">{gap.termStart} 〜 {gap.termEnd}</span>
          </label>
          <label className="field">
            <span className="flabel">周期</span>
            <select value={every} onChange={(e) => pickCycle(Number(e.target.value))}>
              {CYCLES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <span className="faint">毎回選びます（条件には持たせません）</span>
          </label>
          <label className="field">
            <span className="flabel">初回の締め日</span>
            <input type="date" value={startOn}
              onChange={(e) => { setStartOn(e.target.value); setLines(null); }} />
          </label>
          <label className="field">
            <span className="flabel">回数</span>
            <span className="code">{count}</span>
            <span className="faint">契約期間から</span>
          </label>
          <label className="field">
            <span className="flabel">支払条件</span>
            <input value={terms} placeholder="例：報告月の翌月末払い"
              onChange={(e) => { setTerms(e.target.value); setLines(null); }} />
            <span className="faint">空欄でも構いません</span>
          </label>
        </div>

        {!terms.trim() && (
          <div className="note">
            支払条件が空です。このままだと支払期日は「上限60日」になります
            （約束の日ではありません）。料率の条件は手元の写しで85本すべて空でした。
          </div>
        )}

        {lines && (
          <div className="stack">
            <p className="code">
              {lines.slice(0, 4).map((l) => l.dueOn).join(" ／ ")}
              {lines.length > 4 ? " ／ …" : ""}　全{lines.length}回
            </p>
            <p className="faint">1回あたりの金額は入れません（報告が来るまで決まらないため 0 で並びます）。</p>
          </div>
        )}

        <div className="row">
          <button className="btn" onClick={onCancel}>やめる</button>
          {!lines
            ? <button className="btn accent" onClick={build} disabled={busy || !startOn}>
                {busy ? "組んでいます…" : "並べてみる"}
              </button>
            : <button className="btn accent" onClick={save} disabled={busy || readOnly}>
                {busy ? "書き込んでいます…" : `${lines.length}回を並べる`}
              </button>}
        </div>
      </div>
    </div>
  );
}

/**
 * 初回の締め日の既定値。契約開始から周期ぶん進んだ月の末日。
 *
 * 半期なら 2024-04-01 開始で 2024-09-30。実務の「上期の締め」に合う。
 * 違う契約なら画面で直す。
 */
export function firstClosing(termStart: string | null, everyMonths: number): string {
  if (!termStart) return "";
  const y = Number(termStart.slice(0, 4)), m = Number(termStart.slice(5, 7));
  if (!y || !m) return "";
  const total = y * 12 + (m - 1) + everyMonths;      // 周期ぶん進めて…
  const year = Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month, 0));    // …その前月の末日
  return last.toISOString().slice(0, 10);
}
