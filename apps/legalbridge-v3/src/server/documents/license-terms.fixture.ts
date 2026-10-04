/**
 * 個別利用許諾条件書V4 の本文の試験で使う見本データ。
 * license-terms.test.ts と同じ形（本番のデータの形）。素材2は形態を画面で選んだ想定。
 */
import { licenseScopeSentence } from "./license-terms.js";

const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  mgAmount: 0, agAmount: 0, notes: null,
  scopes: { region: [] as string[], language: [] as string[] }, ...over
});

export const context: Record<string, any> = {
  owner: { name: "浅井 崇", phone: "03-5555-6666", email: "asai@example.test" },
  conditions: [
    cond({ id: 11, conditionNo: "CL-2026-00311", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 3,
      notes: "取引形態: 自社製造・自社販売", scopes: { region: ["日本"], language: ["日本語"] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 12, conditionNo: "CL-2026-00312", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 50,
      notes: "取引形態: 権利許諾（サブライセンス）", scopes: { region: ["全世界"], language: [] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 13, conditionNo: "CL-2026-00313", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 3,
      notes: "取引形態: 自社製造・他社販売", counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 21, conditionNo: "CL-2026-00321", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2,
      notes: "取引形態: 自社製造・自社販売", counterparty: { name: "合同会社アトリエ蒼" } }),
    cond({ id: 23, conditionNo: "CL-2026-00323", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2,
      notes: "取引形態: 自社製造・他社販売", counterparty: { name: "合同会社アトリエ蒼" } })
  ],
  acquisitions: [
    { id: 11, conditionNo: "CL-2026-00311", partName: "ito_原作ゲームデザイン", agreementNo: "ARC-ILT-2026-0030" },
    { id: 21, conditionNo: "CL-2026-00321", partName: "ito_イラスト", agreementNo: null }
  ]
};
// 期間・更新・計算書・支払・再許諾は代表の条件明細から（licenseScopeSentence と同じ出どころ）。
context.condition = { ...context.conditions[0], termStart: "2026-10-01", termEnd: "2031-09-30",
  autoRenew: true, renewMonths: 12, statementTiming: "periodic",
  sublicensable: true, sublicenseConsent: "required" };

export const manual = {
  契約書番号: "ARC-ILT-2026-0041", 発行日: "2026-10-01", 許諾開始日: "2026-10-01",
  基本契約名: "利用許諾基本契約書", work_id: "WRK-10013",
  Licensor_氏名会社名: "株式会社オリジナル", 許諾者種別: "法人",
  Licensor_住所: "東京都千代田区外神田1-1", Licensor_代表者名: "代表取締役 甲野 甲太",
  Licensor_担当者: "甲野 花子", Licensor_メール: "hanako@example.test",
  Licensee_氏名会社名: "株式会社アークライト", Licensee_住所: "東京都千代田区神田小川町1-2",
  Licensee_代表者名: "代表取締役 野澤 邦仁",
  対象製品予定名: "ito 新装版", 独占性: "非独占", v3_maxRegion: "全世界", v3_maxLanguage: "全言語",
  監修者: "甲野 花子",
  v3_sublicensees: [{ slPartner: "サブA社", slRegion: "北米", slLang: "英語",
    slCond: "権利許諾（サブライセンス）", slRate: "50", slDate: "2026-12-01", slNote: "" }],
  v3_special_extras: [{ seId: "1", seText: "初回製造分の見本10部を許諾者に無償で提供する。" }]
};
// 画面は許諾範囲の文を自動で組んで入れる（人が直さなければこの文のまま）。
(manual as Record<string, unknown>).v3_scope = licenseScopeSentence(context, manual);

