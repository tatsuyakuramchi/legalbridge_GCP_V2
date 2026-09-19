import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService, type LicenseSetInput } from "./write-service.js";

/**
 * 許諾セット：作品1点×契約×取引先で、利用形態ごとに条件を N 本。
 * 出版セットはこれの特例（紙・電子の2本）。
 */
const base: LicenseSetInput = {
  title: "ito", counterpartyId: 5, workId: 9, agreementId: 3,
  termStart: "2026-10-01", termEnd: "2031-09-30",
  rows: [
    { usageType: "in_house", ratePct: 2, exclusivity: "non_exclusive", mgAmount: 100000 },
    { usageType: "sublicense", ratePct: 50 },
    { usageType: "oem", ratePct: 2 }
  ]
};

const build = (existing: Array<{ condition_no: string; usage_type: string | null; name?: string; media: string[] | null }> = []) => {
  let next = 100;
  return new FakeDatabase((text) => {
    if (text.includes("FROM parties WHERE id")) return [{ id: 5, name: "権利者" }];
    if (text.includes("FROM works WHERE id")) return [{ id: 9, title: "ito" }];
    if (text.includes("c.status IN ('active', 'scheduled')")) return existing;
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: next }];
    if (text.includes("FROM conditions WHERE condition_no")) return [];
    if (text.includes("INSERT INTO conditions")) { next += 1; return [{ id: next, condition_no: `CL-2026-00${next}` }]; }
    return undefined;
  });
};

test("利用形態ごとに1本ずつ、1トランザクションで作る。利用形態は列に入る", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).createLicenseSet(base, "k");
  assert.deepEqual(r.conditions.map((c) => [c.usageType, c.id]), [["in_house", 101], ["sublicense", 102], ["oem", 103]]);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  assert.equal(inserts.length, 3);
  // 利用形態は最後の列（$29）。料率は ppm。MG は行ごと。
  assert.deepEqual(inserts.map((q) => [q.params[29], q.params[15], q.params[18]]),
    [["in_house", 20_000, 100000], ["sublicense", 500_000, null], ["oem", 20_000, null]]);
  // ゲームの利用形態には媒体の範囲を付けない。
  assert.equal(db.queries.filter((q) => q.text.includes("INSERT INTO condition_scopes")).length, 0);
});

test("出版セットは許諾セットの特例：利用形態 pub_print / pub_digital と媒体の範囲が入る", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).createPublishingSet({
    title: "星降る夜のはなし（単行本）", counterpartyId: 5, workId: 9,
    print: { ratePct: 11, exclusivity: "non_exclusive" }, digital: { ratePct: 15 }
  }, "k");
  assert.equal(r.print?.id, 101);
  assert.equal(r.digital?.id, 102);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  assert.deepEqual(inserts.map((q) => q.params[29]), ["pub_print", "pub_digital"]);
  const scopes = db.queries.filter((q) => q.text.includes("INSERT INTO condition_scopes"));
  assert.deepEqual(scopes.map((q) => [q.params[1], q.params[2], q.params[3]]),
    [["media", "紙", "print"], ["media", "電子", "digital"]]);
});

test("同じ作品・相手先に同じ利用形態があれば止める（列でも、古い媒体の範囲でも）", async () => {
  await assert.rejects(
    () => new ConditionWriteService(build([{ condition_no: "CL-1", usage_type: "sublicense", name: "ito", media: null }]))
      .createLicenseSet(base, "k"),
    /再許諾の条件（CL-1）が既にあります/);
  await assert.rejects(
    () => new ConditionWriteService(build([{ condition_no: "CL-2", usage_type: null, media: ["紙媒体"] }]))
      .createPublishingSet({ title: "x", counterpartyId: 5, workId: 9, print: { ratePct: 10 } }, "k"),
    /出版（紙）の条件（CL-2）が既にあります/);
});

test("同じ利用形態を2回、料率の範囲外、行なしは止める", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(() => svc.createLicenseSet({ ...base, rows: [base.rows[0], base.rows[0]] }, "k"), /2回入っています/);
  await assert.rejects(() => svc.createLicenseSet({ ...base, rows: [{ usageType: "oem", ratePct: 101 }] }, "k"), /0〜100/);
  await assert.rejects(() => svc.createLicenseSet({ ...base, rows: [] }, "k"), /利用形態を1つ以上/);
});

/**
 * 条件名の規則。名前を打たせず、作品名｜取引モデル で行ごとに付ける。
 * 再許諾は 再許諾先／目的 が名前に入り、相手が違えば同じ作品・相手先でも別の条件。
 */
test("条件名が空なら 作品名｜取引モデル で行ごとに付く。再許諾は再許諾先／目的つき", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).createLicenseSet({
    ...base, title: null,
    rows: [
      { usageType: "in_house", ratePct: 2 },
      { usageType: "sublicense", ratePct: 50, sublicensee: "Alpha Games", purpose: "英語版の製造販売" },
      { usageType: "sublicense", ratePct: 50, sublicensee: "Beta", purpose: "韓国語版" },
      { usageType: "oem", ratePct: 2 }
    ]
  }, "k");
  assert.equal(r.conditions.length, 4);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  assert.deepEqual(inserts.map((q) => q.params[4]), [
    "ito｜自社製造・自社販売", "ito｜再許諾（Alpha Games／英語版の製造販売）", "ito｜再許諾（Beta／韓国語版）", "ito｜自社製造・他社販売"
  ]);
});

test("再許諾は再許諾先が要る。同じ再許諾先・目的の再許諾が2回なら止める。相手が違う既存の再許諾とは重ならない", async () => {
  const svc = new ConditionWriteService(build([{ condition_no: "CL-1", usage_type: "sublicense", name: "ito｜再許諾（Alpha Games／英語版）", media: null }]));
  await assert.rejects(() => svc.createLicenseSet({ ...base, title: null, rows: [{ usageType: "sublicense", ratePct: 50 }] }, "k"),
    /再許諾先の名称/);
  await assert.rejects(() => svc.createLicenseSet({ ...base, title: null, rows: [
    { usageType: "sublicense", ratePct: 50, sublicensee: "X", purpose: "y" },
    { usageType: "sublicense", ratePct: 40, sublicensee: "X", purpose: "y" }] }, "k"), /2回入っています/);
  await assert.rejects(() => svc.createLicenseSet({ ...base, title: null, rows: [
    { usageType: "sublicense", ratePct: 50, sublicensee: "Alpha Games", purpose: "英語版" }] }, "k"), /CL-1）が既にあります/);
  const ok = await svc.createLicenseSet({ ...base, title: null, rows: [
    { usageType: "sublicense", ratePct: 50, sublicensee: "Beta", purpose: "韓国語版" }] }, "k");
  assert.equal(ok.conditions.length, 1);
});

test("作品も条件名も無ければ止める", async () => {
  await assert.rejects(() => new ConditionWriteService(build()).createLicenseSet({ ...base, title: null, workId: null }, "k"),
    /作品を選んでください/);
});
