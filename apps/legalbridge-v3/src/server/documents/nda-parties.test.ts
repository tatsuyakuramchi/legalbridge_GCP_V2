import test from "node:test";
import assert from "node:assert/strict";
import { bindVariables } from "./binding.js";
import { resolveAllLegacyVariables, resolveLegacyVariable } from "./legacy-variables.js";
import { documentWarnings } from "./preflight.js";

/** NDA（V2 049 改訂）は 甲＝取引先側（PARTY_A_*）・乙＝自社（PARTY_B_*）。 */
const company = { name: "株式会社アークライト", address: "東京都千代田区小川町1-2", rep: "代表取締役 青柳 昌行" };
const ctx = (counterparty: Record<string, unknown> | null = {
  name: "株式会社サンプル", kind: "corporate", address: "大阪府大阪市北区1-1",
  representativeTitle: "代表取締役", representativeName: "山田 太郎"
}): any => ({ company, condition: counterparty ? { counterparty } : null, conditions: [], contacts: [] });

const NDA_VARS = [
  { name: "PARTY_A_NAME", label: "甲 名称", required: true },
  { name: "PARTY_A_ADDRESS", label: "甲 住所", required: true },
  { name: "PARTY_A_REP", label: "甲 代表者", required: true },
  { name: "PARTY_B_NAME", label: "乙 名称", required: true },
  { name: "PARTY_B_ADDRESS", label: "乙 住所", required: true },
  { name: "PARTY_B_REP", label: "乙 代表者", required: true }
];

test("NDA：甲に取引先、乙に自社が入る", () => {
  const r = bindVariables(NDA_VARS as any, ctx(), {}, { templateKey: "nda" });
  assert.equal(r.values.PARTY_A_NAME, "株式会社サンプル");
  assert.equal(r.values.PARTY_A_ADDRESS, "大阪府大阪市北区1-1");
  assert.equal(r.values.PARTY_A_REP, "代表取締役 山田 太郎");
  assert.equal(r.values.PARTY_B_NAME, "株式会社アークライト");
  assert.equal(r.values.PARTY_B_ADDRESS, "東京都千代田区小川町1-2");
  assert.equal(r.values.PARTY_B_REP, "代表取締役 青柳 昌行");
  assert.deepEqual(r.missing, []);
});

test("NDA：手入力が自動の値に勝つ", () => {
  const r = bindVariables(NDA_VARS as any, ctx(), { PARTY_A_REP: "取締役 佐藤 花子" }, { templateKey: "nda" });
  assert.equal(r.values.PARTY_A_REP, "取締役 佐藤 花子");
});

test("NDA：個人の相手先は代表者の欄に本人の氏名", () => {
  assert.equal(resolveLegacyVariable("PARTY_A_REP", ctx({ name: "如月 涼", kind: "individual" }), "甲 代表者", "nda"), "如月 涼");
});

test("NDA：相手先が無ければ甲は空のまま（土台の値からも自社を出さない）", () => {
  const bag = resolveAllLegacyVariables(ctx(null), "nda");
  assert.equal(bag.PARTY_A_NAME, undefined);
  assert.equal(bag.PARTY_B_NAME, "株式会社アークライト");
  const r = bindVariables(NDA_VARS as any, ctx(null), {}, { templateKey: "nda" });
  assert.deepEqual(r.missing.map((m) => m.name), ["PARTY_A_NAME", "PARTY_A_ADDRESS", "PARTY_A_REP"]);
});

test("NDA 以外（発注書など）の PARTY_A_* は従来どおり自社", () => {
  assert.equal(resolveLegacyVariable("PARTY_A_NAME", ctx(), "発注元 名称", "purchase_order"), "株式会社アークライト");
  assert.equal(resolveAllLegacyVariables(ctx()).PARTY_A_NAME, "株式会社アークライト");
  assert.equal(resolveLegacyVariable("PARTY_B_NAME", ctx(), undefined, "purchase_order"), undefined);
});

test("NDA：甲の空欄を「自社情報が空」と言わない", () => {
  const html = "{{PARTY_A_NAME}} {{PARTY_B_NAME}}";
  const w = documentWarnings(html, { PARTY_A_NAME: "", PARTY_B_NAME: "" }, [], "nda");
  const companyMsg = w.find((x) => x.kind === "company")?.message ?? "";
  assert.match(companyMsg, /自社名/);
  assert.doesNotMatch(companyMsg, /甲/);
  assert.match(w.find((x) => x.kind === "other")?.message ?? "", /甲（取引先）名称/);
});
