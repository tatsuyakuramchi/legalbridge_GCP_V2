import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ContractBandService, stepsOf } from "./contract-band.js";

const UNSENT = { status: "unsent" as const, at: null, source: null };
const raw = (over: Partial<Parameters<typeof stepsOf>[0]> = {}): Parameters<typeof stepsOf>[0] => ({
  source: "document", id: 1, number: "ARC-NDA-2026-0012", title: "秘密保持契約", kindLabel: "秘密保持契約書",
  party: { id: 7, name: "ノースライト企画" }, contract: null, agreementId: null,
  status: "issued", reserved: false, external: false, hasFile: true, sentAt: null, sign: UNSENT,
  executedOn: null, expiresOn: null, autoRenewal: false, agreementStatus: null, ...over
});
const TODAY = "2026-11-06";

test("番号だけ取った文書：ファイルを取り込むまで止まり、取り込んだら締結の記録で止まる（記録を求める）", () => {
  const waiting = stepsOf(raw({ reserved: true, external: true, hasFile: false, status: "draft" }), TODAY);
  assert.equal(waiting.stuck, "document");
  assert.equal(waiting.steps.document.label, "ファイル待ち");
  assert.equal(waiting.steps.sign.state, "none", "止まりは前の段から 1 つだけ");
  const filed = stepsOf(raw({ reserved: true, external: true, hasFile: true }), TODAY);
  assert.equal(filed.steps.send.label, "—", "取り込んだ文書は外で送付");
  assert.equal(filed.stuck, "sign");
  assert.equal(filed.steps.sign.sub, "締結を記録する");
  const signed = stepsOf(raw({ reserved: true, external: true, sign: { status: "executed", at: "2026-10-05", source: "manual" } }), TODAY);
  assert.equal(signed.stuck, null);
  assert.deepEqual([signed.steps.sign.label, signed.steps.sign.sub], ["締結済 10/05", "手で記録"]);
});

test("取り込んだ PDF をクラウドサインで送ったら、送付の段に出す（手で記録した締結は外で送付のまま）", () => {
  const drafted = stepsOf(raw({ external: true, sign: { status: "drafted", at: "2026-11-06", source: "cloudsign" } }), TODAY);
  assert.deepEqual([drafted.steps.send.state, drafted.steps.send.label], ["wait", "CloudSign 下書き"]);
  assert.equal(drafted.steps.sign.label, "署名待ち");
  assert.equal(drafted.stuck, null);
  const sent = stepsOf(raw({ external: true, sign: { status: "sent", at: "2026-11-06", source: "cloudsign" } }), TODAY);
  assert.deepEqual([sent.steps.send.state, sent.steps.send.label], ["ok", "CloudSign で送付 11/06"]);
  const manual = stepsOf(raw({ external: true, sign: { status: "executed", at: "2026-11-06", source: "manual" } }), TODAY);
  assert.equal(manual.steps.send.label, "—");
});

test("ひな形の文書：下書き → 未送付 → 署名待ち → 締結済", () => {
  assert.equal(stepsOf(raw({ status: "draft" }), TODAY).stuck, "document");
  assert.equal(stepsOf(raw({}), TODAY).stuck, "send");
  const sent = stepsOf(raw({ sentAt: "2026-10-02", sign: { status: "sent", at: "2026-10-02", source: "cloudsign" } }), TODAY);
  assert.deepEqual([sent.stuck, sent.steps.send.label, sent.steps.sign.state], [null, "送付済 10/02", "wait"]);
  const declined = stepsOf(raw({ sign: { status: "terminated", at: "2026-11-04", source: "cloudsign" } }), TODAY);
  assert.deepEqual([declined.stuck, declined.steps.sign.label], ["sign", "取下げ"]);
});

test("契約の記録だけ：締結済みなら止まらず、満了が近ければ期限が黄、過ぎたら赤", () => {
  const rec = (expiresOn: string | null, autoRenewal = false) =>
    stepsOf(raw({ source: "agreement", external: true, agreementStatus: "executed", executedOn: "2025-05-30", expiresOn, autoRenewal }), TODAY);
  assert.equal(rec(null).stuck, null);
  assert.equal(rec(null).steps.sign.label, "締結済 05/30");
  assert.equal(rec("2026-12-01").steps.term.state, "wait");
  assert.equal(rec("2026-10-01").steps.term.state, "stop");
  assert.equal(rec("2028-01-01", true).steps.term.sub, "自動更新");
  assert.equal(rec(null, true).steps.term.label, "自動更新");
});

test("帯の行：条件に結ばれていない文書と、文書も条件も無い契約を、切り口で絞って読む", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("a.order_document_id IS NULL")) return [{ id: 108, agreement_no: "K-0108", title: "出版ライセンス基本契約", kind: "master", status: "executed",
      executed_on: "2025-05-30", expires_on: null, auto_renewal: true, party_id: 8, party_name: "東和ブックス", root_id: null }];
    if (t.includes("FROM documents d")) return [{ id: 12, document_no: "ARC-NDA-2026-0012", status: "draft", agreement_id: null, storage_url: null,
      external: true, reserved: true, title: "秘密保持契約", kind_label: "秘密保持契約書", party_id: 7, party_name: "ノースライト企画",
      sent_at: null, sign: null, root_id: null }];
    return undefined;
  });
  const rows = await new ContractBandService(db, () => TODAY).rows({ matterId: 30 });
  assert.deepEqual(rows.map((r) => [r.key, r.numberOnly, r.stuck]), [["document:12", true, "document"], ["agreement:108", false, null]]);
  assert.equal(rows[1].kindLabel, "基本契約");
  const docSql = db.find("LEFT JOIN v_document_display v")!.text;
  assert.ok(docSql.includes("NOT EXISTS (SELECT 1 FROM document_conditions dc"), "条件の行に出る文書は帯に出さない");
  assert.ok(docSql.includes("d.matter_id = $1"));
  assert.deepEqual(db.find("LEFT JOIN v_document_display v")!.params, [30]);
  assert.ok(db.find("a.order_document_id IS NULL")!.text.includes("mc.target_type = 'condition'"),
    "案件の切り口：この案件に入っていない条件しか無い契約は帯に出す");
  await new ContractBandService(db, () => TODAY).rows({ partyId: 7 });
  assert.ok(db.all("LEFT JOIN v_document_display v").at(-1)!.text.includes("v.counterparty_id = $1"));
});
