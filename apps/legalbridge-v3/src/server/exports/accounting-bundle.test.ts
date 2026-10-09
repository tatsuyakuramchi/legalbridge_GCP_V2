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

test("支払先ごとにまとめる：同じ支払先の支払を 1 行に足し、支払内容は 1 組（作品数と合計）。PDF は元の書類ごとに全部", async () => {
  const { mergeByPayee, V1_ACCOUNTING_HEADERS } = await import("./accounting.js");
  const { combinedAccountingSheets } = await import("./accounting-bundle.js");
  const slot = (content: string, amount: number) => ({ content, unitPrice: "" as const, quantity: "" as const, amount, deliveryDate: "2026-06-30" });
  const empty = { content: "", unitPrice: "" as const, quantity: "" as const, amount: "" as const, deliveryDate: "" };
  const nine = Array.from({ length: 9 }, (_, i) => slot(`作品${i + 1}`, 1000));
  const wakiya = (over: Partial<AccountingRow>) => row({
    vendorCode: "V-1", vendorName: "脇屋彰太", invoiceRegistration: "", subtotal: 0, consumptionTax: 0,
    withholdingTax: 0, afterTax: 0, netTransfer: 0, reimbursement: 0, ...over
  });
  const rows = [
    wakiya({ paymentId: 1, documentId: 31, documentNo: "ARC-ROY-2026-1031", title: "キズナバレット 利用許諾料のご報告",
             slots: nine.slice(0, 8), moreSlots: [[nine[8], ...Array(7).fill(empty)]],
             subtotal: 9000, consumptionTax: 900, withholdingTax: 918, afterTax: 8982, netTransfer: 8982 }),
    wakiya({ paymentId: 2, documentId: 28, documentNo: "ARC-ROY-2026-1028", title: "プリンセスウイング 利用許諾料のご報告",
             slots: [slot("プリンセスウイング", 2000), ...Array(7).fill(empty)],
             subtotal: 2000, consumptionTax: 200, withholdingTax: 204, afterTax: 1996, netTransfer: 1996 }),
    row({ paymentId: 3, vendorCode: "V-2", vendorName: "伊藤圭亮", documentId: 21, slots: [slot("光砕のリヴァルチャー", 500), ...Array(7).fill(empty)],
          subtotal: 500, consumptionTax: 50, withholdingTax: 0, afterTax: 550, netTransfer: 550 })
  ];
  const merged = mergeByPayee(rows);
  assert.equal(merged.length, 2, "脇屋彰太の 2 件は 1 行");
  const w = merged.find((r) => r.vendorName === "脇屋彰太")!;
  assert.deepEqual([w.slots[0].content, w.slots[0].amount, w.slots.length, w.moreSlots],
                   ["利用許諾料（10作品分）", 11000, 8, undefined]);
  assert.ok(w.slots.slice(1).every((s) => !s.content && s.amount === ""), "2 組目以降は空");
  assert.deepEqual([w.subtotal, w.consumptionTax, w.withholdingTax, w.netTransfer], [11000, 1100, 1122, 10978]);
  assert.equal(w.title, "キズナバレット 利用許諾料のご報告 ほか1件");
  // 締めの回が分かれば、支払内容の名前は回の名前（利用期間）。
  const withRound = mergeByPayee(rows.map((r) => ({ ...r, roundLabels: ["2025年7月〜2026年6月"] })));
  assert.equal(withRound.find((r) => r.vendorName === "脇屋彰太")!.slots[0].content, "2025年7月〜2026年6月");

  const sheet = combinedAccountingSheets(rows, "sheets", { merge: true })[0];
  assert.equal(sheet.rows.length, 1 + 2, "続きの行が無く、支払先ごとに 1 行");
  assert.equal(sheet.rows[0].length, V1_ACCOUNTING_HEADERS.length, "52 列の形は変えない");

  const asked: number[] = [];
  const bundle = await buildAccountingBundle(rows, { pdf: async (id) => { asked.push(id); return new Uint8Array([1]); } }, { merge: true });
  assert.deepEqual(asked, [31, 28, 21], "PDF は元の書類ごとに全部");
  assert.equal(bundle.files.filter((f) => f.endsWith(".xlsx")).length, 1);
});
