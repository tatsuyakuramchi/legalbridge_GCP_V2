import { Router } from "express";
import { z } from "zod";
import type { GmailSendHistoryRepository } from "../integrations/gmail-send-history-repository.js";
import type { CloudSignRequestRepository } from "../integrations/cloudsign-request-repository.js";
import type { DatabasePool } from "../db/pool.js";

// 文書単位の送信・署名履歴＋宛先候補（Phase W3・日常運用監査対応）。
// 従来は Gmail 送信履歴に GET が無く、CloudSign の文書IDも React state 頼みで
// リロードすると送信済みかどうか一切分からなかった。ここで読み口を提供する。
// 宛先候補は確定時に解決済みの documents.vendor_id → vendors.email/担当者から返す
// （台帳画面ではメールをマスキングしているが、送信操作には実アドレスが必要。
//  そのため admin/legal のみに限定して返す）。

export interface RecipientSuggestion {
  email: string;
  name: string;
  source: string;   // 例: "取引先マスタ"
}

export interface RecipientSuggestionSource {
  suggest(documentId: number): Promise<RecipientSuggestion[]>;
}

export class PgRecipientSuggestionSource implements RecipientSuggestionSource {
  constructor(private readonly database: DatabasePool) {}

  async suggest(documentId: number) {
    // 署名者用（CloudSign）→ 担当者 → 代表メールの順で候補にする（067 で2欄追加）。
    // 同じアドレスが複数欄に入っている場合は先勝ちで1件に寄せる。
    const result = await this.database.query(
      `SELECT v.email, v.contact_email, v.signer_email,
              COALESCE(NULLIF(v.contact_name, ''), v.vendor_name) AS name
         FROM documents d
         JOIN vendors v ON v.id = d.vendor_id
        WHERE d.id = $1`,
      [documentId]
    );
    const suggestions: RecipientSuggestion[] = [];
    const seen = new Set<string>();
    for (const row of result.rows) {
      const name = String(row.name ?? "").trim();
      const push = (value: unknown, source: string) => {
        const email = String(value ?? "").trim();
        if (!email.includes("@") || seen.has(email.toLowerCase())) return;
        seen.add(email.toLowerCase());
        suggestions.push({ email, name, source });
      };
      push(row.signer_email, "署名者用（電子契約）");
      push(row.contact_email, "取引先担当者");
      push(row.email, "取引先マスタ");
    }
    return suggestions;
  }
}

export class MemoryRecipientSuggestionSource implements RecipientSuggestionSource {
  constructor(private readonly byDocument: Map<number, RecipientSuggestion[]> = new Map()) {}
  async suggest(documentId: number) {
    return this.byDocument.get(documentId) ?? [];
  }
}

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createSendHistoryRouter(
  gmailHistory?: GmailSendHistoryRepository,
  cloudSignRequests?: CloudSignRequestRepository,
  recipients?: RecipientSuggestionSource
) {
  const router = Router();

  router.get("/documents/:id/send-history", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが閲覧できます", code: "SEND_HISTORY_FORBIDDEN" });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const [gmail, cloudsign, suggestions] = await Promise.all([
        gmailHistory?.listByDocument(id).catch(() => []) ?? Promise.resolve([]),
        cloudSignRequests?.listByDocument(id).catch(() => []) ?? Promise.resolve([]),
        recipients?.suggest(id).catch(() => []) ?? Promise.resolve([])
      ]);
      return response.status(200).json({
        gmail: gmail.map((row) => ({
          recipient: row.recipient, messageId: row.messageId,
          recordedAt: row.recordedAt, recordedBy: row.recordedBy
        })),
        cloudsign: cloudsign.map((row) => ({
          cloudSignDocumentId: row.cloudSignDocumentId, status: row.status,
          participantCount: row.participantCount, recordedAt: row.recordedAt, recordedBy: row.recordedBy
        })),
        suggestions
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
