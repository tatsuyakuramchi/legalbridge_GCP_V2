import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService, type PublishingSetInput } from "./write-service.js";

/**
 * 出版の条件は作品1点＝紙・電子の2本。1回の登録で1トランザクションに入れる。
 */
const base: PublishingSetInput = {
  title: "星降る夜のはなし（単行本）", counterpartyId: 5, workId: 9, agreementId: 3,
  termStart: "2026-10-01", termEnd: "2031-09-30",
  scopes: [{ scopeType: "region", label: "全世界", code: "WORLD" }],
  print: { ratePct: 11, exclusivity: "non_exclusive" },
  digital: { ratePct: 15, exclusivity: "non_exclusive" }
};

const build = (existingMedia: Array<{ condition_no: string; usage_type: string | null; media: string[] | null }> = []) => {
  let next = 100;
  return new FakeDatabase((text) => {
    if (text.includes("FROM parties WHERE id")) return [{ id: 5, name: "甲野 甲太" }];
    if (text.includes("FROM works WHERE id")) return [{ id: 9 }];
    if (text.includes("c.status IN ('active', 'scheduled')")) return existingMedia;
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: next }];
    if (text.includes("FROM conditions WHERE condition_no")) return [];
    if (text.includes("INSERT INTO conditions")) {
      next += 1;
      return [{ id: next, condition_no: `CL-2026-00${next}` }];
    }
    return undefined;
  });
};

test("紙と電子の2本を1回で登録する。媒体は範囲に入る", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).createPublishingSet(base, "k");
  assert.equal(r.print?.id, 101);
  assert.equal(r.digital?.id, 102);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  assert.equal(inserts.length, 2);
  // 向き IN・種類 license・料率。11% → 110000 ppm。
  assert.equal(inserts[0].params[2], "in");
  assert.equal(inserts[0].params[3], "license");
  assert.equal(inserts[0].params[13], "revenue_rate");
  assert.equal(inserts[0].params[14], 110_000);
  assert.equal(inserts[1].params[14], 150_000);
  const scopes = db.queries.filter((q) => q.text.includes("INSERT INTO condition_scopes"));
  assert.deepEqual(scopes.map((q) => [q.params[1], q.params[2], q.params[3]]),
    [["region", "全世界", "WORLD"], ["media", "紙", "print"],
     ["region", "全世界", "WORLD"], ["media", "電子", "digital"]]);
  assert.equal(db.queries.filter((q) => q.text.includes("INSERT INTO audit_events")).length, 2);
});

test("紙だけでもよい。どちらも無ければ止める", async () => {
  const r = await new ConditionWriteService(build()).createPublishingSet({ ...base, digital: null }, "k");
  assert.ok(r.print);
  assert.equal(r.digital, null);
  await assert.rejects(
    () => new ConditionWriteService(build()).createPublishingSet({ ...base, print: null, digital: null }, "k"),
    /紙か電子のどちらか/);
});

test("料率の範囲と対象出版物名を検証する", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(() => svc.createPublishingSet({ ...base, print: { ratePct: 101 } }, "k"), /出版（紙）の料率は 0〜100/);
  await assert.rejects(() => svc.createPublishingSet({ ...base, title: " " }, "k"), /対象出版物名/);
});

test("同じ作品・同じ相手先に同じ媒体の生きた条件があれば止める（何も作らない）", async () => {
  const db = build([{ condition_no: "CL-2026-00090", usage_type: null, media: ["紙媒体"] }]);
  await assert.rejects(
    () => new ConditionWriteService(db).createPublishingSet(base, "k"),
    /出版（紙）の条件（CL-2026-00090）が既にあります/);
  assert.equal(db.queries.filter((q) => q.text.includes("INSERT INTO conditions")).length, 0);
  // 電子だけなら通る（紙は既にあるので足さない）。
  const ok = await new ConditionWriteService(build([{ condition_no: "CL-2026-00090", usage_type: "pub_print", media: ["print"] }]))
    .createPublishingSet({ ...base, print: null }, "k");
  assert.ok(ok.digital);
});
