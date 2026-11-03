import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect } from "./SearchSelect.js";

/**
 * 入金から計算書（支払文書のタブ）。
 *
 *   1 取引モデルを選ぶ（再許諾／自社製造・他社販売／自社製造・自社販売）
 *   2 OUT 先（許諾先）を選ぶ → その社の条件（作品ごと）と、記録済みでまだ報告の無い入金
 *     自社製造・自社販売は OUT 先が無いので作品を選ぶ
 *   3 入金の情報（入金日・金額・税込・前金／後金／一括・言語）
 *   4 払うべき作者（自動で全員チェック）→「計算書を作る」で 入金の記録 → 報告 → 計算書 → 支払 まで一度に
 *
 * 裏は POST /royalty-settle（royalty/receipt-settle.ts）。計算の決まりは従来の計算書と同じ。
 */

type Usage = "sublicense" | "oem" | "in_house";
const USAGES: Array<[Usage, string, string]> = [
  ["oem", "自社製造・他社販売", "当社が作って他社が売る。販売先からの受領額 × 料率"],
  ["sublicense", "再許諾", "第三者に出させる。再許諾先からの受領額 × 料率"],
  ["in_house", "自社製造・自社販売", "当社が作って当社が売る。OUT 先は無い（数量 × 基準価格 × 料率）"]
];

interface Out { id: number; conditionNo: string | null; name: string; usageType: string | null; usageLabel: string;
  workId: number | null; workTitle: string | null; currency: string; languages: string[]; ratePct: number | null;
  termStart: string | null; termEnd: string | null }
interface OpenReceipt { paymentId: number; paymentNo: string | null; paidOn: string | null; amount: number; currency: string;
  outConditionId: number; outName: string; usageLabel: string; workTitle: string | null; reported: boolean }
interface Author { conditionId: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number | null; workTitle: string | null; ratePct: number | null; targeted: boolean;
  state: "unreported" | "mismatch" | "waiting" | "issued"; reportCount: number;
  documents: Array<{ id: number; documentNo: string | null }>; estimate: number | null;
  payees: Array<{ partyId: number; partyName: string }> }
interface Preview { mode: "receipt" | "in_house"; paymentId: number | null; paymentNo: string | null; paidOn: string | null;
  amount: number | null; currency: string; outConditionId: number | null; outName: string | null; usageLabel: string;
  licenseeName: string | null; workId: number | null; workTitle: string | null; languages: string[];
  authors: Author[]; blockers: string[]; notes: string[] }
interface ResultRow { conditionId: number; partyName: string; payeeName: string | null; eventIds: number[];
  documentId: number | null; documentNo: string | null; draft: boolean; paymentId: number | null; paymentNo: string | null;
  skipped: string | null; error: string | null }
interface Result { mode: string; paymentId: number | null; paymentNo: string | null; paymentCreated: boolean; rows: ResultRow[]; errors: string[] }

const STATE: Record<Author["state"], { label: string; tag: string }> = {
  unreported: { label: "未報告", tag: "warn" }, mismatch: { label: "金額が違う", tag: "out" },
  waiting: { label: "計算書待ち", tag: "warn" }, issued: { label: "計算書済", tag: "ok" }
};
const today = () => new Date().toISOString().slice(0, 10);
const num = (s: string) => { const n = Number(s.replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };

export function ReceiptSettle({ onOpenCondition, onOpenDocument }: {
  onOpenCondition?: (id: number) => void; onOpenDocument?: (id: number) => void;
}) {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");
  useEffect(() => { api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null)); }, []);

  const [usage, setUsage] = useState<Usage>("oem");
  const [party, setParty] = useState<{ id: number; name: string } | null>(null);
  const [outs, setOuts] = useState<Out[]>([]);
  const [openReceipts, setOpenReceipts] = useState<OpenReceipt[]>([]);
  const [outId, setOutId] = useState<number | null>(null);
  const [paymentId, setPaymentId] = useState<number | null>(null);
  const [work, setWork] = useState<{ id: number; title: string } | null>(null);
  const [paidOn, setPaidOn] = useState(today());
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [stage, setStage] = useState<"" | "advance" | "balance">("");
  const [language, setLanguage] = useState("");
  const [note, setNote] = useState("");
  const [draftOnly, setDraftOnly] = useState(false);
  const [withPayment, setWithPayment] = useState(true);
  const [dueOn, setDueOn] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const inHouse = usage === "in_house";

  // OUT 先を選んだら、その社の条件（取引モデルで絞る）と記録済みの入金。
  useEffect(() => {
    setOuts([]); setOpenReceipts([]); setOutId(null); setPaymentId(null); setPreview(null); setResult(null);
    if (!party || inHouse) return;
    api.get<{ outs: Out[]; receipts: OpenReceipt[] }>(`/royalty-settle/outs?partyId=${party.id}`)
      .then((r) => {
        const list = r.outs.filter((o) => o.usageType === usage);
        setOuts(list); setOpenReceipts(r.receipts.filter((x) => list.some((o) => o.id === x.outConditionId)));
        if (list.length === 1) setOutId(list[0].id);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [party?.id, usage]);

  // 入金を選び直したら、その入金の許諾先と金額を入れ物に写す。
  const chosenReceipt = openReceipts.find((x) => x.paymentId === paymentId) ?? null;
  const out = outs.find((o) => o.id === (chosenReceipt?.outConditionId ?? outId)) ?? null;
  useEffect(() => { setLanguage(out && out.languages.length === 1 ? out.languages[0] : ""); }, [out?.id]);

  // 下見：許諾先（か作品）が決まったら、払うべき作者を引く。金額を入れれば見込み額が付く。
  const body = () => ({
    usageType: usage,
    ...(inHouse
      ? { workId: work?.id ?? null, quantity: num(quantity) || null, unitAmount: num(unit) || null }
      : { paymentId: paymentId ?? null, outConditionId: out?.id ?? null, amount: num(amount) || null }),
    paidOn: paidOn || null, taxIncluded, paymentStage: stage || null,
    languages: language ? [language] : null, note: note.trim() || null
  });
  const previewKey = inHouse ? `${work?.id ?? 0}:${num(quantity)}:${num(unit)}` : `${paymentId ?? 0}:${out?.id ?? 0}:${num(amount)}`;
  useEffect(() => {
    setPreview(null); setResult(null); setError(null);
    if (inHouse ? !work : !out) return;
    let live = true;
    api.post<Preview>("/royalty-settle/preview", body())
      .then((p) => { if (!live) return; setPreview(p); setPicked(p.authors.filter((a) => a.state !== "issued").map((a) => a.conditionId)); })
      .catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [previewKey]);

  const amountFor = inHouse ? Math.round(num(quantity) * num(unit)) : (chosenReceipt?.amount ?? num(amount));
  const ready = canWrite && preview && !preview.blockers.length && picked.length > 0 && amountFor > 0
    && (!(preview.languages.length > 1) || paymentId || language);

  async function run() {
    if (!preview) return;
    const what = draftOnly ? "作者ごとの計算書の下書きを作ります（決定は文書の画面で）" : `作者ごとの計算書を決定${withPayment ? "し、作者への支払を立てます" : "します"}`;
    const head = inHouse
      ? `作品「${preview.workTitle}」の売上 ${money(amountFor, "JPY")}（${quantity} × ${money(num(unit), "JPY")}）から`
      : `${preview.licenseeName} からの入金 ${money(amountFor, preview.currency)}${paymentId ? `（${preview.paymentNo ?? ""} 記録済み）` : "（新しく記録）"} から`;
    if (!confirm(`${head}、作者 ${picked.length} 人の報告を起こし、${what}。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<Result>("/royalty-settle", { ...body(), authors: picked, draftOnly, withPayment, dueOn: dueOn || null });
      setResult(r);
      // 記録済みの入金として選び直せるように、入金の一覧を引き直す。
      if (party) api.get<{ outs: Out[]; receipts: OpenReceipt[] }>(`/royalty-settle/outs?partyId=${party.id}`)
        .then((x) => setOpenReceipts(x.receipts.filter((y) => outs.some((o) => o.id === y.outConditionId)))).catch(() => undefined);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  function reset() {
    setParty(null); setWork(null); setOutId(null); setPaymentId(null); setAmount(""); setQuantity(""); setUnit("");
    setStage(""); setTaxIncluded(false); setNote(""); setPreview(null); setResult(null); setError(null);
  }

  const link = (id: number, text: string) => onOpenCondition
    ? <button className="linky code" onClick={() => onOpenCondition(id)}>{text}</button> : <span className="code">{text}</span>;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>入金から計算書</h2>
          <span className="faint">OUT 先を選ぶ → 入金を入れる → 作者の報告・利用許諾計算書・支払まで 1 回で。時限式（四半期締めなど）は「作家の報告と計算書」から</span>
        </div>
        <div className="panel-bd stack" style={{ gap: 12 }}>
          {/* 1 取引モデル */}
          <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b style={{ minWidth: 110 }}>1 取引モデル</b>
            <span className="chips">
              {USAGES.map(([v, l, hint]) => (
                <button key={v} className="chip" aria-pressed={usage === v} title={hint}
                        onClick={() => { setUsage(v); setOutId(null); setPaymentId(null); setPreview(null); setResult(null); }}>{l}</button>
              ))}
            </span>
            <span className="faint">{USAGES.find((u) => u[0] === usage)?.[2]}</span>
          </div>

          {/* 2 OUT 先 ／ 作品 */}
          <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b style={{ minWidth: 110 }}>{inHouse ? "2 作品" : "2 OUT 先"}</b>
            <div style={{ minWidth: 340 }}>
              {inHouse ? (
                <SearchSelect value={work ? String(work.id) : ""} placeholder="作品名・作品コードで探す（OUT 先は無い）"
                  search={async (q) => {
                    const r = await api.get<{ works: Array<{ id: number; title: string; workCode: string | null }> }>(`/works?q=${encodeURIComponent(q)}`);
                    return r.works.map((w) => ({ value: String(w.id), label: w.title, hint: w.workCode }));
                  }}
                  onChange={(v, o) => setWork(v ? { id: Number(v), title: o?.label ?? v } : null)} />
              ) : (
                <SearchSelect value={party ? String(party.id) : ""} placeholder="許諾先（取引先）の名前で探す"
                  search={async (q) => {
                    const r = await api.get<{ parties: Array<{ id: number; name: string; outs: number; open: number }> }>(`/royalty-settle/licensees?q=${encodeURIComponent(q)}`);
                    return r.parties.map((p) => ({ value: String(p.id), label: p.name, hint: `条件 ${p.outs}${p.open ? `・未処理の入金 ${p.open}` : ""}` }));
                  }}
                  onChange={(v, o) => setParty(v ? { id: Number(v), name: o?.label ?? v } : null)} />
              )}
            </div>
            {!inHouse && party && !outs.length && <span className="warn">この取引先に「{USAGES.find((u) => u[0] === usage)?.[1]}」の OUT 条件がありません。取引モデルを変えるか、条件明細を登録してください</span>}
          </div>
          {!inHouse && outs.length > 0 && (
            <div className="stack" style={{ gap: 6, marginLeft: 120 }}>
              <span className="faint">条件（作品 × 取引モデル）を選ぶ</span>
              {outs.map((o) => (
                <label key={o.id} className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  <input type="radio" name="out" checked={(chosenReceipt?.outConditionId ?? outId) === o.id} disabled={!!chosenReceipt}
                         onChange={() => { setOutId(o.id); setPaymentId(null); }} />
                  <b>{o.workTitle ?? "（作品なし）"}</b>
                  {link(o.id, o.conditionNo ?? `#${o.id}`)}
                  <span className="faint">{o.name}・{o.ratePct === null ? "料率なし" : `${o.ratePct}%`}{o.languages.length ? `・${o.languages.join("・")}` : ""}
                    {o.termStart || o.termEnd ? `・${o.termStart ?? ""}〜${o.termEnd ?? ""}` : ""}</span>
                </label>
              ))}
              {openReceipts.length > 0 && (
                <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                  <span className="faint">記録済みの入金から進める（取引管理で入金済みにしたもの）</span>
                  {openReceipts.map((x) => (
                    <label key={x.paymentId} className="row" style={{ gap: 8, alignItems: "baseline" }}>
                      <input type="radio" name="receipt" checked={paymentId === x.paymentId}
                             onChange={() => { setPaymentId(x.paymentId); setOutId(x.outConditionId); }} />
                      <span>{x.paidOn ?? "—"}</span><span className="code">{x.paymentNo ?? `#${x.paymentId}`}</span>
                      <b>{money(x.amount, x.currency)}</b>
                      <span className="faint">{x.workTitle ?? ""}・{x.usageLabel}</span>
                      {x.reported ? <span className="tag">報告あり</span> : <span className="tag warn">未報告</span>}
                    </label>
                  ))}
                  {paymentId && <button className="linky" onClick={() => setPaymentId(null)}>記録済みの入金を使わず、新しく記録する</button>}
                </div>
              )}
            </div>
          )}

          {/* 3 入金 */}
          <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b style={{ minWidth: 110 }}>{inHouse ? "3 売上" : "3 入金"}</b>
            <label className="row" style={{ gap: 4 }}>{inHouse ? "売上日" : "入金日"}
              <input type="date" value={chosenReceipt?.paidOn ?? paidOn} disabled={!!chosenReceipt} onChange={(e) => setPaidOn(e.target.value)} />
            </label>
            {inHouse ? (<>
              <label className="row" style={{ gap: 4 }}>数量
                <input className="inline-input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={{ width: 90 }} />
              </label>
              <label className="row" style={{ gap: 4 }}>基準価格（税抜）
                <input className="inline-input" inputMode="numeric" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 110 }} />
              </label>
              <span className="faint">= {money(Math.round(num(quantity) * num(unit)), "JPY")}</span>
            </>) : (
              <label className="row" style={{ gap: 4 }}>入金額
                <input className="inline-input" inputMode="numeric" value={chosenReceipt ? String(chosenReceipt.amount) : amount} disabled={!!chosenReceipt}
                       onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} placeholder="例：1,000,000" />
              </label>
            )}
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} />税込（1.1 で割り戻す）
            </label>
            <span className="chips" aria-label="前金・後金・一括">
              {([["", "一括"], ["advance", "前金"], ["balance", "後金"]] as const).map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={stage === v} onClick={() => setStage(v)}>{l}</button>
              ))}
            </span>
            {!inHouse && out && out.languages.length > 1 && (
              <select className="inline-input" aria-label="この入金の言語" style={{ width: "auto" }} value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">言語を選ぶ</option>
                {out.languages.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            <input className="inline-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="備考（計算書の備考に載る。例：前金 50%）" style={{ minWidth: 260 }} />
          </div>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {/* 4 作者 */}
      {preview && (
        <div className="panel">
          <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
            <b>4 払うべき作者</b>
            <span className="faint">
              {preview.mode === "in_house" ? `作品 ${preview.workTitle}` : `${preview.licenseeName}・${preview.workTitle ?? ""}・${preview.usageLabel}`}
              {amountFor > 0 ? `・${inHouse ? "売上" : "受領額"} ${money(amountFor, preview.currency)}` : ""}
            </span>
          </div>
          <div className="panel-bd stack" style={{ gap: 8 }}>
            {preview.blockers.map((b) => <div key={b} className="alert">{b}</div>)}
            {preview.notes.map((n) => <div key={n} className="note">{n}</div>)}
            {preview.authors.length > 0 && (
              <table className="table">
                <thead><tr><th></th><th>作者</th><th>IN 条件</th><th>料率</th><th className="num">見込み額</th><th>状態</th><th>計算書</th></tr></thead>
                <tbody>
                  {preview.authors.map((a) => {
                    const s = STATE[a.state];
                    return (
                      <tr key={a.conditionId}>
                        <td>{a.state !== "issued" && (
                          <input type="checkbox" aria-label={`${a.partyName} の計算書を作る`} checked={picked.includes(a.conditionId)}
                                 onChange={(e) => setPicked((cur) => e.target.checked ? [...cur, a.conditionId] : cur.filter((id) => id !== a.conditionId))} />
                        )}</td>
                        <td>{a.partyName}{a.targeted ? <span className="tag" style={{ marginLeft: 4 }}>許諾先専用</span> : null}
                          {a.payees.length ? <div className="faint">受取人ごとに {a.payees.length} 枚（{a.payees.map((p) => p.partyName).join("・")}）</div> : null}</td>
                        <td>{link(a.conditionId, a.conditionNo ?? `#${a.conditionId}`)}{a.workTitle && a.workTitle !== preview.workTitle ? <div className="faint">{a.workTitle}</div> : null}</td>
                        <td>{a.ratePct === null ? "—" : `${a.ratePct}%`}</td>
                        <td className="num">{a.estimate === null ? "—" : money(a.estimate, preview.currency)}</td>
                        <td><span className={`tag ${s.tag}`}>{s.label}</span>{a.reportCount ? <span className="faint"> 報告 {a.reportCount}</span> : null}</td>
                        <td>{a.documents.map((d) => onOpenDocument
                          ? <div key={d.id}><button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button></div>
                          : <div key={d.id} className="code">{d.documentNo ?? `#${d.id}`}</div>)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <span className="faint">見込み額は {inHouse ? "売上" : "受領額"} × 料率。MG・AG・消費税・源泉は計算書で計算します（従来の計算書と同じ決まり）。</span>
            {canWrite && (
              <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <label className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={draftOnly} onChange={(e) => setDraftOnly(e.target.checked)} />下書きで止める（文書の画面で確かめて決定）
                </label>
                <label className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={withPayment} disabled={draftOnly} onChange={(e) => setWithPayment(e.target.checked)} />作者への支払も立てる
                </label>
                {withPayment && !draftOnly && (
                  <label className="row" style={{ gap: 4 }}>支払期日
                    <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /><span className="faint">（空なら条件の支払条件から）</span>
                  </label>
                )}
                <button className="btn primary" disabled={busy || !ready} onClick={() => void run()}>
                  {busy ? "作っています…" : draftOnly ? `${picked.length} 人の計算書の下書きを作る` : `${picked.length} 人の計算書を作る`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="panel">
          <div className="panel-hd" style={{ gap: 8 }}>
            <b>できたもの</b>
            {result.paymentId && <span className="faint">入金 <span className="code">{result.paymentNo ?? `#${result.paymentId}`}</span>{result.paymentCreated ? "（新しく記録）" : ""}</span>}
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={reset}>次の入金へ</button>
          </div>
          <div className="panel-bd stack" style={{ gap: 6 }}>
            {result.errors.map((e) => <div key={e} className="alert">{e}</div>)}
            <table className="table">
              <thead><tr><th>作者</th><th>報告</th><th>計算書</th><th>支払</th><th></th></tr></thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.partyName}{r.payeeName ? <span className="faint">（受取人 {r.payeeName}）</span> : null}</td>
                    <td>{r.eventIds.length ? `${r.eventIds.length} 件` : "—"}</td>
                    <td>{r.documentId
                      ? (onOpenDocument
                        ? <button className="linky code" onClick={() => onOpenDocument(r.documentId!)}>{r.draft ? `下書き #${r.documentId}` : r.documentNo ?? `#${r.documentId}`}</button>
                        : <span className="code">{r.draft ? `下書き #${r.documentId}` : r.documentNo ?? `#${r.documentId}`}</span>)
                      : "—"}</td>
                    <td>{r.paymentId ? <span className="code">{r.paymentNo ?? `#${r.paymentId}`}</span> : r.draft ? <span className="faint">決定後に</span> : "—"}</td>
                    <td>{r.skipped ? <span className="tag">{r.skipped}</span> : r.error ? <span className="warn">{r.error}</span> : <span className="tag ok">済</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="faint">送付は「一覧」の未送付から（メール／CloudSign）。下書きは文書の画面で確かめて決定すると、実績が結ばれ支払を立てられます。</span>
          </div>
        </div>
      )}
    </div>
  );
}
