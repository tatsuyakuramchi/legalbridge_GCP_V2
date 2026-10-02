import type { PeriodRow } from "./closing-types.js";

/**
 * 支払文書の進み具合。① 実績 → ② 検収書 → ③ 送る → ④ 支払。
 *
 * 検収書（計算書）を出す入口は条件の画面・文書作成・この画面と散っていて、
 * 「いまどこまで進んだか」「次に何を押すか」が見えなかった。どこで作った文書も
 * 実績に結ばれていればこの表に出るので、進み具合はここ1か所で数える。
 */
export type FlowStep = "event" | "document" | "send" | "payment" | "done";

export const FLOW_STEPS: Array<{ key: FlowStep; no: string; label: string; hint: string }> = [
  { key: "event", no: "①", label: "実績", hint: "実績（料率は売上報告）を入れる回" },
  { key: "document", no: "②", label: "検収書", hint: "実績はあるが、検収書・計算書をまだ出していない回" },
  { key: "send", no: "③", label: "送る", hint: "出した検収書・計算書をまだ送っていない回" },
  { key: "payment", no: "④", label: "支払", hint: "文書はあるが、支払をまだ立てていない回" },
  { key: "done", no: "✓", label: "済", hint: "支払まで立ち、文書も送ってある回" }
];

/** 締め日がまだ来ていないか。サーバの notYet と同じ線。 */
export const notYet = (closingOn: string | null) =>
  !!closingOn && closingOn > new Date().toISOString().slice(0, 10);

/** その回がどの段にいるか。送ったかどうかは文書がある回だけ見る。 */
export function flowStepsOf(row: PeriodRow): FlowStep[] {
  const out: FlowStep[] = [];
  if (row.step === "event") out.push("event");
  if (row.step === "document") out.push("document");
  const unsent = row.documentId !== null && !row.documentSentAt;
  if (unsent) out.push("send");
  if (row.step === "payment") out.push("payment");
  if (row.step === "done" && !unsent) out.push("done");
  return out;
}

/** 次に押すもの。行ごとに1つだけ出す（迷わせない）。 */
export type NextAction = "record" | "wait" | "issue" | "send" | "pay" | null;

export function nextActionOf(row: PeriodRow): NextAction {
  if (row.step === "event") {
    if (row.scheduleId === null) return null;
    return notYet(row.closingOn) ? "wait" : "record";
  }
  if (row.step === "document") return row.scheduleId === null ? null : "issue";
  if (row.documentId !== null && !row.documentSentAt) return "send";
  if (row.step === "payment") return row.scheduleId === null ? null : "pay";
  return null;
}

export function StepBar({ rows, active, onPick }: {
  rows: PeriodRow[];
  active: FlowStep | null;
  onPick: (step: FlowStep | null) => void;
}) {
  const count = (key: FlowStep) => rows.filter((r) => flowStepsOf(r).includes(key)).length;
  return (
    <div className="stepbar" role="tablist" aria-label="進み具合"
      style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "stretch" }}>
      {FLOW_STEPS.map((s, i) => {
        const n = count(s.key);
        const on = active === s.key;
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span className="faint" aria-hidden>→</span>}
            <button role="tab" aria-selected={on} title={s.hint}
              className={`btn btn-sm${on ? " primary" : ""}`}
              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 92,
                       opacity: n === 0 && !on ? 0.6 : 1 }}
              onClick={() => onPick(on ? null : s.key)}>
              <span>{s.no} {s.label}</span>
              <strong>{n} 件</strong>
            </button>
          </div>
        );
      })}
      {active && <button className="btn btn-sm linky" onClick={() => onPick(null)}>すべて表示</button>}
    </div>
  );
}
