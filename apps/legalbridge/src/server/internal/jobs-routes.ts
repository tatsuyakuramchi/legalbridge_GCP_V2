import { Router } from "express";
import { tokensMatch, extractPresentedToken } from "./shared-secret.js";

// スケジューラ起動口（Cloud Scheduler → Cloud Run）。ユーザー認証をバイパスし、
// 共有シークレット（X-Jobs-Token / Bearer）で保護する。既定 OFF（enabled=false または token 未設定）。
// 個々のジョブ本体は runners[name] として注入する（本 slice では枠のみ・9-1 以降で実装を差し込む）。

export type JobRunner = () => Promise<unknown>;

export interface JobsRouterOptions {
  enabled?: boolean;
  token?: string;
  runners?: Record<string, JobRunner>;
}

export function createJobsRouter(options: JobsRouterOptions = {}) {
  const router = Router();
  const enabled = options.enabled === true && Boolean(options.token);
  const runners = options.runners ?? {};

  router.post("/internal/jobs/:name", async (request, response) => {
    // 無効時は存在を秘匿して 404。
    if (!enabled) return response.status(404).json({ error: "not found", code: "JOBS_DISABLED" });
    const presented = extractPresentedToken(request.header("x-jobs-token"), request.header("authorization"));
    if (!tokensMatch(options.token, presented)) {
      return response.status(401).json({ error: "invalid job token", code: "JOBS_UNAUTHORIZED" });
    }
    const name = String(request.params.name);
    const runner = runners[name];
    if (!runner) return response.status(404).json({ error: `unknown job: ${name}`, code: "JOB_NOT_FOUND" });
    try {
      const result = await runner();
      return response.status(200).json({ ok: true, name, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response.status(500).json({ ok: false, name, error: message, code: "JOB_FAILED" });
    }
  });

  return router;
}
