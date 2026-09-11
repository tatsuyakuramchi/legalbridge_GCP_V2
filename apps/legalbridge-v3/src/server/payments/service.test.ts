import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PaymentService } from "./service.js";
import { DomainError } from "../core/errors.js";

interface Options {
  direction?: "in" | "out";      // 条件の向き
  partyKind?: string;
  withholding?: boolean;
  occurredOn?: string;
  duplicated?: boolean;
  noParty?: boolean;
  /** 1枚に何本の計算書が載っているか。上書きしたい列だけ書く。 */
  statements?: Array<Record<string, unknown>>;
}

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM statements s")) {
    return (options.statements ?? [{}]).map((over, i) => ({
      statement_id: 800 + i, condition_id: 5 + i * 4,
      currency: "JPY", net_amount: 612000, tax_amount: 61200,
              period: "2026上期", direction: options.direction ?? "in",
              tax_category: "taxable", counterparty_id: options.noParty ? null : 2,
              party_kind: options.partyKind ?? "individual", withholding: options.withholding ?? false,
              party_name: "如月 涼", event_id: 700 + i,
              occurred_on: options.occurredOn ?? "2026-06-20", ...over }));
  }
  if (text.includes("JOIN payment_allocations a ON a.payment_id = p.id")) {
    return options.duplicated ? [{ id: 55 }] : [];
  }
  if (text.includes("INSERT INTO payments")) return [{ id: 900 }];
  if (text.includes("UPDATE payments")) return [{ id: 900, due_on: "2026-08-19", basis_received_on: "2026-06-20" }];
  return undefined;
};

const svc = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  return { db, service: new PaymentService(db) };
};

test("計算書から支払を起こし、必ず条件と実績に割り当てる", async () => {
  const { db, service } = svc();
  const result = await service.createFromStatementDocument(26, "kuramochi");

  assert.equal(result.paymentId, 900);
  assert.equal(result.direction, "out", "取得（IN）条件なので自社が支払う");
  const allocation = db.find("INSERT INTO payment_allocations");
  assert.deepEqual(allocation!.params, [900, 5, 700, 612000]);
  assert.ok(db.texts.includes("COMMIT"));
});

test("束ねた計算書は、1枚につき1件の支払にまとめる", async () => {
  // 条件ごとに支払を立てると、相手先に1枚しか出していないのに支払が何件も並び、
  // 経理提出用の表も行がばらける。支払は文書1枚につき1件、割当は条件ごと。
  const { db, service } = svc({
    statements: [
      {},
      { net_amount: 57600, tax_amount: 5760, occurred_on: "2026-07-31" }
    ]
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");

  assert.equal(db.all("INSERT INTO payments").length, 1, "支払は1件");
  assert.equal(result.amount, 612000 + 57600, "条件ごとの実額を足す");
  assert.equal(result.tax, 61200 + 5760, "消費税も条件ごとの額を足す");
  const allocations = db.all("INSERT INTO payment_allocations");
  assert.deepEqual(allocations.map((a) => a.params),
    [[900, 5, 700, 612000], [900, 9, 701, 57600]], "割当は条件ごと");
  assert.equal(result.dueOn, "2026-09-29", "起算日はいちばん遅い実績（2026-07-31）の +60日");
});

test("支払期日は受領日 +60日を既定にする", async () => {
  const { service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-19");
  assert.equal(result.due.verdict, "ok");
  assert.equal(result.due.days, 60);
});

test("期日を61日以降にすると超過として記録に残る", async () => {
  const { db, service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi", { dueOn: "2026-08-27" });
  assert.equal(result.due.verdict, "over_limit");
  assert.equal(result.due.overBy, 8);
  const issue = db.find("PAYMENT_DUE_OVER_LIMIT");
  assert.ok(issue, "データ品質の記録に残す");
});

test("個人への支払は源泉を引く", async () => {
  const { service } = svc({ partyKind: "individual" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  // 税抜 612,000 + 消費税 61,200 = 673,200 → floor(× 10.21%)
  assert.equal(result.withholding, Math.floor(673200 * 0.1021));
});

test("受け取る側（許諾）では源泉を引かない", async () => {
  const { service } = svc({ direction: "out", partyKind: "individual" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.direction, "in", "許諾（OUT）条件なので入金");
  assert.equal(result.withholding, 0);
});

test("同じ実績に二重の支払は作らない", async () => {
  const { db, service } = svc({ duplicated: true });
  await assert.rejects(() => service.createFromStatementDocument(26, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT" && /#55/.test(e.message));
  assert.equal(db.all("INSERT INTO payments").length, 0);
});

test("相手先が未設定の条件からは支払を作らない", async () => {
  const { service } = svc({ noParty: true });
  await assert.rejects(() => service.createFromStatementDocument(26, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION");
});

test("支払を記録すると期日超過の記録が閉じる", async () => {
  const { db, service } = svc();
  await service.markPaid(900, "2026-08-15", "kuramochi");
  const resolved = db.find("SET status = 'resolved'");
  assert.ok(resolved, "期日超過の記録を閉じる");
  assert.deepEqual(resolved!.params, [900]);
});
