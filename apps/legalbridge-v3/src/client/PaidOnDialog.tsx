import { useState } from "react";
import { Modal } from "./Modal.js";

/**
 * 支払済み（入金済み）にするときに、実際に払った日（入った日）を聞く。
 *
 * 以前は押した日（今日）をそのまま支払日にしていた。押すのは銀行の明細を確かめた日で、
 * 払った日ではない（月末に払ったものを翌月に確かめると、支払日が翌月になり、支払報告書や
 * 経理提出の帳票の月がずれる）。既定は支払の期日（予定どおり払っていればその日）。
 * 期日が無いか、まだ来ていなければ空にして、入れてもらう。先の日付は受け付けない。
 */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function PaidOnDialog({ label, dueOn, incoming = false, onConfirm, onClose }: {
  /** 何を支払済みにするか（支払番号・条件名など）。 */
  label: string;
  /** 支払の期日。既定の支払日にする（今日より後なら使わない）。 */
  dueOn?: string | null;
  /** 入金（当社が受け取る）なら「入金日」と呼ぶ。 */
  incoming?: boolean;
  onConfirm: (paidOn: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const now = today();
  const [paidOn, setPaidOn] = useState(dueOn && dueOn <= now ? dueOn : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = incoming ? "入金日" : "支払日";
  const future = Boolean(paidOn) && paidOn > now;

  async function submit() {
    if (!paidOn || future) return;
    setBusy(true); setError(null);
    try { await onConfirm(paidOn); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <Modal title={<>{label}　<span className="faint">{incoming ? "入金済みにする" : "支払済みにする"}</span></>} onClose={onClose}>
      <div className="stack" style={{ gap: 10, minWidth: 360 }}>
        <label className="field"><span>実際の{word}</span>
          <input type="date" value={paidOn} max={now} autoFocus onChange={(e) => setPaidOn(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          <small className="faint">
            銀行の明細の日付を入れてください。確かめた日（今日）ではありません。
            {dueOn ? `期日は ${dueOn}。` : ""}
          </small>
        </label>
        <div className="row" style={{ gap: 6 }}>
          {dueOn && dueOn <= now && <button className="btn btn-sm" onClick={() => setPaidOn(dueOn)}>期日（{dueOn}）</button>}
          <button className="btn btn-sm" onClick={() => setPaidOn(now)}>今日（{now}）</button>
        </div>
        {future && <div className="alert">{word}に先の日付は入れられません。</div>}
        {error && <div className="alert">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={!paidOn || future || busy} onClick={() => void submit()}>
            {busy ? "記録しています…" : `${paidOn || "（日付を入れる）"} で${incoming ? "入金済み" : "支払済み"}にする`}
          </button>
          <button className="btn" onClick={onClose}>やめる</button>
        </div>
      </div>
    </Modal>
  );
}
