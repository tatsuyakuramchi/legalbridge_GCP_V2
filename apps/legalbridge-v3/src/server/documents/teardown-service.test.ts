import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterTeardownService, warningsFor, type PlanDocument, type PlanPayment } from "./teardown-service.js";

const pay = (over: Partial<PlanPayment> = {}): PlanPayment =>
  ({ id: 1, paymentNo: "PAY-1", amount: 100, status: "planned", paidOn: null, blocked: null, ...over });
const doc = (over: Partial<PlanDocument> = {}): PlanDocument =>
  ({ id: 1, documentNo: "ARC-PO-1", templateLabel: "発注書", settlement: false,
     status: "issued", blocked: null, ...over });

const db = (over: Record<string, any[]> = {}) => new FakeDatabase((t) => {
  for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
  if (t.includes("FROM matters WHERE id")) {
    return [{ id: 1, matter_no: "RR241", title: "テストプレイヤーの発注" }];
  }
  if (t.includes("FROM conditions c\n           LEFT JOIN parties p")) {
    return [{ id: 7, condition_no: "CL-1", name: "挿絵 制作委託", party_name: "受託者名" }];
  }
  return [];
});

test("押す前に、無効にするものを全部出す", async () => {
  const plan = await new MatterTeardownService(db({
    "FROM payments y": [{ id: 50, payment_no: "PAY-2026-1", amount: 88000,
                          status: "planned", paid_on: null }],
    "FROM documents d": [
      { id: 60, document_no: "ARC-PO-1", status: "issued",
        template_key: "purchase_order", template_name: "発注書" },
      { id: 61, document_no: "ARC-INS-1", status: "issued",
        template_key: "inspection_certificate", template_name: "検収書" }
    ],
    "FROM condition_events e\n           JOIN conditions c": [
      { id: 90, condition_id: 7, condition_no: "CL-1", occurred_on: "2026-07-20",
        amount: 88000, document_no: "ARC-INS-1" }
    ]
  })).preview(1, { reason: "作り直すため" });

  assert.equal(plan.matter.matterNo, "RR241");
  assert.equal(plan.summary.payments, 1);
  assert.equal(plan.summary.documents, 2);
  assert.equal(plan.summary.events, 1);
  assert.equal(plan.summary.amount, 88000);
  // 検収書は決済文書、発注書は違う。順番を決めるのに使う。
  assert.equal(plan.documents.find((d) => d.documentNo === "ARC-INS-1")?.settlement, true);
  assert.equal(plan.documents.find((d) => d.documentNo === "ARC-PO-1")?.settlement, false);
});

test("条件は既定で残す（残さないと入れ直しが新しい条件番号になる）", async () => {
  const keep = await new MatterTeardownService(db()).preview(1, { reason: "x" });
  assert.equal(keep.voidConditions, false);
  assert.equal(keep.conditions.length, 0);
  assert.equal(keep.summary.conditions, 0);
  assert.match(keep.warnings.join("\n"), /条件明細は残します/);

  const drop = await new MatterTeardownService(db())
    .preview(1, { reason: "x", voidConditions: true });
  assert.equal(drop.conditions.length, 1);
  assert.match(drop.warnings.join("\n"), /新しい条件番号/);
});

test("支払済みは畳まない（払った事実は銀行にしかない）", async () => {
  const plan = await new MatterTeardownService(db({
    "FROM payments y": [
      { id: 50, payment_no: "PAY-1", amount: 100, status: "paid", paid_on: "2026-09-28" },
      { id: 51, payment_no: "PAY-2", amount: 200, status: "planned", paid_on: null }
    ]
  })).preview(1, { reason: "x" });
  assert.equal(plan.summary.payments, 1);
  assert.equal(plan.summary.blocked, 1);
  assert.match(plan.payments[0]?.blocked ?? "", /支払済み/);
  assert.equal(plan.payments[1]?.blocked, null);
});

test("畳む条件が1本も無ければ断る", async () => {
  const empty = new FakeDatabase((t) =>
    t.includes("FROM matters WHERE id")
      ? [{ id: 1, matter_no: "RR241", title: "x" }] : []);
  await assert.rejects(
    () => new MatterTeardownService(empty).preview(1, { reason: "x" }), /畳む条件明細がありません/);
});

test("無い案件は NOT_FOUND", async () => {
  await assert.rejects(
    () => new MatterTeardownService(new FakeDatabase(() => [])).preview(9, { reason: "x" }),
    /見つかりません/);
});

test("条件を絞れる（13人のうち一部だけ作り直す）", async () => {
  const database = db();
  await new MatterTeardownService(database).preview(1, { reason: "x", conditionIds: [7, 8] });
  const q = database.find("LEFT JOIN parties p")!;
  assert.deepEqual(q.params, [1, [7, 8]]);
  // 絞らないときは空配列。SQL 側で「空なら全部」に落ちる。
  const all = db();
  await new MatterTeardownService(all).preview(1, { reason: "x" });
  assert.deepEqual(all.find("LEFT JOIN parties p")!.params, [1, []]);
});

test("理由なしでは畳めない", async () => {
  await assert.rejects(
    () => new MatterTeardownService(db()).run(1, { reason: "  " }, "who"), /理由を書いて/);
});

test("押す前の注意：番号は戻らない", () => {
  const w = warningsFor({ payments: [], documents: [doc(), doc({ documentNo: null })],
                          voidConditions: false, blocked: 0 });
  assert.match(w.join("\n"), /番号を振って出した文書が 1 枚/);
  assert.match(w.join("\n"), /番号も戻りません/);
});

test("押す前の注意：支払済みは残す", () => {
  const w = warningsFor({ payments: [pay({ status: "paid" })], documents: [],
                          voidConditions: false, blocked: 1 });
  assert.match(w.join("\n"), /支払済みの支払が 1 件/);
});
