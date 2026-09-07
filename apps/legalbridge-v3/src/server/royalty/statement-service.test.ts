import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { RoyaltyStatementService } from "./statement-service.js";
import { DomainError } from "../core/errors.js";

interface Options {
  conditionStatus?: string;
  documentStatus?: string;
  agConsumed?: number;
  hasStatement?: boolean;
  partyKind?: string;
  withholding?: boolean;
  mg?: number | null;
  ag?: number | null;
}

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) {
    return [{ id: 6, status: options.documentStatus ?? "issued" }];
  }
  if (text.includes("FROM statements WHERE document_id")) {
    return options.hasStatement ? [{ id: 99 }] : [];
  }
  if (text.includes("FROM conditions c LEFT JOIN parties p")) {
    return [{ id: 5, condition_no: "CL-2026-00042", currency: "JPY",
              pricing_model: "revenue_rate", rate_ppm: 125000,
              unit_amount: null, flat_amount: null,
              mg_amount: options.mg ?? null, ag_amount: options.ag ?? null,
              tax_category: "taxable", status: options.conditionStatus ?? "active",
              withholding: options.withholding ?? false,
              party_kind: options.partyKind ?? "corporate" }];
  }
  if (text.includes("SUM(deductions)")) return [{ consumed: options.agConsumed ?? 0 }];
  if (text.includes("INSERT INTO condition_events")) return [{ id: 700 }];
  if (text.includes("INSERT INTO statements")) return [{ id: 800 }];
  return undefined;
};

const service = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  return { db, service: new RoyaltyStatementService(db) };
};

test("試算は書き込まない", async () => {
  const { db, service: royalty } = service();
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.fee.gross_ex_tax, 612000, "489.6万 × 12.5% = 61.2万");
  assert.equal(result.amounts.netMinor, 612000);
  assert.equal(db.all("INSERT").length, 0, "INSERT は1つも走らない");
});

test("確定は実績・計算書・明細を1トランザクションで書く", async () => {
  const { db, service: royalty } = service({ ag: 800000 });
  const result = await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2026上期",
    reported: { salesInput: 4896000 }
  }, "kuramochi");

  assert.equal(result.statementId, 800);
  assert.equal(result.eventId, 700);

  const event = db.find("INSERT INTO condition_events");
  assert.equal(event!.params[8], 612000 - 612000, "AGで全額相殺され実額はゼロ");
  assert.equal(event!.params[7], 612000, "相殺額を deductions に積む（次回の消化済み累計になる）");

  const statement = db.find("INSERT INTO statements");
  assert.equal(statement!.params[6], 612000, "ag_offset");
  assert.ok(db.find("INSERT INTO statement_lines"));
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "royalty.finalize");
  assert.ok(db.texts.includes("COMMIT"));
});

test("確定時はフォームの値を使わず計算し直す（消化済みAGを読む）", async () => {
  const { db, service: royalty } = service({ ag: 800000, agConsumed: 500000 });
  await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2026下期", reported: { salesInput: 4896000 }
  }, "kuramochi");

  assert.ok(db.find("SUM(deductions)"), "消化済みAGをDBから読む");
  const event = db.find("INSERT INTO condition_events");
  // AG残 30万 → 相殺30万、実額 61.2万 − 30万 = 31.2万
  assert.equal(event!.params[7], 300000);
  assert.equal(event!.params[8], 312000);
});

test("MGは下限として効き、消化されない", async () => {
  const { db, service: royalty } = service({ mg: 1200000 });
  const preview = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4000000 }
  });
  assert.equal(preview.fee.actual_ex_tax, 1200000);
  assert.equal(preview.amounts.mgTopupMinor, 700000);
  assert.equal(preview.amounts.agOffsetMinor, 0);
  void db;
});

test("相手先が個人なら源泉を自動で対象にする", async () => {
  const { service: royalty } = service({ partyKind: "individual" });
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.payment.withholdingEnabled, true);
  // 税抜 612,000 + 消費税 61,200 = 673,200 → 源泉 floor(673200 × 10.21%)
  assert.equal(result.payment.taxIncluded, 673200);
  assert.equal(result.payment.withholdingTax, Math.floor(673200 * 0.1021));
  assert.equal(result.payment.netTransfer, 673200 - Math.floor(673200 * 0.1021));
});

test("法人で源泉フラグが無ければ源泉は引かない", async () => {
  const { service: royalty } = service({ partyKind: "corporate" });
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.payment.withholdingEnabled, false);
  assert.equal(result.payment.withholdingTax, 0);
});

test("発行済みでない文書には計算書を結び付けない", async () => {
  const { db, service: royalty } = service({ documentStatus: "draft" });
  await assert.rejects(
    () => royalty.finalize({ conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 1 } }, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  assert.ok(db.texts.includes("ROLLBACK"));
});

test("同じ文書に二重の計算書は作らない", async () => {
  const { service: royalty } = service({ hasStatement: true });
  await assert.rejects(
    () => royalty.finalize({ conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 1 } }, "x"),
    (e: unknown) => e instanceof DomainError && /すでに計算書/.test(e.message));
});

test("無効・旧版の条件では計算しない", async () => {
  for (const status of ["void", "superseded"]) {
    const { service: royalty } = service({ conditionStatus: status });
    await assert.rejects(
      () => royalty.preview({ conditionId: 5, period: "2026上期", reported: { salesInput: 1 } }),
      (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  }
});
