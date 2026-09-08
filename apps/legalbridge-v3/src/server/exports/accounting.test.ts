import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNTING_COLUMNS, ACCOUNTING_SLOT_COUNT, buildAccountingRow, expectedWithholding,
  fitSlots, groupAccounting, totalRow, type AccountingSource, type AllocationLine
} from "./accounting.js";
import { toXls, xlsFilename } from "./xls.js";

const line = (over: Partial<AllocationLine> = {}): AllocationLine => ({
  conditionNo: "CND-2026-00001", name: "イラスト制作", taxCategory: "taxable",
  amount: 300000, quantity: null, unitAmount: null, occurredOn: "2026-09-30", ...over
});

const source = (over: Partial<AccountingSource> = {}): AccountingSource => ({
  paymentId: 1, paymentNo: "PAY-2026-00001", currency: "JPY",
  amount: 300000, taxAmount: 30000, withholdingAmount: 33693,
  dueOn: "2026-10-31", paidOn: null, status: "approved",
  party: { code: "P-001", name: "山田 花子", kana: "ヤマダ ハナコ",
           kind: "individual", invoiceNo: "T1234567890123", withholding: true },
  ownerName: "法務 太郎", ownerDepartment: "法務部",
  matterNo: "MTR-2026-00219", matterTitle: "イラスト制作の発注",
  lines: [line()], ...over
});

// ---- V1 から引き継ぐ規則 ----

test("列名と順番は V1 のまま", () => {
  const headers = ACCOUNTING_COLUMNS.map((c) => c.header);
  assert.deepEqual(headers.slice(0, 6),
    ["件名", "支払日", "部署", "取引先コード", "氏名", "氏名（カナ）"]);
  assert.equal(headers[6], "支払内容（1）");
  assert.equal(headers[6 + 5 * 7], "支払内容（8）");
  assert.deepEqual(headers.slice(46, 53),
    ["立替金", "小計", "消費税", "源泉税", "税引後", "差引振込額", "インボイス登録"]);
});

test("スロットは常に8つ", () => {
  assert.equal(fitSlots([]).length, ACCOUNTING_SLOT_COUNT);
  assert.equal(buildAccountingRow(source()).slots.length, ACCOUNTING_SLOT_COUNT);
});

test("9件目以降は8件目に束ねる。落とすと合計が合わなくなる", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    content: `明細${i + 1}`, unitPrice: "" as const, quantity: "" as const,
    amount: 100, deliveryDate: "2026-09-30"
  }));
  const fitted = fitSlots(many);
  assert.equal(fitted.length, 8);
  assert.equal(fitted[7].amount, 300, "8件目＋9件目＋10件目");
  assert.equal(fitted[7].content, "明細8／明細9／明細10");
  const total = fitted.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  assert.equal(total, 1000, "束ねても合計は変わらない");
});

test("源泉は税込ベース。100万円超は二段階（V1 と同じ）", () => {
  const individual = { kind: "individual", withholding: false };
  // 30万＋消費税3万＝33万 → floor(330000 × 0.1021)
  assert.equal(expectedWithholding(300000, 30000, individual), 33693);
  // 100万ちょうど
  assert.equal(expectedWithholding(1000000, 0, individual), 102100);
  // 超過分は 20.42%
  assert.equal(expectedWithholding(1100000, 0, individual),
    Math.floor(1000000 * 0.1021) + Math.floor(100000 * 0.2042));
});

test("法人で源泉OFFなら源泉は0", () => {
  assert.equal(expectedWithholding(300000, 30000, { kind: "corporate", withholding: false }), 0);
  // 法人でも源泉ONなら対象（V1 と同じく true 化のみ）
  assert.equal(expectedWithholding(300000, 30000, { kind: "corporate", withholding: true }), 33693);
});

test("税引後＝税込−源泉、差引振込額＝税引後＋立替金", () => {
  const row = buildAccountingRow(source({
    amount: 350000, taxAmount: 30000, withholdingAmount: 33693,
    lines: [line({ amount: 300000 }), line({ conditionNo: "CND-2", name: "交通費",
                                             taxCategory: "exempt", amount: 50000 })]
  }));
  assert.equal(row.subtotal, 300000, "非課税は小計に入れない");
  assert.equal(row.reimbursement, 50000);
  assert.equal(row.afterTax, 300000 + 30000 - 33693);
  assert.equal(row.netTransfer, row.afterTax + 50000);
});

test("8%は小計に入るが、課税10%とは別の列に出る", () => {
  const row = buildAccountingRow(source({
    amount: 300000,
    lines: [line({ amount: 200000 }), line({ conditionNo: "CND-2", taxCategory: "reduced", amount: 100000 })]
  }));
  assert.equal(row.taxable10, 200000);
  assert.equal(row.reduced8, 100000);
  assert.equal(row.subtotal, 300000);
});

// ---- V3 で足した安全策 ----

test("割当が無ければ支払額を課税として出し、印を付ける", () => {
  const row = buildAccountingRow(source({ lines: [] }));
  assert.equal(row.taxable10, 300000, "分からない内訳を勝手に非課税へ振らない");
  assert.equal(row.exempt, 0);
  assert.ok(row.flags.includes("unallocated"));
  assert.equal(row.slots[0].content, "", "支払内容は埋まらない");
});

test("割当の合計が支払額と合わなければ内訳に使わず、印を付ける", () => {
  const row = buildAccountingRow(source({
    amount: 300000,
    lines: [line({ amount: 100000, taxCategory: "exempt" })]   // 20万足りない
  }));
  assert.ok(row.flags.includes("allocationMismatch"));
  assert.equal(row.subtotal, 300000, "説明できない内訳で経理の列を埋めない");
  assert.equal(row.reimbursement, 0);
});

test("源泉が計算値と違えば印を付ける（申告が狂うので黙って出さない）", () => {
  const ok = buildAccountingRow(source());
  assert.ok(!ok.flags.includes("withholdingGap"));

  const gap = buildAccountingRow(source({ withholdingAmount: 0 }));
  assert.ok(gap.flags.includes("withholdingGap"));
  assert.equal(gap.withholdingExpected, 33693);
  assert.equal(gap.withholdingTax, 0, "出すのは保存値。実際に振り込む額だから");
});

test("束ねは支払期日×担当者×通貨。通貨を混ぜた合計を作らない", () => {
  const jpy = buildAccountingRow(source({ paymentId: 1 }));
  const usd = buildAccountingRow(source({ paymentId: 2, currency: "USD", amount: 1000 }));
  const groups = groupAccounting([jpy, usd], new Map([[1, "法務 太郎"], [2, "法務 太郎"]]));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.currency).sort(), ["JPY", "USD"]);
});

test("並びは支払期日の昇順、空は末尾（V1 と同じ）", () => {
  const rows = [
    buildAccountingRow(source({ paymentId: 1, dueOn: null })),
    buildAccountingRow(source({ paymentId: 2, dueOn: "2026-10-31" })),
    buildAccountingRow(source({ paymentId: 3, dueOn: "2026-09-30" }))
  ];
  const groups = groupAccounting(rows, new Map());
  assert.deepEqual(groups.map((g) => g.paymentDate), ["2026-09-30", "2026-10-31", ""]);
});

test("合計行は束の合計と一致する", () => {
  const rows = [
    buildAccountingRow(source({ paymentId: 1 })),
    buildAccountingRow(source({ paymentId: 2 }))
  ];
  const [group] = groupAccounting(rows, new Map());
  const total = totalRow(group);
  assert.equal(total.subtotal, 600000);
  assert.equal(total.consumptionTax, 60000);
  assert.equal(total.netTransfer, rows[0].netTransfer + rows[1].netTransfer);
  assert.equal(total.paymentNo, "合計");
});

// ---- Excel の形 ----

test("数値は数値のまま、文字列は書式を固定する", () => {
  const xls = toXls("経理", [
    { header: "コード", value: () => "0012" },
    { header: "金額", value: () => 300000 }
  ], [{}]);
  assert.match(xls, /<td style="mso-number-format:'\\@'">0012<\/td>/,
    "取引先コードの先頭0を Excel に落とさせない");
  assert.match(xls, /<td>300000<\/td>/, "金額は数値。合計が取れる形で出す");
});

test("Excel が拒む文字はファイル名から落とす", () => {
  assert.equal(xlsFilename(["経理提出用", "法務 太郎", "2026-10-31"]),
    "経理提出用_法務_太郎_2026-10-31.xls");
  assert.equal(xlsFilename([null, ""]), "export.xls");
});
