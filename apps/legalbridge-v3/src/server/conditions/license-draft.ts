import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import { firstEditionFee, withinSixtyDays } from "./royalty-in-lieu.js";

/**
 * 受注者帰属の成果物の利用許諾の欄の値（A-120）。画面（LicenseTermsSection）が持ち、
 * 『業務委託（発注）』のフォームと条件の登録（1 本）の両方が同じ形で /conditions/service-set へ送る。
 * 画面に依らない確かめ（仮計算額・60 日）と送る形はここに置く（テストできるように）。
 */

export type LicMode = "separate" | "included" | "free" | "in_lieu" | "none";
export type Exclusivity = "" | "exclusive" | "non_exclusive";
export interface InLieuRate { key: number; usageType: string; ratePct: string; exclusivity: Exclusivity }

export interface LicenseDraft {
  mode: LicMode;
  /** 利用形態（in_lieu 以外。in_lieu は rates の行ごと）。 */
  usage: string;
  /** 2 版目以降・電子の料率（in_lieu。利用形態ごとに利用許諾条件が 1 本立つ）。 */
  rates: InLieuRate[];
  /** 独占／非独占（A-098）。作る利用許諾条件すべての既定。 */
  exclusivity: Exclusivity;
  /** 利用許諾料の支払条件（A-106）。in_lieu なら 2 版目以降の分。 */
  paymentTerms: string;
  /** 支払期日（in_lieu）。各行の予定明細の支払日。 */
  payOn: string;
  fePrice: string;
  feCopies: string;
  feRate: string;
  /** 初版の非加算部数（献本・見本等）。 */
  feExempt: string;
  /** 価格の基準（A-091）。"" は本体価格、supply は卸価格、receipts は受領額。 */
  fePriceBasis: "" | "supply" | "receipts";
  confirmDays: string;
  /** 2 版目以降の非加算（発行部数の %）。 */
  exemptLater: string;
  /** 載せる契約（出版基本契約）。"" は業務委託の基本契約と同じ、"none" は載せない。 */
  agreementId: string;
  creditFromWork: boolean;
  creditNotice: string;
  /** 併せて作る条件書（A-080）。 */
  companion: "" | "pub_license_terms_v3" | "individual_license_terms_v4";
  /** 再許諾の可否（A-079）。 */
  sublicense: "no" | "consent" | "covered";
  /** 別途のときの料率・定額。 */
  rate: string;
  flat: string;
  /**
   * 許諾期間（当社が成果物を使える期間）。納期・役務提供期間とは別。
   * 無期限なら termEnd は送らない（期間の定めなし）。有期なら終了日が要る。
   */
  termKind: "perpetual" | "fixed";
  termStart: string;
  termEnd: string;
  regions: string;
  languages: string;
}

/** 欄に出す委託料の行（受注者帰属の行）。 */
export interface LicenseDeliverable {
  /** 画面での呼び方（「1 行目」、1 本の登録なら品目名）。 */
  label: string;
  name: string;
  amount: number;
  deliveryDue: string;
}

let rateKey = 1;
export const newRate = (usageType: string, ratePct: string): InLieuRate =>
  ({ key: rateKey++, usageType, ratePct, exclusivity: "" });

export function newLicenseDraft(mode: LicMode = "included"): LicenseDraft {
  return {
    mode, usage: "in_house",
    rates: [newRate("pub_print", "10"), newRate("pub_digital", "15")],
    exclusivity: "", paymentTerms: "", payOn: "",
    fePrice: "", feCopies: "", feRate: "10", feExempt: "0", fePriceBasis: "", confirmDays: "45", exemptLater: "1",
    agreementId: "", creditFromWork: true, creditNotice: "", companion: "", sublicense: "consent",
    rate: "", flat: "", termKind: "perpetual", termStart: "", termEnd: "", regions: "全世界", languages: "全言語"
  };
}

const num = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const int = (v: string) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const text = (v: string) => { const s = String(v ?? "").trim(); return s || undefined; };
const yen = (n: number) => n.toLocaleString("ja-JP");

/** 初版の算定の基礎。受領額基準（再許諾料の入金 × 料率）は部数を持たない（部数 1・非加算 0）。A-092 */
export function firstEditionOf(d: LicenseDraft) {
  return d.fePriceBasis === "receipts"
    ? { price: num(d.fePrice), copies: 1, ratePct: num(d.feRate), exemptCopies: 0, priceBasis: "receipts" as const }
    : { price: num(d.fePrice), copies: Math.floor(num(d.feCopies)), ratePct: num(d.feRate),
        exemptCopies: d.feExempt.trim() === "" ? 0 : Math.floor(num(d.feExempt)),
        priceBasis: d.fePriceBasis || null };
}

/**
 * 初版の利用許諾料を報酬として払うときの確かめ（A-077）。仮計算額と行の合計、料率の行、確定の期限、
 * 支払期日と 60 日。登録ボタンの横に出す「あと：…」の文もここで作る。
 */
export function inLieuCheck(d: LicenseDraft, deliverables: LicenseDeliverable[]) {
  const fe = firstEditionOf(d);
  const provisional = firstEditionFee(fe);
  const rowsTotal = deliverables.reduce((a, l) => a + l.amount, 0);
  const feOk = fe.price > 0 && fe.copies > 0 && fe.ratePct > 0 && fe.ratePct <= 100
    && (fe.exemptCopies ?? 0) >= 0 && (fe.exemptCopies ?? 0) < fe.copies;
  const ratesOk = d.rates.length > 0
    && d.rates.every((r) => r.usageType && num(r.ratePct) > 0 && num(r.ratePct) <= 100)
    && new Set(d.rates.map((r) => r.usageType)).size === d.rates.length;
  const confirmOk = Number.isInteger(num(d.confirmDays)) && num(d.confirmDays) >= 1 && num(d.confirmDays) <= 60;
  const sixtyDayOver = d.payOn ? deliverables.filter((l) => withinSixtyDays(l.deliveryDue || null, d.payOn) === false) : [];
  const missing = [
    !feOk ? "初版の算定の基礎（見込みの本体価格・初版部数・料率。非加算は部数より少なく）" : null,
    feOk && rowsTotal !== provisional ? `受注者帰属の金額の合計を仮計算額 ¥${yen(provisional)} に合わせる` : null,
    !ratesOk ? "2 版目以降・電子の料率（0 より大きく、重複なし）" : null,
    !confirmOk ? "確定の期限（受領後 1〜60 日）" : null,
    !d.payOn ? "支払期日" : null,
    deliverables.some((l) => l.amount <= 0) ? "受注者帰属の金額（仮計算額の配分。0 円にはしない）" : null,
    sixtyDayOver.length > 0 ? `支払期日が納期から 60 日を超えている（${sixtyDayOver.map((l) => l.label).join("・")}）` : null
  ].filter((m): m is string => Boolean(m));
  return { firstEdition: fe, provisional, rowsTotal, feOk, ratesOk, confirmOk, sixtyDayOver, missing, ready: missing.length === 0 };
}

/** 許諾期間の足りないところ（有期なのに終了日が無い・終了が開始より前）。無ければ null。 */
export function licensePeriodMissing(d: Pick<LicenseDraft, "mode" | "termKind" | "termStart" | "termEnd">): string | null {
  if (d.mode === "none" || d.termKind !== "fixed") return null;
  if (!d.termEnd.trim()) return "許諾期間の終了日（有期を選んだとき）";
  if (d.termStart.trim() && d.termEnd < d.termStart) return "許諾期間の終了日を開始日より後に";
  return null;
}

/** サーバ（/conditions/service-set の license）へ送る形。 */
export function licensePayload(d: LicenseDraft, opts: { workId: string; termStart: string }) {
  const scopes = [
    ...parseRegions(d.regions).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
    ...parseLanguages(d.languages).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
  ];
  const fe = firstEditionOf(d);
  return {
    mode: d.mode, workId: int(opts.workId) ?? null, usageType: d.usage,
    // 出版基本契約。"" は送らない（業務委託の基本契約と同じ）、"none" は null（載せない）。
    ...(d.agreementId === "" ? {} : { agreementId: d.agreementId === "none" ? null : int(d.agreementId) ?? null }),
    // クレジット表記（A-076）。引用なら文書が作品の今の表記を差す（文言は控え）。
    creditFromWork: d.creditFromWork, creditNotice: text(d.creditNotice) ?? null,
    exclusivity: d.exclusivity || null,
    paymentTerms: text(d.paymentTerms) ?? null,
    sublicense: d.sublicense,
    ratePct: d.mode === "separate" && d.rate.trim() ? num(d.rate) : null,
    flatAmount: d.mode === "separate" && !d.rate.trim() && d.flat.trim() ? Math.round(num(d.flat)) : null,
    termStart: text(d.termStart) ?? text(opts.termStart) ?? null,
    termEnd: d.termKind === "perpetual" ? null : text(d.termEnd) ?? null,
    scopes: scopes.length ? scopes : undefined,
    // 初版の利用許諾料を報酬として払う（A-077）。仮計算額と行の合計はサーバが突き合わせる。
    ...(d.mode === "in_lieu" ? {
      rates: d.rates.map((r) => ({ usageType: r.usageType, ratePct: num(r.ratePct), exclusivity: r.exclusivity || null })),
      firstEdition: { price: Math.round(fe.price), copies: fe.copies, ratePct: fe.ratePct,
                      exemptCopies: fe.exemptCopies || null, priceBasis: d.fePriceBasis || null },
      confirmWithinDays: num(d.confirmDays), payOn: text(d.payOn) ?? null,
      exemptLaterPct: d.exemptLater.trim() === "" ? null : num(d.exemptLater)
    } : {})
  };
}
