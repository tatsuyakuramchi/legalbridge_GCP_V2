import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createAuthentication, type AuthSettings } from "../auth.js";
import { createSpllSiteRouter, normalizeBasePath } from "./routes.js";

function site(basePath = "/spll") {
  const app = express();
  app.use(basePath, createSpllSiteRouter({ basePath }));
  return app;
}

test("normalizeBasePath はスラッシュを揃え、ルート直下は空文字にする", () => {
  assert.equal(normalizeBasePath("/spll"), "/spll");
  assert.equal(normalizeBasePath("spll/"), "/spll");
  assert.equal(normalizeBasePath("//spll//"), "/spll");
  assert.equal(normalizeBasePath("/"), "");
  assert.equal(normalizeBasePath(undefined), "");
});

test("トップページを配信し、リンクはベースパス配下を指す", async () => {
  const response = await request(site()).get("/spll/");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/html/);
  assert.match(response.text, /TRPG二次創作ライセンス/);
  assert.match(response.text, /href="\/spll\/works"/);
  assert.doesNotMatch(response.text, /href="\/works"/);
});

test("原作を検索でき、一致しない語では0件と分かる", async () => {
  const hit = await request(site()).get("/spll/works").query({ q: "インセイン" });
  assert.equal(hit.status, 200);
  assert.match(hit.text, /インセイン/);
  assert.doesNotMatch(hit.text, /光砕のリヴァルチャー/);

  const miss = await request(site()).get("/spll/works").query({ q: "存在しない作品" });
  assert.equal(miss.status, 200);
  assert.match(miss.text, /見つかりませんでした/);
});

test("原作詳細は利用できる要素・できないこと・クレジットを示す", async () => {
  const response = await request(site()).get("/spll/works/WRK-ARK00012");
  assert.equal(response.status, 200);
  assert.match(response.text, /世界観・神話設定/);
  assert.match(response.text, /ルールデータの転載/);
  assert.match(response.text, /クレジット表記/);
});

test("存在しない原作は404を返す", async () => {
  const response = await request(site()).get("/spll/works/WRK-NOT-EXIST");
  assert.equal(response.status, 404);
  assert.match(response.text, /ページが見つかりません/);
});

test("申込ページは個人専用であることと契約成立点を明示する", async () => {
  const response = await request(site()).get("/spll/apply").query({ work: "WRK-ARK00045" });
  assert.equal(response.status, 200);
  assert.match(response.text, /光砕のリヴァルチャー/);
  assert.match(response.text, /個人（個人事業主を含む）/);
  assert.match(response.text, /クラウドサイン上で同意した時点/);
});

test("認証の検証は有効・停止中で表示が変わり、停止理由は公開しない", async () => {
  const active = await request(site()).get("/spll/v/CERT-DEMO-0042");
  assert.equal(active.status, 200);
  assert.match(active.text, /確認済み/);
  assert.match(active.text, /SPLL-202608-0042/);

  const hold = await request(site()).get("/spll/v/CERT-DEMO-0041");
  assert.equal(hold.status, 200);
  assert.match(hold.text, /現在は無効です/);
  assert.match(hold.text, /停止の理由は公開していません/);

  const unknown = await request(site()).get("/spll/v/CERT-UNKNOWN");
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /認証を確認できません/);
});

test("公開データのJSON APIを返す", async () => {
  const works = await request(site()).get("/spll/api/works").query({ q: "アークライト" });
  assert.equal(works.status, 200);
  assert.equal(works.body.works.length, 2);
  assert.equal(works.body.works[0].workId, "WRK-ARK00012");

  const fees = await request(site()).get("/spll/api/fees");
  assert.equal(fees.status, 200);
  assert.equal(fees.body.fees.length, 6);
});

test("ベースパスは変更でき、リンクも追随する", async () => {
  const response = await request(site("/creator")).get("/creator/");
  assert.equal(response.status, 200);
  assert.match(response.text, /href="\/creator\/works"/);
});

test("クエリはHTMLへそのまま出力しない（検索語のエスケープ）", async () => {
  const response = await request(site()).get("/spll/works").query({ q: '"><script>alert(1)</script>' });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /<script>alert\(1\)<\/script>/);
  assert.match(response.text, /&lt;script&gt;/);
});

const iapSettings: AuthSettings = {
  mode: "iap",
  adminEmails: new Set(["admin@example.com"]),
  legalEmails: new Set(),
  requesterDomains: new Set()
};

test("公開指定なしなら社内認証の内側に置かれる", async () => {
  const app = express();
  app.use(createAuthentication(iapSettings));
  app.use("/spll", createSpllSiteRouter({ basePath: "/spll" }));
  const response = await request(app).get("/spll/");
  assert.equal(response.status, 401);
});

test("公開指定したベースパス配下だけ認証を通さない", async () => {
  const app = express();
  app.use(createAuthentication(iapSettings, ["/spll"]));
  app.use("/spll", createSpllSiteRouter({ basePath: "/spll" }));
  app.get("/api/v2/me", (_request, response) => response.json({ ok: true }));

  assert.equal((await request(app).get("/spll/")).status, 200);
  assert.equal((await request(app).get("/spll/works")).status, 200);
  // 公開したのはSPLLサイトだけで、業務APIは従来どおり認証必須のまま
  assert.equal((await request(app).get("/api/v2/me")).status, 401);
  // 前方一致の取り違えでうっかり公開しないこと（/spll-admin は対象外）
  assert.equal((await request(app).get("/spll-admin")).status, 401);
});
