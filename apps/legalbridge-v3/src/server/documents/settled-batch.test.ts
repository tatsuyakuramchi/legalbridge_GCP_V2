import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictsOf, groupRows, ownershipOfRows, readPaymentState, readRows,
  scheduleLinesFrom, templateCsv, toCsv, type SettledRow
} from "./settled-batch.js";

const HEAD = "取引先コード,取引先名,作品コード,作品名,契約番号,条件名,品目・業務名,仕様・成果物,"
  + "数量,単価（税抜）,発注日,納品日,検収日,検収額（税抜）,支払期日,支払状態,入金日,"
  + "契約形式,支払条件,成果物の帰属先,発注署名欄,承諾署名欄,特約の定型文,特約,備考";

/** 1行ぶんの値。既定は「読める行」で、直したいところだけ渡す。 */
const line = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    partyCode: "VD-1", partyName: "甲社", workCode: "", workTitle: "",
    agreementNo: "", conditionName: "", itemName: "表紙", spec: "",
    quantity: "1", unitPrice: "100000",
    orderedOn: "2026-06-01", deliveredOn: "2026-07-20", inspectedOn: "2026-07-25",
    inspectedAmount: "", dueOn: "2026-08-31", paymentState: "", paidOn: "",
    contractForm: "請負", paymentTerms: "月末締め翌月末払い", ownership: "発注者",
    orderSign: "", acceptSign: "", snippet: "", specialTerms: "", remarks: "",
    ...over
  };
  // カンマを含む値は引用する。引用しないと欄がずれて、金額の桁区切りを
  // 試すつもりのテストが「列の取り違え」を試すものになる。
  const cell = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [base.partyCode, base.partyName, base.workCode, base.workTitle,
          base.agreementNo, base.conditionName, base.itemName, base.spec,
          base.quantity, base.unitPrice, base.orderedOn, base.deliveredOn,
          base.inspectedOn, base.inspectedAmount, base.dueOn, base.paymentState,
          base.paidOn, base.contractForm, base.paymentTerms, base.ownership,
          base.orderSign, base.acceptSign, base.snippet, base.specialTerms,
          base.remarks].map(cell).join(",");
};
const csv = (...rows: string[]) => [HEAD, ...rows].join("\n");

test("読める行は不備なしで、発注額と検収額が出る", () => {
  const [row] = readRows(csv(line({ quantity: "12", unitPrice: "8000" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.orderedAmount, 96000);
  assert.equal(row.inspectedAmount, 96000, "検収額が空なら発注額と同じ");
  assert.equal(row.orderedOn, "2026-06-01");
  assert.equal(row.inspectedOn, "2026-07-25");
  assert.equal(row.paymentState, "planned", "支払状態が空なら未払");
});

test("減額検収は検収額の列に書く。発注額は発注額のまま残る", () => {
  // 発注額を検収額で上書きしてしまうと、検収書の「金額が変わった」判定が
  // 効かなくなり、変更内容の確認欄が出ない。
  const [row] = readRows(csv(line({ quantity: "12", unitPrice: "8000", inspectedAmount: "88,000" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.orderedAmount, 96000);
  assert.equal(row.inspectedAmount, 88000);
});

test("日付は 2026/07/25 でも読む", () => {
  const [row] = readRows(csv(line({ inspectedOn: "2026/07/25" })));
  assert.equal(row.inspectedOn, "2026-07-25");
  assert.deepEqual(row.issues, []);
});

test("発注日・納品日・検収日は必須", () => {
  const [row] = readRows(csv(line({ orderedOn: "", deliveredOn: "", inspectedOn: "" })));
  assert.deepEqual(row.issues, ["発注日が空", "納品日が空", "検収日が空"]);
});

test("日付の前後が逆なら不備にする。列の取り違えに金額より先に気づける", () => {
  const [row] = readRows(csv(line({ orderedOn: "2026-07-20", deliveredOn: "2026-06-01" })));
  assert.ok(row.issues.some((m) => /納品日（2026-06-01）が発注日（2026-07-20）より前/.test(m)));
  const [row2] = readRows(csv(line({ deliveredOn: "2026-07-20", inspectedOn: "2026-07-01" })));
  assert.ok(row2.issues.some((m) => /検収日（2026-07-01）が納品日（2026-07-20）より前/.test(m)));
});

test("支払済みには入金日が要る", () => {
  const [row] = readRows(csv(line({ paymentState: "支払済み" })));
  assert.ok(row.issues.some((m) => /入金日が要ります/.test(m)));
  const [ok] = readRows(csv(line({ paymentState: "支払済み", paidOn: "2026-08-30" })));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.paymentState, "paid");
  assert.equal(ok.paidOn, "2026-08-30");
});

test("入金日があるのに未払、入金日が検収より前、はどちらも不備", () => {
  const [row] = readRows(csv(line({ paidOn: "2026-08-30" })));
  assert.ok(row.issues.some((m) => /支払状態が 未払 です/.test(m)));
  const [row2] = readRows(csv(line({ paymentState: "支払済み", paidOn: "2026-07-01" })));
  assert.ok(row2.issues.some((m) => /入金日（2026-07-01）が検収日（2026-07-25）より前/.test(m)));
});

test("支払状態の言い換えを読む", () => {
  assert.equal(readPaymentState(""), "planned");
  assert.equal(readPaymentState("未払い"), "planned");
  assert.equal(readPaymentState("支払済"), "paid");
  assert.equal(readPaymentState("入金済み"), "paid");
  assert.equal(readPaymentState("保留"), null);
});

test("検収額 0 は弾く。0 の実績からは支払を作れない", () => {
  const [row] = readRows(csv(line({ inspectedAmount: "0" })));
  assert.ok(row.issues.some((m) => /検収額が 0 です/.test(m)));
});

test("束は 取引先・作品・条件名 で分かれ、発注額と検収額を別々に足す", () => {
  const rows = readRows(csv(
    line({ workCode: "W1", unitPrice: "100000", inspectedAmount: "90000" }),
    line({ workCode: "W1", itemName: "口絵", unitPrice: "50000" }),
    line({ workCode: "W2", itemName: "挿絵", unitPrice: "30000" })
  ));
  const groups = groupRows(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].orderedTotal, 150000);
  assert.equal(groups[0].inspectedTotal, 140000, "減額分は検収の合計にだけ効く");
  assert.equal(groups[1].orderedTotal, 30000);
});

test("束の中で日付や支払が食い違えば作らずに返す", () => {
  const rows = readRows(csv(
    line({ inspectedOn: "2026-07-25" }),
    line({ itemName: "口絵", inspectedOn: "2026-08-01" })
  ));
  const [group] = groupRows(rows);
  const issues = conflictsOf(group.rows);
  assert.ok(issues.some((m) => /検収日が行ごとに違います/.test(m)));
});

test("支払の欄が食い違えば、どれを採るかをこちらで決めない", () => {
  const rows = readRows(csv(
    line({ paymentState: "支払済み", paidOn: "2026-08-30" }),
    line({ itemName: "口絵" })
  ));
  const issues = conflictsOf(groupRows(rows)[0].rows);
  assert.ok(issues.some((m) => /支払状態が行ごとに違います/.test(m)));
  assert.ok(issues.some((m) => /入金日が行ごとに違います/.test(m)));
});

test("納品日は行ごとに違ってよい。実績は行ごとに立つ", () => {
  const rows = readRows(csv(
    line({ deliveredOn: "2026-07-10" }),
    line({ itemName: "口絵", deliveredOn: "2026-07-20" })
  ));
  assert.deepEqual(conflictsOf(groupRows(rows)[0].rows), []);
});

test("予定明細は行ごとに1回、起点は検収後。もう検収は済んでいる", () => {
  const rows = readRows(csv(
    line({ unitPrice: "100000" }),
    line({ itemName: "口絵", unitPrice: "50000", deliveredOn: "2026-07-22" })
  ));
  const lines = scheduleLinesFrom(rows);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.triggerKind), ["on_inspection", "on_inspection"]);
  assert.deepEqual(lines.map((l) => l.plannedAmount), [100000, 50000]);
  assert.deepEqual(lines.map((l) => l.dueOn), ["2026-07-20", "2026-07-22"]);
  assert.deepEqual(lines.map((l) => l.payOn), ["2026-08-31", "2026-08-31"]);
});

test("帰属先は束で揃っているときだけ条件に持たせる", () => {
  const same = readRows(csv(line(), line({ itemName: "口絵" })));
  assert.equal(ownershipOfRows(same), "orderer");
  const mixed = readRows(csv(line(), line({ itemName: "口絵", ownership: "受注者" })));
  assert.equal(ownershipOfRows(mixed), null);
});

test("帰属先は 発注者 か 受注者 だけ", () => {
  const [row] = readRows(csv(line({ ownership: "当社" })));
  assert.ok(row.issues.some((m) => /成果物の帰属先は 発注者 か 受注者/.test(m)));
});

test("雛形の見出しと違うファイルは受け取らない", () => {
  assert.throws(() => readRows("名称,金額\n甲社,100"), /見出しが雛形と合いません/);
});

test("必須の列が無ければ、行ごとの不備を何百件も並べずに断る", () => {
  const head = HEAD.replace(",発注日", ",発注日付");
  assert.throws(() => readRows([head, line()].join("\n")), /「発注日」の列がありません/);
});

test("雛形はそのまま読み返せて、2行目が減額検収と支払済みの例になっている", () => {
  const rows = readRows(templateCsv());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.flatMap((r) => r.issues), []);
  assert.equal(rows[1].orderedAmount, 96000);
  assert.equal(rows[1].inspectedAmount, 88000);
  assert.equal(rows[1].paymentState, "paid");
  assert.equal(rows[1].paidOn, "2026-09-28");
});

test("書き出しは Excel で開けるよう BOM 付き", () => {
  assert.ok(toCsv([]).startsWith("﻿"));
});

test("読めない行も捨てない。何行目が何で駄目かを残す", () => {
  const rows: SettledRow[] = readRows(csv(line(), line({ itemName: "", unitPrice: "" })));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].line, 3, "見出しを 1 行目として数える");
  assert.deepEqual(rows[1].issues, ["品目・業務名が空", "単価が空か読めない"]);
});
