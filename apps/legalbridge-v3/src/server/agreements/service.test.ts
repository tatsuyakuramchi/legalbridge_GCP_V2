import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { AgreementService, checkDirection, directionLabel, directionOf, mapRow } from "./service.js";

test("向きなし（null）にできるのは文書だけの契約", () => {
  assert.doesNotThrow(() => checkDirection("document", null));
  assert.doesNotThrow(() => checkDirection("master", "in"));
  for (const kind of ["master", "standalone", "supplement", "termination"] as const) {
    assert.throws(() => checkDirection(kind, null), /向きなしにできるのは「文書だけ」/);
  }
});

test("向きは DB の値をそのまま読み、空は向きなし", () => {
  assert.equal(directionOf("in"), "in");
  assert.equal(directionOf("out"), "out");
  assert.equal(directionOf(null), null);
  assert.equal(directionLabel(null), "向きなし");
  assert.equal(mapRow({ id: 1, title: "NDA", kind: "document", direction: null, status: "executed" }).direction, null);
});

test("契約の登録：基本契約を向きなしでは立てない。文書だけなら向きなしで立てる", async () => {
  const inserted: unknown[][] = [];
  const db = new FakeDatabase((t, params) => {
    if (t.includes("FROM parties")) return [{ id: 5, name: "株式会社サンプル" }];
    if (t.includes("INSERT INTO agreements")) { inserted.push(params); return [{ id: 77 }]; }
    return [];
  });
  const service = new AgreementService(db);
  await assert.rejects(
    service.create({ counterpartyId: 5, direction: null, kind: "master", domain: "service", title: "基本契約" }, "tester"),
    /向き（IN／OUT）を選んでください/);
  assert.equal(inserted.length, 0);
  const made = await service.create(
    { counterpartyId: 5, direction: null, kind: "document", title: "秘密保持契約書", executedOn: "2026-10-01" }, "tester");
  assert.deepEqual(made, { id: 77, agreementNo: null });
  assert.equal(inserted[0][3], null, "direction は空で入る");
});
