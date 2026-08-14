import type { TemplateField } from "../../types.js";

export const INDIVIDUAL_LICENSE_V3_KEY = "individual_license_terms_v3";

export const individualLicenseV3Fields: TemplateField[] = [
  { name: "契約書番号", label: "契約書番号", group: "I. 基本情報", dbField: "auto.docNumber" },
  { name: "発行日", label: "発行日", type: "date", group: "I. 基本情報", required: true, dbField: "auto.today" },
  { name: "許諾開始日", label: "許諾開始日", type: "date", group: "I. 基本情報", required: true },
  { name: "基本契約名", label: "基本契約名", group: "I. 基本情報" },
  { name: "work_id", label: "作品ID", group: "I. 基本情報", helpText: "作品台帳との参照キー" },
  { name: "Licensor_氏名会社名", label: "Licensor 名称", group: "II. Licensor", required: true, dbField: "vendor.vendor_name" },
  { name: "許諾者種別", label: "Licensor 種別", type: "select", options: ["法人", "個人"], group: "II. Licensor", required: true },
  { name: "Licensor_住所", label: "Licensor 住所", type: "textarea", group: "II. Licensor", dbField: "vendor.address" },
  { name: "Licensor_代表者名", label: "Licensor 代表者名", group: "II. Licensor", dbField: "vendor.vendor_rep" },
  { name: "Licensor_担当者", label: "Licensor 担当者", group: "II. Licensor" },
  { name: "Licensor_電話", label: "Licensor 電話", group: "II. Licensor" },
  { name: "Licensor_メール", label: "Licensor メール", group: "II. Licensor" },
  { name: "Licensee_氏名会社名", label: "Licensee 名称", group: "III. Licensee", required: true, dbField: "company.name" },
  { name: "Licensee_住所", label: "Licensee 住所", type: "textarea", group: "III. Licensee", dbField: "company.address" },
  { name: "Licensee_代表者名", label: "Licensee 代表者名", group: "III. Licensee", dbField: "company.rep" },
  { name: "Licensee_連絡先", label: "Licensee 連絡先", group: "III. Licensee" },
  { name: "対象製品予定名", label: "対象製品予定名", group: "IV. 許諾概要", required: true },
  { name: "独占性", label: "独占性", type: "select", options: ["独占", "非独占"], group: "IV. 許諾概要", required: true },
  { name: "v3_maxRegion", label: "許諾地域（上限）", group: "IV. 許諾概要" },
  { name: "v3_maxLanguage", label: "許諾言語（上限）", group: "IV. 許諾概要" },
  { name: "v3_scope", label: "許諾範囲", type: "textarea", group: "IV. 許諾概要" },
  { name: "監修者", label: "監修者", group: "IV. 許諾概要" }
];

// ひな形プレビュー用サンプル（V1 individualLicenseV3Context.ts の v3SampleFormData 移植）。
// 汎用のサンプル生成では conds/lcs マトリクスを作れないため、跨ぎ原作の
// 取引形態×構成要素を明示した専用サンプルで描画する。
export function individualLicenseV3SampleFormData(): Record<string, unknown> {
  return {
    契約書番号: "LIC-LO-2026-0015-ILT-0001",
    発行日: "2026-06-27",
    許諾開始日: "2026-07-01",
    Licensor_氏名会社名: "株式会社オリジナル（サンプル）",
    Licensee_氏名会社名: "株式会社ライセンシー（サンプル）",
    対象製品予定名: "コラボボードゲーム（サンプル）",
    独占性: "非独占",
    監修者: "監修部",
    Licensor_担当者: "山田", Licensor_電話: "03-1111-2222", Licensor_メール: "yamada@example.co.jp",
    Licensor_住所: "東京都千代田区サンプル1-2-3", Licensor_代表者名: "代表取締役 鈴木 一郎",
    Licensee_住所: "大阪府大阪市サンプル4-5-6", Licensee_代表者名: "代表取締役 佐藤 花子",
    v3_conds: [
      { id: 1, name: "製造・販売", addon: true, manufacturer: "Licensee", seller: "Licensee",
        maxReg: "全世界", maxLang: "全言語", basePrice: "上代（MSRP）× 数量",
        reg: "日本", lang: "日本語", qty: "数量", ag: "0", mg: "100000", cur: "JPY" },
      { id: 2, name: "サブライセンス", addon: false, fixedRate: "50",
        reg: "全世界", lang: "全言語", qty: "1", ag: "0", mg: "0", cur: "JPY" }
    ],
    v3_lcs: [
      { material_code: "LO-2026-0015-001", name: "原作ゲーム（A）", holder: "株式会社オリジナル",
        region: "全世界", language: "全言語", rates: { "1": "5" } },
      { material_code: "LO-2026-0008-003", name: "過去成果物（B・別原作）", holder: "株式会社クリエイト",
        region: "日本国内", language: "日本語", rates: { "1": "2" } }
    ],
    v3_sublicensees: [
      { slPartner: "サブA社", slRegion: "北米", slLang: "英語", slCond: "サブライセンス",
        slRate: "50", slDate: "2026-08-01", slNote: "サンプル" }
    ],
    v3_calc_base_rows: [
      { edition: "初版", trigger: "発売日", note: "" },
      { edition: "2版以降", trigger: "製造日", note: "" }
    ]
  };
}

type AnyRecord = Record<string, unknown>;
const stringValue = (value: unknown) => value == null ? "" : String(value);
const numberValue = (value: unknown) => {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number | null) => value == null ? "—" : `${+value.toFixed(2)}%`;
const records = (value: unknown): AnyRecord[] => Array.isArray(value) ? value.filter((item): item is AnyRecord => !!item && typeof item === "object") : [];

export function buildIndividualLicenseV3Context(formData: AnyRecord) {
  const conditions = records(formData.v3_conds);
  const materials = records(formData.v3_lcs);
  const appliedRate = (condition: AnyRecord) => {
    if (!condition.addon) return percent(numberValue(condition.fixedRate));
    const key = String(condition.id ?? ""); let total = 0; let found = false;
    for (const material of materials) {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as AnyRecord : {};
      const rate = numberValue(rates[key]);
      if (rate !== null) { total += rate; found = true; }
    }
    return found ? percent(total) : "—";
  };
  const renderedConditions = conditions.map((condition, index) => ({
    condLabel: `条件${index + 1}`, condName: stringValue(condition.name), basePrice: stringValue(condition.basePrice),
    condType: condition.addon ? "【加算型】" : "【非加算型】",
    calcModel: ({ BASE_QTY_RATE: "基準価格×個数×料率", BASE_RATE: "実効料率", FIXED: "固定額", SUBSCRIPTION: "サブスク", SUPPLY_QTY: "供給価格×個数×料率" } as Record<string, string>)[stringValue(condition.calc_type)] ?? "",
    condRegion: stringValue(condition.reg), condLang: stringValue(condition.lang), appliedRate: appliedRate(condition),
    quantity: stringValue(condition.qty) || "1", ag: stringValue(condition.ag) || "0", mg: stringValue(condition.mg) || "0", currency: stringValue(condition.cur) || "JPY"
  }));
  const addonConditions = conditions.map((condition, index) => ({ condition, index })).filter(({ condition }) => Boolean(condition.addon));
  const holders = new Set(materials.map((item) => stringValue(item.holder).trim()).filter(Boolean));
  const showHolder = holders.size > 1;
  const pick = (...keys: string[]) => { for (const key of keys) { const value = formData[key]; if (value != null && String(value).trim()) return String(value); } return ""; };
  const calcBaseRows = records(formData.v3_calc_base_rows).map((row) => ({ edition: stringValue(row.edition), trigger: stringValue(row.trigger), note: stringValue(row.note) })).filter((row) => row.edition || row.trigger || row.note);
  return {
    ...formData,
    issueDate: pick("発行日", "issueDate"), contractNo: pick("契約書番号", "contractNo"), workId: pick("work_id", "台帳ID", "workId"), masterAgreement: pick("基本契約名", "masterAgreement"),
    licensorName: pick("Licensor_氏名会社名", "Licensor_名称", "licensorName"), licenseeName: pick("Licensee_氏名会社名", "Licensee_名称", "licenseeName"), startDate: pick("許諾開始日", "startDate"),
    licensorContact: [formData["Licensor_担当者"], formData["Licensor_電話"], formData["Licensor_メール"]].filter((value) => value != null && String(value).trim()).join(" ／ "),
    licenseeContact: pick("Licensee_連絡先", "licenseeContact"),
    productDefinition: pick("v3_productDefinition", "対象製品の定義", "productDefinition") || "被許諾者（Licensee）が本契約に基づき対象作品を利用して企画・開発・製造・販売するボードゲーム製品（以下「対象製品」という。）",
    productName: pick("対象製品予定名", "productName"), exclusivity: pick("独占性", "exclusivity"), maxRegion: pick("v3_maxRegion", "許諾地域", "maxRegion"), maxLanguage: pick("v3_maxLanguage", "許諾言語", "maxLanguage"), scope: pick("v3_scope", "許諾範囲", "scope"),
    conds: renderedConditions,
    addonConds: addonConditions.map(({ condition, index }) => ({ condLabel: renderedConditions[index].condLabel, condName: renderedConditions[index].condName, appliedRate: appliedRate(condition) })),
    showHolder, scopeColCount: 5 + (showHolder ? 1 : 0), rateColCount: 2 + addonConditions.length, licensorIsCorp: pick("許諾者種別") !== "個人",
    lcs: materials.map((material) => {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as AnyRecord : {};
      const source = stringValue(material.source_doc).trim();
      return { lcId: stringValue(material.material_code), lcName: stringValue(material.name), lcHolder: stringValue(material.holder), lcSourceDoc: !source || /^(この|本)条件書/.test(source) ? "本条件書（新規）" : source, lcRegion: stringValue(material.region), lcLanguage: stringValue(material.language), addonRates: addonConditions.map(({ condition }) => percent(numberValue(rates[String(condition.id ?? "")])))};
    }),
    calcBaseRows: calcBaseRows.length ? calcBaseRows : [{ edition: "初版", trigger: "発売日", note: "" }, { edition: "2版以降", trigger: "製造日", note: "" }],
    sublicensees: records(formData.v3_sublicensees), supervisor: pick("監修者", "supervisor"), specialExtras: records(formData.v3_special_extras),
    licensorAddress: pick("Licensor_住所", "licensorAddress"), licensorRep: pick("Licensor_代表者名", "licensorRep"), licenseeAddress: pick("Licensee_住所", "licenseeAddress"), licenseeRep: pick("Licensee_代表者名", "licenseeRep")
  };
}
