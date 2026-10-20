import { inTransaction, int, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { TERMS_TEMPLATE_KEYS } from "../agreements/auto.js";
import { recordAudit } from "../core/audit.js";
import { recordCommunication } from "../matters/communication-service.js";

/**
 * 決定した文書を「送る」工程（本線の 5 駅のうち ②〜⑤）。
 *
 *   ② 作る    … 決定（番号が付いた）
 *   ③ 確かめる … 担当者確認（社内確認メール）／相手方確認（内容確認メール → 返事）。どちらも飛ばせる
 *   ④ 送る    … メールで送付 ／ CloudSign で署名依頼 ／ システム外で送ったと記録
 *   ⑤ 記録する … 締結（CloudSign の webhook か手の記録）。契約書だけ。飛ばせる（紙で結んだ など）
 *
 * 段階は保存しない。送信・確認・署名依頼・飛ばした記録はどれも audit_events に残るので、
 * そこから導く。二重に持つと、片方だけ進んだときに誰も気づけない。
 * 「飛ばした」は document.step_skipped {step, reason}。本当に進んだ記録があればそちらが勝つ。
 */

export type SendStepKey = "decided" | "owner_check" | "party_check" | "send" | "executed";
export const SKIPPABLE_STEPS: SendStepKey[] = ["owner_check", "party_check", "executed"];

export interface SendStep {
  key: SendStepKey;
  /** 本線の駅（2=作る 3=確かめる 4=送る 5=記録する）。 */
  station: 2 | 3 | 4 | 5;
  name: string;
  done: boolean;
  /** 済んだ日時。 */
  at: string | null;
  /** 根拠。誰に送ったか、誰が確認したか。 */
  detail: string;
  /** 飛ばした（記録あり）。 */
  skipped: boolean;
  skipReason: string | null;
  /** 飛ばせる段。 */
  skippable: boolean;
  /** 任意の段（この文書には要らない。締結の無い文書の⑤ など）。 */
  optional?: boolean;
  /** 済んでも飛ばしてもいないのに先へ進んだ（通らなかった）。 */
  passed?: boolean;
  /** 進行中の補足（確認メールを送って返事待ち、CloudSign に下書きあり など）。 */
  pending?: string | null;
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
  /** 締結まで要る文書か（条件書・合意に繋いだ文書）。 */
  needsExecution: boolean;
}

export class DocumentSendService {
  constructor(private readonly database: Transactable) {}

  async timeline(documentId: number): Promise<SendTimeline> {
    try {
      const head = await this.database.query(
        `SELECT d.id, d.status, d.issued_at, d.issued_by, d.agreement_id, a.status AS agreement_status, a.updated_at AS agreement_at,
                t.template_key
           FROM documents d LEFT JOIN agreements a ON a.id = d.agreement_id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.id = $1`, [documentId]);
      const doc = head.rows[0] as Record<string, any> | undefined;
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);

      // この文書についての出来事。送信・確認・署名依頼・飛ばしは文書が対象。
      // 締結の反映（cloudsign.applied）は webhook が対象で、detail に文書IDを持つ。
      const r = await this.database.query(
        `SELECT occurred_at, action, actor, detail FROM audit_events
          WHERE (target_type = 'document' AND target_id = $1
                 AND action IN ('document.issue', 'gmail.send', 'gmail.review', 'gmail.party_check', 'gmail.blocked',
                                'document.confirmed', 'document.sent_manual', 'document.step_skipped',
                                'cloudsign.send', 'cloudsign.draft', 'cloudsign.blocked'))
             OR (action = 'cloudsign.applied' AND (detail->>'documentId')::bigint = $1)
          ORDER BY occurred_at, id`, [documentId]);
      const events: SendEvent[] = r.rows.map((e: Record<string, any>) => ({
        at: new Date(String(e.occurred_at)).toISOString(), action: String(e.action),
        actor: String(e.actor), detail: (e.detail as Record<string, unknown>) ?? {}
      }));

      const last = (action: string) => [...events].reverse().find((e) => e.action === action) ?? null;
      const skipOf = (step: SendStepKey) =>
        [...events].reverse().find((e) => e.action === "document.step_skipped" && e.detail.step === step) ?? null;
      const mail = last("gmail.send");
      // 取引先へ内容確認として送ったもの（契約書の統一のご案内など）。相手には届いている。
      const partyCheck = last("gmail.party_check");
      // 社内確認として担当者に送ったもの（gmail.review）。③ 担当者確認。
      const review = last("gmail.review");
      const confirmed = last("document.confirmed");
      const sign = last("cloudsign.send");
      const drafted = last("cloudsign.draft");
      const sentManual = last("document.sent_manual");
      const applied = [...events].reverse().find((e) => e.action === "cloudsign.applied" && e.detail.applied === true) ?? null;
      const executed = String(doc.agreement_status ?? "") === "executed";
      const issued = doc.status === "issued" || doc.status === "superseded";
      // 締結の段があるのは、合意そのもの（条件書）か、合意に繋いだ文書だけ。発注書・検収書・
      // 計算書は契約の下の個別取引なので、締結の記録は持たない（送るところまでで完了）。
      const isTerms = TERMS_TEMPLATE_KEYS.has(String(doc.template_key ?? ""));
      const needsExecution = isTerms || Boolean(doc.agreement_id);
      // ④ 送る：署名依頼、システム外の送付。締結の無い文書はメールの送付も④。
      const sent = sign ?? sentManual ?? (!needsExecution ? mail : null);
      const who = (e: SendEvent | null) => String(e?.detail.recipient ?? "");
      const skipText = (e: SendEvent | null) => e ? `飛ばした（${e.actor}${e.detail.reason ? `：${String(e.detail.reason)}` : ""}）` : "";

      const skips = { owner_check: skipOf("owner_check"), party_check: skipOf("party_check"), executed: skipOf("executed") };
      const steps: SendStep[] = [
        { key: "decided", station: 2, name: "決定", done: issued, skipped: false, skipReason: null, skippable: false,
          at: issued && doc.issued_at ? new Date(String(doc.issued_at)).toISOString() : null,
          detail: issued ? `決定（${String(doc.issued_by ?? "")}）` : "まだ下書き。決定すると番号が付く" },
        { key: "owner_check", station: 3, name: "担当者確認", done: review !== null, skippable: true,
          skipped: review === null && skips.owner_check !== null, skipReason: str(skips.owner_check?.detail.reason),
          at: review?.at ?? skips.owner_check?.at ?? null,
          detail: review
            ? `${who(review)} へ社内確認メール（${review.actor}）`
            : skips.owner_check ? skipText(skips.owner_check)
            : "事業部の担当者に、相手へ出す前に中身を見てもらう（社内確認メール）" },
        { key: "party_check", station: 3, name: "相手方確認", done: confirmed !== null, skippable: true,
          skipped: confirmed === null && skips.party_check !== null, skipReason: str(skips.party_check?.detail.reason),
          at: confirmed?.at ?? skips.party_check?.at ?? null,
          pending: !confirmed && (partyCheck || (needsExecution && mail))
            ? `${who(partyCheck ?? mail)} へ内容確認メール送付済み（返事待ち）` : null,
          detail: confirmed
            ? `${String(confirmed.detail.via ?? "")}で確認をもらった${confirmed.detail.note ? `：${String(confirmed.detail.note)}` : ""}`
            : skips.party_check ? skipText(skips.party_check)
            : partyCheck || (needsExecution && mail)
              ? `${who(partyCheck ?? mail)} へ内容確認メール送付済み。返事をもらったら記録する`
              : "相手に内容確認のメールを送り、返事をもらったら記録する" },
        { key: "send", station: 4, name: needsExecution ? "送付（署名依頼）" : "送付", done: sent !== null, skippable: false,
          skipped: false, skipReason: null, at: sent?.at ?? null,
          pending: !sent && drafted ? `CloudSign に下書きあり（#${String(drafted.detail.externalId ?? "")}）` : null,
          detail: sign
            ? sign.detail.manual === true
              ? `${who(sign)} へ署名依頼（システム外で送付。${sign.actor} が記録${sign.detail.externalId ? `／CloudSign #${String(sign.detail.externalId)}` : ""}）`
              : `${who(sign)} へ署名依頼（CloudSign #${String(sign.detail.externalId ?? "")}）`
            : sentManual
              ? `システム外で送付（${sentManual.actor} が記録${sentManual.detail.via ? `／${String(sentManual.detail.via)}` : ""}）`
            : sent
              ? `${who(sent)} へメールで送付（${sent.actor}）`
            : drafted
              ? `CloudSign に下書きあり（#${String(drafted.detail.externalId ?? "")}）。CloudSign の画面で中身を見て送り、送ったらここで「送った」と記録する`
            : needsExecution
              ? "署名者を入れると CloudSign に下書きができる。送信は CloudSign の画面から。送ったら手で記録する"
              : "メールで送付するか、CloudSign で署名依頼する" },
        { key: "executed", station: 5, name: "締結", done: executed, skippable: needsExecution,
          skipped: !executed && skips.executed !== null, skipReason: str(skips.executed?.detail.reason),
          at: executed ? (applied?.at ?? (doc.agreement_at ? new Date(String(doc.agreement_at)).toISOString() : null)) : skips.executed?.at ?? null,
          optional: !needsExecution,
          detail: executed
            ? applied?.detail.manual === true ? `合意が締結済み（${applied.actor} が手で記録）` : "合意が締結済み"
            : skips.executed ? skipText(skips.executed)
            : doc.agreement_id
              ? "CloudSign から結果が届くと、合意が締結済みになる"
              : isTerms
                ? "この文書は合意に繋がっていないので、締結は記録されない（つながり から合意を付ける）"
                : "発注書・検収書・計算書は契約そのものではないので、締結の記録は持ちません。送付まで送れば完了です" }
      ];
      // 次にやる段：いちばん先まで済んだ段の、次の「済んでも飛ばしてもいない」段。
      // 途中を飛ばして先へ進んだ段（通らなかった）は、戻って求めない（passed）。
      // 進行中（確認メールを送って返事待ち、CloudSign に下書きあり）の段があれば、そこが「いま」。
      const lastDone = steps.reduce((m, s, i) => (s.done ? i : m), -1);
      const required = (s: SendStep) => s.key !== "executed" || needsExecution;
      const pendingIdx = steps.findIndex((s, i) => i > lastDone && !s.done && Boolean(s.pending));
      const current = pendingIdx >= 0 ? steps[pendingIdx]!
        : steps.find((s, i) => i > lastDone && !s.done && !s.skipped && required(s)) ?? null;
      const frontier = pendingIdx >= 0 ? pendingIdx : lastDone;
      for (const [i, s] of steps.entries()) if (i < frontier && !s.done && !s.skipped && required(s)) s.passed = true;
      return { steps, current, events, hasAgreement: Boolean(doc.agreement_id), needsExecution };
    } catch (error) { throw translate(error); }
  }

  /** 工程を飛ばす（担当者確認・相手方確認・締結）。理由は任意。記録に残り、工程表に「飛ばした」と出る。 */
  async skip(documentId: number, input: { step: SendStepKey; reason?: string | null }, actor: string): Promise<{ id: number }> {
    if (!SKIPPABLE_STEPS.includes(input.step)) throw new DomainError("VALIDATION", "この工程は飛ばせません");
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query("SELECT id, document_no, status FROM documents WHERE id = $1", [documentId]);
        const doc = head.rows[0] as Record<string, any> | undefined;
        if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (doc.status !== "issued") throw new DomainError("CONFLICT", "決定済みの文書だけ工程を飛ばせます");
        await recordAudit(client, {
          actor, action: "document.step_skipped", targetType: "document", targetId: documentId,
          detail: { step: input.step, reason: str(input.reason), documentNo: doc.document_no }
        });
        return { id: documentId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * システム外で扱った CloudSign の状態を手で記録する。
   *
   * 予備系（ローカル）で CloudSign 連携を開けていない（既定）ときは、署名依頼は CloudSign の
   * 画面から直接送る。そのままだと「送る」の段が進まず、締結も記録されない。
   * 送信は cloudsign.send、結果は cloudsign.applied として、webhook と同じ形で
   * 監査に残す（manual: true を付ける）。段の導出は変えない。
   */
  async recordCloudSign(
    documentId: number,
    input: { status: "sent" | "executed" | "terminated" | "unsent" | "drafted"; at?: string | null;
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

        // 未送信に戻す・下書きあり。CloudSign の記録が古い・間違っているときに、
        // 人が現状を上書きする。合意には触らない（送っていないものを締結とは言わない）。
        if (input.status === "unsent" || input.status === "drafted") {
          const label = input.status === "unsent" ? "未送信に戻した" : "CloudSign に下書きあり";
          await recordAudit(client, {
            actor, action: "cloudsign.applied", targetType: "document", targetId: documentId, occurredAt: at,
            detail: { manual: true, applied: false, status: input.status, documentId, documentNo: no, note,
                      externalId, reason: `${label}（手で記録）` }
          });
          if (matterId) {
            await recordCommunication(client, {
              matterId, channel: "cloudsign", direction: "out", actor,
              counterpart: signer ?? "", subject: `${no} の CloudSign の状態`,
              body: `${no} の CloudSign の状態：${label}（手で記録）${note ? `：${note}` : ""}`,
              externalRef: externalId, documentId,
              evidence: { manual: true, status: input.status, at: input.at ?? null }
            });
          }
          return { id: documentId, status: input.status, agreementUpdated: false };
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
