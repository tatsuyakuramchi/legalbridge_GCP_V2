import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PartyWriteService } from "./write-service.js";

const db = (party: Array<Record<string, unknown>> = [{ id: 3, name: "合同会社アトリエ蒼" }]) =>
  new FakeDatabase((t) => (t.includes("FROM parties WHERE id") ? party : undefined));

const FULL = {
  bankName: "みずほ銀行", branchName: "神保町支店", accountType: "普通",
  accountNumber: "1234567", accountHolderKana: "カ）アトリエアオ"
};

test("欠けていた名義を入れられる", async () => {
  const d = db();
  await new PartyWriteService(d).saveBankAccount(3, FULL, "kuramochi");
  const q = d.find("INSERT INTO party_bank_accounts")!;
  assert.deepEqual(q.params,
    [3, "みずほ銀行", "神保町支店", "普通", "1234567", "カ）アトリエアオ"]);
  assert.match(q.text, /ON CONFLICT \(party_id\) DO UPDATE/,
    "すでに行があれば作り直さず直す");
});

test("空欄は NULL にする（書類側の空欄判定を効かせる）", async () => {
  const d = db();
  await new PartyWriteService(d).saveBankAccount(3, { ...FULL, accountHolderKana: "  " }, "k");
  assert.equal(d.find("INSERT INTO party_bank_accounts")!.params[5], null);
});

test("監査に口座番号も名義も残さない", async () => {
  // audit_events は運用の画面から誰でも読める。値をそこへ写すと、
  // 口座表を絞ってある意味が無くなる。
  const d = db();
  await new PartyWriteService(d).saveBankAccount(3, FULL, "kuramochi");
  const audit = d.find("INSERT INTO audit_events")!;
  const dumped = JSON.stringify(audit.params);
  assert.equal(audit.params[1], "party.save_bank_account");
  assert.doesNotMatch(dumped, /1234567/, "口座番号が監査に漏れている");
  assert.doesNotMatch(dumped, /アトリエアオ/, "名義が監査に漏れている");
  assert.match(dumped, /accountNumber|account_number/,
    "どの項目を触ったかは残す（残さないと直した記録にならない）");
});

test("いない取引先には書かない", async () => {
  const d = db([]);
  await assert.rejects(() => new PartyWriteService(d).saveBankAccount(9, FULL, "k"),
    /見つかりません/);
  assert.ok(!d.find("INSERT INTO party_bank_accounts"));
});

test("海外口座（A-051）：送られてきた項目だけ書き、監査には値を残さない", async () => {
  const d = db();
  await new PartyWriteService(d).saveBankAccount(3, {
    ...FULL, accountHolderKana: null, accountScope: "overseas",
    accountHolderName: "EXAMPLE STUDIO LLC", swiftBic: "EXAMUS33", iban: " ",
    currency: "USD"
  }, "kuramochi");
  const q = d.find("UPDATE party_bank_accounts")!;
  assert.match(q.text, /account_scope = \$2/);
  assert.match(q.text, /swift_bic = /);
  assert.doesNotMatch(q.text, /routing_number/, "送られていない項目は触らない");
  assert.deepEqual(q.params, [3, "overseas", "EXAMPLE STUDIO LLC", "EXAMUS33", null, "USD"]);
  const dumped = JSON.stringify(d.find("INSERT INTO audit_events")!.params);
  assert.doesNotMatch(dumped, /EXAMUS33|EXAMPLE STUDIO/, "SWIFT や受取人名が監査に漏れている");
  assert.match(dumped, /swift_bic/);
  assert.match(dumped, /overseas/);
});

test("海外の項目が送られてこなければ（A-051 前の画面・DB）国内の5項目だけ書く", async () => {
  const d = db();
  await new PartyWriteService(d).saveBankAccount(3, FULL, "kuramochi");
  assert.ok(!d.find("UPDATE party_bank_accounts"));
});
