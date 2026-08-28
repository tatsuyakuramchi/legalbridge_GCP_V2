import { Router } from "express";
import { z } from "zod";
import type { MatterRepository } from "./repository.js";
import type {
  MatterSlackThreadRepository, MatterMentionRepository
} from "./matter-slack-thread-repository.js";
import type { MatterSlackChannelAdapter, MatterSlackTemplate } from "../integrations/slack-matter-channel.js";
import {
  composeMentionMessage, buildThreadRootText, isSlackUserId, buildTemplateMessage
} from "../integrations/slack-matter-channel.js";
import type { DrivePermissionGranter } from "../documents/drive-permission.js";
import { extractDriveFileId } from "../documents/drive-permission.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export interface MatterSlackSettings {
  // Slack 実送信が可能か（live + bot token + チャンネル設定 + 書込スコープ）。
  enabled: boolean;
  legalChannelId: string;   // 法務相談チャンネル（未設定なら空）
}

export interface MatterSlackDeps {
  matters: MatterRepository | undefined;
  threads: MatterSlackThreadRepository | undefined;
  mentions: MatterMentionRepository | undefined;
  channel: MatterSlackChannelAdapter;
  settings: MatterSlackSettings;
  granter?: DrivePermissionGranter;   // Drive 閲覧権限付与（任意・テンプレ2/3）
}

const messageBody = z.object({
  text: z.string().trim().min(1, "本文が必要です").max(3000),
  mentions: z.array(z.string().trim()).max(20).optional()
});
const templateBody = z.object({
  template: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mentions: z.array(z.string().trim()).max(20).default([]),
  cc: z.array(z.string().trim()).max(20).optional(),
  documentId: z.coerce.number().int().positive().optional(),
  // 閲覧リンクを複数載せる（documentId の複数版・両方来たら結合して重複除去）。
  documentIds: z.array(z.coerce.number().int().positive()).max(10).optional(),
  driveLink: z.string().trim().max(1000).optional()
});

export function createMatterSlackRouter(deps: MatterSlackDeps) {
  const router = Router();
  const ready = () =>
    Boolean(deps.matters && deps.threads && deps.mentions) &&
    deps.settings.enabled && deps.channel.configured && Boolean(deps.settings.legalChannelId);

  // メンション候補（staff.slack_user_id）。読取。
  router.get("/matters/slack/mention-candidates", async (_request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_SLACK_FORBIDDEN" });
      }
      if (!deps.mentions) return response.status(200).json({ enabled: false, candidates: [] });
      const candidates = await deps.mentions.listCandidates();
      return response.status(200).json({ enabled: ready(), candidates });
    } catch (error) {
      return next(error);
    }
  });

  // スレッド会話の読取。スレッド未作成なら thread:null。
  router.get("/matters/:id/slack/replies", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_SLACK_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      if (!deps.threads) return response.status(200).json({ enabled: false, thread: null, messages: [] });
      const thread = await deps.threads.findByMatter(id);
      if (!thread) return response.status(200).json({ enabled: ready(), thread: null, messages: [] });
      if (!ready()) {
        return response.status(200).json({ enabled: false, thread, messages: [] });
      }
      const messages = await deps.channel.getReplies({ channel: thread.channelId, ts: thread.threadTs });
      return response.status(200).json({ enabled: true, thread, messages });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 法務相談スレッドの作成（1案件1スレッド・冪等）。guarded-write。
  router.post("/matters/:id/slack/thread", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_SLACK_FORBIDDEN" });
      }
      if (!ready() || !deps.matters || !deps.threads) {
        return response.status(409).json({ error: "Slack連携が有効ではありません", code: "MATTER_SLACK_DISABLED" });
      }
      const { id } = idPath.parse(request.params);
      const existing = await deps.threads.findByMatter(id);
      if (existing) return response.status(200).json({ thread: existing, created: false });
      const detail = await deps.matters.find(id);
      if (!detail) return response.status(404).json({ error: "案件が見つかりません", code: "MATTER_NOT_FOUND" });
      const m = detail.matter;
      const rootText = buildThreadRootText({
        matterCode: m.matterCode, matterId: m.id, title: m.title, counterparty: m.counterparty
      });
      const posted = await deps.channel.postMessage({ channel: deps.settings.legalChannelId, text: rootText });
      const thread = await deps.threads.create({
        matterId: id, channelId: posted.channel, threadTs: posted.ts,
        rootText, createdBy: response.locals.currentUser?.email ?? "unknown"
      });
      return response.status(201).json({ thread, created: true });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // メンション付きメッセージをスレッドへ投稿。guarded-write。
  router.post("/matters/:id/slack/messages", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_SLACK_FORBIDDEN" });
      }
      if (!ready() || !deps.threads) {
        return response.status(409).json({ error: "Slack連携が有効ではありません", code: "MATTER_SLACK_DISABLED" });
      }
      const { id } = idPath.parse(request.params);
      const body = messageBody.parse(request.body);
      const thread = await deps.threads.findByMatter(id);
      if (!thread) return response.status(409).json({ error: "スレッド未作成です", code: "MATTER_SLACK_THREAD_MISSING" });
      const mentionIds = (body.mentions ?? []).filter(isSlackUserId);
      const text = composeMentionMessage(body.text, mentionIds);
      const posted = await deps.channel.postMessage({
        channel: thread.channelId, text, threadTs: thread.threadTs
      });
      return response.status(201).json({ ok: true, ts: posted.ts, text });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 定型文（1:CloudSign送信済 / 2:文書作成完了 / 3:評価完了）をスレッドへ投稿。
  // テンプレ2/3 は閲覧リンクを載せ、granter があればメンション先へ Drive 閲覧権限を付与。
  router.post("/matters/:id/slack/template", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_SLACK_FORBIDDEN" });
      }
      if (!ready() || !deps.matters || !deps.threads || !deps.mentions) {
        return response.status(409).json({ error: "Slack連携が有効ではありません", code: "MATTER_SLACK_DISABLED" });
      }
      const { id } = idPath.parse(request.params);
      const body = templateBody.parse(request.body);
      const thread = await deps.threads.findByMatter(id);
      if (!thread) return response.status(409).json({ error: "スレッド未作成です", code: "MATTER_SLACK_THREAD_MISSING" });
      const detail = await deps.matters.find(id);
      if (!detail) return response.status(404).json({ error: "案件が見つかりません", code: "MATTER_NOT_FOUND" });

      const toIds = body.mentions.filter(isSlackUserId);
      const ccIds = (body.cc ?? []).filter(isSlackUserId);
      const template = body.template as MatterSlackTemplate;

      // 閲覧リンク解決：documentIds/documentId（複数可・指定順） > driveLink > 案件の最新文書。
      let driveLinks: Array<{ url: string; label: string | null }> = [];
      if (template !== 1) {
        const requestedIds = [...new Set([...(body.documentIds ?? []),
          ...(body.documentId ? [body.documentId] : [])])];
        driveLinks = requestedIds
          .map((docId) => detail.documents.find((d) => d.id === docId))
          .filter((d): d is NonNullable<typeof d> => Boolean(d?.driveLink))
          .map((d) => ({ url: d.driveLink, label: d.documentNumber }));
        if (!driveLinks.length && body.driveLink) driveLinks = [{ url: body.driveLink, label: null }];
        // 最新文書へのフォールバックは「文書の指定が無い」ときだけ。documentIds: [] は
        // 「リンクを載せない」という明示なので尊重する（旧UIの「添付しない」が
        // 最新文書に化けていた問題の修正）。
        if (!driveLinks.length && body.documentIds === undefined && body.documentId === undefined) {
          const latest = detail.documents.find((d) => d.driveLink);
          if (latest) driveLinks = [{ url: latest.driveLink, label: latest.documentNumber }];
        }
      }

      // Drive 閲覧権限付与（best-effort・granter 有効かつリンク有時のみ・全リンク×宛先）。
      let grant: { granted: string[]; failed: string[]; skipped: boolean } = { granted: [], failed: [], skipped: true };
      if (template !== 1 && driveLinks.length && deps.granter?.configured) {
        const fileIds = [...new Set(driveLinks
          .map((l) => extractDriveFileId(l.url))
          .filter((fileId): fileId is string => Boolean(fileId)))];
        const recipients = await deps.mentions.emailsForSlackIds(toIds);
        if (fileIds.length && recipients.length) {
          grant = { granted: [], failed: [], skipped: false };
          for (const r of recipients) {
            let ok = true;
            for (const fileId of fileIds) {
              try { await deps.granter.grantView(fileId, r.email); }
              catch { ok = false; }
            }
            (ok ? grant.granted : grant.failed).push(r.email);
          }
        }
      }

      const text = buildTemplateMessage(template, { toIds, ccIds, driveLinks });
      const posted = await deps.channel.postMessage({
        channel: thread.channelId, text, threadTs: thread.threadTs
      });
      return response.status(201).json({ ok: true, ts: posted.ts, text, grant });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
