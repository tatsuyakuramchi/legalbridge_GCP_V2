import { useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";

type Basis = "pay" | "paid" | "issued";
type PayStatus = "paid" | "partial" | "planned" | "unregistered";

interface Line { name: string; amountStr: string }
interface Doc {
  id: number; index: number; documentNo: string | null; kind: "inspection" | "completion" | "statement";
  kindLabel: string; title: string; period: string | null; issuedOn: string | null;
  payOn: string | null; payStatus: PayStatus; statusLabel: string; currency: string;
  netStr: string; amountStr: string; taxStr: string; withholdingStr: string; hasWithholding: boolean;
  amountSource: "payment" | "document"; lines: Line[];
}
interface Total { currency: string; count: number; amountStr: string; taxStr: string; withholdingStr: string; netStr: string }
interface Report {
  party: { id: number; name: string; kind: string };
  from: string; to: string; basis: Basis; documents: Doc[]; totals: Total[]; skipped: number;
}

const BASIS: Array<[Basis, string]> = [
  ["pay", "支払日（未払いは支払予定日）"],
  ["paid", "支払日（支払済みのみ）"],
  ["issued", "文書の発行日"]
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthRange = (offset: number) => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last) };
};
/** 半期（1〜6月／7〜12月）。offset 0 で今の半期、-1 で前の半期。 */
const halfRange = (offset: number) => {
  const now = new Date();
  const index = now.getFullYear() * 2 + (now.getMonth() < 6 ? 0 : 1) + offset;
  const y = Math.floor(index / 2), h = index % 2;
  return { from: `${y}-${h ? "07" : "01"}-01`, to: `${y}-${h ? "12-31" : "06-30"}` };
};
const yearRange = (offset: number) => {
  const y = new Date().getFullYear() + offset;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
};

const PRESETS: Array<[string, () => { from: string; to: string }]> = [
  ["先月", () => monthRange(-1)], ["今月", () => monthRange(0)],
  ["前の半期", () => halfRange(-1)], ["今の半期", () => halfRange(0)],
  ["昨年", () => yearRange(-1)], ["今年", () => yearRange(0)]
];

const STATUS_TONE: Record<PayStatus, string> = { paid: "ok", partial: "", planned: "", unregistered: "out" };

/**
 * 支払報告書（文書）。許諾者・受注者 1 件の、期間内の検収書・役務提供完了通知書・利用許諾料計算書を
 * 支払日と明細つきで 1 通にまとめる（ひな形 payment_report。server/paydocs/payment-report-doc.ts）。
 *
 * 集計 → 載せる文書を選ぶ（外したい文書のチェックを外す）→ 備考 → プレビュー／PDF。
 * 読むだけで、文書の番号は振らない。
 */
export function PaymentStatementDoc() {
  const [partyId, setPartyId] = useState("");
  const [partyLabel, setPartyLabel] = useState<string | null>(null);
  const [range, setRange] = useState(monthRange(-1));
  const [basis, setBasis] = useState<Basis>("pay");
  const [report, setReport] = useState<Report | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [remarks, setRemarks] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ partyId, from: range.from, to: range.to, basis });
    if (excluded.size) q.set("exclude", [...excluded].join(","));
    if (remarks.trim()) q.set("remarks", remarks.trim());
    return q.toString();
  }, [partyId, range, basis, excluded, remarks]);

  async function run() {
    if (!partyId) { setError("取引先を選んでください"); return; }
    setBusy(true); setError(null); setPreview(null);
    try {
      const q = new URLSearchParams({ partyId, from: range.from, to: range.to, basis });
      setReport(await api.get<Report>(`/reports/payment-statement?${q}`));
      setExcluded(new Set());
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function showPreview() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v3/reports/payment-statement/html?${query}`);
      const text = await response.text();
      if (!response.ok) {
        let message = "プレビューを作れませんでした";
        try { message = JSON.parse(text).error ?? message; } catch { /* 本文が JSON でない */ }
        throw new Error(message);
      }
      setPreview(text);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const toggle = (id: number) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExcluded(next);
    setPreview(null);
  };

  const picked = report ? report.documents.filter((d) => !excluded.has(d.id)) : [];
  const stale = report && (String(report.party.id) !== partyId || report.from !== range.from
    || report.to !== range.to || report.basis !== basis);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>支払報告書（文書）</h2>
        <span className="faint">許諾者・受注者ごとに、期間内の検収書・利用許諾料計算書を支払日と明細つきで 1 通に</span>
      </div>
      <div className="panel-bd">
        <div className="row no-print" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 260 }}>
            <span>取引先（許諾者・受注者）</span>
            <SearchSelect value={partyId} valueLabel={partyLabel} search={searchParties}
                          placeholder="取引先名・コードで探す"
                          onChange={(v, option) => { setPartyId(v); setPartyLabel(option?.label ?? null); }} />
          </label>
          <label className="field">
            <span>開始</span>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="field">
            <span>終了</span>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </label>
          <label className="field">
            <span>期間の基準</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              {BASIS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={busy || !partyId}>
            {busy && !report ? "集計中…" : "集計する"}
          </button>
        </div>
        <div className="row no-print" style={{ flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          <span className="faint">期間：</span>
          {PRESETS.map(([label, make]) => (
            <button key={label} className="btn btn-sm" onClick={() => setRange(make())}>{label}</button>
          ))}
        </div>

        {error && <div className="alert">{error}</div>}

        {report && (
          <div style={{ marginTop: 12 }}>
            {stale && <div className="alert">条件を変えました。「集計する」で出し直してください。</div>}
            <div className="row" style={{ gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <b>{report.party.name}</b>
              <span className="faint">
                {report.from} 〜 {report.to} ／ {report.documents.length} 件
                {report.skipped ? `（期間外 ${report.skipped} 件は載せない）` : ""}
              </span>
            </div>

            {!report.documents.length ? (
              <p className="faint">この期間に載せる検収書・利用許諾料計算書はありません。期間の基準を変えてみてください。</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>載せる</th><th>支払日</th><th>文書番号</th><th>種別</th><th>件名</th>
                      <th>状態</th><th className="num">明細</th><th className="num">お支払額</th><th>金額の出どころ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.documents.map((d) => (
                      <tr key={d.id} style={excluded.has(d.id) ? { opacity: 0.45 } : undefined}>
                        <td><input type="checkbox" checked={!excluded.has(d.id)} onChange={() => toggle(d.id)}
                                   aria-label={`${d.documentNo ?? d.id} を載せる`} /></td>
                        <td className="code">{d.payOn ?? "未定"}</td>
                        <td className="code">{d.documentNo ?? "—"}</td>
                        <td>{d.kindLabel}</td>
                        <td>{d.title}{d.period ? <div className="faint">{d.period}</div> : null}</td>
                        <td><span className={`tag ${STATUS_TONE[d.payStatus]}`}>{d.statusLabel}</span></td>
                        <td className="num">{d.lines.length}</td>
                        <td className="num">{d.netStr}</td>
                        <td className="faint">{d.amountSource === "payment" ? "支払の記録" : "文書の明細（支払未登録）"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.documents.length > 0 && excluded.size === 0 && report.totals.map((t) => (
              <div key={t.currency} className="faint" style={{ textAlign: "right", marginTop: 4 }}>
                {report.totals.length > 1 ? `${t.currency}：` : "合計："}
                税抜 {t.amountStr} ／ 消費税 {t.taxStr} ／ 源泉 {t.withholdingStr} ／ <b>お支払額 {t.netStr}</b>
              </div>
            ))}
            {excluded.size > 0 && (
              <div className="faint" style={{ textAlign: "right", marginTop: 4 }}>
                {excluded.size} 件を外しています（合計はプレビュー・PDF で出し直します）
              </div>
            )}

            {report.documents.length > 0 && (
              <>
                <label className="field" style={{ marginTop: 10 }}>
                  <span>備考（合計の下に出る）</span>
                  <textarea rows={2} value={remarks} maxLength={2000}
                            onChange={(e) => { setRemarks(e.target.value); setPreview(null); }} />
                </label>
                <div className="row no-print" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn" onClick={showPreview} disabled={busy || !!stale || !picked.length}>
                    {busy ? "作成中…" : "プレビュー"}
                  </button>
                  <a className="btn primary"
                     style={stale || !picked.length ? { opacity: 0.45, pointerEvents: "none" } : undefined}
                     aria-disabled={!!stale || !picked.length}
                     href={stale || !picked.length ? undefined : `/api/v3/reports/payment-statement/pdf?${query}`}>
                    PDF をダウンロード
                  </a>
                  <span className="faint">{picked.length} 件を載せる</span>
                </div>
              </>
            )}

            {preview && (
              <iframe className="preview" title="支払報告書のプレビュー" srcDoc={preview}
                      style={{ width: "100%", minHeight: 720, marginTop: 10, border: "1px solid #ddd", background: "#fff" }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
