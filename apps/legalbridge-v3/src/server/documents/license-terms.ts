/**
 * 個別利用許諾条件書（individual_license_terms_v3）。
 *
 * この書類だけ、項目の一覧が V1・V2 では **コードの中** にあった
 * （V2 template-repository の `databaseFields.length === 0 ? individualLicenseV3Fields`）。
 * V3 は移行でひな形の `variables` 列だけを引き継いだので、この書類の項目が
 * 1つも無く、ひな形を選んでも入力欄が出ないまま「決定する」だけが残っていた。
 * 本文（マトリクス表）を組む文脈も一緒に移していなかったので、仮に埋めても
 * 取引形態と構成要素の表は空で出る。
 *
 * ここは V2 の individual-license-v3.ts の移植。名前は本文との契約なので
 * そのままにしてある。V3 で足したのは「条件明細から表の種を作る」ところで、
 * V1・V2 は同じ表を人が手で打っていた（打った内容をあとから条件台帳へ
 * 逆流させていた）。V3 は条件明細が先にあるので、逆をやる。
 */

import type { TemplateVariable } from "./binding.js";

export const LICENSE_TERMS_KEY = "individual_license_terms_v3";
export const isLicenseTermsTemplate = (templateKey: string): boolean =>
  templateKey === LICENSE_TERMS_KEY;

type Data = Record<string, any>;

/**
 * 取引形態の固定3種。
 *
 * id は 1/2/3 固定。構成要素の料率マップ（v3_lcs[].rates）のキーになるので
 * 変えられない。自由記載をやめて固定軸にしてあるのは、加算型の料率合計と
 * 利用許諾計算が「どの形態の話か」で決まるため（V1 V3LicenseMatrix 準拠）。
 */
export const FIXED_DEALS: Data[] = [
  { id: 1, name: "自社製造・自社販売", calc_type: "BASE_QTY_RATE", addon: true,
    manufacturer: "Licensee", seller: "Licensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "上代（MSRP）× 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" },
  { id: 2, name: "権利許諾（サブライセンス）", calc_type: "BASE_RATE", addon: false,
    manufacturer: "Licensee", seller: "Sublicensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "許諾収入", qty: "1", ag: "0", mg: "0", cur: "JPY" },
  { id: 3, name: "自社製造・他社販売", calc_type: "SUPPLY_QTY", addon: true,
    manufacturer: "Licensee", seller: "販売店", maxReg: "全世界", maxLang: "全言語",
    basePrice: "供給価格 × 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" }
];

export const CALC_MODEL_LABEL: Record<string, string> = {
  BASE_QTY_RATE: "基準価格×個数×料率", BASE_RATE: "実効料率", FIXED: "固定額",
  SUBSCRIPTION: "サブスク", SUPPLY_QTY: "供給価格×個数×料率"
};

/** 加算型の形態。構成要素の料率を合算する側で、料率の列がここの数だけ出る。 */
export const addonDeals = (deals: Data[]): Data[] => deals.filter((d) => Boolean(d.addon));

/**
 * ひな形の項目。V2 の individualLicenseV3Fields をそのまま移す。
 * dbField は V1 の宣言のままで、V3 の対応表（legacy-variables）が読める。
 */
export const LICENSE_TERMS_VARIABLES: TemplateVariable[] = [
  { name: "契約書番号", label: "契約書番号", group: "I. 基本情報",
    dbField: "auto.docNumber", noGuess: true },
  { name: "発行日", label: "発行日", type: "date", group: "I. 基本情報", required: true,
    dbField: "auto.today", noGuess: true },
  { name: "許諾開始日", label: "許諾開始日", type: "date", group: "I. 基本情報", required: true,
    from: "condition.termStart" },
  { name: "基本契約名", label: "基本契約名", group: "I. 基本情報", from: "agreement.title" },
  { name: "work_id", label: "作品ID", group: "I. 基本情報",
    helpText: "作品台帳との参照キー", dbField: "work.code", noGuess: true },
  { name: "署名欄", label: "署名欄（末尾の記名押印欄）", type: "select", options: ["表示する", "表示しない"],
    group: "I. 基本情報", noGuess: true,
    helpText: "基本契約と一括で電子署名する場合は「表示しない」にすると、基本契約側の署名欄だけになります。" },

  { name: "Licensor_氏名会社名", label: "Licensor 名称", group: "II. Licensor", required: true,
    dbField: "vendor.vendor_name", noGuess: true },
  { name: "許諾者種別", label: "Licensor 種別", type: "select", options: ["法人", "個人"],
    group: "II. Licensor", required: true, dbField: "vendor.entity_type", noGuess: true },
  { name: "Licensor_住所", label: "Licensor 住所", type: "textarea", group: "II. Licensor",
    dbField: "vendor.address", noGuess: true },
  { name: "Licensor_代表者名", label: "Licensor 代表者名", group: "II. Licensor",
    dbField: "vendor.vendor_rep", noGuess: true },
  { name: "Licensor_担当者", label: "Licensor 担当者", group: "II. Licensor",
    dbField: "vendor.contact_name", noGuess: true },
  { name: "Licensor_電話", label: "Licensor 電話", group: "II. Licensor",
    dbField: "vendor.phone", noGuess: true },
  { name: "Licensor_メール", label: "Licensor メール", group: "II. Licensor",
    dbField: "vendor.email", noGuess: true },

  { name: "Licensee_氏名会社名", label: "Licensee 名称", group: "III. Licensee", required: true,
    dbField: "company.name", noGuess: true },
  { name: "Licensee_住所", label: "Licensee 住所", type: "textarea", group: "III. Licensee",
    dbField: "company.address", noGuess: true },
  { name: "Licensee_代表者名", label: "Licensee 代表者名", group: "III. Licensee",
    dbField: "company.rep", noGuess: true },
  // 空なら本文を組むときに当社の担当者から「氏名 ／ 電話 ／ メール」を作る。
  { name: "Licensee_連絡先", label: "Licensee 連絡先", group: "III. Licensee", noGuess: true,
    helpText: "空なら案件の担当者（氏名・電話・メール）が入ります" },

  { name: "対象製品予定名", label: "対象製品予定名", group: "IV. 許諾概要", required: true, noGuess: true,
    helpText: "許諾を受けて出す製品の名前。作品名とは別のことが多いので、ここは人が入れる" },
  { name: "独占性", label: "独占性", type: "select", options: ["独占", "非独占"],
    group: "IV. 許諾概要", required: true, from: "condition.exclusivityLabel" },
  { name: "v3_maxRegion", label: "許諾地域（上限）", group: "IV. 許諾概要", noGuess: true },
  { name: "v3_maxLanguage", label: "許諾言語（上限）", group: "IV. 許諾概要", noGuess: true },
  { name: "v3_scope", label: "許諾範囲", type: "textarea", group: "IV. 許諾概要", noGuess: true },
  { name: "監修者", label: "監修者", group: "IV. 許諾概要", noGuess: true,
    helpText: "許諾者側の監修担当。当社の担当者ではない" },
  { name: "v3_productDefinition", label: "対象製品の定義", type: "textarea", group: "IV. 許諾概要",
    noGuess: true, helpText: "空なら定型文（ボードゲーム製品）が入ります" },

  // 表そのもの。画面は専用の編集欄を出すので、手入力の項目一覧には並べない。
  { name: "v3_conds", label: "取引形態", type: "array", group: "V. 取引形態" },
  { name: "v3_lcs", label: "構成要素", type: "array", group: "VI. 構成要素" },
  { name: "v3_sublicensees", label: "サブライセンシー", type: "array", group: "VII. サブライセンス" },
  { name: "v3_calc_base_rows", label: "算定基準", type: "array", group: "VIII. 算定基準" },
  { name: "v3_special_extras", label: "特記事項", type: "array", group: "IX. 特記" }
];

// ---------------------------------------------------------------------------
// 表の種（V3 のデータから作る）
// ---------------------------------------------------------------------------

const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.filter((x): x is Data => Boolean(x) && typeof x === "object") : [];
const text = (value: unknown) => (value == null ? "" : String(value));
const number = (value: unknown): number | null => {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number | null) => (value == null ? "—" : `${+value.toFixed(2)}%`);
const joined = (labels: unknown) => (Array.isArray(labels) ? labels.join("・") : "");

/**
 * 取引形態の種。固定3種に、この文書に載せる条件明細（OUT）の値を重ねる。
 *
 * 条件明細の計算方式が形態を決める（料率＝サブライセンス、単価×数量＝製造販売）。
 * 決められないときは固定3種のままにする。人が直せるので、外すより残すほうがよい。
 */
export function dealSeeds(context: Data): Data[] {
  const granted = (context.conditions ?? []).filter((c: Data) => c.direction === "out");
  return FIXED_DEALS.map((deal) => {
    const match = granted.find((c: Data) => dealIdFor(c) === deal.id);
    // 当たる条件が無い形態も残す（人が使うかもしれない）。範囲は上限を置いて
    // おく。空欄のまま出すと、上限なしなのか未記入なのかが読めない。
    if (!match) return { ...deal, reg: deal.maxReg, lang: deal.maxLang };
    return {
      ...deal,
      conditionId: match.id,
      conditionNo: match.conditionNo ?? null,
      // 非加算型（サブライセンス）は条件の料率がそのまま実効料率になる。
      fixedRate: deal.addon ? "" : text(match.ratePct ?? ""),
      reg: joined(match.scopes?.region) || String(deal.maxReg),
      lang: joined(match.scopes?.language) || String(deal.maxLang),
      ag: text(match.agAmount ?? 0), mg: text(match.mgAmount ?? 0),
      cur: match.currency ?? deal.cur
    };
  });
}

/** 条件明細がどの取引形態にあたるか。計算方式で決まる。 */
export function dealIdFor(condition: Data): number | null {
  if (condition.direction !== "out") return null;
  if (condition.pricingModel === "revenue_rate") return 2;   // 許諾収入 × 料率
  if (condition.pricingModel === "unit_rate") return 1;      // 基準価格 × 数量 × 料率
  return null;
}

/**
 * 構成要素の種。作品の取得条件（IN）から作る。
 *
 * 「許諾できる上限は構成パート全部の取得条件の積で決まる」というのが V3 の
 * 建て付けなので、条件書に並べる構成要素も取得条件そのもの。料率は加算型の
 * 形態（自社製造・自社販売／自社製造・他社販売）に同じ率を置く。人が直せる。
 */
export function materialSeeds(context: Data): Data[] {
  const addonIds = addonDeals(FIXED_DEALS).map((d) => String(d.id));
  return list(context.acquisitions).map((acquired) => ({
    material_code: acquired.conditionNo ?? "",
    name: acquired.partName || acquired.name || acquired.workTitle || "",
    holder: acquired.counterparty ?? "",
    region: joined(acquired.regions) || "全世界",
    language: joined(acquired.languages) || "全言語",
    source_doc: acquired.agreementNo ?? "",
    rates: Object.fromEntries(addonIds.map((id) => [id, text(acquired.ratePct ?? "")]))
  }));
}

/** 画面の編集欄に渡す種。手入力があればそちらが勝つ（人が直したものを消さない）。 */
export function licenseTermsSeeds(context: Data): Record<string, Data[]> {
  return { v3_conds: dealSeeds(context), v3_lcs: materialSeeds(context) };
}

// ---------------------------------------------------------------------------
// 本文の文脈（V2 buildIndividualLicenseV3Context の移植）
// ---------------------------------------------------------------------------

export function licenseTermsPatch(context: Data, manual: Data = {}): Data {
  const seeds = licenseTermsSeeds(context);
  const deals = list(manual.v3_conds).length ? list(manual.v3_conds) : seeds.v3_conds;
  const materials = list(manual.v3_lcs).length ? list(manual.v3_lcs) : seeds.v3_lcs;

  /** 加算型は構成要素の料率の合計、非加算型は実効料率。 */
  const appliedRate = (deal: Data): string => {
    if (!deal.addon) return percent(number(deal.fixedRate));
    const key = String(deal.id ?? "");
    let total = 0;
    let found = false;
    for (const material of materials) {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as Data : {};
      const rate = number(rates[key]);
      if (rate !== null) { total += rate; found = true; }
    }
    return found ? percent(total) : "—";
  };

  const conds = deals.map((deal, index) => ({
    condLabel: `条件${index + 1}`,
    condName: text(deal.name),
    basePrice: text(deal.basePrice),
    condType: deal.addon ? "【加算型】" : "【非加算型】",
    calcModel: CALC_MODEL_LABEL[text(deal.calc_type)] ?? "",
    condRegion: text(deal.reg),
    condLang: text(deal.lang),
    appliedRate: appliedRate(deal),
    quantity: text(deal.qty) || "1",
    ag: text(deal.ag) || "0",
    mg: text(deal.mg) || "0",
    currency: text(deal.cur) || "JPY"
  }));

  const addons = deals.map((deal, index) => ({ deal, index })).filter(({ deal }) => Boolean(deal.addon));
  const holders = new Set(materials.map((m) => text(m.holder).trim()).filter(Boolean));
  const showHolder = holders.size > 1;

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = manual[key] ?? context[key];
      if (value != null && String(value).trim() !== "") return String(value);
    }
    return "";
  };
  const contact = (...keys: string[]) =>
    keys.map((k) => manual[k]).filter((v) => v != null && String(v).trim() !== "").join(" ／ ");

  const calcBaseRows = list(manual.v3_calc_base_rows)
    .map((row) => ({ edition: text(row.edition), trigger: text(row.trigger), note: text(row.note) }))
    .filter((row) => row.edition || row.trigger || row.note);

  return {
    issueDate: pick("発行日", "issueDate"),
    contractNo: pick("契約書番号", "contractNo"),
    workId: pick("work_id", "台帳ID", "workId"),
    masterAgreement: pick("基本契約名", "masterAgreement"),
    licensorName: pick("Licensor_氏名会社名", "Licensor_名称", "licensorName"),
    licenseeName: pick("Licensee_氏名会社名", "Licensee_名称", "licenseeName"),
    startDate: pick("許諾開始日", "startDate"),
    licensorContact: contact("Licensor_担当者", "Licensor_電話", "Licensor_メール"),
    // 自社側の通知先。欄が空なら当社の担当者から組む（V1 と同じ連結形）。
    licenseeContact: pick("Licensee_連絡先", "licenseeContact")
      || [context.owner?.name, context.owner?.phone, context.owner?.email]
        .filter((v) => v != null && String(v).trim() !== "").join(" ／ "),
    productDefinition: pick("v3_productDefinition", "対象製品の定義", "productDefinition")
      || "被許諾者（Licensee）が本契約に基づき対象作品を利用して企画・開発・製造・販売するボードゲーム製品（以下「対象製品」という。）",
    productName: pick("対象製品予定名", "productName"),
    exclusivity: pick("独占性", "exclusivity"),
    maxRegion: pick("v3_maxRegion", "許諾地域", "maxRegion"),
    maxLanguage: pick("v3_maxLanguage", "許諾言語", "maxLanguage"),
    scope: pick("v3_scope", "許諾範囲", "scope"),
    conds,
    addonConds: addons.map(({ deal, index }) => ({
      condLabel: conds[index].condLabel, condName: conds[index].condName, appliedRate: appliedRate(deal)
    })),
    showHolder,
    scopeColCount: 5 + (showHolder ? 1 : 0),
    rateColCount: 2 + addons.length,
    licensorIsCorp: pick("許諾者種別") !== "個人",
    lcs: materials.map((material) => {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as Data : {};
      const source = text(material.source_doc).trim();
      return {
        lcId: text(material.material_code),
        lcName: text(material.name),
        lcHolder: text(material.holder),
        lcSourceDoc: !source || /^(この|本)条件書/.test(source) ? "本条件書（新規）" : source,
        lcRegion: text(material.region),
        lcLanguage: text(material.language),
        addonRates: addons.map(({ deal }) => percent(number(rates[String(deal.id ?? "")])))
      };
    }),
    calcBaseRows: calcBaseRows.length ? calcBaseRows
      : [{ edition: "初版", trigger: "発売日", note: "" }, { edition: "2版以降", trigger: "製造日", note: "" }],
    sublicensees: list(manual.v3_sublicensees),
    supervisor: pick("監修者", "supervisor"),
    specialExtras: list(manual.v3_special_extras),
    licensorAddress: pick("Licensor_住所", "licensorAddress"),
    licensorRep: pick("Licensor_代表者名", "licensorRep"),
    licenseeAddress: pick("Licensee_住所", "licenseeAddress"),
    licenseeRep: pick("Licensee_代表者名", "licenseeRep")
  };
}
