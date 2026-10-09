import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientStamp } from "./app.js";

/**
 * 「入れ替えたのに画面が古い」を切り分けるための印。コンテナが配っている
 * 資材の名前が出る。ブラウザが読んだ名前と違えばブラウザ側の持ち越し。
 */
test("配っている画面の版は index.html の資材名から出る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-client-"));
  fs.writeFileSync(path.join(dir, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-DIJdFkdu.js"></script>');
  const stamp = clientStamp(dir);
  assert.equal(stamp.asset, "index-DIJdFkdu.js");
  assert.match(String(stamp.builtAt), /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("画面が置かれていなければ空で返す（/health は落とさない）", () => {
  assert.deepEqual(clientStamp(path.join(os.tmpdir(), "lb-client-missing")),
    { asset: null, builtAt: null });
});

/**
 * 経路の番号が数でないとき。貼り損ねたコマンド（.../conditions/…/void）が
 * 500「サーバ内部でエラー」に見えていたのを、その場で 400 にする。
 */
test("経路の番号が数でなければ 400 で、どの欄が悪いかを言う", async () => {
  const { createRoutes } = await import("./routes.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/v3", createRoutes({ query: async () => ({ rows: [] }) } as never));
  const { errorHandler } = await import("./routes.js");
  app.use(errorHandler);

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/conditions/%E2%80%A6/events/29/void`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "検証" }) });
    assert.equal(res.status, 400, "500 ではなく 400");
    const body = await res.json() as { error?: string };
    assert.match(String(body.error), /id は番号で指定してください/);
  } finally {
    server.close();
  }
});

test("送付の一覧（/documents/unsent-bundles）は /documents/:id に取られない", async () => {
  const { createRoutes, errorHandler } = await import("./routes.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  // 役割の確かめを通すため、admin として入る（本物は認証の層が res.locals に入れる）。
  app.use((_req, res, next) => { res.locals.currentUser = { email: "t@example.test", role: "admin" } as never; next(); });
  app.use("/api/v3", createRoutes({ query: async () => ({ rows: [] }) } as never));
  app.use(errorHandler);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/documents/unsent-bundles`);
    const body = await res.json() as { bundles?: unknown[]; error?: string };
    assert.doesNotMatch(String(body.error ?? ""), /id は番号で指定してください/);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.bundles, []);
  } finally {
    server.close();
  }
});
