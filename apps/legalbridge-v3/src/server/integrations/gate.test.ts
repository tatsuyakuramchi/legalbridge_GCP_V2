import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, parseMode } from "./gate.js";

const base = { mode: "live" as const, adapterConfigured: true, readOnly: false };

test("すべて揃えば送れる", () => {
  const r = evaluateGate({ channel: "gmail", recipient: "a@example.test", hasContent: true }, base);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.blockers, []);
});

test("無効・未設定・読み取り専用は送らない", () => {
  assert.deepEqual(evaluateGate({ channel: "slack" }, { ...base, mode: "off" }).blockers, ["channel_off"]);
  assert.deepEqual(evaluateGate({ channel: "slack" }, { ...base, adapterConfigured: false }).blockers, ["adapter_unconfigured"]);
  assert.deepEqual(evaluateGate({ channel: "slack" }, { ...base, readOnly: true }).blockers, ["read_only"]);
});

test("検証モードは送らないが中身は確認できる", () => {
  const r = evaluateGate({ channel: "gmail", recipient: "a@example.test" }, { ...base, mode: "dry_run" });
  assert.equal(r.allowed, false);
  assert.equal(r.previewable, true, "何が送られるかは返してよい");
  assert.deepEqual(r.blockers, ["dry_run"]);
});

test("検証モードでも他に理由があれば中身の確認もさせない", () => {
  const r = evaluateGate({ channel: "gmail", recipient: "" }, { ...base, mode: "dry_run" });
  assert.equal(r.previewable, false);
  assert.deepEqual(r.blockers, ["dry_run", "recipient_missing"]);
});

test("宛先の許可リストは検証中の暴発を止める", () => {
  const settings = { ...base, allowlist: ["ok@example.test"] };
  assert.equal(evaluateGate({ channel: "gmail", recipient: "ok@example.test" }, settings).allowed, true);
  const blocked = evaluateGate({ channel: "gmail", recipient: "other@example.test" }, settings);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.blockers, ["not_allowlisted"]);
});

test("送れない理由は必ず日本語で並べて返す（黙って送らないのが一番まずい）", () => {
  const r = evaluateGate({ channel: "cloudsign", recipient: "", hasContent: false },
    { mode: "off", adapterConfigured: false, readOnly: true });
  assert.equal(r.blockers.length, 5);
  assert.equal(r.reasons.length, 5);
  assert.ok(r.reasons.every((x) => x.length > 0));
});

test("モードの既定は off（設定し忘れで送らない）", () => {
  assert.equal(parseMode(undefined), "off");
  assert.equal(parseMode(""), "off");
  assert.equal(parseMode("LIVE"), "live");
  assert.equal(parseMode("dry_run"), "dry_run");
  assert.equal(parseMode("yes"), "off");
});
