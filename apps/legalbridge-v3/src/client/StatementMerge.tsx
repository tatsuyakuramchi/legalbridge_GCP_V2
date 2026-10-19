import { useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 同じ人・同じ回の計算書が 2 枚（受取人としての共著の取り分と、本人が相手先の単独の作品）に
 * 分かれたものを、1 枚の訂正版にまとめる。未払いの支払は取り消して 1 本に立て直す。
 * まとめて締めるは人ごとに 1 枚になったので、その前に出した組を直すための口。
 */
interface Group {
  key: string; partyName: string; periodLabel: string | null; currency: string;
  documents: Array<{ id: number; documentNo: string | null; payee: boolean; netAmount: number; issuedOn: string | null }>;
  netAmount: number;
  payments: Array<{ id: number; paymentNo: string | null; status: string; dueOn: string | null; amount: number }>;
  status: "ready" | "paid" | "draft" | "amount" | "error";
  message: string | null;
}
interface Result {
  key: string; partyName: string; status: "merged" | "skipped" | "error";
  newDocumentNo?: string | null; paymentNo?: string | null; message?: string;
}

const yen = (n: number) => n.toLocaleString("ja-JP");

export function StatementMerge() {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setError(null);
    try {
      const r = await api.get<{ groups: Group[] }>("/royalty-ledger/statements/merge");
      setGroups(r.groups);
      setPicked(new Set(r.groups.filter((g) => g.status === "ready").map((g) => g.key)));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setGroups(null); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!picked.size) return;
    if (!window.confirm(`${picked.size} 人分の計算書を 1 枚にまとめ、未払いの支払を 1 本に立て直します。元の計算書は退きます。よいですか？`)) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ merged: number; results: Result[] }>("/royalty-ledger/statements/merge", { keys: [...picked] });
      setResults(r.results);
      setDone(`${r.merged} 人分をまとめました`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
    await load();
  }
  const ready = (groups ?? []).filter((g) => g.status === "ready");
  const toggle = (key: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>計算書を人ごとに 1 枚にまとめる</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>{open ? "閉じる" : "開く"}</button>
      </div>
      {open && (
        <div className="panel-bd stack">
          <div className="faint">
            同じ人・同じ回の計算書が、受取人としての分（共著の取り分）と本人の作品の分の 2 枚に分かれているものです。
            1 枚の訂正版にまとめ（元の決定日、額は変えない）、元の紙から立った未払いの支払を取り消して 1 本に立て直します
            （期日は元の支払の遅いほう）。支払済みの支払がある組はまとめません。まとめた紙は未送付の一覧に出るので、送り直してください。
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>試算</button>
            {groups && !readOnly && (
              <button className="btn btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
                {busy ? "まとめています…" : `${picked.size} 人分をまとめる`}
              </button>
            )}
          </div>
          {error && <div className="alert">{error}</div>}
          {done && <div className="notice">{done}</div>}
          {groups && (
            <div className="tablewrap"><table>
              <thead><tr>
                <th><input type="checkbox" aria-label="全部選ぶ" checked={!!ready.length && picked.size === ready.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(ready.map((g) => g.key)) : new Set())} /></th>
                <th>宛先</th><th>対象期間</th><th>まとめる計算書</th><th>合計（税抜）</th><th>立て直す支払</th><th>注意</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} className={g.status === "ready" ? "" : "faint"}>
                    <td>{g.status === "ready" && <input type="checkbox" checked={picked.has(g.key)} onChange={() => toggle(g.key)}
                      aria-label={`${g.partyName} をまとめる`} />}</td>
                    <td>{g.partyName}</td>
                    <td>{g.periodLabel ?? "—"}</td>
                    <td>{g.documents.map((d) => (
                      <div key={d.id}><span className="code">{d.documentNo ?? `#${d.id}`}</span>
                        <span className="faint">　{d.payee ? "受取人として" : "本人の作品"}　{yen(d.netAmount)}</span></div>))}</td>
                    <td className="num">{yen(g.netAmount)}</td>
                    <td>{g.payments.map((p) => (
                      <div key={p.id} className="faint">{p.paymentNo ?? `#${p.id}`}　{yen(p.amount)}　{p.dueOn ?? ""}</div>))}
                      {!g.payments.length && <span className="faint">（支払なし）</span>}</td>
                    <td>{g.message && <span className="tag warn">{g.message}</span>}</td>
                  </tr>
                ))}
                {!groups.length && <tr><td colSpan={7} className="faint">2 枚に分かれた計算書はありません</td></tr>}
              </tbody>
            </table></div>
          )}
          {!!results.length && (
            <div className="tablewrap"><table>
              <thead><tr><th>宛先</th><th>結果</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.key}>
                    <td>{r.partyName}</td>
                    <td>{r.status === "merged"
                      ? <><span className="tag ok">済</span> {r.newDocumentNo ?? ""} にまとめ、支払 {r.paymentNo ?? ""} を立てました</>
                      : <><span className="tag warn">{r.status === "skipped" ? "飛ばし" : "失敗"}</span> {r.message}</>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
