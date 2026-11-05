import test from "node:test";
import assert from "node:assert/strict";
import { isPoolTimeout } from "./pool.js";
import { errorHandler } from "../routes.js";

const fakeRes = () => {
  const r: any = { headersSent: false, statusCode: 0, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
};

test("pg-pool の接続待ちの失敗を見分ける", () => {
  assert.equal(isPoolTimeout(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isPoolTimeout(new Error("Connection terminated due to connection timeout")), true);
  assert.equal(isPoolTimeout(new Error("something else")), false);
  assert.equal(isPoolTimeout(null), false);
});

test("接続待ちで落ちたら 500 ではなく 503 と、何が起きたか・どうすればよいかを返す", () => {
  const res = fakeRes();
  const original = console.error; console.error = () => undefined;
  try {
    errorHandler(new Error("timeout exceeded when trying to connect"), { originalUrl: "/api/v3/tasks/counts" } as any, res, () => undefined);
  } finally { console.error = original; }
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "UNAVAILABLE");
  assert.match(res.body.error, /データベースに接続できませんでした/);
});

test("ほかの想定外のエラーは従来どおり 500", () => {
  const res = fakeRes();
  const original = console.error; console.error = () => undefined;
  try { errorHandler(new Error("boom"), { originalUrl: "/x" } as any, res, () => undefined); }
  finally { console.error = original; }
  assert.equal(res.statusCode, 500);
});

test("台帳が上限で止めた問い合わせ（lock_timeout・statement_timeout・止まった取引）を見分け、503 で返す", async () => {
  const { isDbTimeout } = await import("./pool.js");
  const pgError = (code: string) => Object.assign(new Error("x"), { code });
  assert.equal(isDbTimeout(pgError("55P03")), "lock");
  assert.equal(isDbTimeout(pgError("57014")), "statement");
  assert.equal(isDbTimeout(pgError("25P03")), "idle_tx");
  assert.equal(isDbTimeout(pgError("23505")), null);
  const original = console.error; console.error = () => undefined;
  try {
    const lock = fakeRes();
    errorHandler(pgError("55P03"), { originalUrl: "/api/v3/parties" } as any, lock, () => undefined);
    assert.equal(lock.statusCode, 503);
    assert.match(lock.body.error, /ほかの処理がデータを使っている/);
    const slow = fakeRes();
    errorHandler(pgError("57014"), { originalUrl: "/api/v3/exports" } as any, slow, () => undefined);
    assert.equal(slow.statusCode, 503);
    assert.match(slow.body.error, /時間内に終わらなかった/);
  } finally { console.error = original; }
});
