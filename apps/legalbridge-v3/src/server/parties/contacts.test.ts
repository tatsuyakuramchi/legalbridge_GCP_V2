import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PartyWriteService } from "./write-service.js";

/**
 * A-032：連絡先は 1 行 = 1 人で役割は印（roles）。法人は代表者を担当者と分けて持つ。
 */
const build = (kind = "corporate") => new FakeDatabase((t) => {
  if (t.includes("SELECT id FROM parties WHERE id = $1")) return [{ id: 4 }];
  if (t.includes("FROM parties WHERE id = $1 FOR UPDATE")) return [{ id: 4, name: "合同会社アトリエ蒼", status: "active" }];
  if (t.includes("INSERT INTO party_contacts")) return [{ id: 31 }];
  if (t.includes("UPDATE party_contacts SET")) return [{ id: 31 }];
  if (t.includes("DELETE FROM party_contacts")) return [{ id: 31, name: "青井 蒼" }];
  if (t.includes("UPDATE parties SET")) return [{ id: 4, party_code: "VD-1", name: "合同会社アトリエ蒼", kind, status: "active", aliases: [] }];
  if (t.includes("INSERT INTO parties")) return [{ id: 9, party_code: "PTY-0009" }];
  if (t.includes("btrim(name)")) return [];
  if (t.includes("UPDATE document_sequences")) return [{ current_value: 9 }];
  return undefined;
});

test("登録：法人は代表者の肩書・氏名を持ち、主担当を同時に 1 人入れられる", async () => {
  const d = build();
  await new PartyWriteService(d).create({
    name: "合同会社アトリエ蒼", kind: "corporate",
    representativeTitle: "代表社員", representativeName: "青井 蒼",
    primaryContact: { name: "担当 花子", email: "hanako@example.co.jp", department: "制作部" }
  }, "k");
  const ins = d.find("INSERT INTO parties")!;
  assert.match(ins.text, /representative_title, representative_name/);
  assert.equal(ins.params[11], "代表社員");
  assert.equal(ins.params[12], "青井 蒼");
  const c = d.find("INSERT INTO party_contacts")!;
  assert.match(c.text, /ARRAY\['primary'\]/);
  assert.deepEqual(c.params.slice(1), ["担当 花子", "hanako@example.co.jp", "制作部"]);
});

test("登録：個人は代表者を持たず、主担当も入れない（本人が窓口）", async () => {
  const d = build("individual");
  await new PartyWriteService(d).create({
    name: "山田 太郎", kind: "individual",
    representativeTitle: "代表", representativeName: "山田 太郎",
    primaryContact: { name: "山田 太郎", email: "t@example.com" }
  }, "k");
  const ins = d.find("INSERT INTO parties")!;
  assert.equal(ins.params[11], null);
  assert.equal(ins.params[12], null);
  assert.equal(d.find("INSERT INTO party_contacts"), undefined);
});

test("直す：代表者の欄は空文字で消せる", async () => {
  const d = build();
  await new PartyWriteService(d).update(4, { representativeTitle: "代表取締役", representativeName: "" }, "k");
  const q = d.find("UPDATE parties SET")!;
  assert.match(q.text, /representative_title = \$/);
  assert.ok(q.params.includes("代表取締役"));
  assert.ok(q.params.includes(null), "空文字は NULL");
});

test("連絡先を足す：役割の印は複数付き、role には先頭の印が入る（互換）", async () => {
  const d = build();
  const r = await new PartyWriteService(d).addContact(4, {
    name: "青井 蒼", email: "ao@example.co.jp", roles: ["primary", "billing"]
  }, "k");
  assert.equal(r.id, 31);
  const q = d.find("INSERT INTO party_contacts")!;
  assert.equal(q.params[1], "primary");
  assert.deepEqual(q.params[2], ["primary", "billing"]);
  const audit = d.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "party.add_contact");
});

test("連絡先を足す：氏名もメールも無い行、知らない役割は止める", async () => {
  const svc = new PartyWriteService(build());
  await assert.rejects(() => svc.addContact(4, { phone: "03-0000-0000" }, "k"), /氏名かメール/);
  await assert.rejects(() => svc.addContact(4, { name: "x", roles: ["ceo" as never] }, "k"), /役割は/);
});

test("連絡先を直す：渡した項目だけ更新し、役割を渡せば role も揃える", async () => {
  const d = build();
  await new PartyWriteService(d).updateContact(4, 31, { department: "営業部", roles: ["signer"] }, "k");
  const q = d.find("UPDATE party_contacts SET")!;
  assert.match(q.text, /department = \$3, roles = \$4, role = \$5/);
  assert.deepEqual(q.params, [31, 4, "営業部", ["signer"], "signer"]);
  assert.doesNotMatch(q.text, /email/);
});

test("連絡先を消す：無い行は止める。監査には氏名だけ", async () => {
  const d = build();
  await new PartyWriteService(d).removeContact(4, 31, "k");
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "party.remove_contact");
  const none = new FakeDatabase((t) => t.includes("DELETE FROM party_contacts") ? [] : undefined);
  await assert.rejects(() => new PartyWriteService(none).removeContact(4, 99, "k"), /見つかりません/);
});
