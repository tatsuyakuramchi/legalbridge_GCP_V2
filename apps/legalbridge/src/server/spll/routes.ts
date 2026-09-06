/**
 * SPLL 公開サイト（クリエーター向け）のルーター。
 *
 * SPLL本体はGoogle Apps Script上で動いているが、一般公開部分のアクセス集中耐性を
 * GASから切り離す方針のため、まず「ベースになるサイト」をこのAPIサービス上に置く。
 * デモ段階ではDB・外部サービスへ一切依存せず、サンプルデータだけで成立させている。
 *
 * URLはSPLL側の公開URL設計に合わせてある（/works・/apply・/v/:certificateId）。
 * 認証QRは頒布物に印刷されて永続するため、実運用では独自ドメインを前段に置き、
 * このサービスの実URL（*.run.app 等）をQRへ埋め込まない。
 */

import { Router } from "express";
import {
  SAMPLE_CERTIFICATES, SAMPLE_FEES, SAMPLE_WORKS,
  findCertificate, findWork, searchWorks
} from "./sample-data.js";
import {
  applyPage, homePage, notFoundPage, verifyIndexPage, verifyPage, workDetailPage, worksPage
} from "./views.js";

export interface SpllSiteOptions {
  /** サイトをぶら下げるパス（既定 /spll）。前後のスラッシュは正規化する。 */
  basePath?: string;
}

/** "/spll/" や "spll" のような入力を "/spll" に揃える。ルート直下の場合は空文字。 */
export function normalizeBasePath(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  return ("/" + trimmed.replace(/^\/+/, "").replace(/\/+$/, ""));
}

export function createSpllSiteRouter(options: SpllSiteOptions = {}): Router {
  const basePath = normalizeBasePath(options.basePath ?? "/spll");
  const router = Router();
  const html = (response: Parameters<Parameters<Router["get"]>[1]>[1], body: string, status = 200) => {
    response.status(status).type("html").send(body);
  };

  router.get("/", (_request, response) => {
    html(response, homePage(basePath, SAMPLE_WORKS));
  });

  router.get("/works", (request, response) => {
    const query = String(request.query.q ?? "").slice(0, 100);
    html(response, worksPage(basePath, searchWorks(query), query));
  });

  router.get("/works/:workId", (request, response) => {
    const work = findWork(String(request.params.workId));
    if (!work) return html(response, notFoundPage(basePath), 404);
    html(response, workDetailPage(basePath, work));
  });

  router.get("/apply", (request, response) => {
    html(response, applyPage(basePath, findWork(String(request.query.work ?? ""))));
  });

  router.get("/verify", (_request, response) => {
    html(response, verifyIndexPage(basePath, SAMPLE_CERTIFICATES));
  });

  // 認証バッジのQRが指す先。SPLL側の verifyUrl_ と同じ形（/v/{cert_id}?c={code}）。
  router.get("/v/:certificateId", (request, response) => {
    const certificate = findCertificate(String(request.params.certificateId));
    html(response, verifyPage(basePath, certificate), certificate ? 200 : 404);
  });

  // 公開データのJSON。将来 public projection へ差し替える前提の読み取り専用API。
  router.get("/api/works", (request, response) => {
    const query = String(request.query.q ?? "").slice(0, 100);
    response.json({ query, works: searchWorks(query), source: "sample" });
  });

  router.get("/api/fees", (_request, response) => {
    response.json({ fees: SAMPLE_FEES, source: "sample" });
  });

  router.use((_request, response) => {
    html(response, notFoundPage(basePath), 404);
  });

  return router;
}
