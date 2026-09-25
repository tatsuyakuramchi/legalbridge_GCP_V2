import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictsOf, groupRows, ownershipOfRows, readOldHandling, readPaymentState, readRevision, settlementsOf,
  rawRows, readRows, scheduleLinesFrom, templateCsv, toCsv, type SettledRow
} from "./settled-batch.js";

const HEAD = "取引先コード,取引先名,作品コード,作品名,契約番号,条件番号,条件名,旧分,品目・業務名,仕様・成果物,"
  + "数量,単価（税抜）,発注日,納品日,検収日,検収数量,変更理由,版,支払期日,支払状態,入金日,"
  + "契約形式,支払条件,成果物の帰属先,発注署名欄,承諾署名欄,特約の定型文,特約,備考";

/** 1行ぶんの値。既定は「読める行」で、直したいところだけ渡す。 */
const line = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    partyCode: "VD-1", partyName: "甲社", workCode: "", workTitle: "",
    agreementNo: "", conditionNo: "", conditionName: "", oldHandling: "",
    itemName: "表紙", spec: "",
    quantity: "1", unitPrice: "100000",
    orderedOn: "2026-06-01", deliveredOn: "2026-07-20", inspectedOn: "2026-07-25",
    inspectedQuantity: "", varianceNote: "", revision: "",
    dueOn: "2026-08-31", paymentState: "", paidOn: "",
    contractForm: "請負", paymentTerms: "月末締め翌月末払い", ownership: "発注者",
    orderSign: "", acceptSign: "", snippet: "", specialTerms: "", remarks: "",
    ...over
  };
  // カンマを含む値は引用する。引用しないと欄がずれて、金額の桁区切りを
  // 試すつもりのテストが「列の取り違え」を試すものになる。
  const cell = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [base.partyCode, base.partyName, base.workCode, base.workTitle,
          base.agreementNo, base.conditionNo, base.conditionName, base.oldHandling,
          base.itemName, base.spec,
          base.quantity, base.unitPrice, base.orderedOn, base.deliveredOn,
          base.inspectedOn, base.inspectedQuantity, base.varianceNote, base.revision,
          base.dueOn, base.paymentState,
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

test("減額検収は検収数量で書く。金額は単価×検収数量で出す", () => {
  // 金額を直に書かせると、単価×数量と合計が合わない行が作れてしまい、
  // あとから何が起きたのか読めなくなる。発注額は発注額のまま残す。
  // 上書きすると検収書の「金額が変わった」判定が効かず、確認欄が出ない。
  const [row] = readRows(csv(line({ quantity: "12", unitPrice: "8000", inspectedQuantity: "11", varianceNote: "11点に減った" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.orderedAmount, 96000);
  assert.equal(row.inspectedQuantity, 11);
  assert.equal(row.inspectedAmount, 88000, "8000 × 11");
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

test("検収数量 0 は弾く。0 の実績からは支払を作れない", () => {
  const [row] = readRows(csv(line({ inspectedQuantity: "0" })));
  assert.ok(row.issues.some((m) => /検収数量が 0 です/.test(m)));
});

test("束は 取引先・作品・条件名 で分かれ、発注額と検収額を別々に足す", () => {
  const rows = readRows(csv(
    line({ workCode: "W1", quantity: "10", unitPrice: "10000", inspectedQuantity: "9", varianceNote: "一部差し戻し" }),
    line({ workCode: "W1", itemName: "口絵", unitPrice: "50000" }),
    line({ workCode: "W2", itemName: "挿絵", unitPrice: "30000" })
  ));
  const groups = groupRows(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].orderedTotal, 150000);
  assert.equal(groups[0].inspectedTotal, 140000, "減った分は検収の合計にだけ効く");
  assert.equal(groups[1].orderedTotal, 30000);
});

test("検収日が行ごとに違えば、1束のまま検収書を分ける（発注書は1枚）", () => {
  // 1枚の発注書に検収が何回かあるのがふつう。ここを弾くと実際の取引がほぼ全部止まる。
  const rows = readRows(csv(
    line({ inspectedOn: "2026-07-25" }),
    line({ itemName: "口絵", inspectedOn: "2026-08-01", deliveredOn: "2026-07-30" })
  ));
  const [group] = groupRows(rows);
  assert.deepEqual(conflictsOf(group.rows), []);
  const parts = settlementsOf(group.rows);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.inspectedOn), ["2026-07-25", "2026-08-01"]);
  assert.equal(parts[0].rows[0].line, 2);
});

test("支払の欄が行ごとに違えば、支払も組ごとに分ける", () => {
  const rows = readRows(csv(
    line({ paymentState: "支払済み", paidOn: "2026-08-30" }),
    line({ itemName: "口絵" })
  ));
  assert.deepEqual(conflictsOf(groupRows(rows)[0].rows), []);
  const parts = settlementsOf(groupRows(rows)[0].rows);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.paymentState).sort(), ["paid", "planned"]);
});

test("発注日が行ごとに違えば別の発注。条件名で分けてもらう", () => {
  const rows = readRows(csv(
    line({ orderedOn: "2026-06-01" }),
    line({ itemName: "口絵", orderedOn: "2026-06-15" })
  ));
  assert.match(conflictsOf(groupRows(rows)[0].rows).join("／"), /発注日が行ごとに違います.*条件名を分けて/);
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
  assert.equal(rows[1].inspectedQuantity, 11);
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

test("数量が動いた行に理由が無ければ作らない。紙に「（理由未記入）」と刷られて相手に渡る", () => {
  const [row] = readRows(csv(line({ quantity: "10", unitPrice: "10000", inspectedQuantity: "9" })));
  assert.ok(row.issues.some((m) => /検収数量（9）が数量（10）と違います。変更理由が要ります/.test(m)));
  const [ok] = readRows(csv(line({ quantity: "10", unitPrice: "10000", inspectedQuantity: "9", varianceNote: "一部差し戻し" })));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.varianceNote, "一部差し戻し");
});

test("数量が同じ行に理由は要らない", () => {
  const [row] = readRows(csv(line({ quantity: "10", unitPrice: "10000", inspectedQuantity: "10" })));
  assert.deepEqual(row.issues, []);
});

test("検収数量は小数でも読む（0.5人日）。金額は丸めて整数にする", () => {
  const [row] = readRows(csv(
    line({ quantity: "2", unitPrice: "33333", inspectedQuantity: "1.5", varianceNote: "半日ぶん未実施" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.inspectedAmount, 50_000, "33333 × 1.5 = 49999.5 → 丸めて整数（0.5 は切り上げ）");
});

test("増えた検収も数量で書ける。理由は同じように要る", () => {
  const [row] = readRows(csv(
    line({ quantity: "10", unitPrice: "1000", inspectedQuantity: "12", varianceNote: "追加2点" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.orderedAmount, 10_000);
  assert.equal(row.inspectedAmount, 12_000);
});

test("検収数量が負なら弾く", () => {
  const [row] = readRows(csv(line({ inspectedQuantity: "-1", varianceNote: "打ち間違い" })));
  assert.ok(row.issues.some((m) => /検収数量が負の数です/.test(m)));
});

test("発注書には発注の数量を刷る。検収の数量は検収書が実績から出す", () => {
  const [row] = readRows(csv(
    line({ quantity: "12", unitPrice: "8000", inspectedQuantity: "11", varianceNote: "1点未納" })));
  assert.equal(row.item.quantity, 12);
  assert.equal(row.item.ordered_quantity, 12);
  assert.equal(row.item.amount_ex_tax, 96_000, "発注書の金額は発注のまま");
});

test("支払状態に「なし」と書けば、検収書まで作って支払は立てない", () => {
  const [row] = readRows(csv(line({ paymentState: "なし", dueOn: "" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.paymentState, "none");
});

test("支払を立てないのに期日や入金日があれば不備。書いたのに使われないのが一番困る", () => {
  const [row] = readRows(csv(line({ paymentState: "なし" })));
  assert.ok(row.issues.some((m) => /支払期日（2026-08-31）があるのに支払状態が なし です/.test(m)));
  const [row2] = readRows(csv(line({ paymentState: "作らない", dueOn: "", paidOn: "2026-08-30" })));
  assert.ok(row2.issues.some((m) => /入金日（2026-08-30）があるのに支払状態が なし です/.test(m)));
});

test("「なし」の言い換えを読む", () => {
  assert.equal(readPaymentState("なし"), "none");
  assert.equal(readPaymentState("立てない"), "none");
  assert.equal(readPaymentState("不要"), "none");
  assert.equal(readPaymentState("-"), "none");
});

test("支払の立て方が束の中で違えば、立てる組と立てない組に分かれる", () => {
  const rows = readRows(csv(
    line({ paymentState: "なし", dueOn: "" }),
    line({ itemName: "口絵" })
  ));
  const parts = settlementsOf(groupRows(rows)[0].rows);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.paymentState).sort(), ["none", "planned"]);
});


// ---------------------------------------------------------------------------
// 版（初版 / 変更履歴付）
//
// 同じ「発注 12 点・検収 11 点」でも、当初から減ったのか、はじめから 11 点
// だったのかで意味が違う。台帳の数字では区別できないので、人が書く。
// ---------------------------------------------------------------------------

test("空欄なら数字から察する（版の列を足す前の CSV がそのまま通る）", () => {
  assert.equal(readRevision("", 11, 12), "amended");
  assert.equal(readRevision("", 12, 12), "first");
  assert.equal(readRevision("  ", 11, 12), "amended");
});

test("書いてあればそれに従う", () => {
  assert.equal(readRevision("初版", 11, 12), "first");
  assert.equal(readRevision("変更履歴付", 11, 12), "amended");
  assert.equal(readRevision("変更履歴", 12, 12), "amended");
  assert.equal(readRevision("あり", 12, 12), "amended");
  assert.equal(readRevision("なし", 11, 12), "first");
  assert.equal(readRevision("第2版", 12, 12), null);
});

test("変更履歴付なら変更理由が要る（求めるのは正しい）", () => {
  const [bad] = readRows(csv(line({
    quantity: "12", unitPrice: "8000", inspectedQuantity: "11", revision: "変更履歴付" })));
  assert.match(bad.issues.join("／"), /変更理由が要ります/);

  const [ok] = readRows(csv(line({
    quantity: "12", unitPrice: "8000", inspectedQuantity: "11", revision: "変更履歴付",
    varianceNote: "納品点数が11点になったため減額" })));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.revision, "amended");
  assert.equal(ok.inspectedAmount, 88000);
});

test("初版なら変更理由は要らない（当初からの変更そのものが無い）", () => {
  const [row] = readRows(csv(line({
    quantity: "11", unitPrice: "8000", inspectedQuantity: "", revision: "初版" })));
  assert.deepEqual(row.issues, []);
  assert.equal(row.revision, "first");
  // 額は変更履歴付と同じ。違うのは紙に履歴が出るかどうかだけ。
  assert.equal(row.inspectedAmount, 88000);
  assert.equal(row.orderedAmount, 88000);
});

test("初版なのに数が食い違えば断る（起きていない減額を刷らない）", () => {
  const [row] = readRows(csv(line({
    quantity: "12", unitPrice: "8000", inspectedQuantity: "11", revision: "初版" })));
  assert.match(row.issues.join("／"), /初版ですが、検収数量（11）が数量（12）と違います/);
  assert.match(row.issues.join("／"), /変更として残すなら 変更履歴付/);
});

test("変更履歴付なのに変わっていなければ断る", () => {
  const [row] = readRows(csv(line({
    quantity: "12", unitPrice: "8000", inspectedQuantity: "12", revision: "変更履歴付" })));
  assert.match(row.issues.join("／"), /変わっていないなら 初版 に/);
});

test("読めない版は断る", () => {
  const [row] = readRows(csv(line({ revision: "第2版" })));
  assert.match(row.issues.join("／"), /版は 初版 か 変更履歴付/);
});

test("雛形は初版と変更履歴付を1行ずつ見せる", () => {
  const rows = readRows(templateCsv());
  assert.equal(rows[0]?.revision, "first");
  assert.equal(rows[1]?.revision, "amended");
  assert.deepEqual(rows.flatMap((r) => r.issues), []);
});

// ---------------------------------------------------------------------------
// 条件番号
// ---------------------------------------------------------------------------

test("条件番号が書いてあれば、それだけで束が決まる", () => {
  // 取引先も作品も条件名も違うのに、同じ番号を指していれば同じ束。
  const rows = readRows(csv(
    line({ conditionNo: "CL-2026-00775", conditionName: "挿絵", itemName: "表紙" }),
    line({ conditionNo: "CL-2026-00775", conditionName: "別の名前", itemName: "本文" })));
  assert.equal(groupRows(rows).length, 1);
  assert.equal(groupRows(rows)[0]?.conditionNo, "CL-2026-00775");
});

test("番号が違えば、名前が同じでも別の束（同名の条件を取り違えない）", () => {
  const rows = readRows(csv(
    line({ conditionNo: "CL-2026-00775", conditionName: "挿絵 制作委託" }),
    line({ conditionNo: "CL-2026-00777", conditionName: "挿絵 制作委託" })));
  assert.equal(groupRows(rows).length, 2);
});

test("番号が無ければ、これまでどおり取引先・作品・条件名で束ねる", () => {
  const rows = readRows(csv(
    line({ conditionName: "挿絵 制作委託", itemName: "表紙" }),
    line({ conditionName: "挿絵 制作委託", itemName: "本文" }),
    line({ conditionName: "別の条件", itemName: "口絵" })));
  assert.equal(groupRows(rows).length, 2);
});

test("条件番号は行にそのまま残る", () => {
  const [row] = readRows(csv(line({ conditionNo: " CL-2026-00775 " })));
  assert.equal(row.conditionNo, "CL-2026-00775");
  assert.equal(readRows(csv(line()))[0]!.conditionNo, null);
});

// ---------------------------------------------------------------------------
// 旧分の扱い（残す / 畳む / 無効）
// ---------------------------------------------------------------------------

test("旧分は空欄なら残す", () => {
  assert.equal(readOldHandling(""), "keep");
  assert.equal(readOldHandling("残す"), "keep");
  assert.equal(readOldHandling("畳む"), "fold");
  assert.equal(readOldHandling("無効"), "void");
  assert.equal(readOldHandling("重複"), "void");
  assert.equal(readOldHandling("けす"), null);
});

test("畳む・無効には条件番号が要る（名前で当てると別の条件を巻き込む）", () => {
  const [bad] = readRows(csv(line({ oldHandling: "畳む" })));
  assert.match(bad.issues.join("／"), /条件番号が要ります/);

  const [ok] = readRows(csv(line({ oldHandling: "畳む", conditionNo: "CL-2026-00775" })));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.oldHandling, "fold");
});

test("残すなら条件番号が無くてもよい（新しく作る行）", () => {
  const [row] = readRows(csv(line()));
  assert.deepEqual(row.issues, []);
  assert.equal(row.oldHandling, "keep");
});

test("読めない旧分は断る", () => {
  const [row] = readRows(csv(line({ oldHandling: "けす", conditionNo: "CL-1" })));
  assert.match(row.issues.join("／"), /旧分は 残す \/ 畳む \/ 無効/);
});

test("束の中で旧分が食い違えば不備", () => {
  const rows = readRows(csv(
    line({ conditionNo: "CL-1", oldHandling: "畳む", itemName: "表紙" }),
    line({ conditionNo: "CL-1", oldHandling: "無効", itemName: "本文" })));
  const [group] = groupRows(rows);
  assert.match(conflictsOf(group.rows).join("／"), /旧分の扱いが行ごとに違います/);
});

test("束は旧分を持つ", () => {
  const rows = readRows(csv(line({ conditionNo: "CL-1", oldHandling: "無効" })));
  assert.equal(groupRows(rows)[0]?.oldHandling, "void");
});

test("rawRows も見出しを検査する（差分で別物の CSV が「全部消える」と出ない）", () => {
  assert.throws(() => rawRows("a,b,c\n1,2,3\n"), /見出しが雛形と合いません/);
});
