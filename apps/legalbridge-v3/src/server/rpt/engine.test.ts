import test from "node:test";
import assert from "node:assert/strict";
import { RptEngine, type Masters, type PartyRef } from "./engine.js";

// 親 P（取締役会あり）が 子 S1 を 100%、S2 を 70% 持つ。A 社は独立。
// 役員：山田（P 代表・S1 取締役）、佐藤（S1 代表・S2 代表）、鈴木（P 取締役、A 社を 60% 保有）、
//       田中（S2 取締役・S1 取締役、どちらも代表でない）
const masters = (): Masters => ({
  companies: [
    { id: "1", name: "親P", board: true, shareholders: [] },
    { id: "2", name: "子S1", board: true, shareholders: [{ holderKind: "company", holderId: "1", pct: 100 }] },
    { id: "3", name: "子S2", board: false, shareholders: [{ holderKind: "company", holderId: "1", pct: 70 }] },
    { id: "4", name: "A社", board: true, shareholders: [{ holderKind: "person", holderId: "30", pct: 60 }] },
    { id: "5", name: "関連B", board: true, shareholders: [{ holderKind: "company", holderId: "1", pct: 25 }] }
  ],
  directors: [
    { id: "10", name: "山田", roles: [{ companyId: "1", title: "代表取締役" }, { companyId: "2", title: "取締役" }] },
    { id: "20", name: "佐藤", roles: [{ companyId: "2", title: "代表取締役" }, { companyId: "3", title: "代表取締役" }] },
    { id: "30", name: "鈴木", roles: [{ companyId: "1", title: "取締役" }] },
    { id: "40", name: "田中", roles: [{ companyId: "2", title: "取締役" }, { companyId: "3", title: "取締役" }] }
  ]
});
const co = (id: string): PartyRef => ({ kind: "company", id });
const per = (id: string): PartyRef => ({ kind: "person", id });
const th = { company: null, person: 10_000_000 };
const judge = (a: PartyRef, b: PartyRef, txn = "service", amount: number | null = null, competing = false, m = masters()) =>
  new RptEngine(m).judge({ a, b, txn, amount, competing, thresholds: th });
const types = (j: ReturnType<typeof judge>) => j.conflict.findings.map((f) => `${f.companyName}:${f.type}`).sort();

test("① 取締役本人と自社の取引は直接取引（356①二）。無過失責任の印を付ける", () => {
  const j = judge(per("30"), co("1"));
  assert.deepEqual(types(j), ["親P:直接取引"]);
  assert.equal(j.conflict.findings[0].self, true);
});

test("② 双方を代表する兼任は、両社で承認（双方代表）", () => {
  const j = judge(co("2"), co("3"));
  assert.ok(types(j).includes("子S1:双方代表") && types(j).includes("子S2:双方代表"));
});

test("② 片方だけ代表する兼任は、相手方で承認・代表側も保守的に承認", () => {
  const j = judge(co("1"), co("2"));   // 山田：親P 代表・子S1 平取
  assert.ok(types(j).includes("子S1:直接取引（相手方を代表）"));
  assert.ok(types(j).includes("親P:利益相反（保守）"));
});

test("② 代表権の無い兼任は、両社で保守的に承認・除斥", () => {
  const m = masters();
  m.directors = m.directors.filter((d) => d.name === "田中");
  const j = judge(co("2"), co("3"), "service", null, false, m);
  assert.deepEqual(types(j), ["子S1:利益相反（無代表兼任）", "子S2:利益相反（無代表兼任）"]);
});

test("③ 取締役が相手方を過半数で支配していれば、間接取引（支配）", () => {
  const j = judge(co("1"), co("4"));   // 鈴木：親P 取締役・A社 60%
  assert.deepEqual(types(j), ["親P:間接取引（支配）"]);
});

test("④ 債務保証・担保提供は、取締役本人との間で間接取引（356①三）", () => {
  assert.ok(types(judge(per("30"), co("1"), "guarantee")).includes("親P:間接取引"));
  assert.ok(!types(judge(per("30"), co("1"), "sale")).includes("親P:間接取引"));
});

test("⑤ 競業の印があれば競業取引（356①一）", () => {
  assert.ok(types(judge(per("30"), co("1"), "sale", null, true)).includes("親P:競業取引"));
});

test("承認の仕方：取締役会が無ければ株主総会。特別利害関係の取締役を除斥し、残りが 0 なら役会不成立", () => {
  const j = judge(co("2"), co("3"));
  assert.equal(j.method["3"].organ, "株主総会");
  assert.equal(j.method["2"].organ, "取締役会");
  assert.deepEqual(j.method["2"].excluded.sort(), ["佐藤", "田中"]);
  // 子S1 の取締役は 山田・佐藤・田中。佐藤と田中を除斥して 山田 1 名が残る
  assert.equal(j.method["2"].baseCount, 1);
  assert.equal(j.method["2"].deadlock, false);

  const m = masters();
  m.directors = m.directors.filter((d) => d.name !== "山田");   // 子S1 に残る取締役がいない
  const j2 = judge(co("2"), co("3"), "service", null, false, m);
  assert.equal(j2.method["2"].deadlock, true);
});

test("関連当事者の区分：親子・完全子会社・兄弟会社・関連会社", () => {
  assert.match(judge(co("2"), co("1")).disclosure.rel!.category, /親会社（完全子会社・連結相殺）/);
  assert.match(judge(co("1"), co("3")).disclosure.rel!.category, /^子会社$/);
  assert.match(judge(co("2"), co("3")).disclosure.rel!.category, /兄弟会社/);
  assert.match(judge(co("1"), co("5")).disclosure.rel!.category, /^関連会社$/);
  assert.equal(judge(co("4"), co("5")).disclosure.related, false);
});

test("個人と会社：役員・主要株主・親会社等の役員", () => {
  assert.equal(judge(per("30"), co("1")).disclosure.rel!.category, "役員（及びその近親者）");
  assert.equal(judge(per("30"), co("4")).disclosure.rel!.category, "主要株主（及びその近親者）");
  assert.equal(judge(per("30"), co("2")).disclosure.rel!.category, "親会社等の役員");
});

test("重要性：個人との取引は 1,000 万円を超えたら重要。金額が無ければ要判断", () => {
  assert.equal(judge(per("30"), co("1"), "service", 12_000_000).disclosure.materiality, "重要（開示対象の目安）");
  assert.equal(judge(per("30"), co("1"), "service", 3_000_000).disclosure.materiality, "重要性基準未満（目安）");
  assert.equal(judge(per("30"), co("1")).disclosure.materiality, "要判断");
  // 法人との取引は基準額が未設定なら要判断
  assert.equal(judge(co("2"), co("1"), "service", 99_000_000).disclosure.materiality, "要判断");
});

test("資本関係の見出し：完全子会社・子会社・関連会社・独立", () => {
  const e = new RptEngine(masters());
  const m = masters();
  assert.match(e.classifyOwnership(m.companies[1]).label, /完全子会社（親P 100%）/);
  assert.match(e.classifyOwnership(m.companies[2]).label, /子会社（親P 70%）/);
  assert.match(e.classifyOwnership(m.companies[4]).label, /関連会社（親P 25%）/);
  assert.match(e.classifyOwnership(m.companies[0]).label, /独立/);
});

test("会社と役員の ID が同じ数字でも取り違えない（種類ごとに別の番号）", () => {
  const m = masters();
  // 役員 1 が 親P（会社 1）の株を持つわけではない
  m.companies[3].shareholders = [{ holderKind: "company", holderId: "10", pct: 60 }];
  const e = new RptEngine(m);
  assert.equal(e.pctHeld("10", "4", "person"), 0);
  assert.equal(e.pctHeld("10", "4", "company"), 60);
});
