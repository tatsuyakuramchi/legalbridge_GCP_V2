import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ContractCheckRepository } from "./contract-check.js";

const party = (over: Record<string, unknown> = {}) => ({
  id: 5, name: "株式会社甲", party_code: "PTY-5",
  matched_on: "正式名称と一致", via_merge: false, ...over
});
const agreement = (over: Record<string, unknown> = {}) => ({
  id: 1, agreement_no: "AGR-1", title: "基本契約", status: "executed",
  effective_on: new Date(2025, 0, 1), expires_on: new Date(2027, 0, 1),
  auto_renewal: false, days_to_expiry: 300, ...over
});

const build = (parties: any[], agreements: any[] = [], conditions: any[] = []) =>
  new ContractCheckRepository(new FakeDatabase((t) => {
    if (t.includes("FROM parties p")) return parties;
    if (t.includes("FROM agreements a")) return agreements;
    if (t.includes("FROM conditions c")) return conditions;
    return undefined;
  }));

test("有効な契約があれば、そう言い切る", async () => {
  const r = await build([party()], [agreement()]).check("株式会社甲");
  assert.equal(r.verdict, "covered");
  assert.equal(r.needsLegalReview, false);
  assert.match(r.message, /有効な契約があります/);
});

test("期限の定めが無い契約は期間を心配しない", async () => {
  const r = await build([party()], [agreement({ expires_on: null, days_to_expiry: null })])
    .check("株式会社甲");
  assert.equal(r.verdict, "covered");
  assert.match(r.message, /期限の定めなし/);
});

test("満了していれば止める。発注させない", async () => {
  const r = await build([party()], [agreement({ days_to_expiry: -10 })]).check("株式会社甲");
  assert.equal(r.verdict, "expired");
  assert.equal(r.needsLegalReview, true);
  assert.match(r.message, /満了しています/);
});

test("まもなく切れるなら知らせる", async () => {
  const r = await build([party()], [agreement({ days_to_expiry: 20 })]).check("株式会社甲");
  assert.equal(r.verdict, "expiring");
  assert.equal(r.needsLegalReview, true);
  assert.match(r.message, /あと 20 日/);
});

test("自動更新でも通知期限の確認を促す", async () => {
  const r = await build([party()], [agreement({ days_to_expiry: 20, auto_renewal: true })])
    .check("株式会社甲");
  assert.match(r.message, /自動更新の定めがありますが、通知期限/);
});

test("先の契約があれば、近い満了があっても覆われている", async () => {
  const r = await build([party()], [
    agreement({ id: 1, days_to_expiry: 20 }),
    agreement({ id: 2, days_to_expiry: 400, expires_on: new Date(2027, 10, 1) })
  ]).check("株式会社甲");
  assert.equal(r.verdict, "covered");
});

test("交渉中は締結済みとして扱わない", async () => {
  const r = await build([party()], [agreement({ status: "negotiating" })]).check("株式会社甲");
  assert.equal(r.verdict, "none");
  assert.equal(r.needsLegalReview, true);
  assert.match(r.message, /締結前に発注しないでください/);
});

test("契約が無ければ法務に回す。「たぶん大丈夫」を返さない", async () => {
  const r = await build([party()], []).check("株式会社甲");
  assert.equal(r.verdict, "none");
  assert.equal(r.needsLegalReview, true);
});

test("取引先が見つからなければ法務に回す", async () => {
  const r = await build([]).check("知らない会社");
  assert.equal(r.verdict, "none");
  assert.equal(r.needsLegalReview, true);
  assert.match(r.message, /未登録か、名称が違う/);
});

test("候補が複数なら絞らせる。勝手に選ばない", async () => {
  const r = await build([party(), party({ id: 9, name: "株式会社甲乙" })]).check("株式会社甲");
  assert.equal(r.verdict, "ambiguous");
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.agreements, [], "絞れていないうちは契約を出さない");
});

test("統合された相手先は1件にまとめる", async () => {
  const r = await build([
    party({ id: 5, name: "株式会社甲" }),
    party({ id: 5, name: "株式会社甲", via_merge: true, matched_on: "別名と一致" })
  ], [agreement()]).check("旧甲");
  assert.equal(r.matches.length, 1, "辿った先が同じなら1件");
  assert.equal(r.verdict, "covered");
});

test("短すぎる入力では引かない", async () => {
  const r = await build([party()]).check("甲");
  assert.equal(r.verdict, "none");
  assert.equal(r.needsLegalReview, false, "入力不足は法務の問題ではない");
  assert.match(r.message, /2文字以上/);
});
