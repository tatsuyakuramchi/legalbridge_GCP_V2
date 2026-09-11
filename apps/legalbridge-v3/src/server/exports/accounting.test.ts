import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNTING_COLUMNS, ACCOUNTING_SLOT_COUNT, buildAccountingRow, expectedWithholding,
  fitSlots, groupAccounting, totalRow, type AccountingSource, type AllocationLine
} from "./accounting.js";
import { documentLinesFrom } from "./accounting-repository.js";
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

// ---- 出力済みの記録（監査記録は追記専用）----

test("取り消しは記録を消さず、取り消した記録を足す", async () => {
  const { AccountingExportLedger } = await import("./accounting-repository.js");
  const { FakeDatabase } = await import("../core/fake-db.js");

  const db = new FakeDatabase(() => []);
  await new AccountingExportLedger(db).unmark([1, 2], "legal@arch.co.jp");

  const q = db.find("INSERT INTO audit_events")!;
  assert.equal(q.params[3], "export.accounting.undo");
  // 003_grants.sql は audit_events の DELETE をランタイムロールから剥がしている。
  // 消しに行くと本番で権限エラーになる。
  assert.equal(db.all("DELETE").length, 0, "監査記録は追記専用");
  assert.equal(db.all("UPDATE audit_events").length, 0);
});

test("出力済みも取り消しも、状態が変わるときだけ書く", async () => {
  const { AccountingExportLedger } = await import("./accounting-repository.js");
  const { FakeDatabase } = await import("../core/fake-db.js");

  const db = new FakeDatabase(() => []);
  await new AccountingExportLedger(db).markExported([1], "b", "a");
  const sql = db.find("INSERT INTO audit_events")!.text;
  assert.match(sql, /IS DISTINCT FROM \$4/, "同じ状態なら書かない");
  // unnest の列は必ず名前を付ける。付けないと副問い合わせの中で
  // audit_events.id が優先され、別の行を見に行く。
  assert.match(sql, /unnest\(\$1::bigint\[\]\) AS t\(payment_id\)/);
  assert.match(sql, /a\.target_id = t\.payment_id/);
});

test("空の指定では何も書かない", async () => {
  const { AccountingExportLedger } = await import("./accounting-repository.js");
  const { FakeDatabase } = await import("../core/fake-db.js");

  const db = new FakeDatabase(() => []);
  assert.equal(await new AccountingExportLedger(db).markExported([], "b", "a"), 0);
  assert.equal(await new AccountingExportLedger(db).markExported([0, -1, NaN], "b", "a"), 0);
  assert.equal(db.queries.length, 0);
});

test("支払内容は書類の明細から出す（V1・V2 と同じ）", () => {
  const row = buildAccountingRow(source({
    documentLines: [
      { content: "第2回 キャラクターデザイン一式", unitPrice: 280000, quantity: 1,
        amount: 280000, deliveryDate: "2026-08-31" },
      { content: "『ワンダラス・クリーチャーズ』の翻訳", unitPrice: null, quantity: 1,
        amount: 100000, deliveryDate: "2026-08-31" }
    ]
  }));
  assert.equal(row.slots[0].content, "第2回 キャラクターデザイン一式");
  assert.equal(row.slots[0].unitPrice, 280000);
  assert.equal(row.slots[0].deliveryDate, "2026-08-31");
  assert.equal(row.slots[1].content, "『ワンダラス・クリーチャーズ』の翻訳");
  assert.equal(row.slots[1].unitPrice, "", "単価が無ければ空。0 は出さない");
});

test("書類が無い支払（手で起こした分）は割当から組む", () => {
  const row = buildAccountingRow(source());
  assert.notEqual(row.slots[0].content, "");
});

test("書類の明細は「今回の分」だけを支払内容にする", () => {
  const lines = documentLinesFrom({
    delivery_line_items: [
      { item_name: "第1回 本文原稿", inspection_status: "done",
        inspected_amount_ex_tax: 280000, delivery_date: "2026-04-30" },
      { item_name: "第2回 挿絵", inspection_status: "now", inspected_quantity: 1,
        unit_price: 280000, inspected_amount_ex_tax: 280000, delivery_date: "2026-05-31T00:00:00Z" },
      { item_name: "第3回 装丁", inspection_status: "pending", inspected_amount_ex_tax: 280000 }
    ],
    other_fees: [
      { fee_name: "振込手数料", amount_ex_tax: 550, tax_category: "taxable" },
      { fee_name: "立替の交通費", amount_ex_tax: 1200, tax_category: "exempt" }
    ]
  });
  assert.deepEqual(lines.map((l) => l.content), ["第2回 挿絵", "振込手数料"]);
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].unitPrice, 280000);
  assert.equal(lines[0].deliveryDate, "2026-05-31", "日付は10文字に切る");
  assert.equal(lines[1].amount, 550, "課税の手数料は支払内容に載る");
});

test("印の無い行はそのまま今回の分として扱う", () => {
  const lines = documentLinesFrom({
    delivery_line_items: [{ item_name: "翻訳", amount_ex_tax: 100000 }]
  });
  assert.deepEqual(lines.map((l) => l.content), ["翻訳"]);
  assert.equal(lines[0].amount, 100000);
});

test("書類が空なら明細も空（割当から組む側へ落ちる）", () => {
  assert.deepEqual(documentLinesFrom(null), []);
  assert.deepEqual(documentLinesFrom({}), []);
});

test("継続課金の1期分は数量1・単価＝金額で出す（V2 と同じ）", () => {
  const lines = documentLinesFrom({
    delivery_line_items: [
      { item_name: "月額サポート 2026年8月", calc_method: "SUBSCRIPTION",
        inspected_amount_ex_tax: 50000, inspected_quantity: 0 }
    ]
  });
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].unitPrice, 50000);
});
