import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 経理提出用の帳票。経理へ渡すのは V1 形式（種別 × 個人／法人ごとの xlsx と
 * 各文書の PDF を zip で）。確認用の Excel は要確認の列付きで別に出せる。
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
  slots: Array<{ content: string }>; moreSlots?: Array<Array<{ content: string }>>; flags: string[];
  category: string; entity: string; documentNo: string | null; documentId: number | null;
}
interface Group {
  key: string; paymentDate: string; owner: string; currency: string;
  count: number; flagged: number; rows: Row[];
  v1Files: Array<{ category: string; entity: string; count: number }>;
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
// 手元の日付で YYYY-MM-DD にする。toISOString は UTC なので、日本時間では月初・月末の
// 0 時が前日になり、既定の期間が 9/30〜10/30 になって 10/31 期日の支払が出なかった。
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

export function AccountingExport() {
  const [from, setFrom] = useState(iso(monthStart));
  const [to, setTo] = useState(iso(monthEnd));
  const [basis, setBasis] = useState<"due" | "paid">("due");
  const [includeExported, setIncludeExported] = useState(false);
  /** 全部まとめての xlsx を、支払先ごとに 1 行・支払内容 1 組にする（作品ごとの組を並べない）。 */
  const [merge, setMerge] = useState(true);
  /** 全部まとめての社内担当（空なら全員）。束の担当者の名前で絞る。 */
  const [owner, setOwner] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [staff, setStaff] = useState<Array<{ id: number; name: string; status?: string }>>([]);
  useEffect(() => {
    api.get<{ staff: typeof staff }>("/staff")
      .then((r) => setStaff(r.staff.filter((x) => (x.status ?? "active") === "active"))).catch(() => setStaff([]));
  }, []);

  /** 社内の担当者（経理提出用）を付け替える。紙（PDF）は変わらない。 */
  async function assign(row: Row, staffId: string) {
    if (!row.documentId) return;
    setBusy(`owner:${row.paymentId}`); setError(null);
    try {
      await api.put(`/documents/${row.documentId}/account-owner`, { staffId: staffId ? Number(staffId) : null });
      load();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(""); }
  }

  const query = () =>
    `from=${from}&to=${to}&basis=${basis}${includeExported ? "&includeExported=true" : ""}`;

  function load() {
    setError(null);
    api.get<Result>(`/exports/accounting?${query()}`)
      .then(setResult).catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { load(); }, [from, to, basis, includeExported]);

  /** 全部の束をまとめて出力済みにする。経理に渡したあとで押す。 */
  async function markAll() {
    if (!result) return;
    const groups = result.groups.filter((g) => !owner || g.owner === owner);
    const ids = groups.flatMap((g) => g.rows.map((r) => r.paymentId));
    if (!ids.length) return;
    if (!window.confirm(`${owner ? `${owner} の ` : ""}${ids.length} 件を出力済みにします。次の集計から外れます。経理に渡したあとで押してください。よいですか？`)) return;
    setBusy("all"); setError(null);
    try {
      await api.post("/exports/accounting/mark", {
        paymentIds: ids, batchKey: `${from}_${to}${owner ? `_${owner}` : ""}`
      });
      load();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(""); }
  }

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
          <span className="faint">旧システム（V1）と同じ形：種別 × 個人／法人ごとの xlsx（52 列）＋ 各文書の PDF を zip で</span>
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
          {result && result.count > 0 && (
            <div className="row" style={{ gap: 6, marginTop: 9, flexWrap: "wrap", alignItems: "center" }}>
              <strong>全部まとめて</strong>
              <label className="row" style={{ gap: 4 }} title="社内担当で絞る。選んだ担当者の分だけを 1 つにまとめる">
                <span className="faint">担当者</span>
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">全員</option>
                  {[...new Set(result.groups.map((g) => g.owner))].sort((a, b) => a.localeCompare(b, "ja")).map((o) => (
                    <option key={o} value={o}>{o}（{result.groups.filter((g) => g.owner === o).reduce((n, g) => n + g.count, 0)} 件）</option>
                  ))}
                </select>
              </label>
              <label className="row" style={{ gap: 4 }} title="作品ごとの支払内容の組を並べず、支払先ごとに 1 行・支払内容 1 列（例「利用許諾料（12作品分）」）にまとめる">
                <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
                <span>支払先ごとに 1 行（支払内容を 1 列にまとめる。下の束ごとのボタンにも効きます）</span>
              </label>
              <a className="btn primary" href={`/api/v3/exports/accounting/combined?${query()}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}&format=zip&merge=${merge ? 1 : 0}`}
                 title="V1 の xlsx（種別 × 個人／法人 × 支払日）と、全部の PDF を 1 つの zip に">
                ↓ 1 つの zip（xlsx ＋ 全部の PDF）
              </a>
              <a className="btn" href={`/api/v3/exports/accounting/combined?${query()}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}&format=xlsx&layout=sheets&merge=${merge ? 1 : 0}`}
                 title="1 つの xlsx。種別 × 個人／法人ごとにシートを分ける">
                ↓ xlsx 1 ファイル（シート分け）
              </a>
              <a className="btn ghost" href={`/api/v3/exports/accounting/combined?${query()}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}&format=xlsx&layout=one&merge=${merge ? 1 : 0}`}
                 title="1 つの xlsx の 1 シートに全部（種別 → 個人／法人 → 支払日の順）">
                ↓ xlsx 1 シートに全部
              </a>
              <button className="btn ghost" disabled={busy === "all"} onClick={() => void markAll()}>
                {busy === "all" ? "記録中…"
                  : `${owner ? `${owner} の分` : "全部"}（${result.groups.filter((g) => !owner || g.owner === owner).reduce((n, g) => n + g.count, 0)} 件）を出力済みにする`}
              </button>
              <span className="faint">下の束ごとのボタンは、担当者・支払日ごとに分けて出したいときに</span>
            </div>
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
              <thead><tr><th>支払番号</th><th>種別</th><th>件名</th><th>取引先</th><th>支払内容</th><th>社内担当</th>
                <th className="right">小計</th><th className="right">消費税</th>
                <th className="right">源泉税</th><th className="right">差引振込額</th><th>要確認</th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.paymentId}>
                    <td className="code">{r.paymentNo ?? `#${r.paymentId}`}</td>
                    <td className="faint">{r.category}（{r.entity}）
                      {!r.documentNo && <div className="faint">書類なし</div>}</td>
                    <td>{r.title || "—"}</td>
                    <td>{r.vendorName}</td>
                    <td className="faint">
                      {[...r.slots, ...(r.moreSlots ?? []).flat()].filter((x) => x.content)
                        .map((x, i) => <div key={i}>{x.content}</div>)}
                      {!r.slots.some((x) => x.content) && "—"}
                      {(r.moreSlots?.length ?? 0) > 0 && (
                        <div className="tag ghost" title="9 組目からは Excel の次の行に続けて載せます（金額の欄は 1 行目だけ）">
                          Excel {1 + (r.moreSlots?.length ?? 0)} 行
                        </div>
                      )}
                    </td>
                    <td>
                      {r.documentId
                        ? <select aria-label="社内担当" value="" disabled={busy === `owner:${r.paymentId}`}
                            title="経理提出用の担当者。紙（PDF）には出ません"
                            onChange={(e) => void assign(r, e.target.value)}>
                            <option value="">{g.owner === "(担当者未設定)" ? "担当を付ける…" : "付け替える…"}</option>
                            {staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        : <span className="faint">—</span>}
                    </td>
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
            {g.v1Files.map((f) => {
              const href = `/api/v3/exports/accounting/v1?${query()}&groupKey=${encodeURIComponent(g.key)}`
                + `&category=${encodeURIComponent(f.category)}&entity=${encodeURIComponent(f.entity)}&merge=${merge ? 1 : 0}`;
              return (
                <span key={`${f.category}-${f.entity}`} className="row" style={{ gap: 4 }}>
                  <a className="btn primary" href={href}>
                    ↓ {f.category}_{f.entity}（{f.count}件・PDF 付き zip）
                  </a>
                  <a className="btn ghost btn-sm" href={`${href}&withPdf=0`}>xlsx だけ</a>
                </span>
              );
            })}
          </div>
          <div className="panel-bd row">
            <a className="btn ghost" href={`/api/v3/exports/accounting.xls?${query()}&groupKey=${encodeURIComponent(g.key)}`}>
              ↓ 確認用Excel（要確認の列付き）
            </a>
            <a className="btn ghost" href={`/api/v3/exports/accounting.xls?${query()}&groupKey=${encodeURIComponent(g.key)}&layout=breakdown`}>
              ↓ 内訳一覧
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
