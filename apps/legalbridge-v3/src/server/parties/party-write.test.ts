import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PartyWriteService } from "./write-service.js";
import { DomainError } from "../core/errors.js";

const HEAD = { id: 4, name: "合同会社アトリエ蒼", status: "active" };
const ROW: Record<string, unknown> = {
  id: 4, party_code: "VD-00317", name: "合同会社アトリエ蒼", kind: "corporate",
  name_kana: "アトリエアオ", aliases: [], invoice_no: null, corporate_no: null,
  withholding: false, address: null, phone: null, email: null, status: "active"
};

const db = (head: Record<string, unknown> | null = HEAD, row = ROW) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM parties WHERE id = $1 FOR UPDATE")) return head ? [head] : [];
    if (t.includes("UPDATE parties SET")) return [row];
    return undefined;
  });

/** UPDATE の SET 部分だけ。RETURNING には全列が並ぶので、そちらは見ない。 */
const setClause = (sql: string) => sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));

test("住所を入れられる（契約書の頭書きと請求書の宛先はここから出る）", async () => {
  const d = db(HEAD, { ...ROW, address: "東京都千代田区外神田1-1" });
  const r = await new PartyWriteService(d).update(
    4, { address: "東京都千代田区外神田1-1" }, "kuramochi");

  assert.equal(r.address, "東京都千代田区外神田1-1");
  const q = d.find("UPDATE parties SET")!;
  assert.match(setClause(q.text), /address = \$2/);
  assert.deepEqual(q.params, [4, "東京都千代田区外神田1-1"]);
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "party.update");
});

test("渡さなかった項目には触らない", async () => {
  const d = db();
  await new PartyWriteService(d).update(4, { phone: "03-1111-2222" }, "k");
  const set = setClause(d.find("UPDATE parties SET")!.text);
  assert.match(set, /phone = /);
  assert.doesNotMatch(set, /name = /);
  assert.doesNotMatch(set, /address = /);
});

test("空欄は NULL にする（書類側の空欄判定を効かせる）", async () => {
  const d = db();
  await new PartyWriteService(d).update(4, { invoiceNo: "  ", email: "" }, "k");
  assert.deepEqual(d.find("UPDATE parties SET")!.params, [4, null, null]);
});

test("名前は空にできない。使わなくなったら状態で外す", async () => {
  await assert.rejects(
    () => new PartyWriteService(db()).update(4, { name: "  " }, "k"),
    (e: unknown) => e instanceof DomainError && /空にできません/.test(e.message));
});

test("直す項目が無ければ断る（空の UPDATE を投げない）", async () => {
  await assert.rejects(
    () => new PartyWriteService(db()).update(4, {}, "k"),
    (e: unknown) => e instanceof DomainError && /直す項目がありません/.test(e.message));
});

test("統合された取引先は直せない。先に統合を取り消す", async () => {
  const d = db({ id: 4, name: "旧アトリエ蒼", status: "merged" });
  await assert.rejects(
    () => new PartyWriteService(d).update(4, { name: "新名称" }, "k"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  assert.equal(d.all("UPDATE parties SET").length, 0, "書き込まない");
});

test("いない取引先には書かない", async () => {
  const d = db(null);
  await assert.rejects(
    () => new PartyWriteService(d).update(9, { name: "x" }, "k"),
    (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND");
});

test("監査に値そのものは残さない（住所・電話は個人の連絡先でもある）", async () => {
  const d = db();
  await new PartyWriteService(d).update(
    4, { address: "東京都千代田区外神田1-1", phone: "03-1111-2222" }, "k");
  const detail = String(d.find("INSERT INTO audit_events")!.params[5]);
  assert.match(detail, /"fields":\["address","phone"\]/);
  assert.doesNotMatch(detail, /外神田/);
  assert.doesNotMatch(detail, /03-1111-2222/);
});

test("別名は空の行を落として入れる", async () => {
  const d = db();
  await new PartyWriteService(d).update(4, { aliases: ["アトリエ蒼", " ", "Atelier Ao"] }, "k");
  assert.deepEqual(d.find("UPDATE parties SET")!.params[1], ["アトリエ蒼", "Atelier Ao"]);
});

test("登録でも住所・電話・メールを入れられる", async () => {
  const d = new FakeDatabase((t) => {
    if (t.includes("INSERT INTO parties")) return [{ id: 9, party_code: "PTY-0009" }];
    if (t.includes("btrim(name)")) return [];
    // 採番。番号そのものはこの試験の関心ではない。
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 9 }];
    return undefined;
  });
  await new PartyWriteService(d).create(
    { name: "新規取次", kind: "corporate", address: "大阪市…", phone: "06-0000-0000", email: "" },
    "k");
  const q = d.find("INSERT INTO parties")!;
  assert.match(q.text, /address, phone, email/);
  assert.equal(q.params[8], "大阪市…");
  assert.equal(q.params[9], "06-0000-0000");
  assert.equal(q.params[10], null, "空文字は NULL");
});
