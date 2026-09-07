import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DispatchService } from "./dispatch-service.js";
import { MemoryAdapter } from "./adapters.js";
import type { GateSettings, IntegrationChannel } from "./gate.js";

const live: GateSettings = { mode: "live", adapterConfigured: true, readOnly: false };

const build = (settings: Partial<GateSettings> = {}, existing?: Record<string, unknown>) => {
  const db = new FakeDatabase((text) =>
    text.includes("FROM audit_events WHERE idempotency_key") && existing ? [{ detail: existing }] : undefined);
  const adapter = new MemoryAdapter("gmail");
  const service = new DispatchService(
    db, { gmail: adapter }, () => ({ ...live, ...settings }));
  return { db, adapter, service };
};

const request = {
  channel: "gmail" as IntegrationChannel, targetType: "document", targetId: 6, actor: "kuramochi",
  request: { recipient: "acct@example.test", subject: "計算書の送付", body: "本文" }
};

test("送信して外部IDと監査記録を残す", async () => {
  const { db, adapter, service } = build();
  const result = await service.dispatch(request);

  assert.equal(result.sent, true);
  assert.equal(adapter.sent.length, 1);
  assert.equal(result.externalId, "gmail-1");
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "gmail.send");
  assert.ok(audit!.params[4], "冪等キーを付ける");
});

test("設定が無効なら送らず、止めた理由も記録に残す", async () => {
  const { db, adapter, service } = build({ mode: "off" });
  const result = await service.dispatch(request);

  assert.equal(result.sent, false);
  assert.equal(adapter.sent.length, 0);
  assert.deepEqual(result.gate.blockers, ["channel_off"]);
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "gmail.blocked", "止めた事実も残す");
});

test("検証モードは送らずに中身だけ返す", async () => {
  const { adapter, service } = build({ mode: "dry_run" });
  const result = await service.dispatch(request);

  assert.equal(result.sent, false);
  assert.equal(adapter.sent.length, 0);
  assert.equal(result.preview?.recipient, "acct@example.test");
  assert.equal(result.preview?.subject, "計算書の送付");
});

test("止まった理由が検証以外にもあれば中身も返さない", async () => {
  const { service } = build({ mode: "dry_run", readOnly: true });
  const result = await service.dispatch(request);
  assert.equal(result.preview, undefined);
  assert.deepEqual(result.gate.blockers, ["dry_run", "read_only"]);
});

test("同じ内容の再送は冪等キーで弾き、前回の外部IDを返す", async () => {
  const { adapter, service } = build({}, { externalId: "gmail-previous" });
  const result = await service.dispatch(request);

  assert.equal(result.duplicated, true);
  assert.equal(result.sent, false);
  assert.equal(result.externalId, "gmail-previous");
  assert.equal(adapter.sent.length, 0, "二度目は送らない");
});

test("冪等キーは対象と宛先と本文で決まる", () => {
  const base = { channel: "gmail", targetType: "document", targetId: 6, recipient: "a@x.test", body: "本文" };
  const key = DispatchService.idempotencyKey(base);
  assert.equal(DispatchService.idempotencyKey(base), key, "同じ入力なら同じキー");
  assert.notEqual(DispatchService.idempotencyKey({ ...base, recipient: "b@x.test" }), key);
  assert.notEqual(DispatchService.idempotencyKey({ ...base, body: "訂正版" }), key);
  assert.notEqual(DispatchService.idempotencyKey({ ...base, targetId: 7 }), key);
});

test("アダプタが未設定なら送らない", async () => {
  const db = new FakeDatabase();
  const service = new DispatchService(db, {}, () => live);
  const result = await service.dispatch(request);
  assert.equal(result.sent, false);
  assert.deepEqual(result.gate.blockers, ["adapter_unconfigured"]);
});

test("受信は外部IDで一意にし、二度目は duplicated になる", async () => {
  const db = new FakeDatabase((text) =>
    text.includes("INSERT INTO audit_events") ? [{ id: 1 }] : undefined);
  const service = new DispatchService(db, {}, () => live);
  const first = await service.receiveWebhook({
    source: "cloudsign", externalId: "evt-1", payload: { status: "signed" } });
  assert.deepEqual(first, { accepted: true, duplicated: false });

  const quiet = new FakeDatabase();   // ON CONFLICT DO NOTHING で0行
  const second = new DispatchService(quiet, {}, () => live);
  const again = await second.receiveWebhook({
    source: "cloudsign", externalId: "evt-1", payload: {} });
  assert.equal(again.duplicated, true);
});

test("外部IDの無い受信は受け付けない", async () => {
  const service = new DispatchService(new FakeDatabase(), {}, () => live);
  await assert.rejects(() => service.receiveWebhook({ source: "backlog", externalId: "", payload: {} }));
});
