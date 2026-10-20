import test from "node:test";
import assert from "node:assert/strict";
import { effectiveAllowlist, parseDispatchAllowlist, readDispatchAllowlist } from "./dispatch-allowlist.js";

test("設定が無ければ .env のとおり。open は制限なし、list は書いた宛先だけ", () => {
  const env = ["me@example.com"];
  assert.deepEqual(effectiveAllowlist(readDispatchAllowlist(undefined), env), { allowlist: env, source: "env" });
  assert.deepEqual(effectiveAllowlist(readDispatchAllowlist({ mode: "open", addresses: ["x@y.z"] }), env), { allowlist: [], source: "open" });
  assert.deepEqual(effectiveAllowlist(readDispatchAllowlist({ mode: "list", addresses: "A@b.c, keiri@b.c" }), env),
    { allowlist: ["a@b.c", "keiri@b.c"], source: "list" });
});

test("形を確かめる：メールの形でないもの、list なのに空", () => {
  assert.match(parseDispatchAllowlist({ mode: "list", addresses: ["nope"] }).errors.join("/"), /メールアドレスの形/);
  assert.match(parseDispatchAllowlist({ mode: "list", addresses: [] }).errors.join("/"), /1 つ以上/);
  assert.deepEqual(parseDispatchAllowlist({ mode: "weird" }).value, { mode: "env", addresses: [] });
});
