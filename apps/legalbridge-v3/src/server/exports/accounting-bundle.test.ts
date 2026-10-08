import test from "node:test";
import assert from "node:assert/strict";
import { buildAccountingBundle } from "./accounting-bundle.js";
import type { AccountingRow } from "./accounting.js";
import { totalRow } from "./accounting.js";

/** 1 行分。種別・個人法人・支払日・書類だけ変える。 */
const row = (over: Partial<AccountingRow>): AccountingRow => ({
  ...totalRow({ key: "k", paymentDate: "", owner: "", currency: "JPY", count: 0, rows: [], flagged: 0,
                v1Files: [], totals: { subtotal: 0, consumptionTax: 0, withholdingTax: 0, reimbursement: 0, netTransfer: 0 } }),
  paymentNo: "PAY-1", title: "件名", category: "利用許諾料計算書", entity: "個人", paymentDate: "2026-10-20",
  documentId: 10, documentNo: "ARC-RS-2026-0001", ...over
});

test("種別 × 個人／法人 × 支払日 ごとに xlsx を分け、書類の PDF を 1 枚ずつ入れる", async () => {
  const asked: number[] = [];
  const bundle = await buildAccountingBundle([
    row({ paymentId: 1 }),
    row({ paymentId: 2, documentId: 10 }),                       // 同じ書類は PDF 1 枚
    row({ paymentId: 3, entity: "法人", documentId: 11, documentNo: "ARC-RS-2026-0002" }),
    row({ paymentId: 4, category: "検収書", documentId: null, documentNo: null, paymentNo: "PAY-4" })
  ], { pdf: async (id) => { asked.push(id); return new Uint8Array([1]); } });
  assert.deepEqual(bundle.files, [
    "検収書_個人_2026-10-20.xlsx",
    "利用許諾料計算書_個人_2026-10-20.xlsx",
    "利用許諾料計算書_法人_2026-10-20.xlsx",
    "ARC-RS-2026-0001.pdf",
    "ARC-RS-2026-0002.pdf"
  ]);
  assert.deepEqual(asked, [10, 11]);
  assert.deepEqual(bundle.missing, ["PAY-4（元になった書類がありません）"]);
  assert.equal(bundle.name, "支払申請_2026-10-20.zip");
});

test("PDF を作れなかった書類は理由を並べ、xlsx は出す。withPdf=false なら PDF を探さない", async () => {
  const failed = await buildAccountingBundle([row({ paymentId: 1 })],
    { pdf: async () => { throw new Error("x"); } });
  assert.deepEqual(failed.missing, ["ARC-RS-2026-0001（PDF を作れませんでした）"]);
  assert.equal(failed.files.length, 1);
  const noPdf = await buildAccountingBundle([row({ paymentId: 1 }), row({ paymentId: 2, paymentDate: "2026-10-31" })],
    { pdf: async () => { throw new Error("呼ばれない"); } }, { withPdf: false });
  assert.deepEqual(noPdf.missing, []);
  assert.equal(noPdf.name, "支払申請_2026-10-20_2026-10-31.zip");
});

test("全部まとめて 1 つの xlsx：種別 × 個人／法人ごとのシート（支払日が 2 つ以上ならシート名に日付）、または 1 シートに全部", async () => {
  const { combinedAccountingSheets } = await import("./accounting-bundle.js");
  const rows = [
    row({ paymentId: 1 }),
    row({ paymentId: 2, entity: "法人", documentId: 11 }),
    row({ paymentId: 3, category: "検収書", paymentDate: "2026-10-20" }),
    row({ paymentId: 4, category: "検収書", paymentDate: "2026-10-31" })
  ];
  const sheets = combinedAccountingSheets(rows, "sheets");
  assert.deepEqual(sheets.map((s) => [s.name, s.rows.length - 1]), [
    ["検収書(個人)_2026-10-20", 1], ["検収書(個人)_2026-10-31", 1],
    ["利用許諾料計算書(個人)", 1], ["利用許諾料計算書(法人)", 1]
  ]);
  const one = combinedAccountingSheets(rows, "one");
  assert.equal(one.length, 1);
  assert.equal(one[0].rows.length, 1 + 4, "見出し 1 行 ＋ 4 件");
  assert.ok(sheets.every((s) => s.name.length <= 31), "Excel のシート名は 31 文字まで");
});
