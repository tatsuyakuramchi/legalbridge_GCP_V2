import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { StatementPeriodReissueService } from "./statement-reissue.js";

/**
 * 文書 901：条件 7、実績 51・52 が回 100（2025/7/1〜2026/6/30）に付き、紙は売上のあった月の範囲で出ている。
 * 文書 902：条件 8、もう回の期間で出ている。
 * 文書 903：条件 9、実績 71 が回に付いていない。
 */
const head = (over: Record<string, unknown>) => ({
  id: 901, document_no: "ARC-ROY-2026-1101", matter_id: null, agreement_id: null,
  manual_inputs: { statementMode: "bundle", rs_bundle_lines: [], notes: "備考" },
  issued_on: "2026-06-30", printed_label: "2025年8月分〜2026年3月分", template_key: "royalty_statement_pub",
  has_draft: false, statement_id: 1, condition_id: 7, payee_party_id: null, period: "2025年8月分〜2026年3月分",
  net_amount: 90000, usage_type: "pub_digital", party_name: "作家甲", ...over
});
const ROUND = { schedule_id: 100, service_from: "2025-07-01", service_to: "2026-06-30", label: "2025年7月〜2026年6月" };
const db = () => new FakeDatabase((text) => {
  if (text.includes("FROM documents d")) return [
    head({}),
    head({ id: 902, document_no: "ARC-ROY-2026-1102", statement_id: 2, condition_id: 8,
           printed_label: "2025年7月〜2026年6月", period: "2025年7月〜2026年6月" }),
    head({ id: 903, document_no: "ARC-ROY-2026-1103", statement_id: 3, condition_id: 9 }),
    head({ id: 904, document_no: "ARC-ROY-2026-1104", statement_id: 4, condition_id: 10, usage_type: "pub_print" })
  ];
  if (text.includes("FROM statements s")) return [
    { statement_id: 1, event_id: 51, ...ROUND }, { statement_id: 1, event_id: 52, ...ROUND },
    { statement_id: 2, event_id: 61, ...ROUND },
    { statement_id: 3, event_id: 71, schedule_id: null, service_from: null, service_to: null, label: null }
  ];
  return [];
});
const fakeIssuer = (net = 90000) => {
  const issued: Array<Record<string, any>> = [];
  return {
    issued,
    previewBundle: async (entries: unknown[]) => entries.map(() => ({ amounts: { netMinor: net } })) as any,
    issue: async (input: Record<string, any>) => {
      issued.push(input);
      return { document: { id: 990, documentNo: "ARC-ROY-2026-1101-R1" } } as any;
    }
  };
};

test("試算：回の期間と違う計算書だけ出し直す。揃っている・回の無い・媒体の違う計算書は出さない", async () => {
  const service = new StatementPeriodReissueService(db(), fakeIssuer() as any);
  const r = await service.preview({ usageType: "pub_digital" });
  assert.deepEqual(r.targets.map((t) => [t.documentId, t.status, t.currentLabel, t.newLabel]), [
    [901, "change", "2025年8月分〜2026年3月分", "2025年7月〜2026年6月"],
    [902, "same", "2025年7月〜2026年6月", "2025年7月〜2026年6月"],
    [903, "no_round", "2025年8月分〜2026年3月分", null]
  ]);
  assert.equal(r.changing, 1);
});

test("試算：いま計算し直して額が変わる計算書は出し直さない（支払は元の額）", async () => {
  const service = new StatementPeriodReissueService(db(), fakeIssuer(91000) as any);
  const r = await service.preview({ usageType: "pub_digital" });
  assert.equal(r.targets[0].status, "amount");
  assert.equal(r.changing, 0);
});

test("出し直し：訂正版で、元の条件・実績・決定日のまま回の期間を渡す。焼き付けた行は引き継がない", async () => {
  const issuer = fakeIssuer();
  const service = new StatementPeriodReissueService(db(), issuer as any);
  const r = await service.run({ usageType: "pub_digital", documentIds: [901, 902] }, "tester");
  assert.equal(r.reissued, 1);
  assert.equal(issuer.issued.length, 1, "揃っている 902 は出さない");
  const input = issuer.issued[0];
  assert.deepEqual(input.entries, [{ conditionId: 7, payeePartyId: null, eventIds: [51, 52], period: "2025年7月〜2026年6月" }]);
  assert.equal(input.periodLabel, "2025年7月〜2026年6月");
  assert.deepEqual(input.supersedes, [901]);
  assert.equal(input.reason, "対象期間の表記を回の期間に揃える");
  assert.equal(input.issuedOn, "2026-06-30");
  assert.equal(input.templateKey, "royalty_statement_pub");
  assert.deepEqual(input.manualInputs, { notes: "備考" });
  assert.deepEqual(r.results.map((x) => [x.documentId, x.newDocumentNo]), [[901, "ARC-ROY-2026-1101-R1"], [902, null]]);
});
