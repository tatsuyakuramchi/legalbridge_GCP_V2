import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { ClosePreview, CloseResult } from "./closing-types.js";

/**
 * まとめて締める。試算 → 実行 → 結果。
 *
 * 押す前に何が起きるかを全部出す。枚数・使うことになる番号・合計・支払期日の
 * 根拠まで。押したあとに「思っていたのと違う」が起きないようにする。
 */
export function ClosingRun({ scheduleIds, onRan, onDone, onCancel }: {
  scheduleIds: number[];
  /** 締め終わった直後。下に出したままの表を引き直す合図。 */
  onRan?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const readOnly = useReadOnly();
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 開いた時点で引く。ここでもう一度「まとめて締める」を出すと、押した人には
  // 同じ帯が2枚並んで見えて、1回目が効かなかったように読める。
  useEffect(() => {
    // 締め終わったあとは引き直さない。結果を出したときに親が表を引き直して
    // 選択を空にするので、ここで追いかけると「選んでください」で結果が消える。
    if (result || !scheduleIds.length) return;
    setBusy(true); setError(null);
    api.post<ClosePreview>("/closing/preview", { scheduleIds })
      .then(setPreview)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setBusy(false));
  }, [scheduleIds.join(","), result]);

  const run = () => {
    setBusy(true); setError(null);
    api.post<CloseResult>("/closing/run", { scheduleIds })
      // 結果を出したあと、下の表も引き直す。「締めました」の下に締める前の
      // 行が残っていると、効かなかったように読める。
      .then((r) => { setResult(r); onRan?.(); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (result) return <RunResult result={result} onDone={onDone} />;

  if (!preview) {
    return (
      <div className="bulkbar">
        {error
          ? <><span className="danger">{error}</span>
              <button className="btn btn-sm" onClick={onCancel}>戻る</button></>
          : <span>{scheduleIds.length} 行を調べています…</span>}
      </div>
    );
  }

  const p = preview;
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>これから起きること</h2>
        <span className="faint">押すまで何も作りません</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {readOnly && <div className="note">いまは読み取り専用です。締めることはできません。</div>}

        <div className="tiles">
          <Tile label="対象" value={`${p.summary.rows} 行`} sub={`${p.summary.parties} 取引先`} />
          <Tile label="実績を記録する" value={`${p.summary.events} 件`} sub="予定どおりの額" />
          <Tile label="決済文書を出す" value={`${p.summary.documents} 枚`}
            sub={p.numbers.map((n) => `${n.label} ${n.from}${n.count > 1 ? `〜${n.to}` : ""}`).join(" / ") || "—"} />
          <Tile label="支払を立てる" value={`${p.summary.payments} 件`} sub="立てるまで。支払済みにはしません" />
          <Tile label="合計（税抜）" value={money(p.summary.total)} sub="" />
        </div>

        {p.summary.dueByLimit > 0 && (
          <div className="alert">
            {p.summary.dueByLimit} 件は支払期日の根拠が「上限60日」です。条件に支払条件が入っていません
            （{p.targets.filter((t) => t.dueSource === "limit")
                  .map((t) => t.conditionName).slice(0, 5).join("／")}）。
          </div>
        )}

        {p.documents.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>条件</th><th>決済文書</th><th>決定日</th><th className="num">回</th><th className="num">金額</th>
              </tr></thead>
              <tbody>
                {p.documents.map((d) => (
                  <tr key={d.conditionId}>
                    <td>{d.conditionName}</td>
                    <td>{d.documentLabel}</td>
                    <td className="code">{d.issuedOn ?? "—"}</td>
                    <td className="num">{d.scheduleIds.length}</td>
                    <td className="num">{money(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {p.skipped.length > 0 && (
          <div className="note">
            <strong>対象から外すもの（{p.skipped.length}）</strong>
            <ul>
              {p.skipped.map((s) => (
                <li key={s.scheduleId}>
                  {s.conditionName} {s.seq ? `第${s.seq}回` : ""} — {s.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="faint">
          決済文書の決定日はその回の締め日。支払は立てるまでで、支払済みにはしません。
          料率の回は、売上報告が入っていないものを対象から外します（計算できないため）。
        </p>

        <div className="row">
          <button className="btn" onClick={() => { setPreview(null); onCancel(); }}>やめる</button>
          <button className="btn accent" onClick={run} disabled={busy || readOnly || !p.summary.rows}>
            {busy ? "締めています…" : `${p.summary.rows} 行を締める`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 結果。1件でも止まったら終わり、にはしない。できたものはでき、
 * 落ちたものは理由とどこまで進んだかを出す。
 */
function RunResult({ result, onDone }: { result: CloseResult; onDone: () => void }) {
  const REACHED: Record<string, string> = {
    event: "実績まで", document: "決済文書まで", payment: "支払まで"
  };
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>締めました</h2>
        <span className="faint">済 {result.ok}／止まった {result.failed}</span>
      </div>
      <div className="panel-bd stack">
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th>条件</th><th>回</th><th>決済文書</th><th>支払</th><th>結果</th>
            </tr></thead>
            <tbody>
              {result.outcomes.map((o) => (
                <tr key={o.scheduleId} className={o.ok ? "" : "overdue"}>
                  <td>{o.conditionName}</td>
                  <td>{o.seq ? `第${o.seq}回` : "—"}</td>
                  <td className="code">{o.documentNo ?? "—"}</td>
                  <td className="code">{o.paymentNo ?? "—"}</td>
                  <td>
                    {o.ok
                      ? <span className="tag ok">済</span>
                      : <>
                          <span className="tag out">{REACHED[o.reached] ?? "止まった"}</span>
                          <div className="faint">{o.error}</div>
                        </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.failed > 0 && (
          <p className="faint">
            止まった回は、できたところまで残してあります。理由を直してもう一度選べば、
            続きから進みます（できている手はやり直しません）。
          </p>
        )}
        <div className="row"><button className="btn accent" onClick={onDone}>表に戻る</button></div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile" style={{ cursor: "default" }}>
      <span className="lab">{label}</span>
      <span className="val">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}
