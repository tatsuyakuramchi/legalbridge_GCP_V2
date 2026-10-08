import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { RightsScopePicker } from "./RightsScopePicker.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CONTRACT_FORMS, CONTRACT_FORMS_EN } from "../server/conditions/contract-form.js";
import { PAYMENT_TERMS_PRESETS_EN, PAYMENT_TERMS_PRESETS_JA } from "../server/conditions/payment-terms.js";
import { CONDITION_USAGE_TYPES } from "../server/core/condition-usage.js";

/**
 * 業務委託の明細を表で登録する（1 行＝条件明細 1 本）。
 *
 * 見積書の行（品目・仕様・数量・単位・単価・納期）をそのまま入れると、行ごとに
 * 委託料の条件明細ができ、発注書はその行数で出る。検収も行ごとに起きる。
 * 実費・手数料の行は別の種類の条件になる。
 *
 * 帰属先が受注者の行があれば、当社が成果物を使うための利用許諾条件（IN）を
 * 作品 × 受託者に立てる（許諾料は 別途／委託報酬に含む／無償／立てない）。
 *
 * 作品は行ごとに持てる（1つの発注で複数作品の素材を頼むことがある）。行の作品が
 * 「上と同じ」なら上で選んだ作品。受注者帰属の行の作品が違えば、利用許諾条件も作品ごとに立つ。
 * 支払方法は 納品ごと／定期払い／一括。
 */

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}
interface Line {
  key: number;
  kind: "service" | "expense" | "fee";
  name: string; spec: string; quantity: string; unit: string; unitPrice: string;
  deliveryDue: string; contractForm: string; ownership: string; tax: string;
  /** 行の作品。"" は上と同じ、"none" は作品なし、ほかは作品 id。 */
  workId: string;
  /** 一覧に無い作品を探している最中。 */
  pickingWork?: boolean;
}
interface WorkOption { id: number; title: string }
export interface ServiceLinesCreated {
  conditions: Array<{ usageType: string; id: number; conditionNo: string | null }>;
  licenseConditions: Array<{ id: number; conditionNo: string | null; existed: boolean }>;
  scheduled: number;
}

const num = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const int = (v: string) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const text = (v: string) => { const s = String(v ?? "").trim(); return s || undefined; };
const yen = (n: number) => n.toLocaleString("ja-JP");
let keySeq = 1;
const blank = (kind: Line["kind"] = "service"): Line =>
  ({ key: keySeq++, kind, name: "", spec: "", quantity: "1", unit: "式", unitPrice: "", deliveryDue: "", contractForm: "", ownership: "", tax: "", workId: "" });
const amountOf = (l: Line) => Math.round(num(l.quantity || "1") * num(l.unitPrice));

/** Excel／CSV の貼り付け。列は 品目・仕様・数量・単位・単価・納期 の順（足りなければ右が空）。 */
function parsePaste(raw: string): Line[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim().replace(/^"|"$/g, ""));
    const l = blank();
    [l.name, l.spec, l.quantity, l.unit, l.unitPrice, l.deliveryDue] =
      [cells[0] ?? "", cells[1] ?? "", cells[2] || "1", cells[3] || "式", cells[4] ?? "", cells[5] ?? ""];
    // 「品目,単価」だけの短い行も受ける。
    if (cells.length === 2) { l.spec = ""; l.quantity = "1"; l.unit = "式"; l.unitPrice = cells[1]; l.deliveryDue = ""; }
    return l;
  }).filter((l) => l.name);
}

export function ServiceLinesForm(
  { preset, counterpartyName, workTitle, workOptions, initialTitle, onDone, onCancel }: {
    preset?: Partial<Record<"counterpartyId" | "agreementId" | "matterId" | "workId", string>>;
    counterpartyName?: string | null;
    /** preset.workId の作品名（無いと「#489」のように番号で出る）。 */
    workTitle?: string | null;
    /** 行の作品の選択肢（案件の作品など）。ここに無い作品は行で探せる。 */
    workOptions?: WorkOption[];
    /** 件名の初期値（進行画面の案件名など）。 */
    initialTitle?: string | null;
    onDone: (created: ServiceLinesCreated) => void;
    onCancel: () => void;
  }
) {
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [partyId, setPartyId] = useState(preset?.counterpartyId ?? "");
  const [partyLabel, setPartyLabel] = useState<string | null>(counterpartyName ?? null);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [agreementId, setAgreementId] = useState(preset?.agreementId ?? "");
  const [workId, setWorkId] = useState(preset?.workId ?? "");
  const [workLabel, setWorkLabel] = useState<string | null>(workTitle ?? null);
  // 行の作品の選択肢：案件の作品＋上の作品＋行で探して選んだ作品。
  const [extraWorks, setExtraWorks] = useState<WorkOption[]>(
    preset?.workId && workTitle ? [{ id: Number(preset.workId), title: workTitle }] : []);
  const knownWorks = useMemo(() => {
    const out: WorkOption[] = [];
    for (const w of [...(workOptions ?? []), ...extraWorks]) if (!out.some((o) => o.id === w.id)) out.push(w);
    return out;
  }, [workOptions, extraWorks]);
  const remember = (id: number, title: string) =>
    setExtraWorks((prev) => (prev.some((w) => w.id === id) ? prev : [...prev, { id, title }]));
  const workName = (id: string) => knownWorks.find((w) => String(w.id) === id)?.title ?? (id === workId ? workLabel : null) ?? `#${id}`;
  /** 行の実際の作品 id（"" は作品なし）。 */
  const rowWork = (l: Line) => (l.workId === "" ? workId : l.workId === "none" ? "" : l.workId);
  const [contractForm, setContractForm] = useState("");
  const [ownership, setOwnership] = useState("orderer");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [tax, setTax] = useState("taxable");
  const [currency, setCurrency] = useState("JPY");
  const [termStart, setTermStart] = useState("");
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  // 権利の扱い
  const [licMode, setLicMode] = useState<"separate" | "included" | "free" | "none">("included");
  const [licUsage, setLicUsage] = useState("in_house");
  const [licRate, setLicRate] = useState("");
  const [licFlat, setLicFlat] = useState("");
  const [licTermEnd, setLicTermEnd] = useState("");
  const [licRegions, setLicRegions] = useState("全世界");
  const [licLanguages, setLicLanguages] = useState("全言語");
  // 支払方法
  const [payMode, setPayMode] = useState<"per_delivery" | "periodic" | "lump">("per_delivery");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [every, setEvery] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ agreements: Agreement[] }>("/agreements").then((a) => setAgreements(a.agreements)).catch(() => undefined);
  }, []);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: number) => setLines((prev) => prev.filter((l) => l.key !== key));
  const serviceLines = lines.filter((l) => l.kind === "service");
  const subtotal = useMemo(() => lines.filter((l) => l.kind !== "expense").reduce((a, l) => a + amountOf(l), 0), [lines]);
  const expenses = useMemo(() => lines.filter((l) => l.kind === "expense").reduce((a, l) => a + amountOf(l), 0), [lines]);
  const contractorLines = lines.filter((l) => l.kind === "service" && (l.ownership || ownership) === "contractor");
  const hasContractor = contractorLines.length > 0;
  // 受注者帰属の行に作品が無いと利用許諾条件が立てられない（サーバは上の作品で補う）。
  const contractorWithoutWork = contractorLines.filter((l) => !rowWork(l) && !workId);
  const licenseWorks = [...new Set(contractorLines.map((l) => rowWork(l) || workId).filter(Boolean))];
  const agreementOptions = agreements.filter((a) => !partyId || String(a.counterparty?.id ?? "") === partyId);

  const ready = Boolean(partyId) && title.trim() !== "" && serviceLines.length > 0
    && serviceLines.every((l) => l.name.trim() && num(l.unitPrice) >= 0)
    && (!hasContractor || licMode === "none" || contractorWithoutWork.length === 0)
    && (payMode !== "periodic" || (periodFrom && periodTo));

  /**
   * 同じ相手・同じ品目（名前と種類、行に作品があれば作品も）の生きた条件が既にある行。
   * 取引を進めるで入れ直すと、既に登録してある発注の条件と 2 重になる。作る前に見せる。
   */
  const [dupes, setDupes] = useState<Array<{ key: number; name: string; existing: Array<{ id: number; conditionNo: string | null; name: string; work: string | null }> }> | null>(null);
  const norm = (v: string) => v.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  async function findDupes(): Promise<NonNullable<typeof dupes>> {
    if (!partyId) return [];
    const r = await api.get<{ conditions: Array<{ id: number; conditionNo: string | null; name: string; kind: string; status: string;
      work: { id: number; title: string } | null }> }>(`/conditions?counterpartyId=${partyId}&direction=in`);
    const live = r.conditions.filter((c) => ["active", "draft", "scheduled"].includes(c.status));
    return lines.flatMap((l) => {
      const name = norm(l.name || (l.kind === "service" ? title : ""));
      if (!name) return [];
      const work = rowWork(l);
      const hit = live.filter((c) => c.kind === l.kind && norm(c.name) === name && (!work || !c.work || String(c.work.id) === work));
      return hit.length ? [{ key: l.key, name: l.name || title, existing: hit.map((c) => ({ id: c.id, conditionNo: c.conditionNo, name: c.name, work: c.work?.title ?? null })) }] : [];
    });
  }

  /** 重複した行は既存の条件を使い（案件に繋ぐ）、残りの行だけ作る。 */
  async function useExisting() {
    if (!dupes) return;
    setBusy(true); setError(null);
    try {
      const matter = int(preset?.matterId ?? "");
      const used = dupes.map((d) => d.existing[0]);
      if (matter) for (const c of used) await api.post(`/matters/${matter}/conditions`, { conditionId: c.id }).catch(() => undefined);
      const rest = lines.filter((l) => !dupes.some((d) => d.key === l.key));
      setDupes(null);
      if (rest.some((l) => l.kind === "service")) { setBusy(false); await submit(true, rest); return; }
      onDone({ conditions: used.map((c) => ({ usageType: "service", id: c.id, conditionNo: c.conditionNo })), licenseConditions: [], scheduled: 0 });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function submit(force = false, only: Line[] | null = null) {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    const lines_ = only ?? lines;
    try {
      if (!force) {
        const found = await findDupes();
        if (found.length) { setDupes(found); return; }
      }
      const scopes = [
        ...parseRegions(licRegions).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
        ...parseLanguages(licLanguages).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
      ];
      const r = await api.post<ServiceLinesCreated>("/conditions/service-set", {
        title: title.trim(), counterpartyId: int(partyId), agreementId: int(agreementId) ?? null,
        matterId: int(preset?.matterId ?? "") ?? null, workId: int(workId) ?? null,
        termStart: text(termStart) ?? null, termEnd: null,
        currency, taxCategory: tax, paymentTerms: text(paymentTerms) ?? null,
        contractForm: text(contractForm) ?? null, deliverableOwnership: ownership || null,
        rows: lines_.map((l) => ({
          kind: l.kind, name: text(l.name) ?? null,
          // 定期払いの委託料は定期課金（1 回あたり＝単価×数量）。台帳でも定期と分かり、
          // 発注書では期ごとの回が 1 行にまとまる。それ以外の委託料は単価×数量。
          pricingModel: l.kind === "service" ? (payMode === "periodic" ? "subscription" : "unit_rate") : "fixed",
          unitAmount: l.kind === "service" ? Math.round(num(l.unitPrice)) : null,
          quantity: l.kind === "service" ? num(l.quantity || "1") : null,
          flatAmount: l.kind === "service"
            ? (payMode === "periodic" ? Math.round(num(l.unitPrice) * num(l.quantity || "1")) : null)
            : amountOf(l),
          unitLabel: l.kind === "service" ? (text(l.unit) ?? null) : null,
          spec: text(l.spec) ?? null,
          deliveryDue: text(l.deliveryDue) ?? null,
          contractForm: l.kind === "service" ? (text(l.contractForm) ?? null) : null,
          deliverableOwnership: l.kind === "service" ? (l.ownership || null) : null,
          taxCategory: l.kind === "service" && l.tax ? l.tax : null,
          // 「上と同じ」は送らない（サーバが上の作品を使う）。
          ...(l.workId === "" ? {} : { workId: l.workId === "none" ? null : int(l.workId) ?? null })
        })),
        license: hasContractor ? {
          mode: licMode, workId: int(workId) ?? null, usageType: licUsage,
          ratePct: licMode === "separate" && licRate.trim() ? num(licRate) : null,
          flatAmount: licMode === "separate" && !licRate.trim() && licFlat.trim() ? Math.round(num(licFlat)) : null,
          termStart: text(termStart) ?? null, termEnd: text(licTermEnd) ?? null,
          scopes: scopes.length ? scopes : undefined
        } : null,
        payment: { mode: payMode, periodicFrom: text(periodFrom) ?? null, periodicTo: text(periodTo) ?? null,
                   everyMonths: int(every) ?? 1 }
      });
      onDone(r);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const cell = (l: Line, field: keyof Line, props: Record<string, unknown> = {}) => (
    <input value={String(l[field] ?? "")} onChange={(e) => update(l.key, { [field]: e.target.value } as Partial<Line>)} {...props} />
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>業務委託の明細を登録（1 行＝条件明細 1 本）</h2>
        <span className="faint">見積書の行をそのまま。行ごとに委託料の条件ができ、発注書はその行数で出ます</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>やめる</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 12 }}>
        <div className="form-grid">
          <label className="field"><span>受託者（相手先）</span>
            <SearchSelect value={partyId} search={searchParties} valueLabel={partyLabel} placeholder="取引先名・コードで探す"
                          onChange={(v, o) => { setPartyId(v); setPartyLabel(o?.label ?? null); }} />
            <small className="faint">発注書の宛先。全行に同じ相手先が付く</small></label>
          <label className="field"><span>件名（発注の束の名前）</span>
            <input value={title} placeholder="J-TAG Web サイト制作" onChange={(e) => setTitle(e.target.value)} />
            <small className="faint">委託料の行が 1 つならその条件名にもなる</small></label>
          <label className="field"><span>基本契約（合意）</span>
            <select value={agreementId} onChange={(e) => setAgreementId(e.target.value)}>
              <option value="">（なし＝発注書単独。基本契約なしの条項が入る）</option>
              {agreementOptions.map((a) => <option key={a.id} value={a.id}>{[a.agreementNo, a.title].filter(Boolean).join(" ")}</option>)}
            </select></label>
          <label className="field"><span>作品（任意。受注者帰属の行があれば必要）</span>
            <SearchSelect value={workId} search={searchWorks} emptyLabel="（なし）" placeholder="作品名・コードで探す"
                          valueLabel={workLabel}
                          onChange={(v, o) => {
                            setWorkId(v); setWorkLabel(o?.label ?? null);
                            if (v && o) remember(Number(v), o.label);
                          }} />
            <small className="faint">行の作品の既定。行ごとに変えられる</small></label>
          <label className="field"><span>契約形式（既定）</span>
            <select value={contractForm} onChange={(e) => setContractForm(e.target.value)}>
              <option value="">（未定）</option>
              {CONTRACT_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
              {CONTRACT_FORMS_EN.map((f) => <option key={f} value={f}>{f}（海外版）</option>)}
            </select></label>
          <label className="field"><span>成果物の帰属先（既定）</span>
            <select value={ownership} onChange={(e) => setOwnership(e.target.value)}>
              <option value="orderer">発注者（譲渡型）</option>
              <option value="contractor">受注者（利用許諾型）</option>
            </select></label>
          <label className="field"><span>支払条件</span>
            <input list="svc-payment-terms" value={paymentTerms} placeholder="検収後 月末締め翌月末払い" onChange={(e) => setPaymentTerms(e.target.value)} />
            <datalist id="svc-payment-terms">{[...PAYMENT_TERMS_PRESETS_JA, ...PAYMENT_TERMS_PRESETS_EN].map((p) => <option key={p} value={p} />)}</datalist></label>
          <label className="field"><span>税区分（既定）・通貨</span>
            <span className="row" style={{ gap: 6 }}>
              <select value={tax} onChange={(e) => setTax(e.target.value)}>
                <option value="taxable">課税</option><option value="reduced">軽減</option>
                <option value="exempt">非課税</option><option value="included">税込（内税）</option>
              </select>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="JPY">JPY</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </select>
            </span></label>
          <label className="field"><span>開始日</span><input type="date" value={termStart} onChange={(e) => setTermStart(e.target.value)} /></label>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <b>明細</b>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, blank()])}>行を足す</button>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { ...blank("expense"), name: `${title || "業務"} 実費`, tax: "exempt" }])}>実費の行を足す（非課税）</button>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { ...blank("fee"), name: `${title || "業務"} 手数料` }])}>手数料の行を足す</button>
          <button className="btn btn-sm" onClick={() => setShowPaste((v) => !v)}>{showPaste ? "貼り付けを閉じる" : "Excel／CSV から貼り付け"}</button>
          <span className="faint">列は 品目・仕様・数量・単位・単価・納期 の順。「品目,単価」だけでも入ります</span>
        </div>
        {showPaste && (
          <div className="stack" style={{ gap: 6 }}>
            <textarea rows={5} value={paste} placeholder={"TOP ページ デザイン費用\t\t1\t式\t150000\t2026-11-14"} onChange={(e) => setPaste(e.target.value)} />
            <div className="row">
              <button className="btn btn-sm primary" disabled={!paste.trim()}
                      onClick={() => { const got = parsePaste(paste); if (got.length) { setLines((p) => [...p.filter((l) => l.name.trim() || l.kind !== "service"), ...got]); setPaste(""); setShowPaste(false); } }}>
                行に入れる
              </button>
            </div>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 1260 }}>
            <thead><tr>
              <th>#</th><th>種類</th><th>品目（条件名）</th><th>作品</th><th>仕様・成果物</th><th>数量</th><th>単位</th><th>単価（税抜）</th><th>金額</th><th>納期</th><th>契約形式</th><th>帰属</th><th>税</th><th></th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>{i + 1}</td>
                  <td>{l.kind === "service" ? "委託料" : l.kind === "expense" ? "実費" : "手数料"}</td>
                  <td style={{ minWidth: 200 }}>{cell(l, "name", { placeholder: "TOP ページ デザイン費用" })}</td>
                  <td style={{ minWidth: 170 }}>
                    {l.pickingWork ? (
                      <SearchSelect value="" search={searchWorks} placeholder="作品名・コードで探す" autoFocus
                                    onChange={(v, o) => {
                                      if (!v) { update(l.key, { pickingWork: false }); return; }
                                      if (o) remember(Number(v), o.label);
                                      update(l.key, { workId: v, pickingWork: false });
                                    }} />
                    ) : (
                      <select value={l.workId} aria-label={`${i + 1} 行目の作品`}
                              onChange={(e) => e.target.value === "?"
                                ? update(l.key, { pickingWork: true })
                                : update(l.key, { workId: e.target.value })}>
                        <option value="">{workId ? `上と同じ（${workName(workId)}）` : "上と同じ（なし）"}</option>
                        {knownWorks.map((w) => <option key={w.id} value={String(w.id)}>{w.title}</option>)}
                        {l.workId && l.workId !== "none" && !knownWorks.some((w) => String(w.id) === l.workId) &&
                          <option value={l.workId}>{workName(l.workId)}</option>}
                        <option value="none">作品なし</option>
                        <option value="?">ほかの作品を探す…</option>
                      </select>
                    )}
                  </td>
                  <td style={{ minWidth: 200 }}>{cell(l, "spec")}</td>
                  {l.kind === "service" ? (<>
                    <td style={{ width: 70 }}>{cell(l, "quantity", { style: { textAlign: "right" } })}</td>
                    <td style={{ width: 60 }}>{cell(l, "unit")}</td>
                    <td style={{ width: 110 }}>{cell(l, "unitPrice", { style: { textAlign: "right" }, placeholder: "150000" })}</td>
                  </>) : (<>
                    <td colSpan={2} className="faint">—</td>
                    <td style={{ width: 110 }}>{cell(l, "unitPrice", { style: { textAlign: "right" }, placeholder: l.kind === "expense" ? "税込上限" : "金額" })}</td>
                  </>)}
                  <td className="num" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{yen(amountOf(l))}</td>
                  <td style={{ width: 140 }}>{cell(l, "deliveryDue", { type: "date" })}</td>
                  {l.kind === "service" ? (<>
                    <td><select value={l.contractForm} onChange={(e) => update(l.key, { contractForm: e.target.value })}>
                      <option value="">（既定）</option>{CONTRACT_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}</select></td>
                    <td><select value={l.ownership} onChange={(e) => update(l.key, { ownership: e.target.value })}>
                      <option value="">（既定）</option><option value="orderer">発注者</option><option value="contractor">受注者</option></select></td>
                    <td><select value={l.tax} onChange={(e) => update(l.key, { tax: e.target.value })}>
                      <option value="">（既定）</option><option value="taxable">課税</option><option value="exempt">非課税</option><option value="included">税込</option></select></td>
                  </>) : <td colSpan={3} className="faint">{l.kind === "expense" ? "非課税（税込の立替）" : "課税"}</td>}
                  <td><button className="linky" onClick={() => remove(l.key)} aria-label="行を外す">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 18 }}>
          <span>委託料・手数料（税抜） <b>¥{yen(subtotal)}</b></span>
          {expenses > 0 && <span>実費（税込） <b>¥{yen(expenses)}</b></span>}
          <span className="faint">保存すると条件明細が {lines.length} 本できます</span>
        </div>

        {hasContractor && (
          <div className="note stack" style={{ gap: 8 }}>
            <b>権利の扱い（帰属先が受注者の行がある）</b>
            <span className="faint">受注者に権利が残る成果物は、当社は許諾を受けて使います。許諾の条件を作品 × 受託者の利用許諾条件（IN）として立て、発注書の「■ 利用許諾条件」に差し込みます。</span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {([["separate", "別途（許諾料を払う）"], ["included", "委託報酬に含む（推奨）"], ["free", "無償"], ["none", "条件を立てない（例外）"]] as const).map(([v, label]) => (
                <button key={v} className="chip" aria-pressed={licMode === v} onClick={() => setLicMode(v)}>{label}</button>
              ))}
            </div>
            {licMode !== "none" && (
              <div className="form-grid">
                <label className="field"><span>利用形態</span>
                  <select value={licUsage} onChange={(e) => setLicUsage(e.target.value)}>
                    {CONDITION_USAGE_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select></label>
                {licMode === "separate" && (<>
                  <label className="field"><span>料率（%）</span><input value={licRate} placeholder="8" onChange={(e) => setLicRate(e.target.value)} /></label>
                  <label className="field"><span>または 定額（税抜）</span><input value={licFlat} placeholder="料率が空のとき" onChange={(e) => setLicFlat(e.target.value)} /></label>
                </>)}
                <label className="field"><span>許諾終了（空なら期間の定めなし）</span><input type="date" value={licTermEnd} onChange={(e) => setLicTermEnd(e.target.value)} /></label>
                <div className="field"><span>地域（許諾範囲）</span><RightsScopePicker kind="region" value={licRegions} onChange={setLicRegions} /></div>
                <div className="field"><span>言語（許諾範囲）</span><RightsScopePicker kind="language" value={licLanguages} onChange={setLicLanguages} /></div>
                {contractorWithoutWork.length > 0
                  ? <div className="alert">受注者帰属の行（{contractorWithoutWork.map((l) => lines.indexOf(l) + 1).join("・")} 行目）に作品を選んでください（利用許諾条件は作品にぶら下がります）</div>
                  : licenseWorks.length > 0 && <div className="faint">利用許諾条件を立てる作品：{licenseWorks.map(workName).join("、")}（作品ごとに 1 本。同じ作品・利用形態の条件が既にあればそれを使う）</div>}
              </div>
            )}
            {licMode === "none" && <span className="faint">発注書に許諾条項が出ず、台帳からも権利が見えません。</span>}
          </div>
        )}

        <div className="note stack" style={{ gap: 8 }}>
          <b>支払方法</b>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {([["per_delivery", "納品ごとに検収して支払（既定）"], ["periodic", "定期払い（毎月・四半期）"], ["lump", "一括（全納品後にまとめて検収）"]] as const).map(([v, label]) => (
              <button key={v} className="chip" aria-pressed={payMode === v} onClick={() => setPayMode(v)}>{label}</button>
            ))}
          </div>
          {payMode === "periodic" && (
            <div className="form-grid">
              <label className="field"><span>期間 開始</span><input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} /></label>
              <label className="field"><span>期間 終了</span><input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} /></label>
              <label className="field"><span>何か月ごと</span><input value={every} onChange={(e) => setEvery(e.target.value)} />
                <small className="faint">行の金額（単価×数量）が 1 回あたり。期ごとに予定明細が立ち、期の末日に検収・支払が起きる。
                  発注書には全回を 1 行にまとめて出す（例：全 12 回（毎月）1 回あたり ¥35,000）。回ごとの金額を直すのは条件明細の「予定」</small></label>
            </div>
          )}
          {payMode === "lump" && <span className="faint">発注書は行ごとに出ますが、検収は全行の納品後に 1 枚の検収書でまとめます（支払文書処理で選ぶ）。</span>}
          <span className="faint">売上連動（ロイヤリティ）は委託料ではなく上の利用許諾条件に料率を持たせ、計算書で回します。</span>
        </div>

        {error && <div className="alert">{error}</div>}
        {dupes && (
          <div className="alert stack" style={{ gap: 6 }}>
            <b>同じ相手・同じ品目の条件が既にあります（2 重に作らないため確かめてください）</b>
            {dupes.map((d) => (
              <div key={d.key}>
                「{d.name}」→ {d.existing.map((c) => `${c.conditionNo ?? `#${c.id}`} ${c.name}${c.work ? `（${c.work}）` : ""}`).join("、")}
              </div>
            ))}
            <span className="faint">既に発注した条件なら、新しく作らずに既存の条件を使ってください（発注書も既存のものを紐づけます）。</span>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary btn-sm" disabled={busy} onClick={() => void useExisting()}>
                {preset?.matterId ? "既存の条件をこの案件に繋ぐ（重複しない行だけ作る）" : "重複している行を外して作る"}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => { setDupes(null); void submit(true); }}>別の発注なので全部作る</button>
              <button className="btn btn-sm" onClick={() => setDupes(null)}>やめる</button>
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "登録しています…" : `条件明細 ${lines.length} 本を登録する`}
          </button>
          <button className="btn" onClick={onCancel}>やめる</button>
        </div>
      </div>
    </div>
  );
}
