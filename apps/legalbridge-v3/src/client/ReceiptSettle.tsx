import { useEffect, useMemo, useState, type ReactElement } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect } from "./SearchSelect.js";

/**
 * 入金から計算書（支払文書のタブ）。
 *
 *   入金カード（1 件以上）：取引モデル → OUT 先（許諾先）→ 条件（作品ごと）か記録済みの入金 → 入金日・金額・税込・一括／前金／後金・言語
 *     自社製造・自社販売は OUT 先が無いので作品を選ぶ（数量 × 基準価格）
 *   「＋ 入金を足す」で前金と後金、別の取引先の入金を並べ、同じ作者は 1 枚の計算書（入金 1 件が 1 行）に。
 *   払うべき作者（自動で全員チェック）→「計算書を作る」で 入金の記録 → 報告 → 計算書 → 支払 まで一度に
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
  payees: Array<{ partyId: number; partyName: string }>; receiptCount: number;
  /** 紙の「対象契約」「契約番号」に自動で出る作者側の契約。両方空なら「契約未指定」。 */
  contract: { title: string; number: string } }
/** 作者の契約の候補（文書フォームの 基本契約・個別契約番号 と同じ引き方）。 */
interface AuthorRefs { masters: Array<{ id: number; agreementNo: string | null; datedTitle: string; primary: boolean; status: string }>;
  terms: Array<{ id: number; documentNo: string; title: string; label: string; issuedOn: string | null }> }
interface ContractChoice { agreementId: number | null; termsNo: string }
interface OnePreview { mode: "receipt" | "in_house"; paymentId: number | null; paymentNo: string | null; paidOn: string | null;
  amount: number | null; currency: string; outConditionId: number | null; outName: string | null; usageLabel: string;
  licenseeName: string | null; workId: number | null; workTitle: string | null; languages: string[];
  authors: Author[]; blockers: string[]; notes: string[] }
interface Preview { receipts: OnePreview[]; authors: Author[]; blockers: string[]; notes: string[] }
interface ResultRow { conditionId: number; partyName: string; payeeName: string | null; eventIds: number[];
  documentId: number | null; documentNo: string | null; draft: boolean; paymentId: number | null; paymentNo: string | null;
  skipped: string | null; error: string | null }
interface Result { payments: Array<{ paymentId: number | null; paymentNo: string | null; created: boolean; licenseeName: string | null; amount: number | null }>;
  rows: ResultRow[]; errors: string[] }

/** 入金カード 1 枚の入力。サーバに送る形（SettleInput）と、画面の見出し用。 */
interface Spec {
  body: Record<string, unknown> | null;
  /** 見出し（確認ダイアログ・結果）。 */
  label: string;
  amount: number;
  /** 言語が要るのに選んでいない、など。 */
  problem: string | null;
}

const STATE: Record<Author["state"], { label: string; tag: string }> = {
  unreported: { label: "未報告", tag: "warn" }, mismatch: { label: "金額が違う", tag: "out" },
  waiting: { label: "計算書待ち", tag: "warn" }, issued: { label: "計算書済", tag: "ok" }
};
const today = () => new Date().toISOString().slice(0, 10);
const num = (s: string) => { const n = Number(s.replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const STAGE_LABEL: Record<string, string> = { "": "一括", advance: "前金", balance: "後金" };

export function ReceiptSettle({ onOpenCondition, onOpenDocument }: {
  onOpenCondition?: (id: number) => void; onOpenDocument?: (id: number) => void;
}) {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");
  useEffect(() => { api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null)); }, []);

  const [cards, setCards] = useState<number[]>([1]);
  const [specs, setSpecs] = useState<Record<number, Spec>>({});
  const [draftOnly, setDraftOnly] = useState(false);
  const [withPayment, setWithPayment] = useState(true);
  const [dueOn, setDueOn] = useState("");
  /** 計算書の備考（全員に共通。紙の固定文の下に出る）。 */
  const [statementNotes, setStatementNotes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  /** 作者ごとの契約の候補と、選び直し。 */
  const [refs, setRefs] = useState<Record<number, AuthorRefs | null>>({});
  const [contracts, setContracts] = useState<Record<number, ContractChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const ordered = cards.map((k) => specs[k]).filter((s): s is Spec => !!s);
  const bodies = ordered.map((s) => s.body).filter((b): b is Record<string, unknown> => !!b);
  const previewKey = JSON.stringify(bodies);
  const allReady = ordered.length === cards.length && bodies.length === cards.length;

  // 下見：入金カードが全部そろったら、払うべき作者（作者ごとに合計）を引く。
  useEffect(() => {
    setPreview(null); setResult(null); setError(null);
    if (!bodies.length) return;
    let live = true;
    api.post<Preview>("/royalty-settle/preview", { receipts: bodies })
      .then((p) => {
        if (!live) return;
        setPreview(p); setPicked(p.authors.filter((a) => a.state !== "issued").map((a) => a.conditionId));
        // 作者ごとの契約の候補（基本契約・個別契約番号）。紙が「契約未指定」になる作者はここで選ぶ。
        for (const a of p.authors) {
          if (refs[a.conditionId] !== undefined) continue;
          api.get<AuthorRefs>(`/agreement-map/parties/${a.partyId}/document-refs?conditionIds=${a.conditionId}`)
            .then((r) => setRefs((cur) => ({ ...cur, [a.conditionId]: { masters: r.masters, terms: r.terms } })))
            .catch(() => setRefs((cur) => ({ ...cur, [a.conditionId]: null })));
        }
      })
      .catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [previewKey]);

  const problems = ordered.map((s) => s.problem).filter((x): x is string => !!x);
  const total = ordered.reduce((n, s) => n + s.amount, 0);
  const ready = canWrite && allReady && preview && !preview.blockers.length && !problems.length && picked.length > 0 && total > 0;

  async function run() {
    if (!preview) return;
    const what = draftOnly ? "作者ごとの計算書の下書きを作ります（決定は文書の画面で）" : `作者ごとの計算書を決定${withPayment ? "し、作者への支払を立てます" : "します"}`;
    const head = ordered.map((s) => s.label).join("、");
    if (!confirm(`${head} から、作者 ${picked.length} 人の報告を起こし、${what}。${ordered.length > 1 ? `入金 ${ordered.length} 件は作者ごとに 1 枚の計算書にまとめます。` : ""}よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const chosen = Object.entries(contracts)
        .filter(([, c]) => c.agreementId || c.termsNo)
        .map(([id, c]) => ({ conditionId: Number(id), agreementId: c.agreementId, termsNo: c.termsNo || null }));
      const r = await api.post<Result>("/royalty-settle", { receipts: bodies, authors: picked, contracts: chosen, statementNotes: statementNotes.trim() || null,
                                                             draftOnly, withPayment, dueOn: dueOn || null });
      setResult(r);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  function reset() { setCards([Date.now()]); setSpecs({}); setPreview(null); setResult(null); setError(null); }

  const link = (id: number, text: string) => onOpenCondition
    ? <button className="linky code" onClick={() => onOpenCondition(id)}>{text}</button> : <span className="code">{text}</span>;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>入金から計算書</h2>
          <span className="faint">OUT 先を選ぶ → 入金を入れる → 作者の報告・利用許諾計算書・支払まで 1 回で。前金と後金、別の取引先の入金は「＋ 入金を足す」で並べると作者ごとに 1 枚。時限式（四半期締めなど）は「作家の報告と計算書」から</span>
        </div>
      </div>
      {cards.map((key, i) => (
        <ReceiptCard key={key} index={i} count={cards.length} link={link}
                     onChange={(spec) => setSpecs((cur) => ({ ...cur, [key]: spec }))}
                     onRemove={cards.length > 1 ? () => { setCards((c) => c.filter((k) => k !== key)); setSpecs((cur) => { const n = { ...cur }; delete n[key]; return n; }); } : undefined} />
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setCards((c) => [...c, Date.now()])}>＋ 入金を足す（前金と後金・別の取引先を同じ計算書に）</button>
        {ordered.length > 1 && <span className="faint">合計 {money(total, "JPY")}・{ordered.length} 件を作者ごとに 1 枚（入金 1 件が 1 行）</span>}
      </div>

      {error && <div className="alert">{error}</div>}

      {preview && (
        <div className="panel">
          <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
            <b>払うべき作者</b>
            <span className="faint">
              {preview.receipts.map((p) => p.mode === "in_house" ? `作品 ${p.workTitle}` : `${p.licenseeName}・${p.workTitle ?? ""}・${p.usageLabel}`)
                .filter((x, i, a) => a.indexOf(x) === i).join("／")}
              {total > 0 ? `・受領額 ${money(total, "JPY")}` : ""}
            </span>
          </div>
          <div className="panel-bd stack" style={{ gap: 8 }}>
            {preview.blockers.map((b) => <div key={b} className="alert">{b}</div>)}
            {problems.map((b) => <div key={b} className="alert">{b}</div>)}
            {preview.notes.map((n) => <div key={n} className="note">{n}</div>)}
            {preview.authors.length > 0 && (
              <table className="table">
                <thead><tr><th></th><th>作者</th><th>IN 条件</th><th>料率</th><th className="num">見込み額</th><th>対象契約（紙に出る契約）</th><th>状態</th><th>計算書</th></tr></thead>
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
                          {a.payees.length ? <div className="faint">受取人ごとに {a.payees.length} 枚（{a.payees.map((p) => p.partyName).join("・")}）</div> : null}
                          {preview.receipts.length > 1 && <div className="faint">入金 {a.receiptCount}/{preview.receipts.length} 件に効く</div>}</td>
                        <td>{link(a.conditionId, a.conditionNo ?? `#${a.conditionId}`)}{a.workTitle ? <div className="faint">{a.workTitle}</div> : null}</td>
                        <td>{a.ratePct === null ? "—" : `${a.ratePct}%`}</td>
                        <td className="num">{a.estimate === null ? "—" : money(a.estimate, "JPY")}</td>
                        <td>
                          <ContractCell a={a} refs={refs[a.conditionId]} value={contracts[a.conditionId] ?? { agreementId: null, termsNo: "" }}
                                        onChange={(c) => setContracts((cur) => ({ ...cur, [a.conditionId]: c }))} />
                        </td>
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
            <span className="faint">見込み額は 受領額 × 料率（入金が複数なら合計）。MG・AG・消費税・源泉は計算書で計算します（従来の計算書と同じ決まり）。</span>
            {canWrite && (
              <label className="field">
                <span>計算書の備考</span>
                <textarea rows={2} value={statementNotes} onChange={(e) => setStatementNotes(e.target.value)}
                          placeholder="全員の計算書の備考に出す文（固定文の下）。前金・後金の説明は入金カードの備考から自動で足します。あとで直すなら文書の画面の「その他の入力」から" />
              </label>
            )}
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
                {!allReady && <span className="faint">入金カードの入力がそろうと押せます</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="panel">
          <div className="panel-hd" style={{ gap: 8, flexWrap: "wrap" }}>
            <b>できたもの</b>
            {result.payments.map((p, i) => (
              <span key={i} className="faint">入金 <span className="code">{p.paymentNo ?? `#${p.paymentId}`}</span>{p.licenseeName ? ` ${p.licenseeName}` : ""}{p.amount !== null ? ` ${money(p.amount, "JPY")}` : ""}{p.created ? "（新しく記録）" : ""}</span>
            ))}
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

/** 入金 1 件のカード。入力が決まるたびに親へ spec を渡す（足りないときは body = null）。 */
function ReceiptCard({ index, count, link, onChange, onRemove }: {
  index: number; count: number;
  link: (id: number, text: string) => ReactElement;
  onChange: (spec: Spec) => void;
  onRemove?: () => void;
}) {
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
  const [sample, setSample] = useState("");
  /** 他社販売の入れ方：受領額か、数量 × 受領価格（個数建ての契約）。 */
  const [basis, setBasis] = useState<"lump" | "per_unit">("lump");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [stage, setStage] = useState<"" | "advance" | "balance">("");
  /** この入金の言語。許諾先が複数の言語を持つとき、まとめて来る入金は全部（既定）、言語ごとに来るなら選ぶ。 */
  const [languages, setLanguages] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const inHouse = usage === "in_house";
  const perUnit = inHouse || (usage === "oem" && basis === "per_unit");
  const unitTotal = Math.round(num(quantity) * num(unit));

  // OUT 先を選んだら、その社の条件（取引モデルで絞る）と記録済みの入金。
  useEffect(() => {
    setOuts([]); setOpenReceipts([]); setOutId(null); setPaymentId(null); setLoadError(null);
    if (!party || inHouse) return;
    api.get<{ outs: Out[]; receipts: OpenReceipt[] }>(`/royalty-settle/outs?partyId=${party.id}`)
      .then((r) => {
        const list = r.outs.filter((o) => o.usageType === usage);
        setOuts(list); setOpenReceipts(r.receipts.filter((x) => list.some((o) => o.id === x.outConditionId)));
        if (list.length === 1) setOutId(list[0].id);
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, [party?.id, usage]);

  const chosenReceipt = openReceipts.find((x) => x.paymentId === paymentId) ?? null;
  const out = outs.find((o) => o.id === (chosenReceipt?.outConditionId ?? outId)) ?? null;
  useEffect(() => { setLanguages(out ? [...out.languages] : []); }, [out?.id]);

  const amountFor = inHouse ? unitTotal : (chosenReceipt?.amount ?? (perUnit ? unitTotal : num(amount)));
  const spec = useMemo((): Spec => {
    const common = { paidOn: paidOn || null, taxIncluded, paymentStage: stage || null,
                     languages: languages.length ? languages : null, note: note.trim() || null };
    const who = inHouse ? `作品「${work?.title ?? ""}」の売上` : `${party?.name ?? ""} からの入金`;
    const label = `${who} ${money(amountFor, "JPY")}${stage ? `（${STAGE_LABEL[stage]}）` : ""}${perUnit ? `（${quantity} × ${money(num(unit), "JPY")}）` : ""}${paymentId ? "（記録済み）" : ""}`;
    const complete = inHouse ? !!work && unitTotal > 0 : !!out && (paymentId !== null || amountFor > 0);
    const problem = !inHouse && out && out.languages.length > 1 && !paymentId && !languages.length
      ? `入金 ${index + 1}：この入金の言語を選んでください（まとめて来るなら全部）` : null;
    const body = !complete ? null : inHouse
      ? { usageType: usage, workId: work!.id, quantity: num(quantity) || null, unitAmount: num(unit) || null, ...common }
      : perUnit
        ? { usageType: usage, paymentId: paymentId ?? null, outConditionId: out!.id, quantity: num(quantity) || null, unitAmount: num(unit) || null,
            sampleQuantity: num(sample) || null, ...common }
        : { usageType: usage, paymentId: paymentId ?? null, outConditionId: out!.id, amount: num(amount) || null, ...common };
    return { body, label, amount: amountFor, problem };
  }, [usage, party?.id, out?.id, paymentId, work?.id, paidOn, amount, quantity, unit, sample, basis, taxIncluded, stage, languages.join("|"), note]);
  useEffect(() => { onChange(spec); }, [spec]);

  const n = count > 1 ? `入金 ${index + 1}` : null;
  return (
    <div className="panel">
      {n && (
        <div className="panel-hd" style={{ gap: 8 }}>
          <b>{n}</b><span className="faint">{spec.label}</span>
          {onRemove && <button className="linky" style={{ marginLeft: "auto" }} onClick={onRemove}>この入金を外す</button>}
        </div>
      )}
      <div className="panel-bd stack" style={{ gap: 12 }}>
        {loadError && <div className="alert">{loadError}</div>}
        {/* 1 取引モデル */}
        <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <b style={{ minWidth: 110 }}>1 取引モデル</b>
          <span className="chips">
            {USAGES.map(([v, l, hint]) => (
              <button key={v} className="chip" aria-pressed={usage === v} title={hint}
                      onClick={() => { setUsage(v); setOutId(null); setPaymentId(null); }}>{l}</button>
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
                <input type="radio" name={`out-${index}`} checked={(chosenReceipt?.outConditionId ?? outId) === o.id} disabled={!!chosenReceipt}
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
                    <input type="radio" name={`receipt-${index}`} checked={paymentId === x.paymentId}
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
            <span className="faint">= {money(unitTotal, "JPY")}</span>
          </>) : (<>
            {usage === "oem" && (
              <span className="chips" aria-label="入れ方">
                {([["lump", "受領額で"], ["per_unit", "数量 × 受領価格で"]] as const).map(([v, l]) => (
                  <button key={v} className="chip" aria-pressed={basis === v} onClick={() => setBasis(v)}>{l}</button>
                ))}
              </span>
            )}
            {perUnit ? (<>
              <label className="row" style={{ gap: 4 }}>数量
                <input className="inline-input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={{ width: 90 }} />
              </label>
              <label className="row" style={{ gap: 4 }}>受領価格（1 個あたり）
                <input className="inline-input" inputMode="numeric" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 110 }} />
              </label>
              <label className="row" style={{ gap: 4 }}>見本
                <input className="inline-input" inputMode="numeric" value={sample} onChange={(e) => setSample(e.target.value)} style={{ width: 70 }} placeholder="0" />
              </label>
              <span className="faint">= {money(unitTotal, out?.currency ?? "JPY")}{chosenReceipt && unitTotal !== chosenReceipt.amount ? <span className="warn">（入金額 {money(chosenReceipt.amount, chosenReceipt.currency)} と違う）</span> : null}</span>
            </>) : (
              <label className="row" style={{ gap: 4 }}>入金額
                <input className="inline-input" inputMode="numeric" value={chosenReceipt ? String(chosenReceipt.amount) : amount} disabled={!!chosenReceipt}
                       onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} placeholder="例：1,000,000" />
              </label>
            )}
          </>)}
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} />税込（1.1 で割り戻す）
          </label>
          <span className="chips" aria-label="前金・後金・一括">
            {([["", "一括"], ["advance", "前金"], ["balance", "後金"]] as const).map(([v, l]) => (
              <button key={v} className="chip" aria-pressed={stage === v} onClick={() => setStage(v)}>{l}</button>
            ))}
          </span>
          {!inHouse && out && out.languages.length > 1 && (
            <span className="row" style={{ gap: 6, alignItems: "center" }}>
              <span className="faint">言語</span>
              <span className="chips" aria-label="この入金の言語（複数可）">
                {out.languages.map((l) => (
                  <button key={l} className="chip" aria-pressed={languages.includes(l)}
                          onClick={() => setLanguages((cur) => cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l])}>{l}</button>
                ))}
              </span>
              <button className="linky" onClick={() => setLanguages(languages.length === out.languages.length ? [] : [...out.languages])}>
                {languages.length === out.languages.length ? "全部外す" : "全部"}
              </button>
            </span>
          )}
          <input className="inline-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="この入金の説明（前金・後金を選ぶと「前金：…」として計算書の備考に載る。例：前金 50%）" style={{ minWidth: 300 }} />
        </div>
      </div>
    </div>
  );
}

/**
 * 作者 1 人の「対象契約」。自動で出る契約（条件に付いた基本契約・決定済みの条件書）を見せ、
 * 無ければ「契約未指定」。基本契約・個別契約番号 を選ぶと紙の「対象契約」「契約番号」に出る。
 */
function ContractCell({ a, refs, value, onChange }: {
  a: Author; refs: AuthorRefs | null | undefined; value: ContractChoice; onChange: (c: ContractChoice) => void;
}) {
  const master = refs?.masters.find((m) => m.id === value.agreementId) ?? null;
  const auto = a.contract.title || a.contract.number;
  const shown = value.agreementId || value.termsNo
    ? [master?.datedTitle, value.termsNo].filter(Boolean).join(" / ")
    : auto ? [a.contract.title, a.contract.number].filter(Boolean).join("　") : null;
  return (
    <div className="stack" style={{ gap: 3 }}>
      {shown ? <span>{shown}</span> : <span className="warn">契約未指定（下で選ぶ）</span>}
      {refs === undefined && <span className="faint">候補を読み込み中…</span>}
      {refs && (
        <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <select className="inline-input" style={{ width: "auto", maxWidth: 260 }} aria-label={`${a.partyName} の基本契約`}
                  value={value.agreementId ?? ""} onChange={(e) => onChange({ ...value, agreementId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{a.contract.title ? "基本契約は自動（条件の契約）" : "基本契約なし"}</option>
            {refs.masters.map((m) => (
              <option key={m.id} value={m.id}>{m.primary ? "★ " : ""}{m.datedTitle}{m.agreementNo ? `（${m.agreementNo}）` : ""}{m.status !== "executed" ? "［未締結］" : ""}</option>
            ))}
          </select>
          <select className="inline-input" style={{ width: "auto", maxWidth: 260 }} aria-label={`${a.partyName} の個別契約番号`}
                  value={value.termsNo} onChange={(e) => onChange({ ...value, termsNo: e.target.value })}>
            <option value="">{a.contract.number ? `個別契約は自動（${a.contract.number}）` : "個別契約なし"}</option>
            {refs.terms.map((t) => (
              <option key={t.id} value={t.documentNo}>{t.documentNo}　{t.label}{t.title ? `：${t.title}` : ""}{t.issuedOn ? `（${t.issuedOn}）` : ""}</option>
            ))}
          </select>
        </span>
      )}
      {refs && !refs.masters.length && !refs.terms.length && !auto && (
        <span className="faint">この作者に契約（基本契約・条件書）が登録されていません。契約 › 取引先⇔基本契約 で登録するか、条件明細の「契約の紐づけ」で付けてください</span>
      )}
    </div>
  );
}
