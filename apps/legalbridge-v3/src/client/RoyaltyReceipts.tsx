import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 入金と作者への支払（docs/royalty-ledger.md §10）。
 *
 * 当社は取引先から OUT 条件に基づいてお金を受け取り、作者へ IN 条件に基づいて払う。
 * 入金（OUT 条件に割り当てた入金済みの入金）ごとに、その許諾先に効く作者（IN 条件）を並べ、
 * 報告が起きているか・受領額が入金と合うか・計算書を出したかを見せる。未報告の作者は
 * ここから報告を起こす（各作者が入金の全額にそれぞれの料率を掛ける）。
 */

type InState = "unreported" | "mismatch" | "waiting" | "issued";
interface Report {
  id: number; grossAmount: number | null; amount: number; occurredOn: string | null; languages: string[]; documentId: number | null; documentNo: string | null;
  /** 共著の取り分（当社が各人に払う）：受取人の数と、まだ計算書の無い受取人。 */
  payees?: { total: number; missing: string[] };
  /** この報告に繋がる決定した計算書（受取人ごとの計算書を含む）。 */
  documents?: Array<{ id: number; documentNo: string | null }>;
}
interface ReceiptIn {
  conditionId: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number | null; workTitle: string | null; usageLabel: string; ratePct: number | null; targeted: boolean;
  reports: Report[]; state: InState; reported: number;
}
interface Receipt {
  key: string; paymentId: number; paymentNo: string | null; paidOn: string | null; amount: number; currency: string;
  outConditionId: number; outConditionNo: string | null; outName: string; usageLabel: string;
  licenseeName: string; workId: number | null; workTitle: string | null; languages: string[]; regions: string[];
  ins: ReceiptIn[]; state: InState | "none";
}

const STATE: Record<InState | "none", { label: string; tag: string }> = {
  unreported: { label: "未報告", tag: "warn" },
  mismatch: { label: "金額が違う", tag: "danger" },
  waiting: { label: "計算書待ち", tag: "accent" },
  issued: { label: "計算書済", tag: "ok" },
  none: { label: "作者の条件なし", tag: "warn" }
};
const FILTERS: Array<[string, string]> = [
  ["open", "要対応"], ["unreported", "未報告"], ["mismatch", "金額が違う"], ["waiting", "計算書待ち"],
  ["issued", "計算書済"], ["none", "作者の条件なし"], ["", "すべて"]
];
const money = (n: number | null | undefined, currency = "JPY") =>
  n === null || n === undefined ? "—" : currency === "JPY"
    ? `¥${Math.round(n).toLocaleString("ja-JP")}` : `${currency} ${(n / 100).toLocaleString("en-US")}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return iso(d); };

export function RoyaltyReceipts({ onOpenCondition, onOpenDocument }: {
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
}) {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");
  const [from, setFrom] = useState(monthsAgo(12));
  const [to, setTo] = useState(iso(new Date()));
  const [state, setState] = useState("open");
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, []);
  useEffect(() => {
    setReceipts(null); setError(null);
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (state) q.set("state", state);
    api.get<{ receipts: Receipt[] }>(`/royalty-receipts?${q.toString()}`)
      .then((r) => setReceipts(r.receipts)).catch((e: ApiError) => setError(e.message));
  }, [from, to, state, version]);

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>入金と作者への支払</h2>
          <span className="faint">取引先からの入金（OUT 条件）ごとに、払うべき作者（IN 条件）の報告・計算書</span>
        </div>
        <div className="panel-bd row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 4 }}>入金日
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />〜
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <span className="chips">
            {FILTERS.map(([v, l]) => (
              <button key={v} className="chip" aria-pressed={state === v} onClick={() => setState(v)}>{l}</button>
            ))}
          </span>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note">{notice}</div>}
      {!receipts && !error && <div className="panel"><div className="panel-bd faint">読み込み中…</div></div>}
      {receipts && !receipts.length && <div className="panel"><div className="panel-bd faint">この条件に当たる入金はありません</div></div>}
      {receipts?.map((r) => (
        <ReceiptCard key={r.key} r={r} canWrite={canWrite} onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
                     onError={setError} onMade={(m) => { setNotice(m); setVersion((v) => v + 1); }} />
      ))}
    </div>
  );
}

function ReceiptCard({ r, canWrite, onOpenCondition, onOpenDocument, onError, onMade }: {
  r: Receipt; canWrite: boolean;
  onOpenCondition?: (id: number) => void; onOpenDocument?: (id: number) => void;
  onError: (m: string) => void; onMade: (m: string) => void;
}) {
  const pending = r.ins.filter((x) => x.state === "unreported");
  const [picked, setPicked] = useState<number[]>(pending.map((x) => x.conditionId));
  const [gross, setGross] = useState(String(r.amount));
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [stage, setStage] = useState<"" | "advance" | "balance">("");
  const [language, setLanguage] = useState(r.languages.length === 1 ? r.languages[0] : "");
  const [busy, setBusy] = useState(false);
  const st = STATE[r.state];
  const link = (id: number, text: string) => onOpenCondition
    ? <button className="linky code" onClick={() => onOpenCondition(id)}>{text}</button> : <span className="code">{text}</span>;

  async function make() {
    const amount = Number(gross.replace(/[,，¥￥\s]/g, ""));
    if (!(amount > 0)) { onError("受領額を入れてください"); return; }
    if (r.languages.length > 1 && !language) { onError("この入金の言語を選んでください（許諾先が複数の言語を持っています）"); return; }
    setBusy(true);
    try {
      await api.post("/royalty-receipts/reports", {
        paymentId: r.paymentId, outConditionId: r.outConditionId,
        entries: picked.map((conditionId) => ({
          conditionId, grossAmount: amount, taxIncluded, paymentStage: stage || null,
          languages: language ? [language] : null
        }))
      });
      onMade(`入金 ${r.paymentNo ?? `#${r.paymentId}`} から ${picked.length} 人分の報告を起こしました`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
        <b>{r.paidOn ?? "—"}</b>
        <span className="code">{r.paymentNo ?? `#${r.paymentId}`}</span>
        <span>{r.licenseeName}</span>
        <b>{money(r.amount, r.currency)}</b>
        <span className={`tag ${st.tag}`}>{st.label}</span>
        <span className="faint">
          許諾先 {link(r.outConditionId, r.outConditionNo ?? `#${r.outConditionId}`)} {r.outName}
          {r.workTitle ? `・作品 ${r.workTitle}` : ""}・{r.usageLabel}
          {r.languages.length ? `・${r.languages.join("・")}` : ""}
        </span>
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        {r.ins.length ? (
          <table className="table">
            <thead>
              <tr><th></th><th>作者</th><th>IN 条件</th><th>料率</th><th>状態</th><th>報告の受領額</th><th>作者への額</th><th>計算書</th></tr>
            </thead>
            <tbody>
              {r.ins.map((x) => {
                const s = STATE[x.state];
                return (
                  <tr key={x.conditionId}>
                    <td>
                      {x.state === "unreported" && canWrite && (
                        <input type="checkbox" aria-label={`${x.partyName} の報告を起こす`} checked={picked.includes(x.conditionId)}
                               onChange={(e) => setPicked((cur) => e.target.checked ? [...cur, x.conditionId] : cur.filter((id) => id !== x.conditionId))} />
                      )}
                    </td>
                    <td>{x.partyName}{x.targeted ? <span className="tag" style={{ marginLeft: 4 }}>許諾先専用</span> : null}</td>
                    <td>{link(x.conditionId, x.conditionNo ?? `#${x.conditionId}`)}{x.workTitle && x.workTitle !== r.workTitle ? <div className="faint">{x.workTitle}</div> : null}</td>
                    <td>{x.ratePct === null ? "—" : `${x.ratePct}%`}</td>
                    <td><span className={`tag ${s.tag}`}>{s.label}</span>
                      {(() => {
                        // 共著の取り分：受取人ごとの計算書のそろい具合（1 人目だけで済にしない）。
                        const p = x.reports.find((e) => e.payees)?.payees;
                        const missing = [...new Set(x.reports.flatMap((e) => e.payees?.missing ?? []))];
                        return p ? <div className={missing.length ? "warn" : "faint"}>
                          受取人 {p.total - missing.length}/{p.total} 人{missing.length ? `（${missing.join("・")} の計算書がまだ）` : ""}
                        </div> : null;
                      })()}</td>
                    <td>{x.reports.length ? money(x.reported, r.currency) : "—"}
                      {x.state === "mismatch" ? <div className="faint">入金 {money(r.amount, r.currency)} より {money(Math.abs(x.reported - r.amount), r.currency)} {x.reported < r.amount ? "少ない" : "多い"}</div> : null}</td>
                    <td>{x.reports.length ? money(x.reports.reduce((n, e) => n + e.amount, 0), r.currency) : "—"}</td>
                    <td>{x.reports.flatMap((e) => e.documents ?? (e.documentId ? [{ id: e.documentId, documentNo: e.documentNo }] : []))
                      .filter((d, i, a) => a.findIndex((y) => y.id === d.id) === i)
                      .map((d) => onOpenDocument
                        ? <div key={d.id}><button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button></div>
                        : <div key={d.id} className="code">{d.documentNo ?? `#${d.id}`}</div>)}
                      {!x.reports.some((e) => e.documentId) && <span className="faint">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <span className="faint">
            この許諾先に効く作者の条件（IN）が見つかりません。許諾先の作品と利用形態、作者の条件の作品（元の作品か）を確かめてください。
          </span>
        )}
        {canWrite && pending.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 4 }}>受領額
              <input className="inline-input" inputMode="numeric" value={gross} onChange={(e) => setGross(e.target.value)} style={{ width: 120 }} />
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} />税込（1.1 で割り戻す）
            </label>
            <select className="inline-input" aria-label="前金・後金" style={{ width: "auto" }} value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
              <option value="">前金・後金の別なし</option>
              <option value="advance">前金</option>
              <option value="balance">後金</option>
            </select>
            {r.languages.length > 1 && (
              <select className="inline-input" aria-label="この入金の言語" style={{ width: "auto" }} value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">言語を選ぶ</option>
                {r.languages.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            <button className="btn btn-sm" disabled={busy || !picked.length} onClick={() => void make()}>
              選んだ {picked.length} 人の報告を起こす
            </button>
            <span className="faint">各作者が受領額の全額にそれぞれの料率を掛けます。計算書は台帳（回）から出します。</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 入金 1 件から払うべき作者（取引管理で「入金を確認した」直後・入金済みの行から）。
 * 再許諾・他社販売の許諾先の入金でなければ（作者のいない入金）何も出さない。
 */
export function ReceiptsForPayment({ paymentId, onOpenCondition, onOpenDocument, onClose }: {
  paymentId: number;
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
  onClose?: () => void;
}) {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, []);
  useEffect(() => {
    api.get<{ receipts: Receipt[] }>(`/royalty-receipts?paymentId=${paymentId}`)
      .then((r) => setReceipts(r.receipts)).catch((e: ApiError) => setError(e.message));
  }, [paymentId, version]);
  if (error) return <div className="alert">{error}</div>;
  const withAuthors = (receipts ?? []).filter((r) => r.ins.length > 0);
  if (!withAuthors.length) return null;
  const pending = withAuthors.flatMap((r) => r.ins).filter((x) => x.state === "unreported").length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <b>この入金で作者に払いが出ます</b>
        <span className="faint">{pending ? `未報告の作者 ${pending} 人。選んで報告を起こしてください（各作者が入金の全額にそれぞれの料率を掛けます）` : "作者の報告は起きています"}</span>
        {onClose && <button className="linky" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>}
      </div>
      {notice && <div className="note ok">{notice}</div>}
      {withAuthors.map((r) => (
        <ReceiptCard key={r.key} r={r} canWrite={canWrite} onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
                     onError={setError} onMade={(m) => { setNotice(m); setVersion((v) => v + 1); }} />
      ))}
    </div>
  );
}

