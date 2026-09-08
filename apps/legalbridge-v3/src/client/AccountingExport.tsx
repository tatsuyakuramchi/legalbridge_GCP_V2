import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 経理提出用の帳票（V1 互換レイアウト）。
 *
 * 束ねごとに中身を確かめてから Excel にする。V1・V2 は一覧を見て
 * そのまま落とすだけだったが、V3 は「要確認」を先に見せる。
 * 割当が無い支払・源泉が計算値と合わない支払をそのまま経理へ流すと、
 * 支払内容が空欄のまま、あるいは源泉が足りないまま提出される。
 */

interface Row {
  paymentId: number; paymentNo: string | null; vendorName: string; title: string;
  subtotal: number; consumptionTax: number; withholdingTax: number; withholdingExpected: number;
  reimbursement: number; netTransfer: number; currency: string;
  slots: Array<{ content: string }>; flags: string[];
}
interface Group {
  key: string; paymentDate: string; owner: string; currency: string;
  count: number; flagged: number; rows: Row[];
  totals: { subtotal: number; consumptionTax: number; withholdingTax: number;
            reimbursement: number; netTransfer: number };
}
interface Result { from: string; to: string; basis: string; count: number; flagged: number; groups: Group[] }

const FLAG_LABEL: Record<string, string> = {
  unallocated: "割当なし",
  allocationMismatch: "割当が支払額と不一致",
  withholdingGap: "源泉が計算値と不一致"
};

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

export function AccountingExport() {
  const [from, setFrom] = useState(iso(monthStart));
  const [to, setTo] = useState(iso(monthEnd));
  const [basis, setBasis] = useState<"due" | "paid">("due");
  const [includeExported, setIncludeExported] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const query = () =>
    `from=${from}&to=${to}&basis=${basis}${includeExported ? "&includeExported=true" : ""}`;

  function load() {
    setError(null);
    api.get<Result>(`/exports/accounting?${query()}`)
      .then(setResult).catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { load(); }, [from, to, basis, includeExported]);

  async function mark(group: Group) {
    setBusy(group.key); setError(null);
    try {
      await api.post("/exports/accounting/mark", {
        paymentIds: group.rows.map((r) => r.paymentId), batchKey: group.key
      });
      load();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(""); }
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>経理提出用の帳票</h2>
          <span className="faint">旧システムと同じ列並び（支払内容×8・立替金・源泉税・差引振込額）</span>
        </div>
        <div className="panel-bd">
          <div className="row">
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">期間</span>
              <input className="inline-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="faint">〜</span>
              <input className="inline-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">基準</span>
              <select value={basis} onChange={(e) => setBasis(e.target.value as "due" | "paid")}>
                <option value="due">支払期日（これから払う分）</option>
                <option value="paid">支払日（経理の月次）</option>
              </select>
            </label>
            <label className="row" style={{ gap: 5 }}>
              <input type="checkbox" checked={includeExported}
                onChange={(e) => setIncludeExported(e.target.checked)} />
              <span className="faint">出力済みも含める</span>
            </label>
          </div>
          {error && <div className="alert" style={{ marginTop: 9 }}>{error}</div>}
          {result && (
            <p className="faint" style={{ marginTop: 9 }}>
              {result.count} 件／{result.groups.length} 束
              {result.flagged > 0 && (
                <b style={{ color: "var(--out)" }}>　要確認 {result.flagged} 件</b>
              )}
            </p>
          )}
          {result && result.flagged > 0 && (
            <div className="note warn" style={{ marginTop: 4 }}>
              要確認のある行は、支払内容が空欄のまま、または源泉が計算値と違うまま出ます。
              Excel の「要確認」列に理由が入るので、経理へ渡す前に潰してください。
              割当は お金 → 支払 の画面から入れられます。
            </div>
          )}
        </div>
      </div>

      {result?.groups.map((g) => (
        <div key={g.key} className="panel">
          <div className="panel-hd">
            <h2>{g.paymentDate || "期日未設定"}　{g.owner}</h2>
            <span className="faint">
              {g.currency}　{g.count}件　小計 {g.totals.subtotal.toLocaleString("ja-JP")}
              　振込 <b>{g.totals.netTransfer.toLocaleString("ja-JP")}</b>
              {g.flagged > 0 && <b style={{ color: "var(--out)" }}>　要確認 {g.flagged}</b>}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>支払番号</th><th>件名</th><th>取引先</th><th>支払内容</th>
                <th className="right">小計</th><th className="right">消費税</th>
                <th className="right">源泉税</th><th className="right">差引振込額</th><th>要確認</th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.paymentId}>
                    <td className="code">{r.paymentNo ?? `#${r.paymentId}`}</td>
                    <td>{r.title || "—"}</td>
                    <td>{r.vendorName}</td>
                    <td className="faint">{r.slots[0]?.content || "—"}</td>
                    <td className="right">{r.subtotal.toLocaleString("ja-JP")}</td>
                    <td className="right">{r.consumptionTax.toLocaleString("ja-JP")}</td>
                    <td className="right">
                      {r.withholdingTax.toLocaleString("ja-JP")}
                      {r.flags.includes("withholdingGap") && (
                        <div className="faint">計算値 {r.withholdingExpected.toLocaleString("ja-JP")}</div>
                      )}
                    </td>
                    <td className="right"><b>{r.netTransfer.toLocaleString("ja-JP")}</b></td>
                    <td>{r.flags.length
                      ? <span className="tag out">{r.flags.map((f) => FLAG_LABEL[f] ?? f).join("／")}</span>
                      : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-bd row">
            <a className="btn primary" href={`/api/v3/exports/accounting.xls?${query()}&groupKey=${encodeURIComponent(g.key)}`}>
              経理提出用Excel（{g.count}件）
            </a>
            <a className="btn" href={`/api/v3/exports/accounting.xls?${query()}&groupKey=${encodeURIComponent(g.key)}&layout=breakdown`}>
              内訳一覧
            </a>
            <button className="btn" disabled={busy === g.key} onClick={() => void mark(g)}>
              {busy === g.key ? "記録中…" : "出力済みにする"}
            </button>
            <span className="faint">出力済みにすると次の集計から外れます（取り消しは監査記録から）</span>
          </div>
        </div>
      ))}

      {result && !result.groups.length && (
        <div className="panel"><div className="panel-bd faint">
          この期間に出す支払はありません。{!includeExported && "すでに出力済みかもしれません（上のチェックで確認できます）。"}
        </div></div>
      )}
    </div>
  );
}
