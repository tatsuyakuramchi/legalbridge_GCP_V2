import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import { checkDatabase, getPool } from "./db/pool.js";
import { PrimaryProbe } from "./db/probe.js";
import type { Transactable } from "./core/db.js";
import { buildUploads, createRoutes, createWebhookRouter, errorHandler } from "./routes.js";
import { createUploadRouter } from "./intake/upload-page.js";
import { createGoogleLoginRouter } from "./integrations/google-login-routes.js";
import { googleLogin } from "./integrations/factory.js";

/**
 * 画面の隅に出す「どの環境で、どの DB を、いつ時点のデータで見ているか」。
 *
 *   label / dataAsOf … 予備系の環境名と、同期スクリプトが書く印のファイル（同期のたびに変わるので毎回読む）
 *   db.target        … つないでいる DB。primary＝本番、standby＝手元の写し、null＝従来（切り替えを使っていない）
 *   db.reachable     … いまつないでいる DB に届くか
 *   db.primaryReachable … 写しで動いているとき、本番に届くようになったか（戻しの判断の材料。自動では切り替えない）
 *
 * docs/v3-local-app-cloud-db.md §3。
 */
export interface SiteInfo {
  label: string;
  dataAsOf: string | null;
  db: { target: "primary" | "standby" | null; reachable: boolean | null; primaryReachable: boolean | null };
}

const primaryProbe = new PrimaryProbe(config.dbTarget.target === "standby" ? config.dbTarget.primary : null);

export async function siteInfo(database: Transactable | null): Promise<SiteInfo> {
  let dataAsOf: string | null = null;
  if (config.dataStampPath) {
    try { dataAsOf = fs.readFileSync(config.dataStampPath, "utf8").trim() || null; } catch { dataAsOf = null; }
  }
  const target = config.dbTarget.target;
  const reachable = target ? (await checkDatabase(database as never)).reachable : null;
  const primaryReachable = target === "standby" ? await primaryProbe.reachable() : null;
  return { label: config.siteLabel, dataAsOf, db: { target, reachable, primaryReachable } };
}

/**
 * 配っている画面（UI）の版。
 *
 * 入れ替えたのに画面が古いままのとき、原因は2つしかない。コンテナが古いか、
 * ブラウザが古いものを持っているか。ここに出すのはコンテナ側の版なので、
 * ブラウザが読んだファイル名（開発者ツールの Network）と突き合わせれば
 * どちらなのかが決まる。名前が違えばブラウザ側、同じならコンテナ側。
 */
export function clientStamp(clientDir: string): { asset: string | null; builtAt: string | null } {
  try {
    const indexPath = path.join(clientDir, "index.html");
    const html = fs.readFileSync(indexPath, "utf8");
    return {
      asset: /\/assets\/([A-Za-z0-9._-]+\.js)/.exec(html)?.[1] ?? null,
      builtAt: fs.statSync(indexPath).mtime.toISOString()
    };
  } catch {
    return { asset: null, builtAt: null };
  }
}

export function createApp(database: Transactable | null = getPool() as Transactable | null) {
  const app = express();
  // 本番はビルド済みUIを同じサービスから配る（V2 と同じ構成）。
  const clientDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../client");
  app.use(cors());

  // Webhook は署名検証に生の本文が要るので、JSON パーサより前に置く。
  // ユーザー認証も通さない（各受信口が共有シークレットか署名で守る）。
  if (database) {
    // 依頼者の資料アップロード（A-055）。1 ファイル 30MB まで受けるので、/internal の
    // 2MB の上限より手前に置く。署名付きのリンクで守る（依頼者は V3 に入れない）。
    app.use("/internal/upload", createUploadRouter(database, buildUploads(database)));
    app.use("/internal", express.raw({ type: "*/*", limit: "2mb" }), createWebhookRouter(database));
  }

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_request, response) => {
    response.json({
      status: "ok",
      service: "legalbridge-v3",
      readOnly: config.readOnly,
      dbTarget: config.dbTarget.target,
      database: await checkDatabase(database as never),
      client: clientStamp(clientDir)
    });
  });

  app.use(authenticate);

  // 予備系の「Google にログイン」（認証の内側。state で守る。google-login.ts）。
  app.use("/auth/google", createGoogleLoginRouter(googleLogin));

  app.get("/api/v3/me", async (_request, response) => {
    response.json({ user: response.locals.currentUser, readOnly: config.readOnly, site: await siteInfo(database) });
  });

  if (database) {
    app.use("/api/v3", createRoutes(database));
  } else {
    app.use("/api/v3", (_request, response) => {
      response.status(503).json({ error: "データベースが設定されていません", code: "DB_UNCONFIGURED" });
    });
  }

  app.use(express.static(clientDir, {
    setHeaders(response, filePath) {
      // 名前にハッシュの入った資材（assets/index-XXXX.js）は、中身が変われば
      // 名前も変わる。長く持たせてよい。
      //
      // index.html はいつも確かめさせる。ここを持たせると、入れ替えたのに
      // 古い資材を指した index.html がブラウザに残り、サーバだけ新しくて
      // 画面は古いまま、という食い違いが起きる（実際に起きた。定期課金の
      // 金額欄が出ないのに、登録すると新しいサーバの検証に弾かれた）。
      response.setHeader("Cache-Control",
        /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
    }
  }));
  app.get(/^(?!\/api|\/health|\/internal).*/, (_request, response) => {
    response.sendFile(path.join(clientDir, "index.html"),
      { headers: { "Cache-Control": "no-cache" } }, (error) => {
        if (error) response.status(404).json({ error: "not found" });
      });
  });

  app.use(errorHandler);
  return app;
}
