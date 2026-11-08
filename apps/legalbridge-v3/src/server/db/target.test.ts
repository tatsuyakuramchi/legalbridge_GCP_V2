import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDbTarget } from "./target.js";
import { PrimaryProbe } from "./probe.js";

const both = {
  PRIMARY_DB_HOST: "host.docker.internal", PRIMARY_DB_PORT: "5433", PRIMARY_DB_NAME: "legalbridge",
  PRIMARY_DB_USER: "legalbridge_v3_runtime", PRIMARY_DB_PASSWORD: "p",
  STANDBY_DB_HOST: "db", STANDBY_DB_NAME: "legalbridge", STANDBY_DB_USER: "legalbridge_v3_runtime", STANDBY_DB_PASSWORD: "s"
};
const noFile = () => { throw new Error("ENOENT"); };

test("どこにも指定が無ければ従来どおり（DB_* をそのまま。番号帯は予備系）", () => {
  const r = resolveDbTarget({ DB_HOST: "db" }, noFile);
  assert.equal(r.target, null);
  assert.equal(r.source, null);
  assert.equal(r.endpoint, null);
  assert.equal(r.numberBand, "backup");
  assert.deepEqual(r.warnings, []);
});

test("ファイルが最優先。standby なら STANDBY_DB_* につなぎ、番号帯は予備系", () => {
  const r = resolveDbTarget({ ...both, DB_TARGET_PATH: "/data/DB_TARGET", DB_TARGET: "primary" }, () => "standby\n");
  assert.equal(r.target, "standby");
  assert.equal(r.source, "file");
  assert.equal(r.endpoint?.host, "db");
  assert.equal(r.endpoint?.port, 5432, "PORT を省くと 5432");
  assert.equal(r.numberBand, "backup");
  assert.equal(r.primary?.port, 5433);
});

test("ファイルが無ければ環境変数。primary なら PRIMARY_DB_* につなぎ、番号帯は本番の連番", () => {
  const r = resolveDbTarget({ ...both, DB_TARGET_PATH: "/data/DB_TARGET", DB_TARGET: "primary" }, noFile);
  assert.equal(r.target, "primary");
  assert.equal(r.source, "env");
  assert.equal(r.endpoint?.host, "host.docker.internal");
  assert.equal(r.numberBand, "");
});

test("空のファイルは無視して環境変数へ。変な中身は知らせて無視する", () => {
  const empty = resolveDbTarget({ ...both, DB_TARGET_PATH: "/data/DB_TARGET", DB_TARGET: "standby" }, () => "  \n");
  assert.equal(empty.target, "standby");
  assert.equal(empty.source, "env");
  const odd = resolveDbTarget({ ...both, DB_TARGET_PATH: "/data/DB_TARGET" }, () => "prod");
  assert.equal(odd.target, null);
  assert.match(odd.warnings[0]!, /primary \/ standby のどちらでもありません/);
  const oddEnv = resolveDbTarget({ ...both, DB_TARGET: "local" }, noFile);
  assert.equal(oddEnv.target, null);
  assert.match(oddEnv.warnings[0]!, /DB_TARGET は primary \/ standby/);
});

test("決まった側の接続先が揃っていなければ DB_* に落ち、知らせる", () => {
  const r = resolveDbTarget({ DB_TARGET: "primary", STANDBY_DB_HOST: "db" }, noFile);
  assert.equal(r.target, "primary");
  assert.equal(r.endpoint, null);
  assert.equal(r.primary, null);
  assert.match(r.warnings[0]!, /PRIMARY_DB_\* が揃っていません/);
});

test("本番に届くかの確認：結果を持ち回し、同時の問い合わせは 1 回にまとめ、接続先が無ければ分からない", async () => {
  let calls = 0, ok = true, t = 0;
  const probe = new PrimaryProbe(
    { host: "h", port: 5432, database: "d", user: "u", password: "p" },
    async () => { calls++; if (!ok) throw new Error("ECONNREFUSED"); },
    30_000, () => t
  );
  const [a, b] = await Promise.all([probe.reachable(), probe.reachable()]);
  assert.deepEqual([a, b, calls], [true, true, 1]);
  ok = false;
  assert.equal(await probe.reachable(), true, "30 秒の間は前の結果");
  t = 31_000;
  assert.equal(await probe.reachable(), false);
  assert.equal(calls, 2);
  assert.equal(await new PrimaryProbe(null).reachable(), null);
});
