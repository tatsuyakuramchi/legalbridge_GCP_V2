import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountingRow, categoryOf, groupAccounting, v1AccountingCells, v1FileStem, v1SheetName,
  V1_ACCOUNTING_HEADERS, type AccountingSource
} from "./accounting.js";
import { buildXlsx } from "./xlsx.js";

/**
 * 経理提出用（V1 形式）。見出しは経理へ渡している実物（2026-09-25 に受領）から。
 * 値はすべて架空。
 */
const source = (over: Partial<AccountingSource> = {}): AccountingSource => ({
  paymentId: 1, paymentNo: "PAY-2026-00001", currency: "JPY",
  amount: 300000, taxAmount: 30000, withholdingAmount: 33693,
  dueOn: "2026-10-31", paidOn: null, status: "approved",
  party: { code: "P-001", name: "山田 花子", kana: "ヤマダ ハナコ",
           kind: "individual", invoiceNo: "T1234567890123", withholding: true },
  ownerName: "法務 太郎", ownerDepartment: "法務部",
  matterNo: "MTR-2026-00219", matterTitle: "イラスト制作の発注",
  lines: [{ conditionNo: "CND-2026-00001", name: "イラスト制作", taxCategory: "taxable",
            amount: 300000, quantity: null, unitAmount: null, occurredOn: "2026-09-30" }],
  document: { id: 7, number: "ARC-INS-2026-0001", templateKey: "inspection_certificate" },
  ...over
});

test("見出しは実物どおり：52 列・数字は全角・納品日だけ半角括弧・消費税の列なし", () => {
  const given = ("件名\t支払日\t部署\t取引先コード\t氏名\t氏名（カナ）\t"
    + "支払内容（１）\t単価（１）\t数量（１）\t金額（１）\t納品日(１)\t"
    + "支払内容（２）\t単価（２）\t数量（２）\t金額（２）\t納品日(２)\t"
    + "支払内容（３）\t単価（３）\t数量（３）\t金額（３）\t納品日(３)\t"
    + "支払内容（４）\t単価（４）\t数量（４）\t金額（４）\t納品日(４)\t"
    + "支払内容（５）\t単価（５）\t数量（５）\t金額（５）\t納品日(５)\t"
    + "支払内容（６）\t単価（６）\t数量（６）\t金額（６）\t納品日(６)\t"
    + "支払内容（７）\t単価（７）\t数量（７）\t金額（７）\t納品日(７)\t"
    + "支払内容（８）\t単価（８）\t数量（８）\t金額（８）\t納品日(８)\t"
    + "立替金\t小計\t源泉税\t税引後\t差引振込額\tインボイス登録").split("\t");
  assert.deepEqual(V1_ACCOUNTING_HEADERS, given);
  assert.equal(V1_ACCOUNTING_HEADERS.length, 52);
  assert.ok(!V1_ACCOUNTING_HEADERS.includes("消費税"));
});

test("小計は税込。小計 − 源泉税 ＝ 税引後、税引後 ＋ 立替金 ＝ 差引振込額", () => {
  const cells = v1AccountingCells(buildAccountingRow(source()));
  assert.equal(cells.length, 52);
  const at = (h: string) => cells[V1_ACCOUNTING_HEADERS.indexOf(h)] as number;
  assert.equal(at("小計"), 330000);
  assert.equal(at("源泉税"), 33693);
  assert.equal(at("税引後"), at("小計") - at("源泉税"));
  assert.equal(at("差引振込額"), at("税引後") + at("立替金"));
});

test("空のスロットは空欄（0 を入れない）、金額は数値のまま", () => {
  const cells = v1AccountingCells(buildAccountingRow(source()));
  const i = V1_ACCOUNTING_HEADERS.indexOf("金額（１）");
  assert.equal(cells[i], 300000);
  assert.equal(cells[V1_ACCOUNTING_HEADERS.indexOf("支払内容（２）")], null);
  assert.equal(cells[V1_ACCOUNTING_HEADERS.indexOf("金額（２）")], null);
});

test("種別：計算書のひな形なら利用許諾料計算書、書類が無ければ条件の種類で決める", () => {
  assert.equal(categoryOf("inspection_certificate"), "検収書");
  assert.equal(categoryOf("royalty_statement"), "利用許諾料計算書");
  assert.equal(categoryOf(null, ["license"]), "利用許諾料計算書");
  assert.equal(categoryOf(null, ["service", "expense"]), "検収書");
  assert.equal(categoryOf(null, []), "検収書");
});

test("束の中を 種別 × 個人／法人 に分け、ファイル名とシート名は V1 の形", () => {
  const rows = [
    buildAccountingRow(source()),
    buildAccountingRow(source({ paymentId: 2,
      party: { code: "P-002", name: "株式会社サンプル", kana: null, kind: "corporate",
               invoiceNo: null, withholding: false } })),
    buildAccountingRow(source({ paymentId: 3,
      document: { id: 9, number: "ARC-RS-2026-0001", templateKey: "royalty_statement" } }))
  ];
  const [group] = groupAccounting(rows, new Map([[1, "法務 太郎"], [2, "法務 太郎"], [3, "法務 太郎"]]));
  assert.deepEqual(group.v1Files, [
    { category: "検収書", entity: "個人", count: 1 },
    { category: "検収書", entity: "法人", count: 1 },
    { category: "利用許諾料計算書", entity: "個人", count: 1 }
  ]);
  assert.equal(v1FileStem("検収書", "個人", "2026-10-31"), "検収書_個人_2026-10-31");
  assert.equal(v1SheetName("検収書", "個人"), "検収書(個人)");
});

test("xlsx：シート名・見出し・数値セルが入る（Excel が開ける Office Open XML）", () => {
  const xlsx = buildXlsx([{ name: v1SheetName("検収書", "個人"),
    rows: [V1_ACCOUNTING_HEADERS, v1AccountingCells(buildAccountingRow(source()))] }]);
  assert.equal(xlsx.subarray(0, 2).toString("latin1"), "PK", "zip 形式");
  // 無圧縮なので中の XML がそのまま読める。
  const text = xlsx.toString("utf8");
  assert.ok(text.includes('<sheet name="検収書(個人)"'));
  assert.ok(text.includes("支払内容（１）"));
  assert.ok(text.includes("納品日(８)"));
  assert.ok(text.includes("<v>330000</v>"), "小計（税込）が数値セルで入る");
  assert.ok(text.includes("[Content_Types].xml"));
});
