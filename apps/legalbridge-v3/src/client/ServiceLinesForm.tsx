import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { RightsScopePicker } from "./RightsScopePicker.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CONTRACT_FORMS, CONTRACT_FORMS_EN } from "../server/conditions/contract-form.js";
import { isQuasiMandate } from "../server/conditions/time-settlement.js";
import { PAYMENT_TERMS_PRESETS_EN, PAYMENT_TERMS_PRESETS_JA } from "../server/conditions/payment-terms.js";
import { CONDITION_USAGE_TYPES } from "../server/core/condition-usage.js";
import { firstEditionBasisText, firstEditionFee, inLieuSpecialTerms, withinSixtyDays } from "../server/conditions/royalty-in-lieu.js";

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
  /** 行の構成要素（A-078）。"" は作品全体、"new:core"／"new:sub" はこの行の品目名で新しく作る、ほかはパート id。 */
  partId: string;
  /** 一覧に無い作品を探している最中。 */
  pickingWork?: boolean;
}
interface WorkOption { id: number; title: string }
/** 1 本だけの登録画面から切り替えて開くときの種。選んだ支払の形と、打ちかけの行を引き継ぐ（A-081）。 */
export interface ServiceLinesSeed {
  title?: string;
  ownership?: "orderer" | "contractor";
  licMode?: "separate" | "included" | "free" | "in_lieu" | "none";
  lines?: Array<Partial<Pick<Line, "name" | "spec" | "quantity" | "unit" | "unitPrice" | "deliveryDue" | "contractForm" | "ownership" | "workId">>>;
}
export interface ServiceLinesCreated {
  conditions: Array<{ usageType: string; id: number; conditionNo: string | null }>;
  licenseConditions: Array<{ id: number; conditionNo: string | null; existed: boolean }>;
  scheduled: number;
  /** 併せて作った条件書の下書き（A-080）。選んでいなければ無い。 */
  companionDocument?: { id: number; templateKey: string } | null;
}

const num = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const int = (v: string) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const text = (v: string) => { const s = String(v ?? "").trim(); return s || undefined; };
const yen = (n: number) => n.toLocaleString("ja-JP");
let keySeq = 1;
const blank = (kind: Line["kind"] = "service"): Line =>
  ({ key: keySeq++, kind, name: "", spec: "", quantity: "1", unit: "式", unitPrice: "", deliveryDue: "", contractForm: "", ownership: "", tax: "", workId: "", partId: "" });
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
  { preset, counterpartyName, workTitle, workOptions, initialTitle, seed, onDone, onCancel }: {
    /** 1 本だけの登録画面から切り替えて開いたときの種（支払の形・行）。 */
    seed?: ServiceLinesSeed | null;
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
  const [title, setTitle] = useState(seed?.title ?? initialTitle ?? "");
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
  const [ownership, setOwnership] = useState<string>(seed?.ownership ?? "orderer");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [tax, setTax] = useState("taxable");
  const [currency, setCurrency] = useState("JPY");
  const [termStart, setTermStart] = useState("");
  /** 業務期間の終了（空なら各行の納期）。初版の利用許諾料で払う発注は特約が業務期間と許諾期間を分けて書く（A-089）。 */
  const [termEnd, setTermEnd] = useState("");
  /** 利用許諾の開始（空なら開始日）。 */
  const [licTermStart, setLicTermStart] = useState("");
  const [lines, setLines] = useState<Line[]>(seed?.lines?.length ? seed.lines.map((l) => ({ ...blank(), ...l })) : [blank()]);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  /** 「仕様・成果物」を広げて編集している行の key。表のセルは狭いので、長文は表の下の大きな欄で書く。 */
  const [specOpen, setSpecOpen] = useState<number | null>(null);
  // 権利の扱い
  const [licMode, setLicMode] = useState<"separate" | "included" | "free" | "in_lieu" | "none">(seed?.licMode ?? "included");
  const [licUsage, setLicUsage] = useState("in_house");
  // 初版の利用許諾料を報酬として払う（A-077）。見込みの本体価格・初版部数・料率（・非加算）で仮計算した額が
  // 受注者帰属の行の金額。納品後 60 日以内に確定して検収書で払う。2 版目以降・電子の料率は利用形態ごと。
  const [inLieuRates, setInLieuRates] = useState<Array<{ key: number; usageType: string; ratePct: string }>>(
    [{ key: keySeq++, usageType: "pub_print", ratePct: "10" }, { key: keySeq++, usageType: "pub_digital", ratePct: "15" }]);
  const [inLieuPayOn, setInLieuPayOn] = useState("");
  const [fePrice, setFePrice] = useState("");
  const [feCopies, setFeCopies] = useState("");
  const [feRate, setFeRate] = useState("10");
  /** 初版の非加算部数（献本・見本等）。既定 0＝全部数。方針が決まるまで 0 のまま。 */
  const [feExempt, setFeExempt] = useState("0");
  /** 価格の基準（A-091）。"" は本体価格、supply は卸価格（再許諾先への供給価格）、receipts は受領額。 */
  const [fePriceBasis, setFePriceBasis] = useState<"" | "supply" | "receipts">("");
  const [confirmDays, setConfirmDays] = useState("45");
  /**
   * 利用許諾条件を載せる契約（出版基本契約）。業務委託の基本契約とは別に選ぶ：成果物を出版・
   * 再許諾するときの利用許諾は、出版基本契約の個別契約として扱う。"" は業務委託の基本契約と同じ、
   * "none" は契約に載せない。
   */
  const [licAgreementId, setLicAgreementId] = useState("");
  // クレジット表記（A-076）。作品のクレジット表記（WorksWorkspace の履歴）を引用するか、この条件で文言を持つ。
  const [creditFromWork, setCreditFromWork] = useState(true);
  const [creditNotice, setCreditNotice] = useState("");
  /** 引用する作品の今のクレジット表記（著作権表示／第三者権利）。作品が無い・未登録なら null。 */
  const [workCredit, setWorkCredit] = useState<string | null>(null);
  const licenseWorkId = [...new Set(lines.filter((l) => l.kind === "service" && (l.ownership || ownership) === "contractor")
    .map((l) => (l.workId === "" ? workId : l.workId === "none" ? "" : l.workId)).filter(Boolean))][0] ?? "";
  useEffect(() => {
    if (!licenseWorkId) { setWorkCredit(null); return; }
    let alive = true;
    api.get<{ current: { copyrightNotice: string; thirdPartyRights: string | null } | null }>(`/works/${licenseWorkId}/credits`)
      .then((r) => { if (alive) setWorkCredit(r.current ? [r.current.copyrightNotice, r.current.thirdPartyRights].filter(Boolean).join("／") : null); })
      .catch(() => { if (alive) setWorkCredit(null); });
    return () => { alive = false; };
  }, [licenseWorkId]);
  /** 作品ごとの構成要素（パート）。受注者帰属の行で選ぶ（A-078）。 */
  const [partsByWork, setPartsByWork] = useState<Record<string, Array<{ id: number; name: string; partRole: string }>>>({});
  const contractorWorkIds = [...new Set(lines.filter((l) => l.kind === "service" && (l.ownership || ownership) === "contractor")
    .map((l) => (l.workId === "" ? workId : l.workId === "none" ? "" : l.workId)).filter(Boolean))].join(",");
  useEffect(() => {
    for (const id of contractorWorkIds.split(",").filter(Boolean)) {
      if (partsByWork[id]) continue;
      api.get<{ parts: Array<{ id: number; name: string; partRole: string }> }>(`/works/${id}`)
        .then((r) => setPartsByWork((p) => ({ ...p, [id]: r.parts ?? [] })))
        .catch(() => setPartsByWork((p) => ({ ...p, [id]: [] })));
    }
  }, [contractorWorkIds]);
  /** 文書に出るクレジット表記（引用なら作品の今の表記。無ければ手入力の文言）。 */
  const creditText = creditFromWork ? (workCredit ?? creditNotice.trim()) : creditNotice.trim();
  /** 2 版目以降の非加算（献本等。発行部数の %）。既定 1。 */
  const [exemptLater, setExemptLater] = useState("1");
  /**
   * 併せて作る条件書（A-080）。出版なら出版等利用許諾条件書（作品追加の合意）、ゲームなら個別利用許諾条件書。
   * 既存のひな形で、受注者帰属の行の利用許諾条件を載せた下書きを発注書とは別に起こす。選択式（空なら作らない）。
   */
  const [companion, setCompanion] = useState<"" | "pub_license_terms_v3" | "individual_license_terms_v4">("");
  /** 再許諾の可否（A-079）。既定は可（都度合意）：自社出版だけの案件もこれで足り、後から再許諾が出ても個別出版条件書で進められる。 */
  const [sublicense, setSublicense] = useState<"no" | "consent" | "covered">("consent");
  const [showTermsPreview, setShowTermsPreview] = useState(false);
  const [licRate, setLicRate] = useState("");
  const [licFlat, setLicFlat] = useState("");
  const [licTermEnd, setLicTermEnd] = useState("");
  const [licRegions, setLicRegions] = useState("全世界");
  const [licLanguages, setLicLanguages] = useState("全言語");
  // 準委任の時間精算（A-073）。契約形式が準委任のときだけ出す。委託料の行に付く。
  const [timeOn, setTimeOn] = useState(false);
  const [hoursIncluded, setHoursIncluded] = useState("");
  const [overageUnit, setOverageUnit] = useState("");
  const [shortfallUnit, setShortfallUnit] = useState("");
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
  /** 準委任の委託料の行があるか（行の契約形式、無ければ既定）。時間精算の欄はこのときだけ出す。 */
  const quasiRows = serviceLines.filter((l) => isQuasiMandate(l.contractForm || contractForm));
  const hasQuasi = quasiRows.length > 0;
  const timeSettled = hasQuasi && timeOn;
  const timeReady = !timeSettled || (num(hoursIncluded) > 0 && overageUnit.trim() !== "");
  // 受注者帰属の行に作品が無いと利用許諾条件が立てられない（サーバは上の作品で補う）。
  const contractorWithoutWork = contractorLines.filter((l) => !rowWork(l) && !workId);
  const licenseWorks = [...new Set(contractorLines.map((l) => rowWork(l) || workId).filter(Boolean))];
  const agreementOptions = agreements.filter((a) => !partyId || String(a.counterparty?.id ?? "") === partyId);

  // 初版の利用許諾料を報酬として払う（A-077）。仮計算額＝本体価格 ×（初版部数 − 非加算）× 率。
  // 表面・明細・特約で同じ額が出るので、受注者帰属の行の合計を仮計算額に合わせる（0 円の行にはしない）。
  const inLieu = hasContractor && licMode === "in_lieu";
  const rowsTotal = useMemo(() => contractorLines.reduce((a, l) => a + amountOf(l), 0), [contractorLines]);
  // 受領額基準（再許諾料の入金 × 料率）は部数を持たない。部数 1・非加算 0 として扱う。A-092
  const firstEdition = fePriceBasis === "receipts"
    ? { price: num(fePrice), copies: 1, ratePct: num(feRate), exemptCopies: 0, priceBasis: "receipts" as const }
    : { price: num(fePrice), copies: Math.floor(num(feCopies)), ratePct: num(feRate),
        exemptCopies: feExempt.trim() === "" ? 0 : Math.floor(num(feExempt)),
        priceBasis: fePriceBasis || null };
  const provisional = firstEditionFee(firstEdition);
  const feOk = firstEdition.price > 0 && firstEdition.copies > 0 && firstEdition.ratePct > 0 && firstEdition.ratePct <= 100
    && (firstEdition.exemptCopies ?? 0) >= 0 && (firstEdition.exemptCopies ?? 0) < firstEdition.copies;
  const inLieuRatesOk = inLieuRates.length > 0
    && inLieuRates.every((r) => r.usageType && num(r.ratePct) > 0 && num(r.ratePct) <= 100)
    && new Set(inLieuRates.map((r) => r.usageType)).size === inLieuRates.length;
  const confirmDaysOk = Number.isInteger(num(confirmDays)) && num(confirmDays) >= 1 && num(confirmDays) <= 60;
  /** 支払期日が納期から 60 日を超えている行（取適法・フリーランス法）。納期の無い行は確かめない。 */
  const sixtyDayOver = inLieu && inLieuPayOn
    ? contractorLines.filter((l) => withinSixtyDays(l.deliveryDue || null, inLieuPayOn) === false) : [];
  const inLieuReady = !inLieu || (feOk && provisional > 0 && rowsTotal === provisional && inLieuRatesOk && confirmDaysOk
    && Boolean(inLieuPayOn) && contractorLines.every((l) => amountOf(l) > 0) && sixtyDayOver.length === 0 && payMode !== "periodic");
  /** 仮計算額を受注者帰属の行に入れる（1 行ならその行、複数なら先頭の行に残りを入れる）。 */
  const fillProvisional = () => {
    if (!contractorLines.length || provisional <= 0) return;
    const [first, ...rest] = contractorLines;
    const others = rest.reduce((a, l) => a + amountOf(l), 0);
    const mine = Math.max(0, provisional - others);
    update(first.key, { quantity: "1", unitPrice: String(mine) });
  };
  /**
   * 受注者帰属の行が 1 本なら、見込み価格・部数・料率を入れた時点で仮計算額をその行に入れる（A-082）。
   * 行の金額は仮計算額と一致しないと登録できないので、押す手順を残す意味が無い。
   * 行が複数なら配分を人が決めるので、ボタン（先頭の行に残りを入れる）のまま。
   */
  const soloKey = inLieu && contractorLines.length === 1 ? contractorLines[0]!.key : null;
  const soloAmount = soloKey !== null ? amountOf(contractorLines[0]!) : null;
  useEffect(() => {
    if (soloKey === null || !feOk || provisional <= 0 || soloAmount === provisional) return;
    update(soloKey, { quantity: "1", unitPrice: String(provisional) });
  }, [soloKey, feOk, provisional, soloAmount]);
  const termsPreview = inLieu ? inLieuSpecialTerms({
    servicePeriod: { start: termStart || null, end: termEnd || contractorLines.map((l) => l.deliveryDue).filter(Boolean).sort().at(-1) || null },
    licensePeriod: { start: licTermStart || termStart || null, end: licTermEnd || null },
    deliverables: contractorLines.map((l) => ({ name: l.name || title, amount: amountOf(l) })),
    firstEdition, provisionalAmount: rowsTotal || provisional,
    confirmWithinDays: confirmDaysOk ? num(confirmDays) : null,
    payOn: inLieuPayOn || null,
    laterRates: inLieuRates.filter((r) => num(r.ratePct) > 0).map((r) => ({ usageType: r.usageType, ratePct: num(r.ratePct) })),
    laterExemptPct: exemptLater.trim() === "" ? null : num(exemptLater),
    masterAgreement: (() => {
      const id = licAgreementId === "" ? agreementId : licAgreementId === "none" ? "" : licAgreementId;
      const a = agreements.find((x) => String(x.id) === id);
      return a ? { no: a.agreementNo, title: a.title } : null;
    })(),
    creditNotice: creditText || null,
    sublicense
  }) : "";

  const ready = Boolean(partyId) && title.trim() !== "" && serviceLines.length > 0
    && serviceLines.every((l) => l.name.trim() && num(l.unitPrice) >= 0)
    && (!hasContractor || licMode === "none" || contractorWithoutWork.length === 0)
    && (payMode !== "periodic" || (periodFrom && periodTo))
    && timeReady && inLieuReady;
  /** 登録ボタンが押せない理由。ボタンの横に出す。 */
  const missing = [
    !partyId ? "受託者" : null,
    title.trim() === "" ? "件名" : null,
    serviceLines.length === 0 ? "委託料の行" : null,
    ...lines.flatMap((l, i) => l.kind !== "service" ? []
      : [!l.name.trim() ? `${i + 1} 行目の品目名` : null, String(l.unitPrice ?? "").trim() === "" ? `${i + 1} 行目の単価` : null]),
    hasContractor && licMode !== "none" && contractorWithoutWork.length > 0 ? "受注者帰属の行の作品" : null,
    payMode === "periodic" && !(periodFrom && periodTo) ? "定期払いの期間（開始・終了）" : null,
    timeSettled && !(num(hoursIncluded) > 0) ? "月間包括枠（時間）" : null,
    timeSettled && overageUnit.trim() === "" ? "超過単価" : null,
    inLieu && !feOk ? "初版の算定の基礎（見込みの本体価格・初版部数・料率。非加算は部数より少なく）" : null,
    inLieu && feOk && rowsTotal !== provisional ? `受注者帰属の行の金額の合計を仮計算額 ¥${yen(provisional)} に合わせる` : null,
    inLieu && !inLieuRatesOk ? "2 版目以降・電子の料率（0 より大きく、重複なし）" : null,
    inLieu && !confirmDaysOk ? "確定の期限（受領後 1〜60 日）" : null,
    inLieu && !inLieuPayOn ? "支払期日" : null,
    inLieu && contractorLines.some((l) => amountOf(l) <= 0) ? "受注者帰属の行の金額（仮計算額の配分。0 円にはしない）" : null,
    inLieu && sixtyDayOver.length > 0
      ? `支払期日が納期から 60 日を超えている行（${sixtyDayOver.map((l) => lines.indexOf(l) + 1).join("・")} 行目）` : null,
    inLieu && payMode === "periodic" ? "支払方法（初版利用許諾料は定期払いにできない）" : null
  ].filter((m): m is string => Boolean(m));

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
      const posted = await api.post<ServiceLinesCreated>("/conditions/service-set", {
        title: title.trim(), counterpartyId: int(partyId), agreementId: int(agreementId) ?? null,
        matterId: int(preset?.matterId ?? "") ?? null, workId: int(workId) ?? null,
        termStart: text(termStart) ?? null, termEnd: text(termEnd) ?? null,
        currency, taxCategory: tax, paymentTerms: text(paymentTerms) ?? null,
        contractForm: text(contractForm) ?? null, deliverableOwnership: ownership || null,
        // 準委任の時間精算（A-073）。束の既定。準委任の委託料の行に付く（サーバが委託料の行だけに付ける）。
        ...(timeSettled ? {
          timeSettlement: true, hoursIncluded: num(hoursIncluded),
          overageUnitAmount: Math.round(num(overageUnit)),
          shortfallUnitAmount: shortfallUnit.trim() === "" ? null : Math.round(num(shortfallUnit))
        } : {}),
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
          // 時間精算は準委任の委託料の行だけ。束の既定が時間精算でも、請負の行には付けない。
          ...(timeSettled && l.kind === "service" && !isQuasiMandate(l.contractForm || contractForm) ? { timeSettlement: false } : {}),
          // 「上と同じ」は送らない（サーバが上の作品を使う）。
          ...(l.workId === "" ? {} : { workId: l.workId === "none" ? null : int(l.workId) ?? null }),
          // 構成要素（A-078）。受注者帰属の行だけ。
          ...((l.ownership || ownership) === "contractor" && l.partId.startsWith("new:") ? { newPartRole: l.partId.slice(4) }
             : (l.ownership || ownership) === "contractor" && l.partId ? { workPartId: int(l.partId) ?? null } : {})
        })),
        license: hasContractor ? {
          mode: licMode, workId: int(workId) ?? null, usageType: licUsage,
          // 出版基本契約。"" は送らない（業務委託の基本契約と同じ）、"none" は null（載せない）。
          ...(licAgreementId === "" ? {} : { agreementId: licAgreementId === "none" ? null : int(licAgreementId) ?? null }),
          // クレジット表記（A-076）。引用なら文書が作品の今の表記を差す（文言は控え）。
          creditFromWork, creditNotice: text(creditNotice) ?? null,
          // 再許諾の可否（A-079）。
          sublicense,
          ratePct: licMode === "separate" && licRate.trim() ? num(licRate) : null,
          flatAmount: licMode === "separate" && !licRate.trim() && licFlat.trim() ? Math.round(num(licFlat)) : null,
          termStart: text(licTermStart) ?? text(termStart) ?? null, termEnd: text(licTermEnd) ?? null,
          scopes: scopes.length ? scopes : undefined,
          // 初版の利用許諾料を報酬として払う（A-077）。仮計算額と行の合計はサーバが突き合わせる。
          ...(licMode === "in_lieu" ? {
            rates: inLieuRates.map((r) => ({ usageType: r.usageType, ratePct: num(r.ratePct) })),
            firstEdition: { price: Math.round(firstEdition.price), copies: firstEdition.copies, ratePct: firstEdition.ratePct,
                            exemptCopies: firstEdition.exemptCopies || null, priceBasis: fePriceBasis || null },
            confirmWithinDays: num(confirmDays), payOn: text(inLieuPayOn) ?? null,
            exemptLaterPct: exemptLater.trim() === "" ? null : num(exemptLater)
          } : {})
        } : null,
        payment: { mode: payMode, periodicFrom: text(periodFrom) ?? null, periodicTo: text(periodTo) ?? null,
                   everyMonths: int(every) ?? 1 }
      });
      // 併せて作る条件書（A-080）。利用許諾条件を載せた下書きを先に起こす（発注書の特約が「その条件書に当たる」と書けるように）。
      const r: ServiceLinesCreated = { ...posted, companionDocument: null };
      if (companion && posted.licenseConditions.length) {
        const licAgreement = licAgreementId === "" ? int(agreementId) : licAgreementId === "none" ? undefined : int(licAgreementId);
        const d = await api.post<{ id: number }>("/documents", {
          templateKey: companion, conditionIds: posted.licenseConditions.map((c) => c.id),
          matterId: int(preset?.matterId ?? "") ?? null, agreementId: licAgreement ?? null
        }).catch(() => null);
        r.companionDocument = d ? { id: d.id, templateKey: companion } : null;
      }
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
          <label className="field"><span>業務終了（空なら各行の納期）</span><input type="date" value={termEnd} onChange={(e) => setTermEnd(e.target.value)} /></label>
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
          <table className="table" style={{ minWidth: 1200 }}>
            <thead><tr>
              {/* 数量・単価・金額を品目のすぐ右に置く。作品・仕様の後ろに置くと、ふつうの幅では
                  単価の列が画面の外に出て、入れ忘れたまま登録ボタンが押せない理由が分からなかった。 */}
              <th style={{ width: 28 }}>#</th><th style={{ width: 56 }}>種類</th><th style={{ minWidth: 200 }}>品目（条件名）</th>
              <th style={{ width: 70 }}>数量</th><th style={{ width: 60 }}>単位</th><th style={{ width: 120 }}>単価（税抜）</th><th style={{ width: 100 }}>金額</th>
              <th>作品</th><th style={{ minWidth: 260 }}>仕様・成果物</th><th style={{ width: 140 }}>納期</th><th>契約形式</th><th>帰属</th><th>税</th><th></th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>{i + 1}</td>
                  <td>{l.kind === "service" ? "委託料" : l.kind === "expense" ? "実費" : "手数料"}</td>
                  <td style={{ minWidth: 200 }}>{cell(l, "name", { placeholder: "TOP ページ デザイン費用" })}</td>
                  {l.kind === "service" ? (<>
                    <td style={{ width: 70 }}>{cell(l, "quantity", { style: { textAlign: "right" } })}</td>
                    <td style={{ width: 60 }}>{cell(l, "unit")}</td>
                    <td style={{ width: 110 }}>{cell(l, "unitPrice", { style: { textAlign: "right" }, placeholder: "150000" })}</td>
                  </>) : (<>
                    <td colSpan={2} className="faint">—</td>
                    <td style={{ width: 110 }}>{cell(l, "unitPrice", { style: { textAlign: "right" }, placeholder: l.kind === "expense" ? "税込上限" : "金額" })}</td>
                  </>)}
                  <td className="num" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{yen(amountOf(l))}</td>
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
                    {/* 構成要素（A-078）。受注者帰属の行は、作品のどの要素か（コアロジック／サブコンポーネント）を持つ。 */}
                    {l.kind === "service" && (l.ownership || ownership) === "contractor" && rowWork(l) && (
                      <select value={l.partId} aria-label={`${i + 1} 行目の構成要素`} style={{ marginTop: 4 }}
                              onChange={(e) => update(l.key, { partId: e.target.value })}>
                        <option value="">構成要素：作品全体</option>
                        {(partsByWork[rowWork(l)] ?? []).map((p) => (
                          <option key={p.id} value={String(p.id)}>{p.name}（{p.partRole === "core" ? "コアロジック" : "サブコンポーネント"}）</option>))}
                        <option value="new:core">新しく作る：コアロジック（{l.name || "この行の品目名"}）</option>
                        <option value="new:sub">新しく作る：サブコンポーネント（{l.name || "この行の品目名"}）</option>
                      </select>
                    )}
                  </td>
                  <td style={{ minWidth: 260 }}>
                    {/* 改行を落とさないよう input ではなく 1 行の textarea。長文は「広げる」で表の下の欄に出す。 */}
                    <div className="spec-cell">
                      <textarea rows={1} value={l.spec} aria-label={`${i + 1} 行目の仕様・成果物`}
                                title={l.spec || undefined}
                                onChange={(e) => update(l.key, { spec: e.target.value })} />
                      <button type="button" className="btn btn-sm" aria-pressed={specOpen === l.key}
                              onClick={() => setSpecOpen((k) => (k === l.key ? null : l.key))}>
                        {specOpen === l.key ? "閉じる" : "広げる"}
                      </button>
                    </div>
                    {l.spec.includes("\n") && <span className="faint">{l.spec.split("\n").length} 行</span>}
                  </td>
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
        {(() => {
          const i = lines.findIndex((l) => l.key === specOpen);
          if (i < 0) return null;
          const l = lines[i];
          return (
            <div className="spec-editor stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8 }}>
                <b>{i + 1} 行目「{l.name || "（品目未入力）"}」の仕様・成果物</b>
                <span className="faint">発注書・検収書の明細にそのまま出ます。改行もそのまま反映されます</span>
                <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setSpecOpen(null)}>閉じる</button>
              </div>
              <textarea rows={16} value={l.spec} autoFocus aria-label={`${i + 1} 行目の仕様・成果物（広げた欄）`}
                        placeholder={"業務概要\n…\n\n業務詳細（成果物仕様）\n1. …"}
                        onChange={(e) => update(l.key, { spec: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Escape") setSpecOpen(null); }} />
              <span className="faint">{l.spec.length.toLocaleString()} 文字・{l.spec ? l.spec.split("\n").length : 0} 行（Esc で閉じる）</span>
            </div>
          );
        })()}
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
              {([["separate", "別途（許諾料を払う）"], ["included", "委託報酬に含む（推奨）"], ["free", "無償"],
                 ["in_lieu", "初版の利用許諾料を報酬として払う（仮計算 → 納品後に確定）"], ["none", "条件を立てない（例外）"]] as const).map(([v, label]) => (
                <button key={v} className="chip" aria-pressed={licMode === v} onClick={() => setLicMode(v)}>{label}</button>
              ))}
            </div>
            {licMode === "in_lieu" && (
              <div className="stack" style={{ gap: 8 }}>
                <span className="faint">
                  別途の制作報酬は払わず、<b>初版の出版に係る利用許諾料</b>を対価にします。発注時は見込みの本体価格・初版部数・料率で<b>仮計算</b>した額を
                  受注者帰属の行（{contractorLines.map((l) => `${lines.indexOf(l) + 1} 行目`).join("・")}）の確定額にし、納品後 60 日以内に本体価格・部数を確定して検収書で払います
                  （確定額が仮計算額を下回っても仮計算額＝減額にしない）。2 版目以降・電子は出版基本契約の個別契約による印税で、初版は計算書の対象外です。
                  発注書には特約（下の文）が既定で入ります（文書の欄で直せます）。
                </span>
                <div className="form-grid">
                  <label className="field"><span>価格の基準</span>
                    <select value={fePriceBasis} onChange={(e) => setFePriceBasis(e.target.value as "" | "supply" | "receipts")}>
                      <option value="">本体価格（定価）</option>
                      <option value="supply">卸価格（再許諾先への供給価格）</option>
                      <option value="receipts">発注者の受領額（再許諾料の入金 × 料率）</option>
                    </select>
                    <small className="faint">KADOKAWA 等へ卸す形は卸価格（ゲームの自社製造・他社販売と同じ構造）。再許諾料の入金に料率を掛けるだけなら受領額（部数は使わない）。2 版目以降の式にも使う</small></label>
                  <label className="field"><span>{fePriceBasis === "supply" ? "見込み卸価格（税抜・円）" : fePriceBasis === "receipts" ? "見込みの再許諾料の受領額（税抜・円）" : "見込み本体価格（税抜・円）"}</span>
                    <input inputMode="numeric" value={fePrice} placeholder={fePriceBasis === "receipts" ? "10000000" : "1000"} onChange={(e) => setFePrice(e.target.value)} /></label>
                  {fePriceBasis !== "receipts" && <label className="field"><span>見込み初版部数</span>
                    <input inputMode="numeric" value={feCopies} placeholder="3000" onChange={(e) => setFeCopies(e.target.value)} /></label>}
                  <label className="field"><span>初版の料率（%）</span>
                    <input inputMode="decimal" value={feRate} placeholder="10" onChange={(e) => setFeRate(e.target.value)} /></label>
                  {fePriceBasis !== "receipts" && <label className="field"><span>初版の非加算部数（献本・見本等）</span>
                    <input inputMode="numeric" value={feExempt} placeholder="0" onChange={(e) => setFeExempt(e.target.value)} />
                    <small className="faint">既定 0（全部数）。入れると算定方法に「− ○部」が明記される。方針が決まるまで 0 のまま</small></label>}
                </div>
                <div className="row" style={{ gap: 18, flexWrap: "wrap", alignItems: "center" }}>
                  <span>仮計算額 <b>¥{yen(provisional)}</b>{feOk && <span className="faint">　{firstEditionBasisText(firstEdition).replace("算定の基礎（見込み）：", "＝ ")}</span>}</span>
                  <span className={rowsTotal === provisional ? "faint" : "tag warn"}>受注者帰属の行の合計 ¥{yen(rowsTotal)}{rowsTotal !== provisional && feOk ? "（仮計算額と合っていません）" : ""}</span>
                  {feOk && rowsTotal !== provisional && contractorLines.length > 1 && (
                    <button type="button" className="btn btn-sm" onClick={fillProvisional}>仮計算額を先頭の受注者帰属の行に入れる</button>
                  )}
                  {feOk && contractorLines.length === 1 && (
                    <span className="faint">行が 1 本なので、仮計算額がそのまま行の金額に入ります（数量 1 × 単価 ¥{yen(provisional)}）</span>
                  )}
                  {contractorLines.length > 1 && (
                    <span className="faint">内訳：{contractorLines.map((l) => `${l.name || title} ¥${yen(amountOf(l))}`).join("、")}</span>
                  )}
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <b style={{ fontSize: "0.9em" }}>2 版目以降・電子の料率（利用形態ごとに利用許諾条件が 1 本立ちます）</b>
                  {inLieuRates.map((r, i) => (
                    <div key={r.key} className="row" style={{ gap: 6, alignItems: "center" }}>
                      <select value={r.usageType} aria-label={`${i + 1} 番目の利用形態`}
                              onChange={(e) => setInLieuRates((p) => p.map((x) => (x.key === r.key ? { ...x, usageType: e.target.value } : x)))}>
                        {CONDITION_USAGE_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                      </select>
                      <input style={{ width: 80, textAlign: "right" }} inputMode="decimal" value={r.ratePct} aria-label={`${i + 1} 番目の料率`}
                             onChange={(e) => setInLieuRates((p) => p.map((x) => (x.key === r.key ? { ...x, ratePct: e.target.value } : x)))} />
                      <span>%</span>
                      <span className="faint">{r.usageType === "pub_print" ? "本体価格 × 発行部数 × 料率" : r.usageType === "pub_digital" ? "当社の受領額 × 料率" : "当社の受領額 × 料率"}</span>
                      {inLieuRates.length > 1 && <button className="linky" onClick={() => setInLieuRates((p) => p.filter((x) => x.key !== r.key))} aria-label="料率の行を外す">✕</button>}
                    </div>
                  ))}
                  <div><button className="btn btn-sm" onClick={() => setInLieuRates((p) => [...p, { key: keySeq++, usageType: "in_house", ratePct: "" }])}>利用形態を足す</button></div>
                </div>
                <div className="form-grid">
                  <label className="field"><span>確定の期限（受領後 ○ 日）</span>
                    <input inputMode="numeric" value={confirmDays} placeholder="45" onChange={(e) => setConfirmDays(e.target.value)} />
                    <small className="faint">本体価格・初版部数を書面で通知し乙の確認を得る期限。60 日以内</small></label>
                  <label className="field"><span>支払期日</span>
                    <input type="date" value={inLieuPayOn} onChange={(e) => setInLieuPayOn(e.target.value)} />
                    <small className="faint">成果物の受領（納期）から 60 日以内。各行の予定明細の支払日になり、発注書の支払期日に出る。期限までに確定しなければ仮計算額を払い、差額は確定後 30 日以内</small></label>
                  <label className="field"><span>非加算：2 版目以降（発行部数の %）</span>
                    <input inputMode="decimal" value={exemptLater} placeholder="1" onChange={(e) => setExemptLater(e.target.value)} />
                    <small className="faint">献本等。空なら非加算なし。初版の非加算とは別の欄</small></label>
                  <label className="field"><span>再許諾（第三者への翻訳出版等）</span>
                    <select value={sublicense} onChange={(e) => setSublicense(e.target.value as "no" | "consent" | "covered")}>
                      <option value="consent">可（都度合意）：乙の事前の書面同意を得て行う（既定）</option>
                      <option value="covered">可（包括同意）：本特約で同意済み。翻訳出版が前提の案件だけ</option>
                      <option value="no">不可：自社出版のみ</option>
                    </select>
                    <small className="faint">可否と同意の要否はここで決め、再許諾先・料率・範囲は個別出版条件書で。再許諾の料率を先に決めるなら上の料率に「翻訳版再許諾」を足す</small></label>
                </div>
                {sixtyDayOver.length > 0 && (
                  <div className="alert">支払期日 {inLieuPayOn} が納期から 60 日を超えている行があります（{sixtyDayOver.map((l) => `${lines.indexOf(l) + 1} 行目 ${l.deliveryDue}`).join("・")}）。取適法・フリーランス法の支払期日に合わせてください</div>
                )}
                <div className="stack" style={{ gap: 4 }}>
                  <button className="linky" type="button" onClick={() => setShowTermsPreview((v) => !v)}>
                    {showTermsPreview ? "特約の文を閉じる" : "発注書に入る特約の文を見る"}
                  </button>
                  {showTermsPreview && <textarea rows={14} readOnly value={termsPreview} aria-label="発注書に入る特約の文" />}
                </div>
              </div>
            )}
            {licMode !== "none" && (
              <div className="form-grid">
                <label className="field"><span>利用許諾条件を載せる契約（出版基本契約）</span>
                  <select value={licAgreementId} onChange={(e) => setLicAgreementId(e.target.value)}>
                    <option value="">{agreementId ? "業務委託の基本契約と同じ" : "（業務委託と同じ：契約に載せない）"}</option>
                    {agreementOptions.filter((a) => String(a.id) !== agreementId).map((a) =>
                      <option key={a.id} value={a.id}>{[a.agreementNo, a.title].filter(Boolean).join(" ")}</option>)}
                    {agreementId && <option value="none">契約に載せない（個別出版条件書のみ）</option>}
                  </select>
                  <small className="faint">成果物を出版・再許諾するときの利用許諾は、業務委託の基本契約とは別に、出版基本契約の個別契約として扱えます。発注書の利用許諾条件の表と特約に「その個別契約」と出ます</small></label>
                <label className="field"><span>条件書も併せて作る（任意）</span>
                  <select value={companion} onChange={(e) => setCompanion(e.target.value as typeof companion)}>
                    <option value="">作らない（発注書だけ）</option>
                    <option value="pub_license_terms_v3">出版等利用許諾条件書（作品追加の合意）{inLieuRates.some((r) => r.usageType.startsWith("pub_")) ? "（おすすめ）" : ""}</option>
                    <option value="individual_license_terms_v4">個別利用許諾条件書（ゲーム）{licMode !== "in_lieu" || inLieuRates.every((r) => !r.usageType.startsWith("pub_")) ? "（おすすめ）" : ""}</option>
                  </select>
                  <small className="faint">コアロジックを生む利用許諾条件が付く発注では、利用許諾条件を載せた条件書の下書きを発注書とは別に起こします（既存のひな形）。発注書の特約に「本発注書の利用許諾の条件はこの条件書に当たる」と入ります</small></label>
                <div className="field wide stack" style={{ gap: 4 }}>
                  <span>クレジット表記（成果物を利用するときの表示）</span>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <button type="button" className="chip" aria-pressed={creditFromWork} onClick={() => setCreditFromWork(true)}>作品のクレジット表記を引用</button>
                    <button type="button" className="chip" aria-pressed={!creditFromWork} onClick={() => setCreditFromWork(false)}>この条件で文言を定める</button>
                  </div>
                  {creditFromWork ? (
                    <small className="faint">
                      {licenseWorkId
                        ? (workCredit
                          ? <>作品の今の表記：<b>{workCredit}</b>（文書を作る日時点の表記を差します。重版で変われば作品側で履歴を足してください）</>
                          : <>作品にクレジット表記が登録されていません。作品の画面で登録するか、下に文言を入れると控えとして使います。</>)
                        : "受注者帰属の行に作品を選ぶと、その作品のクレジット表記を引用できます"}
                    </small>
                  ) : null}
                  <textarea rows={2} value={creditNotice} aria-label="クレジット表記の文言"
                            placeholder={creditFromWork ? "（作品に表記が無いときの控え）© 2026 山田太郎／イラスト：山田太郎" : "© 2026 山田太郎／イラスト：山田太郎"}
                            onChange={(e) => setCreditNotice(e.target.value)} />
                  <small className="faint">発注書の利用許諾条件の下と特約に出ます。</small>
                </div>
                {licMode !== "in_lieu" && (
                <label className="field"><span>利用形態</span>
                  <select value={licUsage} onChange={(e) => setLicUsage(e.target.value)}>
                    {CONDITION_USAGE_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select></label>)}
                {licMode === "separate" && (<>
                  <label className="field"><span>料率（%）</span><input value={licRate} placeholder="8" onChange={(e) => setLicRate(e.target.value)} /></label>
                  <label className="field"><span>または 定額（税抜）</span><input value={licFlat} placeholder="料率が空のとき" onChange={(e) => setLicFlat(e.target.value)} /></label>
                </>)}
                <label className="field"><span>許諾開始（空なら開始日）</span><input type="date" value={licTermStart} onChange={(e) => setLicTermStart(e.target.value)} /></label>
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

        {hasQuasi && (
          <div className="note stack" style={{ gap: 8 }}>
            <b>準委任の精算の仕方</b>
            <span className="faint">
              準委任（役務提供）の委託料は、成果物・固定額で精算するか、月間包括枠（コアタイム）と実績時間で精算するかで、
              持つ情報と決済文書が変わります。対象：{quasiRows.map((l) => `${lines.indexOf(l) + 1} 行目`).join("・")}
            </span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="chip" aria-pressed={!timeOn} onClick={() => setTimeOn(false)}>固定額・成果物で精算（検収書）</button>
              <button className="chip" aria-pressed={timeOn} onClick={() => setTimeOn(true)}>時間精算：月間包括枠 ＋ 実績時間（役務提供完了通知書）</button>
            </div>
            {timeOn && (
              <div className="form-grid">
                <label className="field"><span>月間包括枠（時間）</span>
                  <input inputMode="decimal" value={hoursIncluded} placeholder="64" onChange={(e) => setHoursIncluded(e.target.value)} />
                  <small className="faint">この時間までは行の金額（基本委託料／月）。コアタイム</small></label>
                <label className="field"><span>超過単価（円／時間・税抜）</span>
                  <input inputMode="numeric" value={overageUnit} placeholder="3125" onChange={(e) => setOverageUnit(e.target.value)} />
                  <small className="faint">枠を超えた時間 × 超過単価 を追加精算</small></label>
                <label className="field"><span>控除単価（円／時間・税抜）</span>
                  <input inputMode="numeric" value={shortfallUnit} placeholder="空なら減額しない" onChange={(e) => setShortfallUnit(e.target.value)} />
                  <small className="faint">未消化の時間 × 控除単価 を減額。空なら未消化でも減額しない</small></label>
                <div className="field wide">
                  <span className="faint">
                    時間精算の回は、実績入力で実績時間と月次業務報告書の受領日を入れ、検収書の代わりに役務提供完了通知書を出します。
                    {payMode !== "periodic" && <>　毎月精算するなら支払方法を「定期払い（毎月）」にしてください。
                      <button className="linky" type="button" onClick={() => { setPayMode("periodic"); setEvery("1"); }}>定期払い（毎月）にする</button></>}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="note stack" style={{ gap: 8 }}>
          <b>支払方法</b>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {([["per_delivery", "納品ごとに検収して支払（既定）"], ["periodic", "定期払い（毎月・四半期）"], ["lump", "一括（全納品後にまとめて検収）"]] as const).map(([v, label]) => (
              <button key={v} className="chip" aria-pressed={payMode === v} disabled={inLieu && v === "periodic"}
                      title={inLieu && v === "periodic" ? "初版利用許諾料は受領後に 1 回で払うので定期払いにできません" : undefined}
                      onClick={() => setPayMode(v)}>{label}</button>
            ))}
          </div>
          {inLieu && <span className="faint">初版の利用許諾料を報酬として払う発注は、各行に 1 回の予定明細（納期・支払期日）が立ちます。確定額は検収のときに入れます（予定と違う額として変更履歴に残り、検収書に出ます）。</span>}
          {payMode === "periodic" && (
            <div className="form-grid">
              <label className="field"><span>期間 開始</span><input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} /></label>
              <label className="field"><span>期間 終了</span><input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} /></label>
              <label className="field"><span>何か月ごと</span><input value={every} onChange={(e) => setEvery(e.target.value)} />
                <small className="faint">行の金額（単価×数量）が 1 回あたり。期ごとに予定明細が立ち、期の末日に検収・支払が起きる。
                  発注書には全回を 1 行にまとめて出す（例：全 12 回（毎月）1 回あたり ¥35,000）。回ごとの金額を直すのは条件明細の「予定」</small></label>
            </div>
          )}
          {payMode === "lump" && <span className="faint">発注書は行ごとに出ますが、検収は全行の納品後に 1 枚の検収書でまとめます（支払文書で選ぶ）。</span>}
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
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "登録しています…" : `条件明細 ${lines.length} 本を登録する`}
          </button>
          <button className="btn" onClick={onCancel}>やめる</button>
          {/* 押せない理由。無いと、押しても何も起きないように見える（基礎情報の段階と同じ出し方）。 */}
          {!ready && missing.length > 0 && <span className="tag warn">あと：{missing.join("・")}</span>}
        </div>
      </div>
    </div>
  );
}
