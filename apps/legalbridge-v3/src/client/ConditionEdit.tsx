import { IN_LIEU_REWARD_LABEL, firstEditionBasisText, firstEditionFee } from "../server/conditions/royalty-in-lieu.js";
import { useEffect, useState, type ReactElement } from "react";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { RightsScopePicker } from "./RightsScopePicker.js";
import { api, ApiError, money, rate } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { CONTRACT_FORMS, CONTRACT_FORMS_EN } from "../server/conditions/contract-form.js";
import { isQuasiMandate } from "../server/conditions/time-settlement.js";
import { DIGITAL_CYCLES, DIGITAL_CYCLE_DEFAULTS, PAY_DAYS, digitalPaymentTerms, payDayLabel, payScheduleText, readDigitalCycle, type DigitalCycle, type DigitalCycleInput, type PayDay } from "../server/conditions/pub-digital-cycle.js";
import { PAYMENT_TERMS_PRESETS_EN, PAYMENT_TERMS_PRESETS_JA } from "../server/conditions/payment-terms.js";
import { minorUnitHint, SETTLEMENT_CYCLE_OPTIONS, SETTLEMENT_MODE_OPTIONS } from "./ConditionCreateForm.js";
import { SETTLEMENT_GRACE_DAYS_DEFAULT } from "../server/conditions/settlement-mode.js";
import { CONDITION_USAGE_TYPES, isSublicensingUsage } from "../server/core/condition-usage.js";

/**
 * 条件の編集。
 *
 * 登録のフォーム（ConditionCreateForm）と同じ項目を同じ並びで出す。以前は
 * 編集が金額と期間だけで、相手先・作品・独占性・地域・言語は別の場所に
 * 散っていて、登録した画面と編集の画面が別物に見えた。
 *
 * 変えられないものも同じ場所に出す（向き・種類・通貨・計算方式）。変えると
 * 過去の計算根拠が変わるので、そこは新しい条件を作ってもらう。
 *
 * 実績があるかどうかで保存の意味が変わる。
 *   実績なし … その場で書き換える
 *   実績あり … 旧版を残して新版を作る（改訂）。番号が変わる
 * 押す前にどちらになるかを見せる。あとから「番号が変わった」と驚かせない。
 */

export interface EditResult {
  changed: Array<{ target: string; rows: number }>;
  resolvesThrough: Array<{ target: string; rows: number }>;
  /** 改訂になった場合の新しい条件ID。 */
  revisedTo?: number;
}

const today = () => new Date().toISOString().slice(0, 10);

type Values = Record<string, string>;

const asMoney = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const asPct = (ppm: number | null | undefined) =>
  ppm === null || ppm === undefined ? "" : String(ppm / 10000);
/** 選択欄が読める形（表示名を「、」で繋ぐ）。保存のときにコードへ戻す。 */
const joinScopes = (detail: ConditionDetail, type: string) =>
  detail.scopes.filter((s) => s.scopeType === type).map((s) => s.label).join("、");

/** 空欄は「変更なし」ではなく「空にする」。両者を取り違えないよう明示的に分ける。 */
const patchText = (next: string, before: string | null) => {
  const value = next.trim() === "" ? null : next.trim();
  return value === (before ?? null) ? undefined : value;
};
/** 個数は小数もある（0.5人月・1.5ヶ月）。整数に丸めない。 */
const patchNum = (next: string, before: number | null) => {
  const value = next.trim() === "" ? null : Number(next.replace(/[^0-9.-]/g, ""));
  if (value !== null && !Number.isFinite(value)) return undefined;
  return value === (before ?? null) ? undefined : value;
};
const patchInt = (next: string, before: number | null) => {
  const value = next.trim() === "" ? null : Math.round(Number(next.replace(/[^0-9-]/g, "")));
  if (value !== null && !Number.isFinite(value)) return undefined;
  return value === (before ?? null) ? undefined : value;
};

const PRICING_LABEL: Record<string, string> = {
  fixed: "定額", revenue_rate: "料率", unit_rate: "単価×数量", subscription: "定期課金", none: "計算しない"
};

export function ConditionEdit(
  { detail, onDone, onCancel, onOpenCondition }:
  { detail: ConditionDetail; onDone: (result: EditResult) => void; onCancel: () => void;
    /** 関連する条件（同じ相手先・作品の委託料／利用許諾）を開く。手順ナビの「開く」が使う。 */
    onOpenCondition?: (id: number) => void }
) {
  const [v, setV] = useState<Values>({
    name: detail.name,
    kind: detail.kind,
    pricingModel: detail.pricingModel,
    counterpartyId: detail.counterparty ? String(detail.counterparty.id) : "",
    workId: detail.work ? String(detail.work.id) : "",
    termStart: detail.termStart ?? "",
    termEnd: detail.termEnd ?? "",
    deliveryDue: detail.deliveryDue ?? "",
    autoRenew: detail.autoRenew ? "1" : "",
    renewMonths: detail.renewMonths ? String(detail.renewMonths) : "",
    renewStoppedOn: detail.renewStoppedOn ?? "",
    ratePct: asPct(detail.ratePpm),
    flatAmount: asMoney(detail.flatAmount),
    unitAmount: asMoney(detail.unitAmount),
    quantity: detail.quantity === null || detail.quantity === undefined
      ? "" : String(detail.quantity),
    mgAmount: asMoney(detail.mgAmount),
    agAmount: asMoney(detail.agAmount),
    exclusivity: detail.exclusivity ?? "",
    usageType: detail.usageType ?? "",
    currency: detail.currency,
    targetPartyId: detail.targetParty ? String(detail.targetParty.id) : "",
    sublicenseConsent: detail.sublicenseConsent ?? "",
    licenseFeeBasis: detail.licenseFeeBasis ?? "separate",
    creditNotice: detail.creditNotice ?? "",
    creditFromWork: detail.creditFromWork ? "1" : "",
    // 報酬名の上書き・印税対象外（A-075）。既存の発注を印税型に直すときにここで入れる。
    rewardLabel: detail.rewardLabel ?? "",
    royaltyExemptFirstCopies: detail.royaltyExemptFirstCopies === null || detail.royaltyExemptFirstCopies === undefined ? "" : String(detail.royaltyExemptFirstCopies),
    royaltyExemptLaterPct: detail.royaltyExemptLaterPct === null || detail.royaltyExemptLaterPct === undefined ? "" : String(detail.royaltyExemptLaterPct),
    // 初版の算定の基礎（A-077）。本体価格は最小通貨単位のまま、料率は % で見せる（保存は ppm）。
    firstEditionPrice: detail.firstEditionPrice === null || detail.firstEditionPrice === undefined ? "" : String(detail.firstEditionPrice),
    firstEditionCopies: detail.firstEditionCopies === null || detail.firstEditionCopies === undefined ? "" : String(detail.firstEditionCopies),
    firstEditionRatePct: detail.firstEditionRatePpm === null || detail.firstEditionRatePpm === undefined ? "" : String(detail.firstEditionRatePpm / 10000),
    confirmWithinDays: detail.confirmWithinDays === null || detail.confirmWithinDays === undefined ? "" : String(detail.confirmWithinDays),
    taxCategory: detail.taxCategory,
    paymentTerms: detail.paymentTerms ?? "",
    settlementMode: detail.settlementMode ?? "",
    settlementCount: detail.settlementCount === null ? "" : String(detail.settlementCount),
    settlementCycle: detail.settlementCycle ?? "",
    settlementGraceDays: detail.settlementGraceDays === null ? "" : String(detail.settlementGraceDays),
    reportDueDays: detail.reportDueDays === null || detail.reportDueDays === undefined ? "" : String(detail.reportDueDays),
    contractForm: detail.contractForm ?? "",
    timeSettlement: detail.timeSettlement ? "1" : "",
    hoursIncluded: detail.hoursIncluded === null || detail.hoursIncluded === undefined ? "" : String(detail.hoursIncluded),
    overageUnitAmount: asMoney(detail.overageUnitAmount),
    shortfallUnitAmount: asMoney(detail.shortfallUnitAmount),
    spec: detail.spec ?? "",
    orderNo: detail.orderNo ?? "",
    deliverableOwnership: detail.deliverableOwnership ?? "",
    regions: joinScopes(detail, "region"),
    languages: joinScopes(detail, "language"),
    notes: detail.notes ?? ""
  });
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 適用開始日。未来を入れると「予約された改訂」になり、いまの版は生きたまま残る。
  const [effectiveFrom, setEffectiveFrom] = useState("");
  /**
   * 直接編集。実績や文書があっても改訂（新版の作成）にせず、その場で書き換える。
   * 台帳の整理（移行データの直し）のための口。支払が立っている条件では使えない
   * （払った額の根拠が書き換わる）。種類と計算方式もこのときだけ変えられる。
   */
  const [inPlace, setInPlace] = useState(false);
  const hasPayment = ["payment_planned", "partly_paid", "paid"].includes(detail.settlement?.state ?? "");
  /** 関数更新にする。1 つのハンドラで 2 回呼んでも先の値が消えない（チップで計算方式と報酬名を同時に入れる）。 */
  const set = (k: string, value: string) => setV((prev) => ({ ...prev, [k]: value }));
  /** 電子書籍の集計のしかた（年 1 回・年 2 回・年 4 回）。支払条件の文と決済の型をまとめて入れる。 */
  const readCycle = readDigitalCycle(detail.paymentTerms);
  const [cyc, setCyc] = useState<DigitalCycleInput>(readCycle ?? DIGITAL_CYCLE_DEFAULTS.year);
  const applyCycle = (next: typeof cyc) => {
    setCyc(next);
    setV({ ...v, paymentTerms: digitalPaymentTerms(next), settlementMode: "term_bound", settlementCycle: next.cycle });
  };

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
  }, []);

  // 単価×個数。入れてあれば定額の欄に出す。手で直した値があればそちらが勝つ
  // （文書作成フォームの「金額（税抜）」と同じ扱い）。
  const computedFlat = (() => {
    const unit = Number(v.unitAmount.replace(/[^0-9.-]/g, ""));
    const count = Number(v.quantity.replace(/[^0-9.-]/g, ""));
    if (!v.unitAmount.trim() || !v.quantity.trim()) return null;
    if (!Number.isFinite(unit) || !Number.isFinite(count)) return null;
    return Math.sign(unit * count) * Math.round(Math.abs(unit * count));
  })();

  const later = effectiveFrom !== "" && effectiveFrom > today();
  // 実績があると、保存は改訂（旧版を残して新版を作る）になる。
  const willRevise = detail.events.length > 0 && !inPlace;
  /** 金額の欄は、直接編集で計算方式を変えたときはその方式に合わせて出す。 */
  const pm = inPlace ? v.pricingModel : detail.pricingModel;
  const readOnly = detail.status === "void" || detail.status === "superseded";

  /** 金額・期間・作品・独占性。PATCH /conditions/:id。 */
  function buildPatch() {
    const patch: Record<string, unknown> = {};
    const name = v.name.trim();
    if (name && name !== detail.name) patch.name = name;

    const pairs: Array<[string, unknown]> = [
      ["termStart", patchText(v.termStart, detail.termStart)],
      ["termEnd", patchText(v.termEnd, detail.termEnd)],
      ["deliveryDue", patchText(v.deliveryDue, detail.deliveryDue)],
      ["renewStoppedOn", patchText(v.renewStoppedOn, detail.renewStoppedOn)],
      ["paymentTerms", patchText(v.paymentTerms, detail.paymentTerms)],
      ["contractForm", patchText(v.contractForm, detail.contractForm)],
      ["quantity", patchNum(v.quantity, detail.quantity)],
      ["notes", patchText(v.notes, detail.notes)],
      ["spec", patchText(v.spec, detail.spec)],
      ["orderNo", patchText(v.orderNo, detail.orderNo)],
      ["deliverableOwnership", patchText(v.deliverableOwnership, detail.deliverableOwnership)],
      ["flatAmount", patchInt(v.flatAmount, detail.flatAmount)],
      ["unitAmount", patchInt(v.unitAmount, detail.unitAmount)],
      ["mgAmount", patchInt(v.mgAmount, detail.mgAmount)],
      ["agAmount", patchInt(v.agAmount, detail.agAmount)],
      ["workId", patchInt(v.workId, detail.work?.id ?? null)],
      ["exclusivity", patchText(v.exclusivity, detail.exclusivity)],
      ["usageType", patchText(v.usageType, detail.usageType)],
      ["currency", patchText(v.currency, detail.currency)],
      ["targetPartyId", patchInt(v.targetPartyId, detail.targetParty?.id ?? null)],
      ["sublicenseConsent", patchText(v.sublicenseConsent, detail.sublicenseConsent)],
      ["licenseFeeBasis", patchText(v.licenseFeeBasis, detail.licenseFeeBasis ?? "separate")],
      ["creditNotice", patchText(v.creditNotice, detail.creditNotice)],
      ["rewardLabel", patchText(v.rewardLabel, detail.rewardLabel)],
      ["royaltyExemptFirstCopies", patchInt(v.royaltyExemptFirstCopies, detail.royaltyExemptFirstCopies ?? null)],
      ["royaltyExemptLaterPct", patchNum(v.royaltyExemptLaterPct, detail.royaltyExemptLaterPct ?? null)],
      ["firstEditionPrice", patchInt(v.firstEditionPrice, detail.firstEditionPrice ?? null)],
      ["firstEditionCopies", patchInt(v.firstEditionCopies, detail.firstEditionCopies ?? null)],
      ["confirmWithinDays", patchInt(v.confirmWithinDays, detail.confirmWithinDays ?? null)],
      ["reportDueDays", patchInt(v.reportDueDays, detail.reportDueDays ?? null)]
    ];
    for (const [key, value] of pairs) if (value !== undefined) patch[key] = value;
    // クレジット表記を作品から引用するか（A-076）。変わったときだけ送る。
    if ((v.creditFromWork === "1") !== Boolean(detail.creditFromWork)) patch.creditFromWork = v.creditFromWork === "1";
    // 初版の料率は % で見せて ppm で保存する（A-077）。
    const feRate = patchNum(v.firstEditionRatePct,
      detail.firstEditionRatePpm === null || detail.firstEditionRatePpm === undefined ? null : detail.firstEditionRatePpm / 10000);
    if (feRate !== undefined) patch.firstEditionRatePpm = feRate === null ? null : Math.round(feRate * 10000);

    // 決済の型（A-071）。4 つで 1 組なので、どれか変わったら 4 つとも送る（型に要らない値はサーバが捨てる）。
    const sMode = v.settlementMode || null;
    const sCount = v.settlementCount.trim() === "" ? null : Math.round(Number(v.settlementCount));
    const sCycle = v.settlementCycle || null;
    const sGrace = v.settlementGraceDays.trim() === "" ? null : Math.round(Number(v.settlementGraceDays));
    if (sMode !== detail.settlementMode || sCount !== detail.settlementCount
        || sCycle !== detail.settlementCycle || sGrace !== detail.settlementGraceDays) {
      patch.settlementMode = sMode; patch.settlementCount = sCount;
      patch.settlementCycle = sCycle; patch.settlementGraceDays = sGrace;
    }

    // 準委任の時間精算（A-073）。4 つで 1 組。どれか変わったら 4 つとも送る（時間精算でなければサーバが捨てる）。
    const tOn = v.timeSettlement === "1";
    const tHours = v.hoursIncluded.trim() === "" ? null : Number(v.hoursIncluded.replace(/[^0-9.]/g, ""));
    const tOver = v.overageUnitAmount.trim() === "" ? null : Math.round(Number(v.overageUnitAmount.replace(/[^0-9-]/g, "")));
    const tShort = v.shortfallUnitAmount.trim() === "" ? null : Math.round(Number(v.shortfallUnitAmount.replace(/[^0-9-]/g, "")));
    if (tOn !== Boolean(detail.timeSettlement) || (tOn && (tHours !== (detail.hoursIncluded ?? null)
        || tOver !== (detail.overageUnitAmount ?? null) || tShort !== (detail.shortfallUnitAmount ?? null)))) {
      patch.timeSettlement = tOn; patch.hoursIncluded = tOn ? tHours : null;
      patch.overageUnitAmount = tOn ? tOver : null; patch.shortfallUnitAmount = tOn ? tShort : null;
    }

    // 自動更新（A-039）。更新しないなら単位と止めた日は空に戻す。
    const autoRenew = v.autoRenew === "1";
    if (autoRenew !== Boolean(detail.autoRenew)) patch.autoRenew = autoRenew;
    const months = v.renewMonths.trim() === "" ? null : Math.round(Number(v.renewMonths));
    if (autoRenew && months !== (detail.renewMonths ?? null)
        && (months === null || Number.isFinite(months))) {
      patch.renewMonths = months;
    }
    if (!autoRenew) {
      if (detail.renewMonths !== null) patch.renewMonths = null;
      if (detail.renewStoppedOn !== null) patch.renewStoppedOn = null;
    }

    // 画面は % で受け、保存は ppm（百万分率）。12.5% → 125000
    const pct = v.ratePct.trim();
    const ppm = pct === "" ? null : Math.round(Number(pct) * 10000);
    if (ppm !== (detail.ratePpm ?? null) && (ppm === null || Number.isFinite(ppm))) {
      patch.ratePpm = ppm;
    }
    if (v.taxCategory !== detail.taxCategory) patch.taxCategory = v.taxCategory;
    // 種類と計算方式は直接編集のときだけ送る。
    if (inPlace && v.kind !== detail.kind) patch.kind = v.kind;
    if (inPlace && v.pricingModel !== detail.pricingModel) patch.pricingModel = v.pricingModel;
    return patch;
  }

  const patch = buildPatch();
  const counterpartyChanged = v.counterpartyId !== "" && Number(v.counterpartyId) !== (detail.counterparty?.id ?? null);
  const scopesChanged = v.regions !== joinScopes(detail, "region") || v.languages !== joinScopes(detail, "language");
  const changedCount = Object.keys(patch).length + (counterpartyChanged ? 1 : 0) + (scopesChanged ? 1 : 0);

  /**
   * 保存の順は 相手先 → 範囲 → 金額。金額は改訂で新しい版を作ることがあり、
   * 新しい版は相手先も範囲も元から写すので、先に元を直しておく。
   */
  async function save() {
    setBusy(true); setError(null);
    try {
      if (counterpartyChanged) {
        await api.patch(`/conditions/${detail.id}/counterparty`, { partyId: Number(v.counterpartyId) });
      }
      if (scopesChanged) {
        // 地域・言語だけ差し替える。媒体・チャネル（下の「権利の範囲」で扱う）は残す。
        const kept = detail.scopes.filter((s) => s.scopeType !== "region" && s.scopeType !== "language")
          .map((s) => ({ scopeType: s.scopeType, label: s.label, code: s.code ?? null }));
        await api.put(`/conditions/${detail.id}/scopes`, { scopes: [
          ...kept,
          // 照合はコードで行うので、名前から引き当てて入れ直す。当たらない語は
          // コード無しのまま残す（移行してきた表記を黙って捨てない）。
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region", label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language", label: s.name, code: s.code || null }))
        ] });
      }
      if (Object.keys(patch).length) {
        onDone(await api.patch<EditResult>(`/conditions/${detail.id}`,
          { ...patch, effectiveFrom: effectiveFrom || null, ...(inPlace ? { inPlace: true } : {}) }));
      } else {
        onDone({ changed: [
          ...(counterpartyChanged ? [{ target: "conditions（相手先）", rows: 1 }] : []),
          ...(scopesChanged ? [{ target: "condition_scopes", rows: 1 }] : [])
        ], resolvesThrough: [] });
      }
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (readOnly) {
    return (
      <div className="panel create-form">
        <div className="panel-hd"><h2>条件の編集</h2></div>
        <div className="panel-bd">
          <div className="note warn">
            {detail.status === "void"
              ? "無効にした条件は編集できません。"
              : "旧版の条件は編集できません。最新版を開いて編集してください。"}
          </div>
          <div className="row"><button className="btn" onClick={onCancel}>閉じる</button></div>
        </div>
      </div>
    );
  }

  const field = (name: string, label: string, extra?: { type?: string; hint?: string; wide?: boolean; placeholder?: string }) => (
    <label className={extra?.wide ? "field wide" : "field"} key={name} id={`f-${name}`}>
      <span>{label}</span>
      {extra?.type === "regions" || extra?.type === "languages"
        ? <RightsScopePicker kind={extra.type === "regions" ? "region" : "language"}
                             value={v[name] ?? ""} onChange={(next) => set(name, next)} />
        : extra?.type === "textarea"
        ? <textarea rows={3} value={v[name] ?? ""} placeholder={extra.placeholder} onChange={(e) => set(name, e.target.value)} />
        : <input type={extra?.type ?? "text"} value={v[name] ?? ""} placeholder={extra?.placeholder}
                 inputMode={extra?.type === "number" ? "numeric" : undefined}
                 onChange={(e) => set(name, e.target.value)} />}
      {extra?.hint && <small className="faint">{extra.hint}</small>}
    </label>
  );
  /** 変えられない項目。登録と同じ場所に出し、なぜ変えられないかを添える。 */
  const fixed = (label: string, value: string, why: string) => (
    <label className="field" key={label}>
      <span>{label}</span>
      <input value={value} readOnly disabled />
      <small className="faint">{why}</small>
    </label>
  );

  /** 出し分けに使う種類。直接編集で種類を変えたら、その種類の欄を出す（保存前でも）。 */
  const kindNow = inPlace ? (v.kind || detail.kind) : detail.kind;
  /**
   * 「初版の利用許諾料を報酬として払う」を選ぶ（支払の形のチップと手順ナビの両方から）。
   * 報酬名・確定期限を入れ、計算方式が定額でなければ定額に直す。計算方式の変更は直接編集でしか
   * 送られないので、支払が無ければ直接編集に切り替える。
   */
  const chooseInLieu = () => {
    set("rewardLabel", IN_LIEU_REWARD_LABEL);
    if (v.confirmWithinDays.trim() === "") set("confirmWithinDays", "45");
    if (v.pricingModel !== "fixed") { set("pricingModel", "fixed"); if (!hasPayment) setInPlace(true); }
  };
  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>条件の編集</h2>
        <span className="code">{detail.conditionNo ?? `#${detail.id}`}</span>
        <span className="faint" style={{ marginLeft: "auto" }}>
          {changedCount ? `${changedCount} 項目を変更` : "変更なし"}
        </span>
      </div>

      <div className="panel-bd">
        <label className="row" style={{ gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={inPlace} disabled={hasPayment}
                 onChange={(e) => setInPlace(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <b>直接編集</b>（改訂にせず、その場で書き換える。種類と計算方式も変えられる）
            <small className="faint" style={{ display: "block" }}>
              {hasPayment
                ? "支払が立っている条件は直接編集できません。支払を取り消すか、改訂で直してください"
                : "台帳の整理用。決定済みの文書は焼き付いた値のまま残るので、金額を変えると「金額の取り残し」に出ます"}
            </small>
          </span>
        </label>
        <div className={willRevise || later ? "note warn" : "note"} style={{ marginBottom: 12 }}>
          {inPlace
            ? <>直接編集です。実績が {detail.events.length} 件あっても<b>改訂にせず、この条件をその場で書き換えます</b>。
                条件番号は変わりません。</>
            : later
            ? <>適用開始日が先なので、保存すると<b>{effectiveFrom} から効く改訂として予約します</b>。
                いまの版はその日まで生きたままで、集計にも計算書にも今までどおり使われます。
                当日になると自動で切り替わります（人が押す必要はありません）。</>
            : willRevise
            ? <>この条件には実績が {detail.events.length} 件あります。保存すると
                <b>旧版を残したまま新版を作ります（改訂）</b>。条件番号が新しくなり、
                いまの版は「差し替え済み」になります。過去の計算書は旧版を指したままです。</>
            : <>実績がまだ無いので、保存すると<b>その場で書き換えます</b>。
                実績が付いたあとは、同じ操作が改訂（新版の作成）になります。</>}
        </div>

        {/* 初版の利用許諾料を報酬として払う形に直すときの手順ナビ（委託料・取得側の利用許諾のとき）。 */}
        {detail.direction === "in" && (kindNow === "service" || kindNow === "license") && (
          <InLieuGuide detail={detail} v={v} set={set} pm={pm} hasPayment={hasPayment} chooseInLieu={chooseInLieu} onOpenCondition={onOpenCondition} />
        )}

        {/* 並びは登録のフォームと同じ。 */}
        <div className="form-grid">
          <div className="form-section"><b>① 何の条件か</b><small>条件名・種類・相手先・作品。向きは変えられません</small></div>
          {field("name", "条件名")}
          {fixed("向き", detail.direction === "in" ? "IN 取得（費用側）" : "OUT 許諾（収入側）",
            "向きは変えられません。逆向きなら新しい条件を作ってください")}
          {inPlace
            ? <label className="field">
                <span>種類</span>
                <select value={v.kind} onChange={(e) => set("kind", e.target.value)}>
                  {(["license", "product", "service", "expense", "fee"] as const).map((k) => (
                    <option key={k} value={k}>{CONDITION_KIND_LABEL[k] ?? k}</option>
                  ))}
                </select>
                <small className="faint">案件で使える種類の範囲だけ通ります</small>
              </label>
            : fixed("種類", CONDITION_KIND_LABEL[detail.kind] ?? detail.kind,
                "種類は案件の取引モデルと結びついているので変えられません（直接編集なら変えられます）")}
          <label className="field">
            <span>相手先</span>
            <SearchSelect value={v.counterpartyId} search={searchParties}
                          valueLabel={detail.counterparty?.name ?? null}
                          placeholder="取引先名・コードで探す"
                          onChange={(id) => set("counterpartyId", id)} />
            <small className="faint">付け替えても、この条件を出した文書や過去の支払は書き換わりません</small>
          </label>
          <label className="field">
            <span>作品</span>
            <SearchSelect value={v.workId} emptyLabel="—"
                          options={works.map((w) => ({ value: String(w.id), label: w.title }))}
                          valueLabel={detail.work?.title ?? null}
                          placeholder="作品名で探す"
                          onChange={(id) => set("workId", id)} />
          </label>
          {/* まず権利の帰属先、次に支払の形。ここで分岐してから金額の欄に進む。 */}
          {(kindNow === "service" || kindNow === "product") && (
            <label className="field" id="f-deliverableOwnership">
              <span>成果物の権利の帰属先</span>
              <select value={v.deliverableOwnership} onChange={(e) => set("deliverableOwnership", e.target.value)}>
                <option value="">—</option>
                <option value="orderer">発注者（譲渡型）：権利は当社に移る</option>
                <option value="contractor">受注者（利用許諾型）：権利は相手に残り、当社は許諾を受ける</option>
              </select>
              <small className="faint">発注書の明細に出る。ここで③の「支払の形」の選択肢が変わる</small>
            </label>
          )}
          <div className="form-section"><b>② 期間・納期</b><small>契約期間（開始・終了）と納期は別。終了日があると自動更新の欄が出ます</small></div>
          {field("termStart", "開始", { type: "date" })}
          {field("termEnd", "終了", { type: "date", hint: "空欄は期限なし" })}
          {/* 納期は契約期間の終了日とは別。許諾の終了日は許諾がいつまで有効かで、
              納期ではない。発注書の「納期」はこちらを先に見る。 */}
          {field("deliveryDue", "納期", { type: "date",
            hint: "いつまでに納めてもらうか。契約期間の終了日とは別" })}
          {/*
            自動更新（A-039）。更新した回数は持たず、終了日・単位・基準日から
            数える。止めたい日が来たら「更新を止めた日」を入れる。
          */}
          {v.termEnd.trim() !== "" && (
            <label className="field">
              <span>自動更新</span>
              <select value={v.autoRenew} onChange={(e) => set("autoRenew", e.target.value)}>
                <option value="">しない</option>
                <option value="1">する</option>
              </select>
              <small className="faint">
                終了日が来るたびに自動で更新したことにする。条件書には「更新 n 回」と出る
              </small>
            </label>
          )}
          {v.termEnd.trim() !== "" && v.autoRenew === "1" && (<>
            {field("renewMonths", "更新の単位（月）", { type: "number", hint: "12 = 1年。空なら1年" })}
            {field("renewStoppedOn", "更新を止めた日",
              { type: "date", hint: "入れるとその日で回数が止まる（いまの期間は満了まで有効）" })}
          </>)}
          <div className="form-section"><b>③ 金額の決め方</b><small>通貨・計算方式と、その方式に要る金額。金額は最小通貨単位（JPY は円）</small></div>
          {kindNow === "service" && (() => {
            // 支払の形（帰属先で分岐）。いまの値から読み、選ぶと計算方式・報酬名を入れる。
            const lic = v.deliverableOwnership === "contractor";
            const current = lic
              ? (v.rewardLabel === IN_LIEU_REWARD_LABEL ? "in_lieu" : "fixed")
              : (v.pricingModel || "fixed");
            const options: Array<[string, string, string]> = lic
              ? [["fixed", "委託報酬（固定額）", "利用許諾料の扱い（別途／含む）は利用許諾の条件で決める"],
                 ["in_lieu", "初版の利用許諾料を報酬として払う", "仮計算 → 納品後 60 日以内に確定。報酬名が「初版利用許諾料」になる"]]
              : [["fixed", "固定額（納品ごと）", ""], ["unit_rate", "単価 × 数量", ""], ["subscription", "定期払い", "毎月・毎期の 1 回あたり"],
                 ["revenue_rate", "売上連動（インセンティブ報酬）", "料率で計算"]];
            const choose = (key: string) => {
              if (lic) {
                if (key === "in_lieu") chooseInLieu();
                else if (v.rewardLabel === IN_LIEU_REWARD_LABEL) set("rewardLabel", "");
              } else if (inPlace) set("pricingModel", key);
            };
            return (
              <div className="field wide" id="f-payScheme">
                <span>支払の形（{lic ? "受注者帰属：利用許諾型" : "発注者帰属：譲渡型"}）</span>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {options.map(([key, label, hint]) => (
                    <button key={key} type="button" className="chip" aria-pressed={current === key} title={hint || undefined}
                            disabled={!lic && !inPlace && key !== current}
                            onClick={() => choose(key)}>{label}</button>
                  ))}
                </div>
                <small className="faint">
                  {lic
                    ? "受注者帰属の成果物は、利用許諾の条件（許諾料の扱い・クレジット・再許諾）を別の条件『利用許諾』で持ちます（上の手順ナビの「関連する条件」から開けます）"
                    : inPlace ? "選ぶと計算方式が入る（下で直せる）" : "計算方式を変えるには「直接編集」にする（改訂では変えられない）"}
                </small>
                {lic && current === "in_lieu" && <InLieuServiceBlock v={v} set={set} pm={pm} field={field} />}
              </div>
            );
          })()}
          <label className="field">
            <span>通貨</span>
            <select value={v.currency} onChange={(e) => set("currency", e.target.value)}>
              {["JPY", "USD", "EUR"].concat(["JPY", "USD", "EUR"].includes(detail.currency) ? [] : [detail.currency])
                .map((c) => <option key={c} value={c}>{c === "JPY" ? "JPY 円" : c}</option>)}
            </select>
            <small className="faint">
              {v.currency !== detail.currency
                ? "金額（単価・定額・MG/AG）はそのままの数字で新しい通貨として読まれる。必要なら一緒に直す"
                : "実績や支払が付く前だけ変えられる。金額の意味が変わるため"}
            </small>
          </label>
          {inPlace
            ? <label className="field">
                <span>計算方式</span>
                <select value={v.pricingModel} onChange={(e) => set("pricingModel", e.target.value)}>
                  {Object.entries(PRICING_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <small className="faint">定額なら定額の金額、単価×数量なら単価、料率なら料率を一緒に入れてください</small>
              </label>
            : fixed("計算方式", PRICING_LABEL[detail.pricingModel] ?? detail.pricingModel,
                "計算方式は変えられません。変えると過去の計算根拠が変わるので、新しい条件を作ってください（直接編集なら変えられます）")}

          {/*
            * 単価・個数は計算方式によらず出す。これまで単価は「単価×数量」の
            * 条件にしか出ておらず、個数はどこにも無かった。そのため発注書や
            * 検収書を作るたびに人が明細へ打ち直すことになり、経理提出用の
            * 単価の列も空のままだった。条件が持てば、紙にも帳票にも流れる。
            */}
          {pm !== "revenue_rate" && (<>
            {field("unitAmount", "単価（最小通貨単位）", { type: "number",
              hint: `${minorUnitHint(detail.currency)}　いまの値 ${money(detail.unitAmount, detail.currency)}` })}
            {field("quantity", "個数", { type: "number",
              placeholder: "1", hint: "小数も入る（0.5人月など）。単価×個数が定額に入る" })}
          </>)}
          {pm === "revenue_rate" &&
            field("ratePct", "料率（%）", { type: "number", hint: `小数で入れる。いまの値 ${rate(detail.ratePpm)}` })}
          {pm !== "revenue_rate" &&
            // 定期課金はこの欄が「1回あたり」。登録の画面と呼び方を揃える。
            field("flatAmount",
              pm === "subscription"
                ? "1回あたりの金額（最小通貨単位）" : "定額（最小通貨単位）",
              { type: "number",
              hint: computedFlat === null
                ? `${minorUnitHint(detail.currency)}　いまの値 ${money(detail.flatAmount, detail.currency)}`
                : `単価×個数 = ${computedFlat.toLocaleString("ja-JP")}。直せば手の値が勝つ` })}

          {/* 取得側（IN）の許諾条件にも出す：保証利用許諾料（A-075）は AG で持つ。 */}
          {(detail.direction === "out" || kindNow === "license") && (<>
            {field("mgAmount", "MG 最低保証", { type: "number",
              hint: "毎期独立の下限。消化しないので残高を持たない" })}
            {field("agAmount", "AG 前払保証", { type: "number",
              hint: detail.balance
                ? `消化済み ${money(detail.balance.agConsumed, detail.currency)}／残 ${money(detail.balance.agRemaining, detail.currency)}`
                : "累積で充当する。消化しきるまで実額が出ない" })}
          </>)}
          <label className="field">
            <span>税区分</span>
            <select value={v.taxCategory} onChange={(e) => set("taxCategory", e.target.value)}>
              <option value="taxable">課税</option>
              <option value="reduced">軽減</option>
              <option value="exempt">非課税</option>
              <option value="included">税込（海外・内税）</option>
            </select>
          </label>
          {kindNow === "license"
            ? <div className="form-section"><b>⑥ 利用許諾の条件</b><small>利用形態・許諾料の扱い・独占性・クレジット表記・地域と言語。発注書の「利用許諾条件」と条件書に出ます</small></div>
            : v.deliverableOwnership === "contractor"
            ? <div className="form-section"><b>⑥ 利用許諾の条件 — この条件では持ちません</b><small>受注者帰属の成果物の利用許諾（許諾料の扱い・クレジット表記・再許諾・地域と言語）は、別の条件『利用許諾』で持ちます。作品 × 構成要素 × 利用形態で 1 本。上の手順ナビの「関連する条件」から開けます</small></div>
            : null}
          {kindNow === "license" && (
            <label className="field">
              <span>利用形態</span>
              <select value={v.usageType} onChange={(e) => set("usageType", e.target.value)}>
                <option value="">—</option>
                {/* OUT（許諾先）は当社が相手に出す形。「自社製造・自社販売」は IN 専用。 */}
                {CONDITION_USAGE_TYPES.filter((u) => detail.direction === "in" || u.value !== "in_house")
                  .map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
              <small className="faint">
                {detail.direction === "in"
                  ? "条件書の行・計算書の製品名はこれで決まる。1本に1つ"
                  : "再許諾の実績はこの形の許諾先にしか付かない。作品画面の一覧にもこれが出る"}
              </small>
            </label>
          )}
          {kindNow === "license" && detail.direction === "in" && (v.usageType === "sublicense" || v.usageType === "oem") && (
            <label className="field">
              <span>対象の許諾先</span>
              <SearchSelect value={v.targetPartyId} search={searchParties}
                            placeholder="空なら一律（その作品の許諾先すべてに効く）"
                            emptyLabel="（一律：対象の許諾先を外す）"
                            valueLabel={detail.targetParty?.name ?? null}
                            onChange={(id) => set("targetPartyId", id)} />
              <small className="faint">
                {v.targetPartyId
                  ? "許諾先専用：この許諾先の報告だけがこの料率。一律の条件からはこの許諾先が外れる"
                  : "一律：この作品の許諾先すべてに効く。特定の許諾先だけ料率が違う契約のときだけ選ぶ"}
              </small>
            </label>
          )}
          {isSublicensingUsage(v.usageType) && (
            <label className="field">
              <span>再許諾ごとの別途合意</span>
              <select value={v.sublicenseConsent}
                      onChange={(e) => set("sublicenseConsent", e.target.value)}>
                <option value="">—</option>
                <option value="covered">不要（本条件書で許諾済み）</option>
                <option value="required">要（再許諾先ごとに別途合意）</option>
              </select>
              <small className="faint">出版条件書の翻訳版の欄と本文（第4条）に出る</small>
            </label>
          )}
          {kindNow === "license" && detail.direction === "in" && (
            <label className="field" id="f-licenseFeeBasis">
              <span>許諾料の扱い</span>
              <select value={v.licenseFeeBasis}
                      onChange={(e) => set("licenseFeeBasis", e.target.value)}>
                <option value="separate">別途（料率・額で定める）</option>
                <option value="included">業務委託報酬に含む（追加の許諾料なし）</option>
                <option value="free">無償</option>
                <option value="in_lieu">初版の利用許諾料を委託報酬として支払済み（2 版目以降がこの料率）</option>
              </select>
              <small className="faint">発注書の利用許諾条件の「料率・額」に出る（A-048）。「初版…支払済み」は初版分を委託料の行で払い、計算書の対象は 2 版目以降（A-077）</small>
            </label>
          )}
          {kindNow === "license" && detail.direction === "in" && (
            <label className="field" id="f-creditNotice">
              <span>クレジット表記</span>
              <select value={v.creditFromWork} onChange={(e) => set("creditFromWork", e.target.value)}>
                <option value="1">作品のクレジット表記を引用（文書を作る日時点の表記）</option>
                <option value="">この条件の文言を使う</option>
              </select>
              <textarea rows={2} value={v.creditNotice} onChange={(e) => set("creditNotice", e.target.value)}
                        placeholder={v.creditFromWork ? "（作品に表記が無いときの控え）" : "© 2026 著作者名／イラスト：◯◯"} />
              <small className="faint">発注書の利用許諾条件の下と特約に出る（A-076）</small>
            </label>
          )}
          {kindNow === "license" && detail.direction === "in" && v.licenseFeeBasis === "in_lieu" && (<>
            {field("royaltyExemptFirstCopies", "初版の非加算部数（献本・見本等）", { type: "number",
              placeholder: "0", hint: "初版利用許諾料の算定方法に「− ○部」として明記される。空・0 なら全部数（A-077）" })}
            {field("royaltyExemptLaterPct", "非加算：2 版目以降（発行部数の %）", { type: "number",
              placeholder: "1", hint: "献本等。空なら非加算なし" })}
            {field("firstEditionPrice", "初版の本体価格（税抜・最小通貨単位）", { type: "number",
              placeholder: "1000", hint: "発注時は見込み、確定したら確定値に直す。特約第2項と明細の算定の基礎に出る（A-077）" })}
            {field("firstEditionCopies", "初版発行部数", { type: "number",
              placeholder: "3000", hint: "発注時は見込み、確定したら確定値に直す" })}
            {field("firstEditionRatePct", "初版の料率（%）", { type: "number",
              placeholder: "10", hint: "初版利用許諾料の料率。2 版目以降の料率（上の料率）とは別" })}
            {field("confirmWithinDays", "確定の期限（受領後 ○ 日）", { type: "number",
              placeholder: "45", hint: "本体価格・初版部数を書面で通知し乙の確認を得る期限。60 日以内" })}
            <div className="field wide">
              <span className="faint">
                仮計算額：{(() => {
                  const fee = firstEditionFee({ price: Number(v.firstEditionPrice) || 0, copies: Number(v.firstEditionCopies) || 0,
                    ratePct: Number(v.firstEditionRatePct) || 0, exemptCopies: Number(v.royaltyExemptFirstCopies) || 0 });
                  return fee > 0 ? `¥${fee.toLocaleString("ja-JP")}（委託料の行の合計と同じ額にする）` : "本体価格・部数・料率を入れると出ます";
                })()}
              </span>
            </div>
          </>)}
          {kindNow === "license" && (
            <label className="field">
              <span>独占性</span>
              <select value={v.exclusivity} onChange={(e) => set("exclusivity", e.target.value)}>
                <option value="">—</option>
                <option value="exclusive">独占</option>
                <option value="non_exclusive">非独占</option>
              </select>
            </label>
          )}
          {kindNow === "license" && (<>
            {field("regions", "地域（許諾範囲）", { type: "regions", wide: true,
              hint: "何も選ばなければ無制限（全世界）。媒体・チャネルは下の「権利の範囲」で" })}
            {field("languages", "言語（許諾範囲）", { type: "languages", wide: true })}
          </>)}
          <div className="form-section"><b>④ 支払</b><small>支払条件（文）と、何回払うかの決まり。予定明細はここから回ります</small></div>
          {detail.usageType === "pub_digital" && (
            <div className="field wide">
              <span>電子書籍の集計のしかた</span>
              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <select value={cyc.cycle} aria-label="集計のしかた"
                        onChange={(e) => { const c = e.target.value as DigitalCycle; applyCycle({ ...DIGITAL_CYCLE_DEFAULTS[c] }); }}>
                  {DIGITAL_CYCLES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <select value={cyc.startMonth} aria-label="最初の集計期間の開始月"
                        onChange={(e) => applyCycle({ ...cyc, startMonth: Number(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 月始まり</option>)}
                </select>
                <select value={cyc.payMonth} aria-label="支払月"
                        onChange={(e) => applyCycle({ ...cyc, payMonth: Number(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 月払い</option>)}
                </select>
                <select value={String(cyc.payDay ?? "end")} aria-label="支払日"
                        onChange={(e) => applyCycle({ ...cyc, payDay: (e.target.value === "end" ? "end" : Number(e.target.value)) as PayDay })}>
                  {PAY_DAYS.map((d) => <option key={String(d)} value={String(d)}>{payDayLabel(d)}</option>)}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => applyCycle(cyc)}>支払条件と決済の型に入れる</button>
              </div>
              <small className="faint">
                {readCycle ? `いまの支払条件は「${DIGITAL_CYCLES.find((c) => c.value === readCycle.cycle)?.label}」と読めます。` : "いまの支払条件は集計のしかたとして読めません。"}
                支払月は最初の集計期間の分（{payScheduleText(cyc)}）。選び直すと下の支払条件の文と決済の型（期間で決まる・周期）が入れ替わります。出版条件書の支払の表と計算書の回はこの文に連動します
              </small>
            </div>
          )}
          <label className="field">
            <span>支払条件</span>
            <input list="payment-terms-presets" value={v.paymentTerms}
                   placeholder="月末締め翌月末払い など"
                   onChange={(e) => set("paymentTerms", e.target.value)} />
            <datalist id="payment-terms-presets">
              {PAYMENT_TERMS_PRESETS_JA.map((f) => <option key={f} value={f} />)}
              {PAYMENT_TERMS_PRESETS_EN.map((f) => <option key={f} value={f} />)}
            </datalist>
            <small className="faint">
              予定明細の支払期日はここから出す。海外の相手なら英語の定型文（Net 30 など）を選ぶ。契約形式（請負）はひとつ上の欄へ
            </small>
          </label>
          <label className="field">
            <span>決済の型（支払の回数）</span>
            <select value={v.settlementMode} onChange={(e) => set("settlementMode", e.target.value)}>
              <option value="">未設定（予定明細から推す）</option>
              {SETTLEMENT_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <small className="faint">
              {SETTLEMENT_MODE_OPTIONS.find((o) => o.value === v.settlementMode)?.hint
                ?? "この取引は何回払うものか。予定明細はこの決まりの中で回る"}
            </small>
          </label>
          {v.settlementMode === "fixed_count" && field("settlementCount", "回数", {
            type: "number", placeholder: "3", hint: "2 回以上。増やすときは改訂で" })}
          {v.settlementMode === "term_bound" && (
            <label className="field">
              <span>周期</span>
              <select value={v.settlementCycle} onChange={(e) => set("settlementCycle", e.target.value)}>
                <option value="">—</option>
                {SETTLEMENT_CYCLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <small className="faint">契約期間 ÷ 周期 が回数になる。期間を延ばせば回が増える</small>
            </label>
          )}
          {(v.settlementMode === "open" || v.settlementMode === "term_bound") && field("settlementGraceDays", "終了後の猶予（日）", {
            type: "number", placeholder: String(SETTLEMENT_GRACE_DAYS_DEFAULT),
            hint: `終了日の後いつまで回を立ててよいか。空なら ${SETTLEMENT_GRACE_DAYS_DEFAULT} 日` })}
          {(v.pricingModel === "revenue_rate" || v.timeSettlement === "1"
            || v.usageType === "sublicense" || v.usageType === "oem") && field("reportDueDays", "報告期限（締めから何日）", {
            type: "number", placeholder: "30",
            hint: "売上報告・月次報告が締めから何日で来るはずか。過ぎると支払文書で督促の対象になる。空なら 30 日" })}
          <div className="form-section"><b>⑤ 成果物・発注書に出るもの</b><small>仕様・契約形式・成果物の帰属先・報酬名。発注書・検収書の明細はここから出ます</small></div>
          {field("spec", "仕様・成果物", { type: "textarea",
            placeholder: "カラーイラスト1点（表紙用）、A4 相当 など",
            hint: "発注書・検収書の明細の「仕様・成果物」にそのまま出る" })}
          {field("orderNo", "発注番号（外部）", {
            placeholder: "ARC-PO-2025-0123",
            hint: "V1・V2 や紙で出した発注書の番号。検収書の発注番号に出る。V3 で発注書を出したらそちらが優先される" })}
          {kindNow === "service" && field("rewardLabel", "報酬名（上書き）", {
            placeholder: "初版利用許諾料",
            hint: "発注書・検収書の金額欄の小さな行に出る。初版の利用許諾料を報酬として払う発注なら「初版利用許諾料」。空なら計算方式と帰属先から導く（A-077）" })}
          <label className="field">
            <span>契約形式</span>
            <input list="contract-forms" value={v.contractForm}
                   placeholder="請負 / 委任 など"
                   onChange={(e) => set("contractForm", e.target.value)} />
            <datalist id="contract-forms">
              {CONTRACT_FORMS.map((f) => <option key={f} value={f} />)}
              {CONTRACT_FORMS_EN.map((f) => <option key={f} value={f} />)}
            </datalist>
            <small className="faint">
              発注書・検収書の「契約種別」に出る。一覧に無い形は直接書ける（海外版は英語で）
            </small>
          </label>
          {/* 準委任の時間精算（A-073）。委託料だけ。契約形式が準委任のときに出す（他の形式でも付けてあれば出す）。 */}
          {kindNow === "service" && (isQuasiMandate(v.contractForm) || v.timeSettlement === "1") && (
            <label className="field">
              <span>精算の仕方（準委任）</span>
              <select value={v.timeSettlement} onChange={(e) => set("timeSettlement", e.target.value)}>
                <option value="">固定額・成果物で精算（検収書）</option>
                <option value="1">時間精算：月間包括枠と実績時間で精算（役務提供完了通知書）</option>
              </select>
              <small className="faint">
                {v.timeSettlement === "1"
                  ? "枠までは定額、超過は超過単価 × 時間。決済文書は検収書ではなく役務提供完了通知書になる"
                  : "成果物や固定額で精算するなら従来どおり検収書"}
              </small>
            </label>
          )}
          {kindNow === "service" && v.timeSettlement === "1" && (<>
            {field("hoursIncluded", "月間包括枠（時間）", { type: "number", placeholder: "64",
              hint: "この時間までは定額（上の定額の欄が月額）。コアタイム" })}
            {field("overageUnitAmount", "超過単価（1 時間あたり・最小通貨単位）", { type: "number", placeholder: "3125",
              hint: "枠を超えた時間 × 超過単価 を追加精算" })}
            {field("shortfallUnitAmount", "控除単価（1 時間あたり・最小通貨単位）", { type: "number",
              hint: "未消化の時間 × 控除単価 を減額。空なら未消化でも減額しない" })}
          </>)}
          <div className="form-section"><b>⑦ 備考</b><small>台帳の控え。発注書・検収書には出ません（明細に出すものは ⑤ の仕様へ）</small></div>
          {field("notes", "備考", { type: "textarea", wide: true })}

          <label className="field wide">
            <span>この変更の適用開始日</span>
            <input type="date" value={effectiveFrom}
                   onChange={(e) => setEffectiveFrom(e.target.value)} />
            <small className="faint">
              契約変更で「2027-04-01 から料率が変わる」ときは、その日を入れます。
              契約期間そのものは動きません。空欄なら今日から効きます。
              {detail.effectiveFrom && `　いまの版は ${detail.effectiveFrom} から適用中`}
            </small>
          </label>
        </div>

        {error && <div className="alert">{error}</div>}

        <div className="row">
          <button className="btn primary" disabled={busy || !changedCount}
                  onClick={() => void save()}>
            {busy ? "保存中…" : inPlace ? "直接書き換えて保存"
              : later ? `${effectiveFrom} からの改訂を予約`
              : willRevise && Object.keys(patch).length ? "改訂して保存" : "保存する"}
          </button>
          <button className="btn" onClick={onCancel} disabled={busy}>やめる</button>
          {!changedCount && <span className="faint">変更された項目がありません</span>}
        </div>
      </div>
    </div>
  );
}

/** 仕様の末尾の「算定の基礎（見込み）：…」の行を差し替える（無ければ足す）。 */
function withBasisLine(spec: string, line: string | null): string {
  const kept = spec.split(/\r?\n/).filter((l) => !l.startsWith("算定の基礎")).join("\n").replace(/\n+$/, "");
  if (!line) return kept;
  return kept ? `${kept}\n${line}` : line;
}

/**
 * 委託料の行で「初版の利用許諾料を報酬として払う」を選んだときに、チップの直下に出すブロック（A-083）。
 *
 * 選んでも報酬名が ⑤ で変わるだけで、画面の見える範囲では何も起きなかった。発注書をモックの
 * 見え方にするには 見込み価格 × 部数 × 料率 の仮計算額が行の金額に入っていることが要るので、
 * ここで入れさせ、金額と仕様の「算定の基礎」の行を自動で合わせる。算定の基礎はこの条件にも保存する
 * （紙の利用許諾条件にも同じ値を入れる。発注書の特約はそちらから読む）。
 */
function InLieuServiceBlock(
  { v, set, pm, field }:
  { v: Record<string, string>; set: (name: string, value: string) => void; pm: string;
    field: (name: string, label: string, extra?: { type?: string; hint?: string; wide?: boolean; placeholder?: string }) => ReactElement }
) {
  const num = (x: string) => Number(String(x ?? "").replace(/[^0-9.-]/g, "")) || 0;
  const fe = { price: num(v.firstEditionPrice), copies: Math.floor(num(v.firstEditionCopies)), ratePct: num(v.firstEditionRatePct),
               exemptCopies: Math.floor(num(v.royaltyExemptFirstCopies)) };
  const ok = fe.price > 0 && fe.copies > 0 && fe.ratePct > 0 && fe.exemptCopies >= 0 && fe.exemptCopies < fe.copies;
  const provisional = ok ? firstEditionFee(fe) : 0;
  const basis = ok ? firstEditionBasisText(fe, "見込み") : null;
  const amount = pm === "unit_rate" ? num(v.unitAmount) * (num(v.quantity) || 1) : num(v.flatAmount);
  // 仮計算額が出たら、金額と仕様の算定の基礎を合わせる（人が金額を別に打っても、この形では仮計算額と同じ額にする決まり）。
  useEffect(() => {
    if (!ok || provisional <= 0) return;
    // 定額でも 単価＝仮計算額・個数 1 を揃える。単価 0 のまま残ると発注書の行が「単価 ¥0」と刷られる。
    if (amount !== provisional || num(v.unitAmount) !== provisional) {
      set("quantity", "1"); set("unitAmount", String(provisional));
      if (pm !== "unit_rate") set("flatAmount", String(provisional));
    }
    const next = withBasisLine(v.spec ?? "", basis);
    if (next !== (v.spec ?? "")) set("spec", next);
  }, [ok, provisional, amount, basis, pm]);
  const checks: Array<[boolean, string]> = [
    [v.rewardLabel === IN_LIEU_REWARD_LABEL, "報酬名「初版利用許諾料」（⑤）"],
    [pm === "fixed", pm === "fixed" ? "計算方式 定額" : "計算方式 定額（支払が立っているので変えられない。新しい条件を『業務委託（発注）』で作る）"],
    [ok && amount === provisional, ok ? `金額 ＝ 仮計算額 ¥${provisional.toLocaleString("ja-JP")}` : "金額 ＝ 仮計算額（下の 3 つを入れると入る）"],
    [Boolean(basis) && String(v.spec ?? "").includes("算定の基礎"), "仕様の末尾に「算定の基礎（見込み）」の行（⑤）"],
    [Boolean(v.deliveryDue), "納期（②）。支払期日は受領から 60 日以内"],
    [num(v.confirmWithinDays) >= 1 && num(v.confirmWithinDays) <= 60, "確定の期限（60 日以内）"]
  ];
  return (
    <div className="note" style={{ marginTop: 8 }}>
      <b>この選択で変わること</b>
      <ul style={{ margin: "4px 0 8px 18px" }}>
        {checks.map(([done, label]) => <li key={label}>{done ? "✓" : "□"} {label}</li>)}
      </ul>
      <b>初版の算定の基礎（見込み）</b>
      <span className="faint">　仮計算額 ＝ 本体価格 ×（初版部数 − 非加算部数）× 料率。入れると行の金額と仕様の算定の基礎に入る</span>
      <div className="form-grid" style={{ marginTop: 6 }}>
        {field("firstEditionPrice", "見込み本体価格（税抜・円）", { type: "number", placeholder: "1000" })}
        {field("firstEditionCopies", "初版発行部数", { type: "number", placeholder: "3000" })}
        {field("firstEditionRatePct", "初版の料率（%）", { type: "number", placeholder: "10" })}
        {field("royaltyExemptFirstCopies", "初版の非加算部数", { type: "number", placeholder: "0", hint: "既定 0。入れると算定方法に「− ○部」と明記" })}
        {field("confirmWithinDays", "確定の期限（受領後 ○ 日）", { type: "number", placeholder: "45", hint: "60 日以内" })}
        <div className="field">
          <span>仮計算額</span>
          <b style={{ fontSize: "1.1em" }}>{ok ? `¥${provisional.toLocaleString("ja-JP")}` : "—"}</b>
          <small className="faint">{basis ?? "本体価格・部数・料率を入れると出ます"}</small>
        </div>
      </div>
      <small className="faint">
        保存後：「予定」に 1 回（締め＝納期、支払日＝受領から 60 日以内、金額＝この額）を立て、紙の利用許諾条件の
        許諾料の扱いを「初版…支払済み」にして同じ算定の基礎を入れる（上の手順ナビ）。決定済みの発注書は訂正版を起こす。
      </small>
    </div>
  );
}

/**
 * 手順ナビ：初版の利用許諾料を報酬として払う形（A-077）に、既存の条件を直すとき。
 *
 * 編集画面は欄が多く、「どの条件のどの欄を、どの順に」が分からなかった。委託料の行と
 * 利用許諾条件（紙・電子）で手順が違うので、開いている条件の種類に合わせて並べ、
 * いまの入力値から済み／未を出す。「入れる」は既定値を欄に入れるだけ（保存は下のボタン）。
 * 関連する条件（同じ相手先・作品の委託料／利用許諾）は一覧して開ける。
 */
function InLieuGuide(
  { detail, v, set, pm, hasPayment, chooseInLieu, onOpenCondition }:
  { detail: ConditionDetail; v: Record<string, string>; set: (name: string, value: string) => void;
    /** いま画面に出ている計算方式（直接編集なら入力値、改訂なら保存値）。金額の欄はこれで決まる。 */
    pm: string; hasPayment: boolean; chooseInLieu: () => void;
    onOpenCondition?: (id: number) => void }
) {
  const [open, setOpen] = useState<boolean>(
    detail.kind === "license" ? detail.licenseFeeBasis === "in_lieu" : detail.rewardLabel === IN_LIEU_REWARD_LABEL);
  type Sibling = { id: number; conditionNo: string | null; name: string; kind: string; status: string; work: { id: number } | null };
  const [siblings, setSiblings] = useState<Sibling[] | null>(null);
  useEffect(() => {
    if (!open || !detail.counterparty) return;
    let alive = true;
    api.get<{ conditions: Sibling[] }>(`/conditions?counterpartyId=${detail.counterparty.id}&direction=in`)
      .then((r) => { if (alive) setSiblings(r.conditions.filter((c) => c.id !== detail.id && ["active", "draft", "scheduled"].includes(c.status)
        && (!detail.work || !c.work || c.work.id === detail.work.id))); })
      .catch(() => { if (alive) setSiblings([]); });
    return () => { alive = false; };
  }, [open, detail.id, detail.counterparty?.id, detail.work?.id]);
  /** 欄へ飛ぶ。計算方式や支払の形によって出ていない欄なら、次の候補（最後は「支払の形」）へ飛ぶ。 */
  const jump = (...ids: string[]) => {
    const el = [...ids, "payScheme"].map((id) => document.getElementById(`f-${id}`)).find((e): e is HTMLElement => Boolean(e));
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el?.querySelector("input, select, textarea, button") as HTMLElement | null)?.focus();
  };
  const num = (s: string) => Number(String(s ?? "").replace(/[,，]/g, "")) || 0;
  // 金額は画面に出ている計算方式で読む。料率（売上連動）のままなら定額の欄が無いので 0。
  const amount = pm === "unit_rate" ? num(v.unitAmount) * (num(v.quantity) || 1) : pm === "revenue_rate" ? 0 : num(v.flatAmount);
  const fe = { price: num(v.firstEditionPrice), copies: Math.floor(num(v.firstEditionCopies)), ratePct: num(v.firstEditionRatePct),
               exemptCopies: Math.floor(num(v.royaltyExemptFirstCopies)) };
  const provisional = firstEditionFee(fe);
  const schemeDone = v.rewardLabel === IN_LIEU_REWARD_LABEL && pm === "fixed";
  const basisLine = fe.price > 0 && fe.copies > 0 && fe.ratePct > 0 ? firstEditionBasisText(fe) : null;
  const Step = ({ done, title, hint, acts }: { done: boolean; title: string; hint?: string; acts?: React.ReactNode }) => (
    <li className={done ? "done" : ""}>
      <span className="mark">{done ? "✓" : ""}</span>
      <span className="body">{title}{acts && <span className="acts">{acts}</span>}{hint && <small>{hint}</small>}</span>
    </li>
  );
  const to = (...ids: string[]) => <button type="button" className="linky" onClick={() => jump(...ids)}>欄へ</button>;
  const list = (kind: "service" | "license", empty: string) => {
    const rows = (siblings ?? []).filter((c) => c.kind === kind);
    if (siblings === null) return <small>関連する条件を引いています…</small>;
    if (!rows.length) return <small>{empty}</small>;
    return <span>{rows.map((c) => (
      <span key={c.id} className="sibling">
        <span className="code">{c.conditionNo ?? `#${c.id}`}</span>{c.name}
        {onOpenCondition && <button type="button" className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>開く</button>}
      </span>))}</span>;
  };
  const isService = detail.kind === "service";
  return (
    <div className="guide">
      <div className="guide-hd">
        <b>初版の利用許諾料を報酬として払う形に直す{isService ? "（委託料の行）" : "（利用許諾条件）"}</b>
        <span className="faint">原稿・イラストの対価を、別途の制作報酬ではなく初版の利用許諾料にする運用（A-077）</span>
        <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen((o) => !o)}>
          {open ? "手順を閉じる" : "手順を見る"}
        </button>
      </div>
      {open && (isService ? (
        <ol>
          <Step done={v.deliverableOwnership === "contractor"} title="成果物の帰属先を「受注者（利用許諾型）」にする"
                acts={<>{v.deliverableOwnership !== "contractor" && <button type="button" className="btn btn-sm" onClick={() => set("deliverableOwnership", "contractor")}>受注者にする</button>}{to("deliverableOwnership")}</>} />
          <Step done={schemeDone} title="支払の形を「初版の利用許諾料を報酬として払う」にする（③）"
                hint={schemeDone ? `計算方式 定額、報酬名「${IN_LIEU_REWARD_LABEL}」`
                  : hasPayment && pm !== "fixed"
                  ? `計算方式が「${pm === "revenue_rate" ? "料率" : pm}」で、支払が立っているので変えられない。この条件は残し、『業務委託（発注）』で新しく作る`
                  : `計算方式が定額になり（直接編集に切り替わる）、報酬名が「${IN_LIEU_REWARD_LABEL}」になる。発注書の金額欄に「初版利用許諾料（仮計算。確定は特約第3項）」と出る`}
                acts={<>{!schemeDone && v.deliverableOwnership === "contractor" && !(hasPayment && pm !== "fixed")
                  && <button type="button" className="btn btn-sm" onClick={chooseInLieu}>選ぶ</button>}{to("payScheme")}</>} />
          <Step done={Boolean(basisLine) && num(v.confirmWithinDays) >= 1 && num(v.confirmWithinDays) <= 60}
                title="初版の算定の基礎を入れる：見込み本体価格・初版部数・初版の料率・非加算部数・確定の期限（③ 支払の形の下）"
                hint={basisLine ? `${basisLine} ＝ 仮計算額 ¥${provisional.toLocaleString("ja-JP")}` : "支払の形を選ぶと欄が出る。仮計算額＝本体価格 ×（初版部数 − 非加算）× 料率"}
                acts={to("firstEditionPrice")} />
          <Step done={provisional > 0 && amount === provisional} title="金額 ＝ 仮計算額（原稿とイラストの 2 行なら配分）"
                hint={provisional > 0 && amount !== provisional
                  ? `いまの金額 ¥${amount.toLocaleString("ja-JP")}。算定の基礎を入れると自動で入る。2 行に配分するときだけ手で直す（合計を仮計算額に）`
                  : "算定の基礎を入れると自動で入る。0 円にはしない（買いたたき・一方的決定の外観）"}
                acts={to(pm === "unit_rate" ? "unitAmount" : "flatAmount", "firstEditionPrice")} />
          <Step done={Boolean(v.deliveryDue)} title="納期を入れる（②）" hint="受領から 60 日以内の支払期日の起点になる" acts={to("deliveryDue")} />
          <Step done={String(v.spec ?? "").includes("算定の基礎")} title="仕様の末尾に「算定の基礎（見込み）」の 1 行（⑤）"
                hint="算定の基礎を入れると自動で書かれる。例：算定の基礎（見込み）：本体価格 1,000円（税抜）× 初版 3,000部 × 10%（発注書の明細に出る。確定時の比較の起点）"
                acts={to("spec")} />
          <Step done={false} title="保存したら「予定」に 1 回立てる：締め＝納期、支払日＝受領から 60 日以内、金額＝この行の額"
                hint="発注書の支払期日と明細の支払日はこの予定から出る" />
          <Step done={(siblings ?? []).some((c) => c.kind === "license")} title="利用許諾条件（紙・電子）を直す"
                hint="同じ相手先・作品の利用許諾条件。無ければ「条件の登録」で 種類＝許諾料・向き IN・作品を選んで紙と電子を作る"
                acts={list("license", "利用許諾条件が見つかりません")} />
          <Step done={false} title="最後に、決定済みの発注書から訂正版を起こす" hint="新しいひな形で描画され、特約が既定で入る（元の特約欄に文があればそちらが残るので、空にすると自動文に戻る）" />
        </ol>
      ) : (
        <ol>
          <Step done={v.licenseFeeBasis === "in_lieu"} title="許諾料の扱いを「初版の利用許諾料を委託報酬として支払済み」にする"
                acts={<>{v.licenseFeeBasis !== "in_lieu" && <button type="button" className="btn btn-sm" onClick={() => set("licenseFeeBasis", "in_lieu")}>入れる</button>}{to("licenseFeeBasis")}</>} />
          <Step done={num(v.ratePct) > 0} title="料率を「2 版目以降・電子」の率にする（紙 10%・電子 15% など）" hint="初版の料率は次の欄。ここは計算書が使う率" acts={to("ratePct")} />
          <Step done={fe.price > 0 && fe.copies > 0 && fe.ratePct > 0 && num(v.confirmWithinDays) > 0}
                title="初版の算定の基礎を入れる：本体価格・初版部数・初版の料率・確定の期限（紙の 1 本だけ）"
                hint={basisLine ? `${basisLine} ＝ 仮計算額 ¥${provisional.toLocaleString("ja-JP")}（委託料の行の合計と同じ額にする）` : "電子の条件には入れない（紙の条件が持つ）。許諾料の扱いを「初版…支払済み」にすると欄が出る"}
                acts={v.licenseFeeBasis === "in_lieu" ? to("firstEditionPrice") : undefined} />
          <Step done={String(v.royaltyExemptLaterPct ?? "").trim() !== ""} title="非加算：初版は 0（既定）、2 版目以降は発行部数の 1% など"
                hint="初版の非加算を入れるかは法務の確認待ち。入れると算定方法に「− ○部」と明記される"
                acts={v.licenseFeeBasis === "in_lieu" ? to("royaltyExemptLaterPct") : undefined} />
          <Step done={!num(v.agAmount) && !num(v.mgAmount)} title="MG・AG は空にする"
                hint="初版分は委託料の行で払うので、保証や前払いは持たない（持つと計算書で相殺・下限になってしまう）"
                acts={<>{(num(v.agAmount) || num(v.mgAmount)) ? <button type="button" className="btn btn-sm" onClick={() => { set("agAmount", ""); set("mgAmount", ""); }}>空にする</button> : null}{to("agAmount")}</>} />
          <Step done={v.creditFromWork === "1" || String(v.creditNotice ?? "").trim() !== ""} title="クレジット表記（作品から引用、または文言）" acts={to("creditNotice")} />
          <Step done={false} title="契約は出版基本契約に載せる" hint="付け替えは条件の画面の「契約」の欄で（この編集画面にはない）。業務委託の基本契約とは別に、出版基本契約の個別契約として扱う" />
          <Step done={(siblings ?? []).some((c) => c.kind === "service")} title="対応する委託料の行（原稿・イラスト）を直す"
                hint="同じ相手先・作品の委託料。帰属先＝受注者、金額＝仮計算額の配分、報酬名＝初版利用許諾料、納期、予定 1 回"
                acts={list("service", "委託料の行が見つかりません")} />
          <Step done={false} title="最後に、決定済みの発注書から訂正版を起こす" hint="新しいひな形で描画され、特約が既定で入る" />
        </ol>
      ))}
    </div>
  );
}
