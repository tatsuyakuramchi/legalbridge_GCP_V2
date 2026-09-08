import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, kindForField } from "./candidates.js";

const ctx = () => ({
  condition: {
    conditionNo: "CL-2026-00410", name: "毎月280,000円の委託",
    counterparty: { name: "吉澤淳郎", honorific: "様", kana: "ヨシザワ ジュンロウ",
                    invoiceNo: "T1234567890123" },
    termStart: "2026-04-01", termEnd: "2027-03-31",
    paymentTerms: "検収月の翌月末払い", flatAmount: 280000
  },
  contacts: [
    { role: "primary", name: "吉澤 淳郎", department: "制作", email: "y@example.com", phone: "03" },
    { role: "billing", name: "経理 花子", department: "経理部", email: "k@example.com" }
  ],
  owner: { name: "川島 純子", department: "法務部", email: "j@arclight.co.jp" },
  event: { occurredOn: "2026-04-30", amount: 300000, period: "2026年4月分" },
  totals: { exTax: 280000, tax: 28000, incTax: 308000 },
  company: { name: "株式会社アークライト", address: "東京都千代田区" }
});

const find = (label: string) => buildCandidates(ctx()).find((c) => c.label === label);

test("取引先の情報を候補に出す（宛名・カナ・インボイス番号）", () => {
  assert.equal(find("相手先名（敬称つき）")?.value, "吉澤淳郎 様");
  assert.equal(find("取引先カナ")?.value, "ヨシザワ ジュンロウ");
  assert.equal(find("インボイス登録番号")?.value, "T1234567890123");
});

test("取引先の担当者を役割ごとに出す", () => {
  assert.equal(find("先方担当の氏名")?.value, "吉澤 淳郎");
  assert.equal(find("請求先の部署")?.value, "経理部");
  assert.equal(find("請求先のメール")?.value, "k@example.com");
});

test("案件の担当者を出す（検収者はたいていこの人）", () => {
  assert.equal(find("担当者名")?.value, "川島 純子");
  assert.equal(find("担当者の部署")?.value, "法務部");
});

test("実績と条件の金額は別々に出す（どちらを載せるか人が選ぶ）", () => {
  // 予定280,000に対して実績300,000のとき、条件の定額だけを渡していたので
  // 書類と実績が食い違ったまま出ていた。
  assert.equal(find("定額（税抜）")?.value, "280000");
  assert.equal(find("実績の金額（税抜）")?.value, "300000");
});

test("空の値は候補に出さない（選べない候補は邪魔なだけ）", () => {
  const sparse = buildCandidates({ condition: { conditionNo: null, name: "x" } });
  assert.equal(sparse.some((c) => c.label === "相手先名"), false);
  assert.equal(sparse.some((c) => c.label === "条件名"), true);
});

test("欄の名前から、その欄に合う候補の種類を当てる", () => {
  assert.equal(kindForField("delivered_on", "実納品日"), "date");
  assert.equal(kindForField("amount_ex_tax", "納品額 (税抜)"), "amount");
  assert.equal(kindForField("inspector_name", "検収者氏名"), "text");
  // 「氏名」は日付ではない。「日」を含むが人の名前。
  assert.notEqual(kindForField("inspector_name", "検収者氏名"), "date");
});

test("振込先を候補に出す。1行にまとめたものも用意する", () => {
  const withBank = buildCandidates({
    ...ctx(),
    bank: { bankName: "みずほ銀行", branchName: "渋谷支店", accountType: "ordinary",
            accountNumber: "1234567", holderKana: "ヨシザワ ジユンロウ" }
  });
  const at = (label: string) => withBank.find((c) => c.label === label)?.value;
  assert.equal(at("振込先銀行"), "みずほ銀行");
  assert.equal(at("口座種別"), "普通", "英語のコードは書類に出せない");
  assert.equal(at("口座番号"), "1234567");
  assert.equal(at("振込先（1行）"), "みずほ銀行 渋谷支店 普通 1234567 ヨシザワ ジユンロウ");
});

test("口座が無い取引先では、振込先の候補を出さない", () => {
  assert.equal(buildCandidates(ctx()).some((c) => c.source === "振込先"), false);
});
