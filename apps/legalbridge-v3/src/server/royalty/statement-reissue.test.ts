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

test("出し直し：担当者を選べば訂正版の担当にする（選ばなければ元の担当のまま）", async () => {
  const issuer = fakeIssuer();
  const service = new StatementPeriodReissueService(db(), issuer as any);
  await service.run({ usageType: "pub_digital", documentIds: [901], ownerStaffId: 12 }, "tester");
  assert.deepEqual(issuer.issued[0].manualInputs, { notes: "備考", _ownerStaffId: 12 });
});

/** 902（もう回の期間で出ている）が個人宛て・担当なし・古いひな形。回 100 の支払日は 2026-10-31。 */
const dbFor = (over: { paid?: boolean } = {}) => new FakeDatabase((text, params) => {
  if (text.includes("FROM documents d")) return [
    head({ id: 902, document_no: "ARC-ROY-2026-1102", statement_id: 2, condition_id: 8,
           printed_label: "2025年7月〜2026年6月", period: "2025年7月〜2026年6月",
           printed_pay_on: "2026-10-31", owner_staff_id: null, old_template: true, party_kind: "individual", pay_party_id: 31 })
  ];
  if (text.includes("FROM statements s")) return [{ statement_id: 2, event_id: 61, ...ROUND, pay_on: "2026-10-31" }];
  if (text.includes("p.status = 'paid'")) return over.paid ? [{ event_id: 61 }] : [];
  if (text.startsWith("\n      UPDATE payments") || text.includes("UPDATE payments p SET due_on")) return [{ id: 700 }];
  return undefined;
});

test("担当者・支払日：揃っている計算書でも、担当者を入れる・個人宛ての支払日を 20 日にするなら出し直す", async () => {
  const issuer = fakeIssuer();
  const database = dbFor();
  const service = new StatementPeriodReissueService(database, issuer as any, () => "2026-10-19");

  const plain = await service.preview({ usageType: "pub_digital" });
  assert.equal(plain.targets[0].status, "same", "何も選ばなければ揃っている");

  const both = await service.preview({ usageType: "pub_digital", ownerStaffId: 12, individualPayDay: true });
  assert.deepEqual([both.targets[0].status, both.targets[0].reasons, both.targets[0].currentPayOn, both.targets[0].newPayOn],
                   ["change", ["staff", "payday"], "2026-10-31", "2026-10-20"]);

  const r = await service.run({ usageType: "pub_digital", documentIds: [902], ownerStaffId: 12, individualPayDay: true }, "tester");
  assert.equal(r.reissued, 1);
  assert.equal(issuer.issued[0].reason, "担当者を記載する・支払日を 20 日に改める");
  assert.equal(issuer.issued[0].manualInputs._ownerStaffId, 12);
  const moved = database.all("UPDATE condition_schedules SET pay_on");
  assert.deepEqual(moved.map((q) => q.params), [[100, "2026-10-20"]], "出し直す前に回を 20 日に");
  assert.deepEqual(database.find("UPDATE payments p SET due_on")!.params, [[61], 31], "未払いの支払の期日も");
  assert.equal(r.results[0].paymentsUpdated, 1);
});

test("支払日：支払済みなら直さない。出し直しに失敗したら回の支払日を元に戻す", async () => {
  const paid = await new StatementPeriodReissueService(dbFor({ paid: true }), fakeIssuer() as any, () => "2026-10-19")
    .preview({ usageType: "pub_digital", individualPayDay: true });
  assert.equal(paid.targets[0].status, "same");
  assert.match(paid.targets[0].message ?? "", /支払済み/);

  const database = dbFor();
  const failing = { ...fakeIssuer(), issue: async () => { throw new Error("発行できません"); } };
  const r = await new StatementPeriodReissueService(database, failing as any, () => "2026-10-19")
    .run({ usageType: "pub_digital", documentIds: [902], individualPayDay: true }, "tester");
  assert.equal(r.results[0].status, "error");
  assert.deepEqual(database.all("UPDATE condition_schedules SET pay_on").map((q) => q.params),
                   [[100, "2026-10-20"], [100, "2026-10-31"]], "元に戻す");
  assert.equal(database.find("UPDATE payments p SET due_on"), undefined, "支払の期日は触らない");
});

test("取り分の表示：受取人宛ての計算書で、行に取り分が無ければ（前に出した紙）出し直す", async () => {
  const database = new FakeDatabase((text) => {
    if (text.includes("FROM documents d")) return [
      head({ id: 902, document_no: "ARC-ROY-2026-1049-R3", statement_id: 2, condition_id: 8, payee_party_id: 2534,
             printed_label: "2025年7月〜2026年6月", period: "2025年7月〜2026年6月", no_share_lines: true }),
      head({ id: 905, document_no: "ARC-ROY-2026-1050", statement_id: 5, condition_id: 9, payee_party_id: 2534,
             printed_label: "2025年7月〜2026年6月", period: "2025年7月〜2026年6月", no_share_lines: false })
    ];
    if (text.includes("FROM statements s")) return [
      { statement_id: 2, event_id: 61, ...ROUND }, { statement_id: 5, event_id: 62, ...ROUND }
    ];
    return [];
  });
  const issuer = fakeIssuer();
  const service = new StatementPeriodReissueService(database, issuer as any);
  const r = await service.preview({ usageType: "pub_digital" });
  assert.deepEqual(r.targets.map((t) => [t.documentId, t.status, t.reasons]), [[902, "change", ["share"]], [905, "same", []]]);
  await service.run({ usageType: "pub_digital", documentIds: [902] }, "tester");
  assert.equal(issuer.issued[0]!.reason, "共著の取り分の計算を記載する");
});
