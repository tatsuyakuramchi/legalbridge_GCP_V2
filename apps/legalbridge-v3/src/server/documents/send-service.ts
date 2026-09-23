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
  /** 合意に繋がっているか。締結の手記録はこれが無いとできない。 */
  hasAgreement: boolean;
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
            ? sign.detail.manual === true
              ? `${String(sign.detail.recipient ?? "")} へ署名依頼（システム外で送付。${sign.actor} が記録${sign.detail.externalId ? `／CloudSign #${String(sign.detail.externalId)}` : ""}）`
              : `${String(sign.detail.recipient ?? "")} へ署名依頼（CloudSign #${String(sign.detail.externalId ?? "")}）`
            : "署名者のメールアドレスを入れて送る。システム外で送ったなら手で記録できる" },
        { key: "executed", name: "締結", done: executed, at: executed ? (applied?.at ?? (doc.agreement_at ? new Date(String(doc.agreement_at)).toISOString() : null)) : null,
          detail: executed
            ? applied?.detail.manual === true ? `合意が締結済み（${applied.actor} が手で記録）` : "合意が締結済み"
            : doc.agreement_id
              ? "CloudSign から結果が届くと、合意が締結済みになる"
              : "この文書は合意に繋がっていないので、締結は記録されない（つながり から合意を付ける）" }
      ];
      // 任意の段は飛ばせる。次にやるのは「必須で済んでいない最初」。
      const current = steps.find((s) => !s.done && !s.optional)
        ?? (steps.every((s) => s.done || s.optional) && !steps[3].done ? steps[3] : null);
      return { steps, current: steps[3].done ? null : current, events, hasAgreement: Boolean(doc.agreement_id) };
    } catch (error) { throw translate(error); }
  }

  /**
   * システム外で扱った CloudSign の状態を手で記録する。
   *
   * 予備系（ローカル）では CloudSign 連携が動かないので、署名依頼は CloudSign の
   * 画面から直接送る。そのままだと「送る」の段が進まず、締結も記録されない。
   * 送信は cloudsign.send、結果は cloudsign.applied として、webhook と同じ形で
   * 監査に残す（manual: true を付ける）。段の導出は変えない。
   */
  async recordCloudSign(
    documentId: number,
    input: { status: "sent" | "executed" | "terminated" | "unsent"; at?: string | null;
             externalId?: string | null; signer?: string | null; note?: string | null },
    actor: string
  ): Promise<{ id: number; status: string; agreementUpdated: boolean }> {
    // 日付だけを受ける。正午（JST）にしておくと、UTC に直しても日付が前日にずれない。
    const at = str(input.at) ? `${String(input.at).slice(0, 10)}T12:00:00+09:00` : null;
    const note = str(input.note);
    const externalId = str(input.externalId);
    const signer = str(input.signer);
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT d.id, d.document_no, d.status, d.matter_id, d.agreement_id, a.status AS agreement_status
             FROM documents d LEFT JOIN agreements a ON a.id = d.agreement_id
            WHERE d.id = $1 FOR UPDATE OF d`, [documentId]);
        const doc = head.rows[0] as Record<string, any> | undefined;
        if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (doc.status !== "issued") {
          throw new DomainError("CONFLICT", "決定済みの文書だけ CloudSign の状態を記録できます（下書きは先に決定してください）");
        }
        const no = str(doc.document_no) ?? `#${documentId}`;
        const matterId = int(doc.matter_id);
        const agreementId = int(doc.agreement_id);

        if (input.status === "sent") {
          await recordAudit(client, {
            actor, action: "cloudsign.send", targetType: "document", targetId: documentId, occurredAt: at,
            detail: { manual: true, recipient: signer ?? "", externalId, note, documentNo: no }
          });
          if (matterId) {
            await recordCommunication(client, {
              matterId, channel: "cloudsign", direction: "out", actor,
              counterpart: signer ?? "", subject: `${no} の署名依頼`,
              body: `${no} の署名依頼を CloudSign で送った（システム外で送付。手で記録）${note ? `：${note}` : ""}`,
              externalRef: externalId, documentId,
              evidence: { manual: true, cloudSignDocumentId: externalId, signer, at: input.at ?? null }
            });
          }
          return { id: documentId, status: "sent", agreementUpdated: false };
        }

        // 未送信に戻す。CloudSign の記録が古い・間違っているときに、人が現状を
        // 上書きする。合意には触らない（送っていないものを締結とは言わない）。
        if (input.status === "unsent") {
          await recordAudit(client, {
            actor, action: "cloudsign.applied", targetType: "document", targetId: documentId, occurredAt: at,
            detail: { manual: true, applied: false, status: "unsent", documentId, documentNo: no, note,
                      reason: "未送信に戻した（手で記録）" }
          });
          if (matterId) {
            await recordCommunication(client, {
              matterId, channel: "cloudsign", direction: "out", actor,
              counterpart: signer ?? "", subject: `${no} の CloudSign の状態`,
              body: `${no} の CloudSign の状態を未送信に戻した（手で記録）${note ? `：${note}` : ""}`,
              externalRef: externalId, documentId,
              evidence: { manual: true, status: "unsent", at: input.at ?? null }
            });
          }
          return { id: documentId, status: "unsent", agreementUpdated: false };
        }

        // 締結・辞退。合意に繋がっていれば合意の状態を動かす（文書は出力物）。
        // 発注書や検収書のように合意を持たない文書は、文書の状態としてだけ残す。
        // 束の画面はこの記録を読むので、合意が無くても「締結済」と出る。
        let agreementUpdated = false;
        if (agreementId) {
          const updated = await client.query(
            `UPDATE agreements
                SET status = $2,
                    executed_on = CASE WHEN $2 = 'executed' THEN COALESCE(executed_on, $3::date) ELSE executed_on END,
                    updated_at = now()
              WHERE id = $1 AND status <> $2 RETURNING id`,
            [agreementId, input.status, input.at ? String(input.at).slice(0, 10) : null]);
          agreementUpdated = (updated.rowCount ?? 0) > 0;
        }
        await recordAudit(client, {
          actor, action: "cloudsign.applied", targetType: "document", targetId: documentId, occurredAt: at,
          detail: { manual: true, applied: agreementUpdated || input.status === "executed", status: input.status,
                    documentId, documentNo: no, agreementId, externalId, note,
                    ...(agreementId ? {} : { reason: "合意に繋がっていないので、文書の状態としてだけ記録" }) }
        });
        if (matterId) {
          const label = input.status === "executed" ? "締結した" : "辞退・取下げになった";
          await recordCommunication(client, {
            matterId, channel: "cloudsign", direction: "in", actor,
            counterpart: signer ?? "", subject: `${no} の CloudSign の結果`,
            body: `${no} が CloudSign で${label}（手で記録）${note ? `：${note}` : ""}`,
            externalRef: externalId, documentId,
            evidence: { manual: true, status: input.status, agreementId, agreementUpdated, at: input.at ?? null }
          });
        }
        return { id: documentId, status: input.status, agreementUpdated };
      });
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
