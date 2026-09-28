import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import type { MatterKind } from "../matters/write-service.js";
import type { DispatchService } from "../integrations/dispatch-service.js";
import type { IntakeSubmission } from "../integrations/slack-intake.js";
import { REQUEST_TYPES, requestLabel } from "../integrations/slack-intake.js";
import { openMatter, resolveCounterparty } from "../integrations/intake-service.js";
import { attachUploadsToMatter } from "./upload-service.js";
import { recordCommunication } from "../matters/communication-service.js";
import {
  isPaymentPurpose, normalizeDocNo, paymentDocLabel, resolvePaymentTarget,
  type PaymentPurpose, type PaymentTarget
} from "./payment-request.js";

/**
 * 受付箱の書き込み。docs/v3-request-inbox.md
 *
 * 依頼は届いた時点では案件にしない。受付箱に入れ、法務が受け付けたときに
 * 案件を立てる（または既存の案件へ繋ぐ）。誤起票・重複・情報不足の依頼まで
 * 案件になっていたのを止めるため。
 *
 * 外への送信（Backlog の起案・依頼者への Slack）は dispatch を通す。ゲートで
 * 止まっても受付箱の操作は成り立つ。送れなかった理由は返す。
 */

export type IntakeState = "new" | "on_hold" | "accepted" | "duplicate" | "dismissed";

export interface SubmitResult {
  requestId: number;
  requestNo: string | null;
  issueKey: string | null;
  /** Backlog に起案できなかった理由（ゲートで止まった等）。 */
  backlogReason?: string;
  message: string;
}

export interface AcceptInput {
  /**
   * new=新規案件で受付 / existing=既存の案件へ接続 /
   * direct=案件にせず処理（検収書・利用許諾計算書の依頼だけ。A-058）
   */
  mode: "new" | "existing" | "direct";
  /** direct：依頼の種類（Slack で選ばれていなければ画面で選ぶ）と対象の番号。 */
  purpose?: PaymentPurpose | null;
  targetDocNo?: string | null;
  /** direct：対象の条件。空なら対象の番号から引き当てたもの。 */
  conditionIds?: number[] | null;
  matterId?: number | null;
  kind: MatterKind;
  title?: string | null;
  counterpartyId?: number | null;
  ownerStaffId?: number | null;
  dueOn?: string | null;
}

export interface AcceptResult {
  requestId: number;
  /** 案件にせず処理したときは null。 */
  matterId: number | null;
  matterNo: string | null;
  createdMatter: boolean;
  handling: "matter" | "direct";
  notified: boolean;
}

/** 依頼の原票から、選ばれた依頼の内容と対象の番号を読む。 */
export function paymentOf(row: Record<string, any>): { purpose: PaymentPurpose | null; targetDocNo: string | null } {
  const p = (row.source_payload ?? {}) as Record<string, any>;
  return {
    purpose: isPaymentPurpose(p.purpose) ? p.purpose : null,
    targetDocNo: p.targetDocNo ? String(p.targetDocNo) : null
  };
}

/**
 * 発注書が案件に入っている検収書は、その案件で作る（案件の工程・スレッドに揃える）。
 * 別の受け方をしようとしたら止める。
 */
export function assertInspectionMatter(
  purpose: PaymentPurpose | null, target: PaymentTarget | null,
  input: { mode: AcceptInput["mode"]; matterId?: number | null }
): void {
  if (purpose !== "inspection" || !target?.matter || !target.documentId) return;
  if (input.mode === "existing" && Number(input.matterId) === target.matter.id) return;
  const m = target.matter;
  throw new DomainError("CONFLICT",
    `発注書 ${target.documentNo ?? target.docNo} は案件 ${m.matterNo ?? `#${m.id}`}（${m.title}）に入っています。`
    + "検収書はその案件で作るので、この案件へ接続して受け付けてください");
}

/** Slack 受付で Backlog に立てる課題の件名。依頼番号を頭に置く（取得のときに突き合わせる）。 */
export function requestIssueSummary(requestNo: string | null, title: string): string {
  return `${requestNo ? `[${requestNo}] ` : ""}${title}`.slice(0, 255);
}

/** Backlog に立てる課題の本文。Backlog だけを見ている人が中身を掴めるだけを書く。 */
export function requestIssueDescription(input: {
  requestNo: string | null; submission: IntakeSubmission;
}): string {
  const s = input.submission;
  const lines = [
    `依頼番号：${input.requestNo ?? "（未採番）"}`,
    `依頼の内容：${requestLabel(s)}`,
    ...(s.targetDocNo ? [`対象の番号：${s.targetDocNo}`] : []),
    `相手先：${s.counterpartyName ?? "（未記載）"}`,
    `希望の期日：${s.dueOn ?? "（未記載）"}`,
    `依頼者：${s.requesterSlackId ? `<@${s.requesterSlackId}>` : ""}${s.requesterName ? ` ${s.requesterName}` : ""}`
  ];
  if (s.detail) lines.push("", s.detail);
  lines.push("", "※ LegalBridge の受付箱に入りました。進捗は Slack でお知らせします。",
             "※ この課題のステータスは更新されません。");
  return lines.join("\n");
}

/** Slack 受付の直後に依頼者へ返す文面。 */
export function submitAcknowledgement(input: {
  requestNo: string | null; issueKey: string | null; submission: IntakeSubmission; uploadUrl?: string | null;
}): string {
  const s = input.submission;
  const lines = [
    `依頼を送信しました：*${input.requestNo ?? "（番号未採番）"}*${input.issueKey ? `（${input.issueKey}）` : ""}`,
    `依頼の内容：${requestLabel(s)}`,
    `件名：${s.title}`,
    ...(s.targetDocNo ? [`対象の番号：${s.targetDocNo}`] : []),
    "法務が内容を確認して受け付けます。受け付けたら Slack でお知らせします。",
    ...(input.uploadUrl
      ? [`📎 レビューしてほしい文書・参考資料は <${input.uploadUrl}|資料アップロードページ> から上げてください（30 日有効）。`]
      : [])
  ];
  return lines.join("\n");
}

export class IntakeRequestService {
  constructor(
    private readonly database: Transactable,
    private readonly dispatch: DispatchService | null,
    private readonly options: {
      backlogIssueTypeId: string;
      /** 依頼者に渡す資料アップロードのリンク。作れなければ null（案内を出さない）。 */
      uploadLink?: (requestId: number) => string | null;
    }
  ) {}

  /**
   * Slack の送信。受付箱に入れて、Backlog にも課題を立てる（V1 と同じ体験）。
   * 課題が立たなくても受付箱には入る。止まった理由は返す。
   */
  /** その依頼の資料アップロードのリンク。作れなければ null（完了画面・確認の DM で使う）。 */
  uploadUrlFor(requestId: number): string | null {
    try { return this.options.uploadLink?.(requestId) ?? null; }
    catch { return null; }
  }

  async submitFromSlack(submission: IntakeSubmission): Promise<SubmitResult> {
    const registered = await this.registerFromSlack(submission);
    return this.followUpSlack(registered, submission);
  }

  /**
   * 受付箱への登録だけ。Slack はモーダルの送信に 3 秒以内の応答を求めるので、
   * 経路ではここまで待って応答し、Backlog の起案と依頼者への通知（followUpSlack）は後に回す。
   * 後続が止まっても依頼は受付箱に入っていて、課題キーは取得（件名の [REQ-…]）で繋がる。
   */
  async registerFromSlack(submission: IntakeSubmission): Promise<{ requestId: number; requestNo: string | null }> {
    const actor = submission.requesterName ?? submission.requesterSlackId ?? "slack";
    try {
      return await inTransaction(this.database, async (client) => {
        const no = await allocateNumber(
          client, { prefix: "REQ", table: "intake_requests", column: "request_no" });
        const inserted = await client.query(
          `INSERT INTO intake_requests
             (request_no, source, state, kind, title, detail, counterparty_name, due_on,
              requester_slack_id, requester_name, created_by, source_payload)
           VALUES ($1, 'slack', 'new', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           RETURNING id, request_no`,
          [no, submission.kind, submission.title, submission.detail, submission.counterpartyName,
           submission.dueOn, submission.requesterSlackId || null, submission.requesterName, actor,
           // 依頼者が選んだ内容と支払の対象番号。表の列にはせず原票に残す（受付箱で見せる）。
           JSON.stringify({ purpose: submission.purpose ?? null, targetDocNo: submission.targetDocNo ?? null })]);
        const row = inserted.rows[0] as { id: number; request_no: string | null };
        await recordAudit(client, {
          actor, action: "intake.submit", targetType: "intake_request", targetId: Number(row.id),
          detail: { source: "slack", requestNo: row.request_no, kind: submission.kind,
                    purpose: submission.purpose ?? null }
        });
        return { requestId: Number(row.id), requestNo: row.request_no ?? null };
      });
    } catch (error) { throw translate(error); }
  }

  /** 登録のあと：Backlog に起案し、依頼者に送信の確認を返す。失敗しても例外にしない。 */
  async followUpSlack(
    registered: { requestId: number; requestNo: string | null }, submission: IntakeSubmission
  ): Promise<SubmitResult> {
    const actor = submission.requesterName ?? submission.requesterSlackId ?? "slack";
    const { requestId, requestNo } = registered;
    // Backlog に起案する。受付箱への登録とは別の出来事（外への送信は巻き戻せない）。
    let issueKey: string | null = null;
    let backlogReason: string | undefined;
    if (this.dispatch) {
      try {
        const outcome = await this.dispatch.dispatch({
          channel: "backlog", targetType: "intake_request", targetId: requestId, actor,
          request: {
            recipient: this.options.backlogIssueTypeId,
            subject: requestIssueSummary(requestNo, submission.title),
            body: requestIssueDescription({ requestNo, submission })
          }
        });
        const key = String(outcome.externalId ?? "").trim();
        if ((outcome.sent || outcome.duplicated) && key) {
          issueKey = key;
          // 取得が先に繋いでいれば何もしない（backlog_issue_key IS NULL の行だけ）。
          await this.database.query(
            `UPDATE intake_requests
                SET backlog_issue_key = $2, updated_at = now()
              WHERE id = $1 AND backlog_issue_key IS NULL`, [requestId, key]);
        } else {
          backlogReason = outcome.gate.reasons.join(" / ") || "Backlog に課題を立てられませんでした";
        }
      } catch (error) {
        // 起案に失敗しても受付箱には入っている。法務は受付箱から拾える。
        backlogReason = `Backlog への起案に失敗しました：${(error as Error)?.message ?? error}`;
        console.error("intake backlog dispatch failed", { requestId, message: backlogReason });
      }
    } else {
      backlogReason = "Backlog の送信口がありません";
    }

    const uploadUrl = this.uploadUrlFor(requestId);
    const message = submitAcknowledgement({ requestNo, issueKey, submission, uploadUrl });
    await this.notify(requestId, submission.requesterSlackId || null, message, actor);
    return { requestId, requestNo, issueKey, ...(backlogReason ? { backlogReason } : {}), message };
  }

  /** 口頭・メールで受けた依頼を手で入れる。Backlog には起案しない。 */
  async createManual(input: {
    title: string; kind?: MatterKind | null; detail?: string | null; counterpartyName?: string | null;
    dueOn?: string | null; requesterName?: string | null; requesterSlackId?: string | null;
  }, actor: string): Promise<{ requestId: number; requestNo: string | null }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const no = await allocateNumber(
          client, { prefix: "REQ", table: "intake_requests", column: "request_no" });
        const r = await client.query(
          `INSERT INTO intake_requests
             (request_no, source, state, kind, title, detail, counterparty_name, due_on,
              requester_slack_id, requester_name, created_by)
           VALUES ($1, 'manual', 'new', $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, request_no`,
          [no, input.kind ?? null, input.title, input.detail ?? null, input.counterpartyName ?? null,
           input.dueOn ?? null, input.requesterSlackId ?? null, input.requesterName ?? null, actor]);
        const row = r.rows[0] as { id: number; request_no: string | null };
        await recordAudit(client, {
          actor, action: "intake.create", targetType: "intake_request", targetId: Number(row.id),
          detail: { source: "manual", requestNo: row.request_no }
        });
        return { requestId: Number(row.id), requestNo: row.request_no ?? null };
      });
    } catch (error) { throw translate(error); }
  }

  /** 行を取り、判断できる状態かを確かめる。 */
  private async lockOpen(client: Queryable, id: number): Promise<Record<string, any>> {
    const r = await client.query("SELECT * FROM intake_requests WHERE id = $1 FOR UPDATE", [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
    if (!["new", "on_hold"].includes(String(row.state))) {
      throw new DomainError("CONFLICT",
        `この依頼は処理済みです（${stateLabel(String(row.state))}）。受付箱に戻してから操作してください`);
    }
    return row;
  }

  /**
   * 受け付ける。新しく案件を立てるか、既存の案件へ繋ぐ。
   * Backlog の課題があれば案件にも繋ぐ（受信で案件を辿れるように）。
   */
  async accept(id: number, input: AcceptInput, actor: string): Promise<AcceptResult> {
    if (input.mode === "direct") return this.acceptDirect(id, input, actor);
    if (!REQUEST_TYPES.some((t) => t.value === input.kind)) {
      throw new DomainError("VALIDATION", "依頼の種類を選んでください");
    }
    let result: Omit<AcceptResult, "notified">;
    let requester: string | null = null;
    let message = "";
    try {
      result = await inTransaction(this.database, async (client) => {
        const row = await this.lockOpen(client, id);
        requester = row.requester_slack_id ?? null;
        const title = String(input.title ?? row.title).trim() || String(row.title);
        // 検収書の依頼で、発注書が案件に入っているなら、その案件へ繋ぐほかは受けない。
        const pay = paymentOf(row);
        if (pay.purpose === "inspection") {
          assertInspectionMatter(pay.purpose,
            await resolvePaymentTarget(client, pay.purpose, pay.targetDocNo), input);
        }

        let matterId: number;
        let matterNo: string | null;
        let createdMatter = false;
        let matterTitle = title;
        let owner: string | null = null;
        if (input.mode === "new") {
          // 相手先：画面で選んだもの → 取り込み時の推定（メールの差出人など）→ 名前から。
          let counterpartyId = input.counterpartyId ?? (row.counterparty_id ? Number(row.counterparty_id) : null);
          if (!counterpartyId) {
            counterpartyId = (await resolveCounterparty(client, row.counterparty_name ?? null))?.id ?? null;
          }
          const remarks = [
            row.detail,
            row.counterparty_name && !counterpartyId
              ? `依頼時の相手先の記載：${row.counterparty_name}（未登録）` : null,
            `受付箱から受付（${row.request_no ?? `#${id}`}${row.backlog_issue_key ? `・${row.backlog_issue_key}` : ""}）`
          ].filter(Boolean).join("\n\n");
          const opened = await openMatter(client, {
            title, kind: input.kind, counterpartyId,
            counterpartyWritten: row.counterparty_name ?? null,
            ownerStaffId: input.ownerStaffId ?? null,
            requesterSlackId: row.requester_slack_id ?? null,
            dueOn: input.dueOn ?? dateStr(row.due_on),
            remarks, createdBy: actor
          });
          matterId = opened.id;
          matterNo = opened.matterNo;
          createdMatter = true;
          await recordAudit(client, {
            actor, action: "matter.intake", targetType: "matter", targetId: matterId,
            detail: { source: "intake", requestId: id, requestNo: row.request_no, kind: input.kind,
                      matterNo, counterpartyWritten: row.counterparty_name ?? null }
          });
        } else {
          if (!input.matterId) throw new DomainError("VALIDATION", "繋ぐ案件を選んでください");
          const m = await client.query(
            "SELECT id, matter_no, title, status, merged_into_id FROM matters WHERE id = $1",
            [input.matterId]);
          const matter = m.rows[0] as any;
          if (!matter) throw new DomainError("NOT_FOUND", `案件 ${input.matterId} が見つかりません`);
          if (matter.merged_into_id) {
            throw new DomainError("CONFLICT", "統合済みの案件には繋げません。統合先の案件を選んでください");
          }
          matterId = Number(matter.id);
          matterNo = matter.matter_no ?? null;
          matterTitle = String(matter.title);
        }

        // Backlog の課題を案件に繋ぐ。別の案件に繋がっていれば止める（受信先が決まらなくなる）。
        if (row.backlog_issue_key) {
          const other = await client.query(
            `SELECT l.matter_id, m.matter_no FROM matter_links l JOIN matters m ON m.id = l.matter_id
              WHERE l.target_type = 'backlog_issue' AND l.target_ref = $1 AND l.matter_id <> $2
              LIMIT 1`, [row.backlog_issue_key, matterId]);
          const o = other.rows[0] as any;
          if (o) {
            throw new DomainError("CONFLICT",
              `課題 ${row.backlog_issue_key} は案件 ${o.matter_no ?? o.matter_id} に繋がっています`);
          }
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'backlog_issue', $2, 'origin', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [matterId, row.backlog_issue_key, JSON.stringify({ requestNo: row.request_no, acceptedBy: actor })]);
        }

        // メールの依頼。スレッドを案件に繋ぎ（以後の返信は案件のやり取りに入る）、
        // 受付箱にあいだ溜まっていた原文をやり取りの記録に書き戻す。
        if (row.email_thread_id) {
          const other = await client.query(
            `SELECT l.matter_id, m.matter_no FROM matter_links l JOIN matters m ON m.id = l.matter_id
              WHERE l.target_type = 'email_thread' AND l.target_ref = $1 AND l.matter_id <> $2
              LIMIT 1`, [row.email_thread_id, matterId]);
          const o = other.rows[0] as any;
          if (o) {
            throw new DomainError("CONFLICT",
              `このメールのスレッドは案件 ${o.matter_no ?? o.matter_id} に繋がっています`);
          }
          const payload = (row.source_payload ?? {}) as Record<string, any>;
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'email_thread', $2, 'origin', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [matterId, row.email_thread_id, JSON.stringify({
              firstSubject: payload.subject ?? null, firstFrom: payload.from ?? null,
              receivedAt: payload.receivedAt ?? null, requestNo: row.request_no
            })]);
          const mails = [payload, ...((payload.followUps ?? []) as Array<Record<string, any>>)]
            .filter((m) => m && m.messageId);
          for (const m of mails) {
            await recordCommunication(client, {
              matterId, channel: "email", direction: "in",
              occurredAt: m.receivedAt ?? null,
              actor: String(m.from ?? "mail"),
              counterpart: Array.isArray(m.to) ? m.to.join(", ") : null,
              subject: m.subject ?? null, body: m.body ?? null,
              externalRef: String(m.messageId),
              evidence: { threadId: m.threadId ?? null, rfcMessageId: m.rfcMessageId ?? null,
                          from: m.from ?? null, to: m.to ?? [], attachments: m.attachments ?? [],
                          viaIntake: row.request_no }
            });
          }
        }

        // 依頼者がリンクから上げた資料も案件に繋ぐ（案件のやり取りに Drive のファイルとして出る）。
        await attachUploadsToMatter(client, id, matterId);

        await client.query(
          `UPDATE intake_requests
              SET state = 'accepted', handling = 'matter', matter_id = $2, kind = $3, title = $4,
                  due_on = COALESCE($5::date, due_on), has_unseen_update = false,
                  reason = NULL, hold_until = NULL,
                  handled_at = now(), handled_by = $6, updated_at = now()
            WHERE id = $1`,
          [id, matterId, input.kind, title, input.dueOn ?? null, actor]);
        await recordAudit(client, {
          actor, action: "intake.accept", targetType: "intake_request", targetId: id,
          detail: { matterId, matterNo, createdMatter, requestNo: row.request_no }
        });

        const ownerRow = await client.query(
          `SELECT s.name FROM matters m LEFT JOIN staff s ON s.id = m.owner_staff_id WHERE m.id = $1`,
          [matterId]);
        owner = (ownerRow.rows[0] as any)?.name ?? null;
        message = [
          `依頼を受け付けました：*${row.request_no ?? `#${id}`}*`,
          createdMatter
            ? `案件：${matterNo ?? `#${matterId}`} ${matterTitle}`
            : `${matterNo ?? `#${matterId}`} ${matterTitle} の案件で対応します`,
          `担当：${owner ?? "（これから決めます）"}`
        ].join("\n");
        return { requestId: id, matterId, matterNo, createdMatter, handling: "matter" as const };
      });
    } catch (error) { throw translate(error); }

    const notified = await this.notify(id, requester, message, actor);
    return { ...result, notified };
  }

  /**
   * 案件にせず処理する（A-058）。検収書・利用許諾計算書の依頼だけ。
   *
   * 依頼そのものを小さなチケットにする。担当・期日は依頼に持ち、対象の番号から
   * 引き当てた条件を依頼に繋ぐ（作った文書・支払はそこから辿る）。
   */
  private async acceptDirect(id: number, input: AcceptInput, actor: string): Promise<AcceptResult> {
    let requester: string | null = null;
    let message = "";
    let result: Omit<AcceptResult, "notified">;
    try {
      result = await inTransaction(this.database, async (client) => {
        const row = await this.lockOpen(client, id);
        requester = row.requester_slack_id ?? null;
        const pay = paymentOf(row);
        const purpose = pay.purpose ?? (isPaymentPurpose(input.purpose) ? input.purpose : null);
        if (!purpose) {
          throw new DomainError("VALIDATION",
            "案件にせず処理できるのは、検収書・利用許諾計算書の依頼だけです（依頼の内容を選んでください）");
        }
        const targetDocNo = normalizeDocNo(input.targetDocNo) ?? normalizeDocNo(pay.targetDocNo);
        const target = await resolvePaymentTarget(client, purpose, targetDocNo);
        assertInspectionMatter(purpose, target, input);

        // 対象の条件。画面で選び直していればそれ、無ければ引き当てたもの。
        const conditionIds = [...new Set((input.conditionIds?.length
          ? input.conditionIds : target?.conditions.map((c) => c.id) ?? []).map(Number))]
          .filter((n) => Number.isFinite(n) && n > 0);
        if (!conditionIds.length) {
          throw new DomainError("VALIDATION", targetDocNo
            ? `${purpose === "inspection" ? "発注書" : "契約書"}番号 ${targetDocNo} から条件を引き当てられません。`
              + "番号を直すか、対象の条件を選んでください"
            : `${purpose === "inspection" ? "発注書" : "契約書"}番号を入れてください（どの契約の支払かが分からないと作れません）`);
        }
        const found = await client.query(
          "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [conditionIds]);
        if (found.rows.length !== conditionIds.length) {
          throw new DomainError("NOT_FOUND", "選んだ条件の一部が見つかりません");
        }

        const title = String(input.title ?? row.title).trim() || String(row.title);
        const kind = purpose === "inspection" ? "outsourcing" : "work";
        const payload = { ...(row.source_payload ?? {}), purpose, targetDocNo };
        await client.query(
          `UPDATE intake_requests
              SET state = 'accepted', handling = 'direct', matter_id = NULL, kind = $2, title = $3,
                  due_on = COALESCE($4::date, due_on), assignee_staff_id = $5,
                  counterparty_id = COALESCE(counterparty_id, $6),
                  source_payload = $7::jsonb, has_unseen_update = false,
                  reason = NULL, hold_until = NULL, done_at = NULL, done_by = NULL,
                  handled_at = now(), handled_by = $8, updated_at = now()
            WHERE id = $1`,
          [id, kind, title, input.dueOn ?? null, input.ownerStaffId ?? null,
           target?.counterpartyId ?? null, JSON.stringify(payload), actor]);
        await client.query(
          "DELETE FROM intake_request_links WHERE request_id = $1 AND target_type = 'condition'", [id]);
        for (const conditionId of conditionIds) {
          await client.query(
            `INSERT INTO intake_request_links (request_id, target_type, target_id, created_by)
             VALUES ($1, 'condition', $2, $3) ON CONFLICT DO NOTHING`, [id, conditionId, actor]);
        }
        await recordAudit(client, {
          actor, action: "intake.accept", targetType: "intake_request", targetId: id,
          detail: { handling: "direct", purpose, targetDocNo, conditionIds, requestNo: row.request_no }
        });

        const owner = input.ownerStaffId
          ? ((await client.query("SELECT name FROM staff WHERE id = $1", [input.ownerStaffId])).rows[0] as any)?.name ?? null
          : null;
        const label = paymentDocLabel(purpose);
        message = [
          `依頼を受け付けました：*${row.request_no ?? `#${id}`}*`,
          `${label}を作ります${targetDocNo ? `（対象：${targetDocNo}）` : ""}。`,
          `担当：${owner ?? "（これから決めます）"}`,
          "進み具合（作成・送付・支払予定・支払）はこのスレッドでお知らせします。"
        ].join("\n");
        return { requestId: id, matterId: null, matterNo: null, createdMatter: false, handling: "direct" as const };
      });
    } catch (error) { throw translate(error); }
    const notified = await this.notify(id, requester, message, actor);
    return { ...result, notified };
  }

  /** 案件にせず処理している依頼の担当・期日を変える。 */
  async assign(id: number, input: { staffId?: number | null; dueOn?: string | null }, actor: string)
    : Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockDirect(client, id);
        await client.query(
          `UPDATE intake_requests
              SET assignee_staff_id = $2, due_on = $3::date, updated_at = now()
            WHERE id = $1`, [id, input.staffId ?? null, input.dueOn ?? null]);
        await recordAudit(client, {
          actor, action: "intake.assign", targetType: "intake_request", targetId: id,
          detail: { staffId: input.staffId ?? null, dueOn: input.dueOn ?? null }
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 文書を手で繋ぐ・外す。自動の引き当て（依頼より後に作った、依頼の条件の文書）に
   * 当たらないとき（依頼の前に作っていた、別の条件で作った）に使う。
   */
  async linkDocument(id: number, documentRef: { documentId?: number | null; documentNo?: string | null },
                     actor: string): Promise<{ requestId: number; documentId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockDirect(client, id);
        const no = normalizeDocNo(documentRef.documentNo);
        const d = await client.query(
          `SELECT id, document_no, status FROM documents
            WHERE ${documentRef.documentId ? "id = $1" : "upper(document_no) = $1"}`,
          [documentRef.documentId ?? no]);
        const doc = d.rows[0] as any;
        if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentRef.documentId ?? no ?? ""} が見つかりません`);
        if (doc.status === "void") throw new DomainError("CONFLICT", "無効にした文書は繋げません");
        await client.query(
          `INSERT INTO intake_request_links (request_id, target_type, target_id, created_by)
           VALUES ($1, 'document', $2, $3) ON CONFLICT DO NOTHING`, [id, doc.id, actor]);
        await recordAudit(client, {
          actor, action: "intake.link", targetType: "intake_request", targetId: id,
          detail: { documentId: Number(doc.id), documentNo: doc.document_no ?? null }
        });
        return { requestId: id, documentId: Number(doc.id) };
      });
    } catch (error) { throw translate(error); }
  }

  async unlinkDocument(id: number, documentId: number, actor: string): Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockDirect(client, id);
        await client.query(
          `DELETE FROM intake_request_links
            WHERE request_id = $1 AND target_type = 'document' AND target_id = $2`, [id, documentId]);
        await recordAudit(client, {
          actor, action: "intake.unlink", targetType: "intake_request", targetId: id, detail: { documentId }
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 対応完了にする（支払の記録が V3 に無い、支払まで待たずに閉じる、など）。
   * 依頼者に知らせるのは工程の知らせ（ジョブ）に任せる。二重に送らない。
   */
  async complete(id: number, note: string | null, actor: string): Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const row = await this.lockDirect(client, id);
        if (row.done_at) throw new DomainError("CONFLICT", "この依頼は対応完了にしてあります");
        await client.query(
          `UPDATE intake_requests SET done_at = now(), done_by = $2, updated_at = now() WHERE id = $1`,
          [id, actor]);
        await recordAudit(client, {
          actor, action: "intake.done", targetType: "intake_request", targetId: id,
          detail: { note: note?.trim() || null }
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 対応完了を取り消す（まだ終わっていなかった）。 */
  async uncomplete(id: number, actor: string): Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockDirect(client, id);
        await client.query(
          `UPDATE intake_requests SET done_at = NULL, done_by = NULL, updated_at = now() WHERE id = $1`, [id]);
        await recordAudit(client, {
          actor, action: "intake.undone", targetType: "intake_request", targetId: id
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 案件にせず処理している依頼を取る。 */
  private async lockDirect(client: Queryable, id: number): Promise<Record<string, any>> {
    const r = await client.query("SELECT * FROM intake_requests WHERE id = $1 FOR UPDATE", [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
    if (row.state !== "accepted" || row.handling !== "direct") {
      throw new DomainError("CONFLICT", "案件にせず処理している依頼ではありません");
    }
    return row;
  }

  /** 工程の知らせ（ジョブ）から送る。依頼のスレッドに返す。 */
  async notifyProgress(id: number, slackId: string, text: string): Promise<boolean> {
    return this.notify(id, slackId, text, "system:intake-progress");
  }

  /** 重複として閉じる。重複元が案件に繋がっていれば、その案件の「受付」に参考として出す。 */
  async duplicate(id: number, ofId: number, actor: string): Promise<{ requestId: number; notified: boolean }> {
    if (id === ofId) throw new DomainError("VALIDATION", "同じ依頼は重複元にできません");
    let requester: string | null = null;
    let message = "";
    try {
      await inTransaction(this.database, async (client) => {
        const row = await this.lockOpen(client, id);
        requester = row.requester_slack_id ?? null;
        const of = await client.query(
          `SELECT r.id, r.request_no, r.matter_id, m.matter_no
             FROM intake_requests r LEFT JOIN matters m ON m.id = r.matter_id WHERE r.id = $1`, [ofId]);
        const original = of.rows[0] as any;
        if (!original) throw new DomainError("NOT_FOUND", `重複元の依頼 ${ofId} が見つかりません`);
        await client.query(
          `UPDATE intake_requests
              SET state = 'duplicate', duplicate_of_id = $2, matter_id = $3,
                  handled_at = now(), handled_by = $4, updated_at = now()
            WHERE id = $1`, [id, ofId, original.matter_id ?? null, actor]);
        await recordAudit(client, {
          actor, action: "intake.duplicate", targetType: "intake_request", targetId: id,
          detail: { duplicateOf: ofId, duplicateOfNo: original.request_no, matterId: original.matter_id ?? null }
        });
        message = `この依頼（${row.request_no ?? `#${id}`}）は ${original.request_no ?? `#${ofId}`} と同じ依頼として扱います。`
          + (original.matter_no ? `\n案件：${original.matter_no}` : "");
      });
    } catch (error) { throw translate(error); }
    return { requestId: id, notified: await this.notify(id, requester, message, actor) };
  }

  /** 保留。確認したいことを依頼者に送る。 */
  async hold(id: number, reason: string, until: string | null, actor: string)
    : Promise<{ requestId: number; notified: boolean }> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "保留の理由（確認したいこと）を書いてください");
    let requester: string | null = null;
    let message = "";
    try {
      await inTransaction(this.database, async (client) => {
        const row = await this.lockOpen(client, id);
        requester = row.requester_slack_id ?? null;
        await client.query(
          `UPDATE intake_requests
              SET state = 'on_hold', reason = $2, hold_until = $3::date,
                  handled_at = now(), handled_by = $4, updated_at = now()
            WHERE id = $1`, [id, why, until, actor]);
        await recordAudit(client, {
          actor, action: "intake.hold", targetType: "intake_request", targetId: id,
          detail: { reason: why, until }
        });
        message = `確認させてください（${row.request_no ?? `#${id}`}）\n${why}\nこのメッセージに返信してください。`
          + (until ? `${until} に再確認します。` : "");
      });
    } catch (error) { throw translate(error); }
    return { requestId: id, notified: await this.notify(id, requester, message, actor) };
  }

  /** 対象外。理由は必須。 */
  async dismiss(id: number, reason: string, actor: string): Promise<{ requestId: number; notified: boolean }> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "対象外にする理由を選んでください");
    let requester: string | null = null;
    let message = "";
    try {
      await inTransaction(this.database, async (client) => {
        const row = await this.lockOpen(client, id);
        requester = row.requester_slack_id ?? null;
        await client.query(
          `UPDATE intake_requests
              SET state = 'dismissed', reason = $2, handled_at = now(), handled_by = $3, updated_at = now()
            WHERE id = $1`, [id, why, actor]);
        await recordAudit(client, {
          actor, action: "intake.dismiss", targetType: "intake_request", targetId: id, detail: { reason: why }
        });
        message = `この依頼（${row.request_no ?? `#${id}`}）は法務の対応対象外としました。理由：${why}\n`
          + "ご不明点は法務までご連絡ください。";
      });
    } catch (error) { throw translate(error); }
    // テスト投稿・誤起票では依頼者に知らせない（送っても混乱させるだけ）。
    const quiet = /テスト|誤起票/.test(why);
    return { requestId: id, notified: quiet ? false : await this.notify(id, requester, message, actor) };
  }

  /**
   * 受付箱に戻す（誤操作の取消）。重複・対象外・保留だけ。
   * 受付済みは戻さない。案件が既に動いているので、案件側で扱う。
   */
  async reopen(id: number, actor: string): Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query("SELECT state FROM intake_requests WHERE id = $1 FOR UPDATE", [id]);
        const row = r.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
        if (!["duplicate", "dismissed", "on_hold"].includes(String(row.state))) {
          throw new DomainError("CONFLICT",
            `${stateLabel(String(row.state))}の依頼は受付箱に戻せません`);
        }
        await client.query(
          `UPDATE intake_requests
              SET state = 'new', duplicate_of_id = NULL, matter_id = NULL, reason = NULL, hold_until = NULL,
                  handled_at = NULL, handled_by = NULL, updated_at = now()
            WHERE id = $1`, [id]);
        await recordAudit(client, {
          actor, action: "intake.reopen", targetType: "intake_request", targetId: id,
          detail: { from: row.state }
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 「更新あり」を既読にする。 */
  async markSeen(id: number, actor: string): Promise<{ requestId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE intake_requests SET has_unseen_update = false, updated_at = now()
            WHERE id = $1 RETURNING id`, [id]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
        await recordAudit(client, {
          actor, action: "intake.seen", targetType: "intake_request", targetId: id
        });
        return { requestId: id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 依頼者へ Slack の DM。ゲートで止まれば送らない（理由は audit_events に残る）。
   * 送れなくても受付箱の操作は成り立っているので、失敗で落とさない。
   */
  private async notify(requestId: number, slackId: string | null, text: string, actor: string): Promise<boolean> {
    if (!this.dispatch || !slackId || !text) return false;
    try {
      // 依頼ごとに DM を1本のスレッドにまとめる。最初の DM（送信の確認）が親。
      const t = await this.database.query(
        "SELECT slack_thread_ts FROM intake_requests WHERE id = $1", [requestId]);
      const threadRef = ((t.rows[0] as any)?.slack_thread_ts as string | null | undefined) ?? null;
      const send = (thread: string | null) => this.dispatch!.dispatch({
        channel: "slack", targetType: "intake_request", targetId: requestId, actor,
        request: { recipient: slackId, body: text, ...(thread ? { threadRef: thread } : {}) }
      });
      let outcome;
      try {
        outcome = await send(threadRef);
      } catch (error) {
        // スレッドに返せなかったとき（親が消えた等）は、スレッドなしで送り直す。
        if (!threadRef) throw error;
        outcome = await send(null);
      }
      if (outcome.sent && !threadRef && outcome.threadRef) {
        await this.database.query(
          `UPDATE intake_requests SET slack_thread_ts = $2
            WHERE id = $1 AND slack_thread_ts IS NULL`, [requestId, outcome.threadRef]);
      }
      return outcome.sent;
    } catch (error) {
      console.error("intake slack notify failed", { requestId, message: (error as Error)?.message });
      return false;
    }
  }
}

export function stateLabel(state: string): string {
  return ({ new: "未処理", on_hold: "保留", accepted: "受付済", duplicate: "重複", dismissed: "対象外" } as
    Record<string, string>)[state] ?? state;
}
