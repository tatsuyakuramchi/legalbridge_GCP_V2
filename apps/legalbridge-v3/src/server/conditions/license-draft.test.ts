import test from "node:test";
import assert from "node:assert/strict";
import { inLieuCheck, licensePayload, newLicenseDraft } from "./license-draft.js";

const one = (amount: number, deliveryDue = "2026-11-30") => [{ label: "原稿制作", name: "原稿制作", amount, deliveryDue }];

test("A-120：初版の利用許諾料で払う — 仮計算額と制作報酬が合い、期日がそろえば登録できる", () => {
  const d = { ...newLicenseDraft("in_lieu"), fePrice: "2500", feCopies: "4000", feRate: "8", feExempt: "100", payOn: "2027-01-15" };
  const ok = inLieuCheck(d, one(780000));
  assert.equal(ok.provisional, 780000);
  assert.deepEqual(ok.missing, []);
  const off = inLieuCheck(d, one(700000));
  assert.ok(off.missing.some((m) => m.includes("仮計算額 ¥780,000")), "金額が合わなければ理由に出る");
});

test("A-120：支払期日が納期から 60 日を超えると、その制作報酬の名前で理由に出る", () => {
  const d = { ...newLicenseDraft("in_lieu"), fePrice: "1000", feCopies: "3000", feRate: "10", payOn: "2027-03-31" };
  const r = inLieuCheck(d, one(300000, "2026-11-30"));
  assert.ok(r.missing.some((m) => m.includes("60 日") && m.includes("原稿制作")));
  assert.ok(inLieuCheck({ ...d, payOn: "" }, one(300000)).missing.includes("支払期日"));
});

test("A-120：送る形 — 別途は料率、初版利用許諾料は算定の基礎と料率の行、許諾開始は空なら業務の開始日", () => {
  const sep = licensePayload({ ...newLicenseDraft("separate"), rate: "8", exclusivity: "exclusive" }, { workId: "12", termStart: "2026-10-01" });
  assert.equal(sep.ratePct, 8);
  assert.equal(sep.workId, 12);
  assert.equal(sep.exclusivity, "exclusive");
  assert.equal(sep.termStart, "2026-10-01");
  assert.equal((sep as Record<string, unknown>).firstEdition, undefined);
  const lieu = licensePayload({ ...newLicenseDraft("in_lieu"), fePrice: "2500", feCopies: "4000", feRate: "8", feExempt: "100", payOn: "2027-01-15" },
                              { workId: "12", termStart: "" }) as Record<string, any>;
  assert.deepEqual(lieu.firstEdition, { price: 2500, copies: 4000, ratePct: 8, exemptCopies: 100, priceBasis: null });
  assert.deepEqual(lieu.rates.map((r: { usageType: string }) => r.usageType), ["pub_print", "pub_digital"]);
  assert.equal(lieu.payOn, "2027-01-15");
  assert.equal(lieu.agreementId, undefined, "空なら送らない（業務委託の基本契約と同じ）");
});
