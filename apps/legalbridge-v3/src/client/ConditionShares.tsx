import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";
import { ListSearch, useDebounced } from "./ListTools.js";

/**
 * 共著の取り分（A-068。docs/royalty-shares.md）。
 *
 * 作品に対する許諾料率は条件明細 1 本（全体率）が持つ。当社から複数の権利者へ
 * 直接払う作品だけ、ここで「誰に何 %」を入れる。計算書は受取人ごとに 1 枚になり、
 * 全体額を四捨五入で割る（合計は全体を超えない）。
 *
 * 代表 1 者が受け取って自分で分配する契約は、ここには何も入れない（相手先 1 者が
 * 100% を受け取る）。買い切りは定額の条件 1 本で持つので、ここは関係ない。
 */

type Row = { partyId: number; name: string; pct: string; note: string };

const pctOf = (ppm: number) => String(ppm / 10000);
const ppmOf = (pct: string) => Math.round(Number(pct.replace(/[^0-9.]/g, "")) * 10000);

export function ConditionShares(
  { detail, onDone, canWrite }: { detail: ConditionDetail; onDone: () => void; canWrite: boolean }
) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [parties, setParties] = useState<Array<{ id: number; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applicable = detail.direction === "in" && detail.kind === "license" && detail.pricingModel === "revenue_rate";
  const shares = detail.shares ?? [];

  useEffect(() => {
    if (!editing) return;
    const q = search.trim();
    api.get<{ parties: Array<{ id: number; name: string }> }>(`/parties${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setParties(r.parties.slice(0, 20))).catch(() => setParties([]));
  }, [editing, search]);

  function start() {
    setRows(shares.length
      ? shares.map((s) => ({ partyId: s.partyId, name: s.partyName, pct: pctOf(s.sharePpm), note: s.note ?? "" }))
      // 空から始めるときは相手先を 1 行目に置く（たいてい代表＝相手先が 1 人目）。
      : detail.counterparty ? [{ partyId: detail.counterparty.id, name: detail.counterparty.name, pct: "", note: "" }] : []);
    setEditing(true); setError(null); setKeyword("");
  }

  function add(p: { id: number; name: string }) {
    if (rows.some((r) => r.partyId === p.id)) return;
    setRows([...rows, { partyId: p.id, name: p.name, pct: "", note: "" }]);
    setKeyword("");
  }

  const total = rows.reduce((a, r) => a + (ppmOf(r.pct) || 0), 0);

  async function save(clear = false) {
    setBusy(true); setError(null);
    try {
      await api.put(`/conditions/${detail.id}/shares`, {
        shares: clear ? [] : rows.map((r) => ({ partyId: r.partyId, sharePpm: ppmOf(r.pct), note: r.note.trim() || null }))
      });
      setEditing(false); onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (!applicable && !shares.length) return null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>取り分（共著）</h2>
        <span className="faint">
          {shares.length
            ? "当社から受取人ごとに直接払う。計算書は受取人ごとに 1 枚"
            : "相手先 1 者が 100%（代表が受け取って分配する契約も、ここは空のまま）"}
        </span>
        {canWrite && applicable && !editing && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={start}>
            {shares.length ? "直す" : "取り分を入れる"}
          </button>
        )}
      </div>
      {!editing && shares.length > 0 && (
        <div className="panel-bd">
          <table>
            <thead><tr><th>受取人</th><th className="num">取り分</th><th className="num">当社の支払率</th><th>備考</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.partyId}>
                  <td>{s.partyName}{s.partyKind === "individual" ? <span className="faint">（個人・源泉）</span> : ""}</td>
                  <td className="num">{s.sharePpm / 10000}%</td>
                  <td className="num faint">
                    {detail.ratePpm === null ? "—" : `${Math.round(detail.ratePpm * s.sharePpm / 1_000_000) / 10000}%`}
                  </td>
                  <td className="faint">{s.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <div className="panel-bd stack">
          {error && <div className="alert">{error}</div>}
          <table>
            <thead><tr><th>受取人</th><th className="num">取り分（%）</th><th>備考</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.partyId}>
                  <td>{r.name}</td>
                  <td className="num">
                    <input value={r.pct} style={{ width: 80, textAlign: "right" }} placeholder="60"
                           onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                  </td>
                  <td>
                    <input value={r.note} placeholder="契約書の条項など"
                           onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} />
                  </td>
                  <td><button className="btn btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>外す</button></td>
                </tr>
              ))}
              <tr>
                <td className="faint">合計</td>
                <td className={`num ${total === 1_000_000 ? "" : "bad"}`}>{total / 10000}%</td>
                <td colSpan={2} className="faint">{total === 1_000_000 ? "" : "100% にしてください"}</td>
              </tr>
            </tbody>
          </table>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword} placeholder="名称・カナ・別名" label="受取人を足す" />
          </div>
          {keyword.trim() && (
            <div className="picker">
              {parties.filter((p) => !rows.some((r) => r.partyId === p.id)).map((p) => (
                <button key={p.id} className="btn btn-sm" style={{ textAlign: "left" }} onClick={() => add(p)}>{p.name}</button>
              ))}
              {!parties.length && <span className="faint">見つかりません</span>}
            </div>
          )}
          <div className="row">
            <button className="btn primary btn-sm" disabled={busy || rows.length < 2 || total !== 1_000_000}
                    onClick={() => void save()}>保存</button>
            {shares.length > 0 && (
              <button className="btn btn-sm" disabled={busy} onClick={() => void save(true)}>取り分を外す（相手先 1 者に戻す）</button>
            )}
            <button className="btn btn-sm" onClick={() => setEditing(false)}>やめる</button>
          </div>
          <p className="faint" style={{ margin: 0 }}>
            全体額を取り分で割るときは四捨五入し、合計が全体を超えたぶんは繰り上げの大きい行から 1 円ずつ引きます。
            決定済みの計算書は変わりません。
          </p>
        </div>
      )}
    </div>
  );
}
