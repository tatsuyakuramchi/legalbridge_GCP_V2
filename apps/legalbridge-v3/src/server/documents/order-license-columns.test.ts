import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { createLicenseConditions, licenseInputsFor, type LicenseSpec } from "./order-license-columns.js";

const spec = (over: Partial<LicenseSpec> = {}): LicenseSpec => ({
  usageType: "pub_print", ratePct: 8, flatAmount: null, feeBasis: "separate",
  termStart: "2026-10-01", termEnd: null, scopes: [], ...over
});
const target = { counterpartyId: 2, workId: 11, workTitle: "星降る夜のミュゼ", agreementId: 7, matterId: 3 };

test("同じ利用形態は 1 本にまとめ、名前は 作品名｜取引モデル", () => {
  const inputs = licenseInputsFor([spec(), spec(), spec({ usageType: "pub_digital", ratePct: null, feeBasis: "included" }), null], target);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].name, "星降る夜のミュゼ｜紙出版");
  assert.equal(inputs[0].kind, "license");
  assert.equal(inputs[0].direction, "in");
  assert.equal(inputs[0].pricingModel, "revenue_rate");
  assert.equal(inputs[0].ratePpm, 80000);
  assert.equal(inputs[0].licenseFeeBasis, "separate");
  assert.equal(inputs[0].agreementId, 7);
  assert.equal(inputs[1].pricingModel, "none", "含む なら率も額も無い");
  assert.equal(inputs[1].licenseFeeBasis, "included");
});

test("定額の許諾料は fixed、開始日が空なら発注日", () => {
  const [one] = licenseInputsFor([spec({ ratePct: null, flatAmount: 50000, termStart: null })],
                                 { ...target, issuedOn: "2026-06-01" });
  assert.equal(one.pricingModel, "fixed");
  assert.equal(one.flatAmount, 50000);
  assert.equal(one.termStart, "2026-06-01");
});

test("同じ作品 × 受注者 × 利用形態の生きている条件があれば作らない", async () => {
  const db = new FakeDatabase((t, p) =>
    t.includes("kind = 'license'") && p[2] === "pub_print" ? [{ id: 91, condition_no: "CL-91" }]
    : t.includes("kind = 'license'") ? [] : undefined);
  const calls: unknown[] = [];
  const fake = { create: async (input: unknown) => { calls.push(input); return { id: 92, conditionNo: "CL-92" }; } };
  const made = await createLicenseConditions(db, fake as any,
    licenseInputsFor([spec(), spec({ usageType: "pub_digital" })], target), "k");
  assert.deepEqual(made.map((m) => [m.conditionNo, m.existed]), [["CL-91", true], ["CL-92", false]]);
  assert.equal(calls.length, 1);
});
