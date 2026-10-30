import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm } from "./CreateForm.js";
import { OutConditionForm } from "./OutConditionForm.js";
import type { ServiceLinesCreated } from "./ServiceLinesForm.js";
import { createCompanionDocument, inLieuCheck, licensePayload, LicenseTermsSection, newLicenseDraft,
         type LicenseDeliverable, type LicenseDraft } from "./LicenseTermsSection.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { searchParties } from "./SearchSelect.js";
import { minorPerMajor } from "../server/royalty/economics.js";
import { CONDITION_USAGE_TYPES, isSublicensingUsage } from "../server/core/condition-usage.js";
import { CONTRACT_FORMS, CONTRACT_FORMS_EN } from "../server/conditions/contract-form.js";
import { isQuasiMandate } from "../server/conditions/time-settlement.js";
import { firstEditionFee } from "../server/conditions/royalty-in-lieu.js";
import { conditionNameFor } from "../server/conditions/naming.js";
import { PAYMENT_TERMS_PRESETS_EN, PAYMENT_TERMS_PRESETS_JA } from "../server/conditions/payment-terms.js";
import { SETTLEMENT_CYCLES, SETTLEMENT_CYCLE_LABEL, SETTLEMENT_GRACE_DAYS_DEFAULT, SETTLEMENT_MODES, SETTLEMENT_MODE_LABEL }
  from "../server/conditions/settlement-mode.js";

/** 決済の型の選択肢。見出しに短い説明を添える（どれを選ぶかで回数の決まりが変わる）。 */
export const SETTLEMENT_MODE_OPTIONS = SETTLEMENT_MODES.map((value) => ({
  value, label: SETTLEMENT_MODE_LABEL[value],
  hint: value === "once" ? "1 回で終わる（成果物ありの業務委託・買い切り）"
    : value === "fixed_count" ? "N 回と決まっている（着手・中間・納品、分割払い）"
    : value === "term_bound" ? "契約期間 × 周期で回数が決まる（顧問・保守、時限式の許諾料）"
    : "出来事のたびに回る（製造・増刷の許諾料）。終了後の猶予まで"
}));
export const SETTLEMENT_CYCLE_OPTIONS = SETTLEMENT_CYCLES.map((value) => ({ value, label: SETTLEMENT_CYCLE_LABEL[value] }));

/**
 * 金額の欄の補足。通貨で単位が変わる。
 *
 * 「最小通貨単位」と書いてあるだけでは、USD の $7.35 を 7.35 と打ってしまう。
 * 小数は保存できないので弾かれるが、何を直せばいいのかは画面から読めない
 * （実際にここで手が止まった）。通貨に合わせて例を出す。
 */
export function minorUnitHint(currency: string): string {
  const per = minorPerMajor(currency || "JPY");
  if (per === 1) return `${currency || "JPY"} は整数で入れる。¥330,000 は 330000`;
  return `${currency} は1/${per}単位。$7.35 は 735（小数は入れられません）`;
}

/**
 * 条件明細の登録フォーム。
 *
 * 条件の画面と案件の画面の両方から使う。以前は条件の画面の中に直接書いてあり、
 * 案件から新しい条件を作るには「条件の画面で作ってください」と案内して、
 * 作ってから案件に戻って繋ぎ直す往復が要った。案件を見ながら作れるようにする。
 *
 * 相手先と作品の一覧は開いたときに取りに行く（登録するときにしか要らない）。
 */

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };

/** 「1年」「6か月」を月に。空なら1年（12か月）。 */
const renewMonths = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  if (!s) return 12;
  const m = s.match(/^(\d+)(年|か月|ヶ月|カ月)?$/);
  if (!m) return 12;
  const n = Number(m[1]);
  return /年/.test(m[2] ?? "") ? n * 12 : n;
};

export function ConditionCreateForm(
  { title = "条件の登録", preset, presetLabels, onDone, onCancel, onRegisterAgreement }: {
    title?: string;
    /**
     * 分かっている項目を埋めた状態で開く。案件から作るなら相手先も
     * 条件の種類も案件が知っている。埋めないと、必須7項目を人が
     * もう一度入れることになる。
     */
    preset?: Partial<Record<
      "direction" | "kind" | "counterpartyId" | "workId" | "agreementId"
      | "currency" | "taxCategory" | "pricingModel" | "name" | "matterId", string>>;
    /** preset の検索項目の表示名。無いと「#2」と出る。 */
    presetLabels?: Partial<Record<"counterpartyId" | "workId" | "agreementId", string | null>>;
    /** 受注者帰属で委託料と利用許諾条件をまとめて作ったときは conditionIds（委託料の条件）と templateKey も返す。 */
    onDone: (created: { id: number; conditionIds?: number[]; templateKey?: string | null }) => void;
    onCancel: () => void;
    /** 相手先に締結済みの契約が無いとき、その場で契約の登録へ移る口。 */
    onRegisterAgreement?: (partyId: number) => void;
  }
) {
  /**
   * 受注者帰属の成果物の利用許諾（A-120）。帰属先で受注者を選ぶと、この画面の下に利用許諾の欄が開き、
   * 登録 1 回で委託料（請負など。納期で検収する）と利用許諾条件を両方作って対応を張る。
   * 以前は『業務委託（発注）』のフォームへ切り替えさせていて、入口が二つあり迷った。
   */
  const [lic, setLicDraft] = useState<LicenseDraft>(() => newLicenseDraft("included"));
  const setLic = (patch: Partial<LicenseDraft>) => setLicDraft((prev) => ({ ...prev, ...patch }));
  /** いまの欄の値（利用許諾の欄が金額・納期・作品を見る）と、欄を書き換える口。 */
  const [cur, setCur] = useState<Record<string, string>>({});
  const setField = useRef<((name: string, value: string) => void) | null>(null);
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  /**
   * 相手先を選んだら、その相手の締結済み契約（基本契約・単体契約）を引く。
   * 1 本なら自動で入れる。無ければ「契約を登録する／契約なしで続ける」。
   * 2 本以上なら選んでもらう。契約なしの条件が黙って増えないようにする。
   */
  const [partyFor, setPartyFor] = useState<string>("");
  const [candidates, setCandidates] = useState<Agreement[] | null>(null);
  const [noAgreement, setNoAgreement] = useState(false);
  /**
   * 許諾（OUT）は再許諾か自社製造・他社販売の相手先なので、専用のフォームで受ける。ここで向きを OUT に
   * 切り替えると、発注（IN）向けの欄が並んだまま取引形態を選べなかった。
   * 切り替えた時点の相手先・作品・契約・通貨を引き継いで差し替える。
   */
  const [outFrom, setOutFrom] = useState<Record<string, string> | null>(
    preset?.direction === "out" ? { ...preset } : null);
  useEffect(() => {
    if (!partyFor) { setCandidates(null); return; }
    let live = true;
    api.get<{ agreements: Agreement[] }>(`/parties/${partyFor}/agreements`)
      .then((r) => { if (live) setCandidates(r.agreements); })
      .catch(() => { if (live) setCandidates([]); });
    return () => { live = false; };
  }, [partyFor]);

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
    // 条件は契約（合意）の明細。どの契約の下の条件かが入っていないと、
    // 契約から条件を辿れず、計算書の契約名・契約番号も空で出る。
    api.get<{ agreements: Agreement[] }>("/agreements")
      .then((a) => setAgreements(a.agreements)).catch(() => undefined);
  }, []);

  // 受注者帰属の委託料（A-120）。金額は 定額 か 単価 × 個数。
  const contractorMode = cur.direction !== "out" && cur.kind === "service" && cur.deliverableOwnership === "contractor";
  const amountOf = (v: Record<string, string>) => v.pricingModel === "fixed" ? (Number(v.flatAmount) || 0)
    : v.pricingModel === "unit_rate" ? Math.round((Number(v.unitAmount) || 0) * (String(v.quantity ?? "").trim() ? Number(v.quantity) || 0 : 1)) : 0;
  const deliverables: LicenseDeliverable[] = contractorMode
    ? [{ label: String(cur.name ?? "").trim() || "この委託料", name: String(cur.name ?? ""), amount: amountOf(cur),
         deliveryDue: String(cur.deliveryDue ?? "") }] : [];
  const inLieu = contractorMode && lic.mode === "in_lieu";
  const check = inLieuCheck(lic, deliverables);
  const contractorBlockers = [
    !String(cur.workId ?? "").trim() ? "作品（利用許諾条件は作品にぶら下がる）" : null,
    cur.pricingModel !== "fixed" && cur.pricingModel !== "unit_rate"
      ? "計算方式（定額か単価×数量。定期払い・売上連動は『業務委託（発注）』で）" : null,
    ...(inLieu ? check.missing : [])
  ].filter((m): m is string => Boolean(m));
  const licAgreements = (candidates && candidates.length ? candidates : agreements)
    .filter((a) => !partyFor || String(a.counterparty?.id ?? "") === partyFor);
  // 初版の利用許諾料を報酬として払う：計算方式は定額、報酬名は「初版利用許諾料」、金額は仮計算額（A-077）。
  // ほかの形に戻したら報酬名を空に戻す（人が別の名前を入れていればそのまま）。
  useEffect(() => {
    const set = setField.current;
    if (!set || !contractorMode) return;
    if (inLieu) {
      if (cur.pricingModel !== "fixed") set("pricingModel", "fixed");
      if ((cur.rewardLabel ?? "") !== "初版利用許諾料") set("rewardLabel", "初版利用許諾料");
      if (check.feOk && check.provisional > 0 && String(check.provisional) !== String(cur.flatAmount ?? "")) {
        set("flatAmount", String(check.provisional));
      }
    } else if ((cur.rewardLabel ?? "") === "初版利用許諾料") {
      set("rewardLabel", "");
    }
  }, [contractorMode, inLieu, check.feOk, check.provisional, cur.pricingModel, cur.rewardLabel, cur.flatAmount]);

  /** 委託料 1 本と利用許諾条件をまとめて作る（『業務委託（発注）』と同じ口）。 */
  async function submitWithLicense(v: Record<string, string>) {
    const qty = v.pricingModel === "unit_rate" && String(v.quantity ?? "").trim() ? Number(v.quantity) : 1;
    const unit = v.pricingModel === "fixed" ? int(v.flatAmount) ?? 0 : int(v.unitAmount) ?? 0;
    const posted = await api.post<ServiceLinesCreated>("/conditions/service-set", {
      title: text(v.name) ?? "", counterpartyId: int(v.counterpartyId), agreementId: int(v.agreementId) ?? null,
      matterId: int(preset?.matterId) ?? null, workId: int(v.workId) ?? null,
      termStart: text(v.termStart) ?? null, termEnd: text(v.termEnd) ?? null,
      currency: v.currency || "JPY", taxCategory: v.taxCategory || "taxable", paymentTerms: text(v.paymentTerms) ?? null,
      contractForm: text(v.contractForm) ?? null, deliverableOwnership: "contractor",
      ...(v.timeSettlement ? {
        timeSettlement: true, hoursIncluded: Number(v.hoursIncluded) || null,
        overageUnitAmount: int(v.overageUnitAmount), shortfallUnitAmount: int(v.shortfallUnitAmount) ?? null
      } : {}),
      rows: [{
        kind: "service", name: text(v.name) ?? null, pricingModel: "unit_rate",
        unitAmount: unit, quantity: qty, unitLabel: v.pricingModel === "fixed" ? "式" : null,
        spec: text(v.spec) ?? null, notes: text(v.notes) ?? null, deliveryDue: text(v.deliveryDue) ?? null,
        contractForm: text(v.contractForm) ?? null, deliverableOwnership: "contractor",
        rewardLabel: text(v.rewardLabel) ?? null
      }],
      license: licensePayload(lic, { workId: String(v.workId ?? ""), termStart: String(v.termStart ?? "") }),
      payment: { mode: "per_delivery" }
    });
    await createCompanionDocument(lic, posted.licenseConditions.map((c) => c.id),
                                  { matterId: preset?.matterId, agreementId: String(v.agreementId ?? "") });
    const ids = posted.conditions.map((c) => c.id);
    return { id: ids[0], conditionIds: ids, templateKey: "purchase_order" };
  }

  if (outFrom) {
    const carry = (k: "workId" | "counterpartyId" | "agreementId") =>
      outFrom[k] ? { [k]: outFrom[k]! } : {};
    return (
      <div className="stack">
        <div className="note">
          許諾（OUT）は再許諾か自社製造・他社販売の相手先なので、専用のフォームで登録します。
          <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }}
                  onClick={() => setOutFrom(null)}>取得（IN）の登録に戻る</button>
        </div>
        <OutConditionForm
          preset={{ ...carry("workId"), ...carry("counterpartyId"), ...carry("agreementId"),
                    ...(outFrom.currency ? { currency: outFrom.currency } : {}),
                    ...(outFrom.name ? { name: outFrom.name } : {}) }}
          presetLabels={{
            workId: works.find((w) => String(w.id) === outFrom.workId)?.title ?? null,
            counterpartyId: outFrom.counterpartyId === preset?.counterpartyId ? presetLabels?.counterpartyId ?? null : null,
            agreementId: outFrom.agreementId === preset?.agreementId ? presetLabels?.agreementId ?? null : null
          }}
          onDone={onDone} onCancel={onCancel} />
      </div>
    );
  }

  return (
<CreateForm
      title={title}
      path="/conditions"
      submitLabel={contractorMode && lic.mode !== "none" ? "委託料と利用許諾条件を登録する" : undefined}
      blockers={contractorMode && lic.mode !== "none" ? contractorBlockers : undefined}
      submitOverride={(v) => (contractorMode && lic.mode !== "none" ? submitWithLicense(v) : null)}
      onValues={(v, set) => {
        if (v.direction === "out") { setOutFrom({ ...v }); return; }
        setField.current = set;
        setCur(v);
        // 支払の形（①）→ 計算方式（③）。受注者帰属なら支払の形は下の利用許諾の欄で選ぶ。
        if (v.kind === "service" && v.deliverableOwnership !== "contractor" && v.payScheme && v.pricingModel !== v.payScheme) {
          set("pricingModel", v.payScheme);
        }
        const party = String(v.counterpartyId ?? "");
        if (party !== partyFor) { setPartyFor(party); setNoAgreement(false); return; }
        // 候補が 1 本で、まだ何も入っていなければ自動で入れる。人が空にしたら戻さない。
        if (candidates && candidates.length === 1 && !v.agreementId && !noAgreement) {
          set("agreementId", String(candidates[0]!.id));
        }
      }}
      initial={{ direction: "in", kind: "service", pricingModel: "fixed",
                 currency: "JPY", taxCategory: "taxable", ...preset }}
      fields={[
        { name: "_s1", type: "section", label: "① 何の条件か", hint: "条件名・向き・種類・相手先・作品・契約。種類で下に出る欄が変わります" },
        // 作品に紐づく許諾（IN）は名前を打たせない。作品名｜取引モデル で付く（下の利用形態）。
        { name: "name", label: "条件名", required: true, placeholder: "◯◯の制作委託 / △△の配信許諾",
          visibleWhen: (v) => !(v.kind === "license" && v.direction === "in" && String(v.workId ?? "").trim() !== "") },
        { name: "direction", label: "向き", type: "select", required: true,
          options: [{ value: "in", label: "IN 取得（費用側）" }, { value: "out", label: "OUT 許諾（収入側）" }] },
        { name: "kind", label: "種類", type: "select", required: true,
          options: (["license", "product", "service", "expense", "fee"] as const).map((k) => ({
            value: k, label: CONDITION_KIND_LABEL[k]
          })),
          hint: "許諾料・製品はライセンスの案件、委託料・実費・手数料は業務委託の案件に繋がる" },
        // まず権利の帰属先、次に支払の形。ここで分岐してから金額の欄に進む（迷わないように）。
        { name: "deliverableOwnership", label: "成果物の権利の帰属先", type: "select",
          visibleWhen: (v) => v.kind === "service" || v.kind === "product",
          options: [{ value: "orderer", label: "発注者（譲渡型）：権利は当社に移る" }, { value: "contractor", label: "受注者（利用許諾型）：権利は相手に残り、当社は許諾を受ける" }],
          hint: (v) => v.kind === "service" && v.deliverableOwnership === "contractor"
            ? "受注者帰属：この画面の下に利用許諾の欄が開きます。登録 1 回で委託料と利用許諾条件を両方作ります"
            : "発注書の明細に出る。受注者を選ぶと利用許諾の欄が開く" },
        { name: "payScheme", label: "支払の形", type: "select",
          visibleWhen: (v) => v.kind === "service" && v.deliverableOwnership !== "contractor",
          options: [{ value: "fixed", label: "固定額（納品ごとに検収して支払）" }, { value: "unit_rate", label: "単価 × 数量" },
                    { value: "subscription", label: "定期払い（毎月・毎期の 1 回あたり）" }, { value: "revenue_rate", label: "売上連動（インセンティブ報酬）" }],
          hint: "選ぶと③の計算方式が入る（③で直せる）" },
        // 取引先は 2,500 件ある。一覧から選ばせず、名前で探して決める。
        { name: "counterpartyId", label: "相手先", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す",
          valueLabel: presetLabels?.counterpartyId ?? null },
        { name: "workId", label: "作品（許諾なら原作か、原作を兼ねる作品）", type: "search",
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          hint: "ライセンスの条件は作品にぶら下げる。ここが空だと権利の上限を計算できない" },
        // 相手先が分かっているときは、その相手先の契約だけを候補にする。
        { name: "agreementId", label: "契約（合意）", type: "search",
          valueLabel: presetLabels?.agreementId ?? null,
          options: (candidates && candidates.length ? candidates : agreements)
            .filter((a) => !partyFor || String(a.counterparty?.id ?? "") === partyFor)
            .map((a) => ({ value: String(a.id), label: a.title,
                           hint: [a.agreementNo, a.counterparty?.name].filter(Boolean).join("／") })),
          hint: (v) => !partyFor ? "相手先を選ぶと、その相手の締結済み契約を当てます"
            : candidates === null ? "契約を引いています…"
            : candidates.length === 1 && v.agreementId === String(candidates[0]!.id)
              ? `この相手の締結済み契約は 1 本なので入れました（${candidates[0]!.agreementNo ?? candidates[0]!.title}）`
            : candidates.length > 1 ? `締結済みの契約が ${candidates.length} 本あります。どちらの下に置くか選んでください`
            : candidates.length === 0 ? (noAgreement ? "契約なしで登録します。工程と契約チェックに「契約なし」と出ます"
                                                     : "この相手には締結済みの契約がありません")
            : "計算書の契約名・契約番号はここから出る" },
        { name: "_s2", type: "section", label: "② 期間・納期", hint: "契約期間（開始・終了）と納期は別。終了日を入れると自動更新の欄が出ます" },
        { name: "termStart", label: "開始", type: "date" },
        { name: "termEnd", label: "終了", type: "date" },
        // 納期は契約期間の終了日とは別。業務委託では同じ日になることが多いが、
        // 許諾の終了日は許諾がいつまで有効かで、納期ではない。
        { name: "deliveryDue", label: "納期", type: "date",
          hint: "いつまでに納めてもらうか。発注書の「納期」に出る。契約期間の終了日とは別" },
        // 自動更新（A-039）。更新した回数は持たず、終了日・単位・今日から数える。
        { name: "autoRenew", label: "自動更新", type: "select",
          options: [{ value: "", label: "しない" }, { value: "1", label: "する" }],
          visibleWhen: (v) => String(v.termEnd ?? "").trim() !== "",
          hint: "終了日が来るたびに自動で更新したことにする。条件書には「更新 n 回」と出る" },
        { name: "renewMonths", label: "更新の単位", placeholder: "1年",
          visibleWhen: (v) => Boolean(v.autoRenew) && String(v.termEnd ?? "").trim() !== "",
          hint: "「1年」「6か月」。空なら1年" },
        { name: "renewStoppedOn", label: "更新を止めた日", type: "date",
          visibleWhen: (v) => Boolean(v.autoRenew) && String(v.termEnd ?? "").trim() !== "",
          hint: "入れるとその日で回数が止まる（いまの期間は満了まで有効）" },
        { name: "_s3", type: "section", label: "③ 金額の決め方", hint: "通貨・計算方式と、その方式に要る金額。金額は最小通貨単位（JPY は円）" },
        { name: "currency", label: "通貨", type: "select", required: true,
          options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },

        { name: "pricingModel", label: "計算方式", type: "select", required: true,
          options: [{ value: "fixed", label: "定額" }, { value: "revenue_rate", label: "料率" },
                    { value: "unit_rate", label: "単価×数量" }, { value: "subscription", label: "定期課金" },
                    { value: "none", label: "計算しない" }],
          hint: "①の支払の形から入る。直すならここ。選んだ方式に必要な値が無いと登録できない" },
        // 定期課金は「1回あたり」をこの欄に入れる（計算も period_amount として読む）。
        // 出していなかったので、定期課金の条件は金額を持てないまま作られていた。
        { name: "flatAmount",
          label: (v) => v.pricingModel === "subscription"
            ? "1回あたりの金額（最小通貨単位）" : "定額（最小通貨単位）",
          type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "fixed" || v.pricingModel === "subscription",
          hint: (v) => v.pricingModel === "subscription"
            ? `毎月・毎期のいちどぶん。総額ではない。${minorUnitHint(v.currency)}`
            : minorUnitHint(v.currency) },
        { name: "ratePct", label: "料率（%）", type: "number", required: true,
          visibleWhen: (v) => v.pricingModel === "revenue_rate",
          placeholder: "12.5", hint: "小数で入れる。12.5 は 12.5%" },
        { name: "unitAmount", label: "単価（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "unit_rate",
          hint: (v) => minorUnitHint(v.currency) },

        // 編集画面と同じ欄（契約形式・個数・報酬名・準委任の時間精算）。作成と編集で入れられるものを揃える。
        { name: "quantity", label: "個数", type: "number", placeholder: "1",
          visibleWhen: (v) => v.pricingModel === "unit_rate",
          hint: "単価×個数が定額の既定値になる。小数も入る（0.5 人月など）" },
        { name: "mgAmount", label: "MG 最低保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: (v) => `毎期独立の下限。消化しないので残高を持たない。${minorUnitHint(v.currency)}` },
        { name: "agAmount", label: "AG 前払保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: (v) => `累積で充当する。消化しきるまで実額が出ない。${minorUnitHint(v.currency)}` },
        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" },
                    { value: "included", label: "税込（海外・内税）" }] },
        { name: "_s4", type: "section", label: "④ 支払", hint: "支払条件（文）と、何回払うかの決まり。予定明細はここから回ります" },
        { name: "paymentTerms", label: "支払条件", placeholder: "検収後30日 など",
          suggestions: [...PAYMENT_TERMS_PRESETS_JA, ...PAYMENT_TERMS_PRESETS_EN],
          hint: "予定明細の支払期日はここから出す。海外の相手なら英語の定型文（Net 30 など）を選ぶ" },
        // 決済の型（A-071）。この取引は何回払うものか。予定明細はこの決まりの中で回る。
        { name: "settlementMode", label: "決済の型（支払の回数）", type: "select",
          options: SETTLEMENT_MODE_OPTIONS,
          hint: "空なら予定明細から推す（1 行＝一回きり、複数行＝回数固定、定期＝期間で決まる）" },
        { name: "settlementCount", label: "回数", type: "number", required: true, placeholder: "3",
          visibleWhen: (v) => v.settlementMode === "fixed_count",
          hint: "2 回以上。1 回なら「一回きり」にする。増やすときは条件の改訂で" },
        { name: "settlementCycle", label: "周期", type: "select", required: true,
          options: SETTLEMENT_CYCLE_OPTIONS,
          visibleWhen: (v) => v.settlementMode === "term_bound",
          hint: "契約期間 ÷ 周期 が回数になる。期間を延ばせば回が増える" },
        { name: "settlementGraceDays", label: "終了後の猶予（日）", type: "number",
          placeholder: String(SETTLEMENT_GRACE_DAYS_DEFAULT),
          visibleWhen: (v) => v.settlementMode === "open" || v.settlementMode === "term_bound",
          hint: `終了日の後いつまで回を立ててよいか。空なら ${SETTLEMENT_GRACE_DAYS_DEFAULT} 日` },
        { name: "_s5", type: "section", label: "⑤ 成果物・発注書に出るもの", hint: "仕様・契約形式・成果物の帰属先・報酬名。発注書・検収書の明細はここから出ます" },
        // 発注書・検収書の明細はここから出る。備考を仕様代わりにしない。
        { name: "spec", label: "仕様・成果物", type: "textarea",
          placeholder: "カラーイラスト1点（表紙用）、A4 相当 など",
          hint: "発注書・検収書の明細の「仕様・成果物」にそのまま出る" },
        // V3 で発注書を出せば自動で入る。移行した条件は元が V1・V2 側にあるので控える。
        { name: "orderNo", label: "発注番号（外部）",
          placeholder: "ARC-PO-2025-0123",
          hint: "V1・V2 や紙で出した発注書の番号。検収書の発注番号に出る。V3 で発注書を出したらそちらが優先される" },
        { name: "contractForm", label: "契約形式", type: "select",
          visibleWhen: (v) => v.kind === "service",
          options: [{ value: "", label: "（未定）" },
                    ...CONTRACT_FORMS.map((f) => ({ value: f, label: f })),
                    ...CONTRACT_FORMS_EN.map((f) => ({ value: f, label: `${f}（海外版）` }))],
          hint: "発注書・検収書の「契約種別」に出る。支払条件とは別" },
        { name: "rewardLabel", label: "報酬名（上書き）", placeholder: "初版利用許諾料",
          visibleWhen: (v) => v.kind === "service",
          hint: "発注書・検収書の金額欄の小さな行に出る。空なら計算方式と帰属先から導く（A-075）" },
        { name: "timeSettlement", label: "準委任の精算の仕方", type: "select",
          visibleWhen: (v) => v.kind === "service" && isQuasiMandate(String(v.contractForm ?? "")),
          options: [{ value: "", label: "固定額・成果物で精算（検収書）" }, { value: "1", label: "時間精算：月間包括枠 ＋ 実績時間（役務提供完了通知書）" }],
          hint: "時間精算の回は役務提供完了通知書で確認する（A-073）" },
        { name: "hoursIncluded", label: "月間包括枠（時間）", type: "number", required: true, placeholder: "64",
          visibleWhen: (v) => v.kind === "service" && Boolean(v.timeSettlement),
          hint: "この時間までは定額（基本委託料／月）" },
        { name: "overageUnitAmount", label: "超過単価（最小通貨単位／時間）", type: "money", required: true, placeholder: "3125",
          visibleWhen: (v) => v.kind === "service" && Boolean(v.timeSettlement),
          hint: "枠を超えた時間 × 超過単価 を追加精算" },
        { name: "shortfallUnitAmount", label: "控除単価（最小通貨単位／時間）", type: "money", placeholder: "空なら減額しない",
          visibleWhen: (v) => v.kind === "service" && Boolean(v.timeSettlement),
          hint: "未消化の時間 × 控除単価 を減額。空なら未消化でも減額しない" },
        { name: "_s6", type: "section", label: "⑥ 利用許諾の条件", hint: "利用形態・許諾料の扱い・独占性・クレジット表記・地域と言語。発注書の「利用許諾条件」と条件書に出ます",
          visibleWhen: (v) => v.kind === "license" },
        { name: "_s6b", type: "section", label: "⑥ 利用許諾の条件 — 下の欄で入れます",
          hint: "受注者帰属の成果物の利用許諾（支払の形・初版の算定の基礎・料率・独占性・許諾期間・クレジット表記）は、この画面の下（登録ボタンの上）の欄で入れます。登録すると利用許諾条件が別の条件明細として立ち、この委託料に対応づきます",
          visibleWhen: (v) => v.kind === "service" && v.deliverableOwnership === "contractor" },
        // 利用形態（A-027）。条件書の行・計算書の製品名はこれで決まる。
        // 作品1点ぶんをまとめて作るなら「許諾セット」「出版セット」のほうが早い。
        { name: "usageType", label: "利用形態（取引モデル）", type: "select",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in",
          required: true,
          options: CONDITION_USAGE_TYPES.map((u) => ({ value: u.value, label: u.label, hint: u.hint })),
          hint: (v) => {
            const t = works.find((w) => String(w.id) === String(v.workId ?? ""))?.title ?? "";
            const made = v.usageType ? conditionNameFor({ workTitle: t, usageType: v.usageType as never,
                                                         sublicensee: null, purpose: v.purpose }) : null;
            return made ? `条件名：${made}` : "取得（IN）の許諾で、この条件がどの使い方の料率かを決める。作品を選ぶと 作品名｜取引モデル の条件名が付く";
          } },
        // 対象の許諾先（A-063）。ふつうは空＝一律（その作品の許諾先すべてに効く）。
        // 契約が特定の許諾先だけ別の料率にしているときだけ、その許諾先を選ぶ（許諾先専用）。
        { name: "targetPartyId", label: "対象の許諾先", type: "search",
          search: searchParties, placeholder: "空なら一律（その作品の許諾先すべてに効く）",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && (v.usageType === "sublicense" || v.usageType === "oem"),
          hint: (v) => v.targetPartyId
            ? "許諾先専用：この許諾先の報告だけがこの料率で計算されます。一律の条件からはこの許諾先が外れます"
            : "一律：この作品の許諾先すべてにこの料率が効きます。特定の許諾先だけ料率が違う契約のときだけ選んでください" },
        { name: "purpose", label: "再許諾の目的（任意）", placeholder: "英語版の製造販売",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.usageType === "sublicense",
          hint: "条件名に添える（作品名｜再許諾（許諾先／目的））" },
        // 翻訳版の再許諾（A-033）。再許諾先ごとに別途合意が要るかを条件に持たせる。
        { name: "sublicenseConsent", label: "再許諾ごとの別途合意", type: "select",
          visibleWhen: (v) => isSublicensingUsage(v.usageType),
          options: [{ value: "covered", label: "不要（本条件書で許諾済み）" },
                    { value: "required", label: "要（再許諾先ごとに別途合意）" }],
          hint: "出版条件書の翻訳版の欄と本文（第4条）に出る" },
        // 許諾料の扱い（A-048）。受注者帰属の成果物を使う許諾で「報酬に含む」「無償」を選べる。
        { name: "licenseFeeBasis", label: "許諾料の扱い", type: "select",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in",
          options: [{ value: "separate", label: "別途（料率・額で定める）" },
                    { value: "included", label: "業務委託報酬に含む（追加の許諾料なし）" },
                    { value: "free", label: "無償" },
                    { value: "in_lieu", label: "初版の利用許諾料を委託報酬として支払済み（2 版目以降がこの料率）" }],
          hint: "発注書の利用許諾条件の「料率・額」に出る。含む／無償なら料率は空でよい。「初版…支払済み」は初版分を委託料の行で払い、計算書の対象は 2 版目以降（A-077）" },
        // 初版の算定の基礎（A-077）。編集画面と同じ欄。
        { name: "royaltyExemptFirstCopies", label: "初版の非加算部数（献本・見本等）", type: "number", placeholder: "0",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: "初版利用許諾料の算定方法に「− ○部」として明記される。空・0 なら全部数" },
        { name: "royaltyExemptLaterPct", label: "非加算：2 版目以降（発行部数の %）", type: "number", placeholder: "1",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: "献本等。空なら非加算なし" },
        { name: "firstEditionPrice", label: "初版の本体価格（税抜・最小通貨単位）", type: "money", placeholder: "1000",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: "発注時は見込み、確定したら確定値に直す。特約第2項と明細の算定の基礎に出る" },
        { name: "firstEditionCopies", label: "初版発行部数", type: "number", placeholder: "3000",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: "発注時は見込み、確定したら確定値に直す" },
        { name: "firstEditionRatePct", label: "初版の料率（%）", type: "number", placeholder: "10",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: (v) => {
            const fee = firstEditionFee({ price: Number(v.firstEditionPrice) || 0, copies: Number(v.firstEditionCopies) || 0,
              ratePct: Number(v.firstEditionRatePct) || 0, exemptCopies: Number(v.royaltyExemptFirstCopies) || 0 });
            return fee > 0 ? `仮計算額 ¥${fee.toLocaleString("ja-JP")}（委託料の行の合計と同じ額にする）` : "初版利用許諾料の料率。2 版目以降の料率（上の料率）とは別";
          } },
        { name: "confirmWithinDays", label: "確定の期限（受領後 ○ 日）", type: "number", placeholder: "45",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.licenseFeeBasis === "in_lieu",
          hint: "本体価格・初版部数を書面で通知し乙の確認を得る期限。60 日以内" },
        // クレジット表記（A-076）。編集画面と同じ欄。
        { name: "creditFromWork", label: "クレジット表記", type: "select",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in",
          options: [{ value: "1", label: "作品のクレジット表記を引用（文書を作る日時点の表記）" }, { value: "", label: "この条件の文言を使う" }],
          hint: "発注書の利用許諾条件の下と特約に出る" },
        { name: "creditNotice", label: "クレジット表記の文言", type: "textarea",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in",
          placeholder: "© 2026 著作者名／イラスト：◯◯",
          hint: (v) => v.creditFromWork ? "引用するときは、作品に表記が無いときの控えとして使う" : "そのまま文書に出る" },
        { name: "exclusivity", label: "独占性", type: "select",
          visibleWhen: (v) => v.kind === "license",
          options: [{ value: "exclusive", label: "独占" }, { value: "non_exclusive", label: "非独占" }] },
        { name: "regions", label: "地域（許諾範囲）", type: "regions",
          visibleWhen: (v) => v.kind === "license",
          hint: "何も選ばなければ、その次元は無制限（全世界）として扱われます" },
        { name: "languages", label: "言語（許諾範囲）", type: "languages",
          visibleWhen: (v) => v.kind === "license" },
        { name: "_s7", type: "section", label: "⑦ 備考", hint: "台帳の控え。発注書・検収書には出ません（明細に出すものは ⑤ の仕様へ）" },
        { name: "notes", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => {
        // 画面は表示名を繋いだ文字列で持っている。保存はコード付きに戻す。
        // 作品の権利包絡との照合はコードで行う（名前だと「日本」「日本国内」が
        // 別物になる）。表に無い語はコード無しのまま入れる。
        const scopes = [
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null })),
        ];
        const ruled = v.kind === "license" && v.direction === "in" && String(v.workId ?? "").trim() !== "";
        return {
          // 作品に紐づく許諾は名前を送らない（サーバが 作品名｜取引モデル で付ける）。
          name: ruled ? "" : text(v.name), direction: v.direction, kind: v.kind,
          targetPartyId: ruled ? int(v.targetPartyId) : undefined, purpose: ruled ? text(v.purpose) : undefined,
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          autoRenew: v.autoRenew ? true : (text(v.termEnd) ? false : undefined),
          renewMonths: v.autoRenew ? renewMonths(v.renewMonths) : undefined,
          renewStoppedOn: v.autoRenew ? (text(v.renewStoppedOn) ?? null) : undefined,
          currency: v.currency || "JPY", pricingModel: v.pricingModel,
          // 画面は % で受け、保存は ppm（百万分率）。12.5% → 125000
          ratePpm: v.ratePct ? Math.round(Number(v.ratePct) * 10000) : undefined,
          flatAmount: int(v.flatAmount), unitAmount: int(v.unitAmount),
          mgAmount: int(v.mgAmount), agAmount: int(v.agAmount),
          exclusivity: text(v.exclusivity), taxCategory: v.taxCategory,
          usageType: v.kind === "license" ? text(v.usageType) : undefined,
          sublicenseConsent: isSublicensingUsage(v.usageType) ? text(v.sublicenseConsent) : undefined,
          licenseFeeBasis: v.kind === "license" ? (text(v.licenseFeeBasis) ?? undefined) : undefined,
          paymentTerms: text(v.paymentTerms), notes: text(v.notes),
          settlementMode: text(v.settlementMode), settlementCount: int(v.settlementCount),
          settlementCycle: text(v.settlementCycle), settlementGraceDays: int(v.settlementGraceDays),
          spec: text(v.spec), deliverableOwnership: text(v.deliverableOwnership),
          // 編集画面と同じ欄（契約形式・個数・報酬名・時間精算・クレジット・初版の算定の基礎）。
          quantity: v.pricingModel === "unit_rate" && String(v.quantity ?? "").trim() !== "" ? Number(v.quantity) : undefined,
          contractForm: v.kind === "service" ? text(v.contractForm) : undefined,
          rewardLabel: v.kind === "service" ? text(v.rewardLabel) : undefined,
          ...(v.kind === "service" && v.timeSettlement ? {
            timeSettlement: true, hoursIncluded: Number(v.hoursIncluded) || null,
            overageUnitAmount: int(v.overageUnitAmount), shortfallUnitAmount: int(v.shortfallUnitAmount)
          } : {}),
          ...(v.kind === "license" && v.direction === "in" ? {
            creditFromWork: Boolean(v.creditFromWork), creditNotice: text(v.creditNotice),
            ...(v.licenseFeeBasis === "in_lieu" ? {
              royaltyExemptFirstCopies: int(v.royaltyExemptFirstCopies),
              royaltyExemptLaterPct: String(v.royaltyExemptLaterPct ?? "").trim() !== "" ? Number(v.royaltyExemptLaterPct) : undefined,
              firstEditionPrice: int(v.firstEditionPrice), firstEditionCopies: int(v.firstEditionCopies),
              firstEditionRatePpm: String(v.firstEditionRatePct ?? "").trim() !== "" ? Math.round(Number(v.firstEditionRatePct) * 10000) : undefined,
              confirmWithinDays: int(v.confirmWithinDays)
            } : {})
          } : {}),
          scopes: scopes.length ? scopes : undefined
        };
      }}
  onDone={onDone}
  onCancel={onCancel}
>
  {contractorMode && (
    <div style={{ marginTop: 8 }}>
      <LicenseTermsSection draft={lic} onChange={setLic} deliverables={deliverables}
                           workId={String(cur.workId ?? "")} title={String(cur.name ?? "")}
                           agreements={licAgreements} baseAgreementId={String(cur.agreementId ?? "")}
                           servicePeriod={{ start: String(cur.termStart ?? ""), end: String(cur.termEnd ?? "") }}
                           workNote={!String(cur.workId ?? "").trim() && lic.mode !== "none"
                             ? <div className="alert">①の「作品」を選んでください（利用許諾条件は作品にぶら下がります）</div> : null} />
    </div>
  )}
  {/* 相手に締結済みの契約が無い。黙って契約なしの条件を増やさず、ここで決めてもらう。 */}
  {partyFor && candidates && candidates.length === 0 && !noAgreement && (
    <div className="note warn" style={{ marginTop: 8 }}>
      この相手には締結済みの契約（基本契約か単体契約）がありません。
      <span className="row" style={{ gap: 8, marginTop: 6 }}>
        {onRegisterAgreement && (
          <button type="button" className="btn btn-sm primary"
                  onClick={() => onRegisterAgreement(Number(partyFor))}>契約を登録する</button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setNoAgreement(true)}>契約なしで続ける</button>
        <span className="faint">契約なしで登録した条件は、工程と契約チェックに「契約なし」と出ます</span>
      </span>
    </div>
  )}
</CreateForm>
  );
}
