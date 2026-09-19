import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PartyWriteService } from "./write-service.js";

const ROW = {
  id: 3, staff_code: "ST-0003", name: "浅井 崇", email: "asai@arclight.co.jp",
  department: "ボードゲーム事業部", phone: null, status: "active"
};
const db = (rows: Array<Record<string, unknown>> = [ROW]) =>
  new FakeDatabase((t) => (t.includes("UPDATE staff") ? rows : undefined));

/** UPDATE の SET 部分だけ。RETURNING には全列が並ぶので、そちらは見ない。 */
const setClause = (sql: string) => sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));

test("担当者のメールを入れられる（検収書の連絡先はここから出る）", async () => {
  const d = db();
  const r = await new PartyWriteService(d).updateStaff(
    3, { email: "asai@arclight.co.jp" }, "kuramochi");

  assert.equal(r.email, "asai@arclight.co.jp");
  const q = d.find("UPDATE staff")!;
  assert.match(q.text, /email = \$2/);
  assert.deepEqual(q.params, [3, "asai@arclight.co.jp"]);
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "staff.update");
});

test("渡さなかった項目には触らない", async () => {
  const d = db();
  await new PartyWriteService(d).updateStaff(3, { phone: "03-6811-0730" }, "k");
  const set = setClause(d.find("UPDATE staff")!.text);
  assert.doesNotMatch(set, /email/, "指定していない列を空で上書きしない");
  assert.match(set, /phone = \$2/);
});

test("空文字は NULL にする（書類側の空欄判定を効かせる）", async () => {
  const d = db();
  await new PartyWriteService(d).updateStaff(3, { email: "  " }, "k");
  assert.equal(d.find("UPDATE staff")!.params[1], null);
});

test("氏名は空にできない。退職は status で外す", async () => {
  await assert.rejects(
    () => new PartyWriteService(db()).updateStaff(3, { name: "  " }, "k"),
    /氏名は空にできません/);
});

test("直す項目が無いなら、空の UPDATE を投げない", async () => {
  const d = db();
  await assert.rejects(() => new PartyWriteService(d).updateStaff(3, {}, "k"),
    /直す項目がありません/);
  assert.ok(!d.find("UPDATE staff"));
});

test("いない担当者には何もしない", async () => {
  await assert.rejects(
    () => new PartyWriteService(db([])).updateStaff(9, { email: "x@y.z" }, "k"),
    /見つかりません/);
});
