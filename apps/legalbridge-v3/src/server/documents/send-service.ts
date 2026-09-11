import { inTransaction, int, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { recordCommunication } from "../matters/communication-service.js";

/**
 * 決定した文書を「送る」工程。
 *
 *   1. 内容確認のメール（任意。飛ばして CloudSign へ行ける）
 *   2. 相手の確認（メールの返信・Slack・電話。人が「もらった」と記録する）
 *   3. CloudSign で署名依頼
 *   4. 締結（CloudSign の webhook が合意を executed にしたとき）
 *
 * 段階は保存しない。送信・確認・署名依頼はどれも audit_events に残るので、
 * そこから導く。二重に持つと、片方だけ進んだときに誰も気づけない。
 */

export type SendStepKey = "mail" | "confirmed" | "cloudsign" | "executed";

export interface SendStep {
  key: SendStepKey;
  name: string;
  done: boolean;
  /** 済んだ日時。 */
  at: string | null;
  /** 根拠。誰に送ったか、誰が確認したか。 */
  detail: string;
  /** 任意の段（飛ばしてよい）。 */
  optional?: boolean;
}

export interface SendEvent {
  at: string; action: string; actor: string; detail: Record<string, unknown>;
}

export interface SendTimeline {
  steps: SendStep[];
  /** 次にやる段。全部済んでいれば null。 */
  current: SendStep | null;
  events: SendEvent[];
}

export class DocumentSendService {
  constructor(private readonly database: Transactable) {}

  async timeline(documentId: number): Promise<SendTimeline> {
    try {
      const head = await this.database.query(
        `SELECT d.id, d.status, d.agreement_id, a.status AS agreement_status, a.updated_at AS agreement_at
           FROM documents d LEFT JOIN agreements a ON a.id = d.agreement_id
          WHERE d.id = $1`, [documentId]);
      const doc = head.rows[0] as Record<string, any> | undefined;
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);

      // この文書についての出来事。送信・確認・署名依頼は文書が対象。
      // 締結の反映（cloudsign.applied）は webhook が対象で、detail に文書IDを持つ。
      const r = await this.database.query(
        `SELECT occurred_at, action, actor, detail FROM audit_events
          WHERE (target_type = 'document' AND target_id = $1
                 AND action IN ('gmail.send', 'gmail.blocked', 'document.confirmed', 'cloudsign.send', 'cloudsign.blocked'))
             OR (action = 'cloudsign.applied' AND (detail->>'documentId')::bigint = $1)
          ORDER BY occurred_at, id`, [documentId]);
      const events: SendEvent[] = r.rows.map((e: Record<string, any>) => ({
        at: new Date(String(e.occurred_at)).toISOString(), action: String(e.action),
        actor: String(e.actor), detail: (e.detail as Record<string, unknown>) ?? {}
      }));

      const last = (action: string) => [...events].reverse().find((e) => e.action === action) ?? null;
      const mail = last("gmail.send");
      const confirmed = last("document.confirmed");
      const sign = last("cloudsign.send");
      const applied = [...events].reverse().find((e) => e.action === "cloudsign.applied" && e.detail.applied === true) ?? null;
      const executed = String(doc.agreement_status ?? "") === "executed";

      const steps: SendStep[] = [
        { key: "mail", name: "内容確認のメール", done: mail !== null, at: mail?.at ?? null, optional: true,
          detail: mail
            ? `${String(mail.detail.recipient ?? "")} へ送付（${mail.actor}）`
            : "任意。飛ばして CloudSign へ行ける" },
        { key: "confirmed", name: "相手の確認", done: confirmed !== null, at: confirmed?.at ?? null, optional: true,
          detail: confirmed
            ? `${String(confirmed.detail.via ?? "")}で確認をもらった${confirmed.detail.note ? `：${String(confirmed.detail.note)}` : ""}`
            : "返信・Slack・電話で確認をもらったら記録する" },
        { key: "cloudsign", name: "CloudSign で署名依頼", done: sign !== null, at: sign?.at ?? null,
          detail: sign
            ? `${String(sign.detail.recipient ?? "")} へ署名依頼（CloudSign #${String(sign.detail.externalId ?? "")}）`
            : "署名者のメールアドレスを入れて送る" },
        { key: "executed", name: "締結", done: executed, at: executed ? (applied?.at ?? (doc.agreement_at ? new Date(String(doc.agreement_at)).toISOString() : null)) : null,
          detail: executed
            ? "合意が締結済み"
            : doc.agreement_id
              ? "CloudSign から結果が届くと、合意が締結済みになる"
              : "この文書は合意に繋がっていないので、締結は記録されない（つながり から合意を付ける）" }
      ];
      // 任意の段は飛ばせる。次にやるのは「必須で済んでいない最初」。
      const current = steps.find((s) => !s.done && !s.optional)
        ?? (steps.every((s) => s.done || s.optional) && !steps[3].done ? steps[3] : null);
      return { steps, current: steps[3].done ? null : current, events };
    } catch (error) { throw translate(error); }
  }

  /** 相手の確認をもらった。返信・Slack・電話のどれでも、人が記録する。 */
  async confirm(
    documentId: number, input: { via: string; note?: string | null }, actor: string
  ): Promise<{ id: number }> {
    const via = String(input.via ?? "").trim();
    if (!via) throw new DomainError("VALIDATION", "どうやって確認をもらったかを選んでください");
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, document_no, status, matter_id FROM documents WHERE id = $1", [documentId]);
        const doc = head.rows[0] as Record<string, any> | undefined;
        if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (doc.status !== "issued") {
          throw new DomainError("CONFLICT", "決定済みの文書だけ確認を記録できます（下書きは先に決定してください）");
        }
        await recordAudit(client, {
          actor, action: "document.confirmed", targetType: "document", targetId: documentId,
          detail: { via, note: str(input.note), documentNo: doc.document_no }
        });
        const matterId = int(doc.matter_id);
        if (matterId) {
          await recordCommunication(client, {
            matterId, channel: "note", direction: "in", actor,
            subject: `${doc.document_no ?? `#${documentId}`} の内容確認`,
            body: `${via}で確認をもらった${input.note ? `：${input.note}` : ""}`,
            documentId
          });
        }
        return { id: documentId };
      });
    } catch (error) { throw translate(error); }
  }
}
