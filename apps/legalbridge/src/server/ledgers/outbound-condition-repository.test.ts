import assert from "node:assert/strict";
import test from "node:test";
import { outboundConditionSchema } from "./outbound-conditions.js";
import {
  MemoryOutboundConditionRepository,
  OutboundConditionReferenceError,
  scopeAllowed
} from "./outbound-condition-repository.js";

function condition(overrides: Record<string, unknown> = {}) {
  return outboundConditionSchema.parse({
    workId: "work:42",
    workLabel: "W-42 作品",
    counterpartyId: "18",
    counterpartyLabel: "V-18 相手方",
    transactionKind: "license",
    conditionName: "英語版ライセンス",
    sourceConditionId: 7,
    documentNumber: "ARC-LIC-2026-0001",
    regions: [{ code: "WORLD", name: "全世界" }],
    languages: [{ code: "en", name: "英語" }],
    exclusivity: "non_exclusive",
    sublicenseAllowed: false,
    currency: "USD",
    paymentScheme: "royalty",
    ratePct: 5,
    ...overrides
  });
}

test("実在する文書・作品・相手方だけを受取条件として保存する", async () => {
  const repository = new MemoryOutboundConditionRepository();
  const first = await repository.save(condition());
  const second = await repository.save(condition({ conditionName: "仏語版ライセンス" }));

  assert.equal(first.direction, "receivable");
  assert.equal(first.documentId, 1);
  assert.equal(first.workId, 42);
  assert.equal(first.counterpartyVendorId, 18);
  assert.equal(first.lineNo, 1);
  assert.equal(second.lineNo, 2);
  assert.equal(repository.conditions.length, 2);
});

test("根拠文書番号がない条件を保存しない", async () => {
  const repository = new MemoryOutboundConditionRepository();
  await assert.rejects(
    repository.save(condition({ documentNumber: "" })),
    OutboundConditionReferenceError
  );
  assert.equal(repository.conditions.length, 0);
});

test("存在しない作品または相手方を保存しない", async () => {
  const repository = new MemoryOutboundConditionRepository();
  await assert.rejects(
    repository.save(condition({ workId: "work:999" })),
    /work not found/
  );
  await assert.rejects(
    repository.save(condition({ counterpartyId: "999" })),
    /counterparty not found/
  );
  assert.equal(repository.conditions.length, 0);
});


test("code欠落の旧child rowはcompatibility textへfallbackしてscope判定する", () => {
  assert.equal(
    scopeAllowed([], "全世界", [{ code: "US", name: "アメリカ合衆国" }], "WORLD"),
    true
  );
  assert.equal(
    scopeAllowed([], "全言語", [{ code: "en", name: "英語" }], "ALL"),
    true
  );
});
