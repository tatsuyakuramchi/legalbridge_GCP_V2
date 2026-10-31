import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 監査 › 条件の点検（docs/navigation.md §6。server/conditions/check-service.ts）。
 *
 * 入金の突き合わせ・計算書・回号を狂わせる条件を 4 つの札で洗い出す。決済の型はここで決められる。
 * 重複・根拠の文書・許諾先の作者は、条件明細を開いて直す（まとめると実績・計算書の付け替えが要るので、
 * ここでは黙って消さない）。
 */

interface CheckCondition {
  id: number; conditionNo: string | null; name: string;
  partyId: number | null; partyName: string | null; workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string; ratePct: number | null;
  settlementMode: string | null; timing: "periodic" | "event"; agreementNo: string | null;
  events: number; documents: number;
}
interface ConditionCheckData {
  duplicates: Array<{ key: string; conditions: CheckCondition[] }>;
  noMode: CheckCondition[]; noBasis: CheckCondition[]; uncovered: CheckCondition[];
}
type Card = "duplicates" | "noMode" | "noBasis" | "uncovered";
const CARDS: Array<{ key: Card; label: string; sub: string }> = [
  { key: "duplicates", label: "重複", sub: "同じ作者 × 作品 × 利用形態に 2 本以上" },
  { key: "noMode", label: "決済の型が空", sub: "時限式／イベント式が推測のまま" },
  { key: "noBasis", label: "根拠の文書なし", sub: "契約にも決定済みの文書にも繋がっていない" },
  { key: "uncovered", label: "作者に届かない許諾", sub: "OUT 条件に効く作者の条件が無い" }
];

export function ConditionCheck({ onOpenCondition }: { onOpenCondition: (id: number) => void }) {
  const readOnly = useReadOnly();
  const [data, setData] = useState<ConditionCheckData | null>(null);
  const [card, setCard] = useState<Card>("duplicates");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [pick, setPick] = useState<Record<number, "periodic" | "event">>({});
  /** 重複のまとまりごとに、残す条件。 */
  const [keep, setKeep] = useState<Record<string, number>>({});
  useEffect(() => {
    api.get<ConditionCheckData>("/conditions-check").then(setData).catch((e: ApiError) => setError(e.message));
  }, [version]);
  const count = (k: Card) => !data ? 0 : k === "duplicates" ? data.duplicates.length : data[k].length;
  const open = (c: CheckCondition) => (
    <button className="linky code" onClick={() => onOpenCondition(c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
  );
  async function decide(c: CheckCondition) {
    const timing = pick[c.id] ?? c.timing;
    setError(null);
    try {
      await api.put("/royalty-ledger/timing", { conditionId: c.id, timing });
      setNotice(`${c.conditionNo ?? `#${c.id}`} を${timing === "event" ? "イベント式（製造のたび）" : "時限式（締めごと）"}に決めました`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); }
  }
  async function merge(group: { key: string; conditions: CheckCondition[] }) {
    // 既定で残すのは、報告・決定した文書の多い方（付け替えが少なくて済む）。
    const keepId = keep[group.key] ?? [...group.conditions].sort((a, b) => (b.documents + b.events) - (a.documents + a.events))[0].id;
    const kept = group.conditions.find((c) => c.id === keepId)!;
    const drops = group.conditions.filter((c) => c.id !== keepId);
    if (!window.confirm(`${drops.map((c) => c.conditionNo ?? `#${c.id}`).join("・")} の報告を ${kept.conditionNo ?? `#${keepId}`} に移し、無効にします。よろしいですか？`)) return;
    setError(null);
    try {
      const r = await api.post<{ movedEvents: number }>("/conditions-check/merge", { keepId, dropIds: drops.map((c) => c.id) });
      setNotice(`${kept.conditionNo ?? `#${keepId}`} にまとめました（報告 ${r.movedEvents} 件を移しました）`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); }
  }
  const head = (c: CheckCondition) => (
    <>
      <td>{open(c)}<div className="faint">{c.name}</div></td>
      <td>{c.partyName ?? "—"}</td>
      <td>{c.workTitle ?? "—"}</td>
      <td>{c.usageLabel}{c.ratePct !== null ? ` ${c.ratePct}%` : ""}</td>
    </>
  );

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>条件の点検</h1>
        <p>入金の突き合わせ・計算書・回号を狂わせる条件を洗い出します。条件番号を押すと条件明細が開きます。</p>
      </header>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 12 }}>
        {CARDS.map((c) => (
          <button key={c.key} className={`btn${card === c.key ? " primary" : ""}`} aria-pressed={card === c.key}
                  style={{ textAlign: "left", display: "block", whiteSpace: "normal" }} onClick={() => setCard(c.key)}>
            <span style={{ display: "block" }}>{c.label}</span>
            <b style={{ fontSize: 22 }}>{data ? count(c.key) : "…"}</b>
            <span style={{ display: "block", fontWeight: 400, opacity: 0.85, fontSize: 12 }}>{c.sub}</span>
          </button>
        ))}
      </div>

      {data && card === "duplicates" && (data.duplicates.length ? data.duplicates.map((g) => (
        <div key={g.key} className="panel">
          <div className="panel-hd">
            <h2>{g.conditions[0].partyName} × {g.conditions[0].workTitle} × {g.conditions[0].usageLabel}</h2>
            <span className="faint">生きている条件が {g.conditions.length} 本。入金・報告がどちらに付くか決まりません。残す方を選んでまとめてください（ほかの条件の報告を移して無効にします。決定した文書・支払・計算書のある条件は寄せられません）</span>
            {!readOnly && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => void merge(g)}>選んだ条件にまとめる</button>}
          </div>
          <div className="tablewrap"><table>
            <thead><tr><th>残す</th><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th>決済の型</th><th>根拠</th><th className="num">報告</th><th className="num">決定した文書</th></tr></thead>
            <tbody>{g.conditions.map((c) => (
              <tr key={c.id}>
                <td><input type="radio" name={`keep-${g.key}`} aria-label={`${c.conditionNo ?? c.id} を残す`}
                           checked={(keep[g.key] ?? [...g.conditions].sort((a, b) => (b.documents + b.events) - (a.documents + a.events))[0].id) === c.id}
                           onChange={() => setKeep((k) => ({ ...k, [g.key]: c.id }))} /></td>
                {head(c)}
                <td>{c.settlementMode ? (c.timing === "event" ? "イベント式" : "時限式") : <span className="tag warn">空</span>}</td>
                <td>{c.agreementNo ? <span className="code">{c.agreementNo}</span> : <span className="tag warn">なし</span>}</td>
                <td className="num">{c.events}</td><td className="num">{c.documents}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )) : <div className="panel"><div className="panel-bd faint">重複した条件はありません</div></div>)}

      {data && card === "noMode" && (
        <div className="panel">
          <div className="panel-hd"><h2>決済の型が空</h2><span className="faint">型を決めると、回の立ち方と回号の数え方が固まります</span></div>
          {data.noMode.length ? <div className="tablewrap"><table>
            <thead><tr><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th>いまの推測</th><th>決める</th></tr></thead>
            <tbody>{data.noMode.map((c) => (
              <tr key={c.id}>{head(c)}
                <td className="faint">{c.timing === "event" ? "イベント式（製造のたび）" : "時限式（締めごと）"}</td>
                <td>
                  <select aria-label={`${c.conditionNo ?? c.id} の決済の型`} value={pick[c.id] ?? c.timing}
                          onChange={(e) => setPick((p) => ({ ...p, [c.id]: e.target.value as "periodic" | "event" }))}>
                    <option value="periodic">時限式（締めごと）</option>
                    <option value="event">イベント式（製造のたび）</option>
                  </select>
                  <button className="btn btn-sm" style={{ marginLeft: 6 }} disabled={readOnly} onClick={() => void decide(c)}>決める</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">型の空いた条件はありません</div>}
        </div>
      )}

      {data && card === "noBasis" && (
        <div className="panel">
          <div className="panel-hd"><h2>根拠の文書なし</h2><span className="faint">条件明細の「契約の紐づけ」で契約に載せるか、条件書を決定して繋いでください</span></div>
          {data.noBasis.length ? <div className="tablewrap"><table>
            <thead><tr><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th className="num">報告</th></tr></thead>
            <tbody>{data.noBasis.map((c) => <tr key={c.id}>{head(c)}<td className="num">{c.events}</td></tr>)}</tbody>
          </table></div> : <div className="panel-bd faint">根拠の無い条件はありません</div>}
        </div>
      )}

      {data && card === "uncovered" && (
        <div className="panel">
          <div className="panel-hd"><h2>作者に届かない許諾</h2><span className="faint">入金しても作者に払いが出ません。作者の条件（IN）の作品・利用形態を確かめるか、作者の条件を足してください</span></div>
          {data.uncovered.length ? <div className="tablewrap"><table>
            <thead><tr><th>許諾（OUT）</th><th>許諾先</th><th>作品</th><th>利用形態</th><th>契約</th></tr></thead>
            <tbody>{data.uncovered.map((c) => (
              <tr key={c.id}>{head(c)}<td>{c.agreementNo ? <span className="code">{c.agreementNo}</span> : "—"}</td></tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">作者に届かない許諾はありません</div>}
        </div>
      )}
    </section>
  );
}
