import { createHash } from "node:crypto";
import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { evaluateGate, type GateResult, type GateSettings, type IntegrationChannel } from "./gate.js";
import type { DispatchAdapter, DispatchRequest } from "./adapters.js";

export interface DispatchOutcome {
  channel: IntegrationChannel;
  /** 送ったか。ゲートで止まった場合は false。 */
  sent: boolean;
  gate: GateResult;
  externalId?: string;
  threadRef?: string | null;
  /** 検証モードで返す「何が送られるか」。 */
  preview?: { recipient: string; subject: string | null; bodyPreview: string; attachment: string | null };
  /** 冪等キーで重複と判定した場合。 */
  duplicated?: boolean;
}

/**
 * 外部送信の唯一の入口。
 *
 * V2 は Slack / Gmail / CloudSign が別々に「ゲート → 送信 → 台帳へ記録」を
 * 実装していて、冪等キーの持ち方も台帳も別だった。V3 はここ1本に集約し、
 * 記録は audit_events の idempotency_key で一意にする。
 *
 * 送信そのものはトランザクションに入れられない（外部への副作用は巻き戻せない）。
 * そこで「冪等キーで重複を弾く → 送信 → 記録」の順にし、記録に失敗しても
 * 外部IDがログに残るようにしている。
 */
export class DispatchService {
  constructor(
    private readonly database: Transactable,
    private readonly adapters: Partial<Record<IntegrationChannel, DispatchAdapter>>,
    private readonly settings: (channel: IntegrationChannel) => GateSettings
  ) {}

  /** 同じ意味の送信を二度しないためのキー。チャネル・対象・宛先・内容から作る。 */
  static idempotencyKey(parts: {
    channel: string; targetType: string; targetId: number | string; recipient: string; body: string;
  }): string {
    return createHash("sha256")
      .update([parts.channel, parts.targetType, String(parts.targetId), parts.recipient, parts.body].join(" "))
      .digest("hex");
  }

  async dispatch(input: {
    channel: IntegrationChannel;
    targetType: string;
    targetId: number;
    request: DispatchRequest;
    actor: string;
  }): Promise<DispatchOutcome> {
    const adapter = this.adapters[input.channel];
    const settings = this.settings(input.channel);
    const gate = evaluateGate(
      {
        channel: input.channel,
        recipient: input.request.recipient,
        hasContent: Boolean(input.request.body || input.request.attachment)
      },
      { ...settings, adapterConfigured: settings.adapterConfigured && Boolean(adapter?.configured) }
    );

    const preview = {
      recipient: input.request.recipient,
      subject: input.request.subject ?? null,
      bodyPreview: input.request.body.slice(0, 500),
      attachment: input.request.attachment?.filename ?? null
    };

    if (!gate.allowed) {
      // 止めた事実も残す。あとから「なぜ送られていないのか」を追えるようにする。
      await this.record(input, {
        action: `${input.channel}.blocked`,
        detail: { blockers: gate.blockers, reasons: gate.reasons, recipient: input.request.recipient }
      });
      return { channel: input.channel, sent: false, gate, ...(gate.previewable ? { preview } : {}) };
    }

    const key = DispatchService.idempotencyKey({
      channel: input.channel, targetType: input.targetType, targetId: input.targetId,
      recipient: input.request.recipient, body: input.request.body
    });
    const existing = await this.database.query(
      "SELECT detail FROM audit_events WHERE idempotency_key = $1", [key]);
    if (existing.rows[0]) {
      const detail = (existing.rows[0] as { detail?: Record<string, unknown> }).detail ?? {};
      return {
        channel: input.channel, sent: false, gate, duplicated: true,
        externalId: detail.externalId ? String(detail.externalId) : undefined
      };
    }

    const receipt = await adapter!.send(input.request);

    try {
      await this.record(input, {
        action: `${input.channel}.send`,
        idempotencyKey: key,
        detail: {
          recipient: input.request.recipient, subject: input.request.subject ?? null,
          externalId: receipt.externalId, threadRef: receipt.threadRef ?? null,
          attachment: input.request.attachment?.filename ?? null
        }
      });
    } catch (error) {
      // 送信は済んでいるので失敗にはしない。記録できなかったことをログに残す。
      console.error("dispatch record failed", {
        channel: input.channel, externalId: receipt.externalId,
        message: (error as Error)?.message
      });
    }

    return {
      channel: input.channel, sent: true, gate,
      externalId: receipt.externalId, threadRef: receipt.threadRef ?? null
    };
  }

  /** 外部からの受信。同じイベントを二度処理しないよう冪等キーで弾く。 */
  async receiveWebhook(input: {
    source: string; externalId: string; payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; duplicated: boolean }> {
    if (!String(input.externalId ?? "").trim()) {
      throw new DomainError("VALIDATION", "外部IDの無い受信は受け付けられません");
    }
    const key = createHash("sha256")
      .update(`webhook ${input.source} ${input.externalId}`).digest("hex");
    try {
      return await inTransaction(this.database, async (client) => {
        const inserted = await client.query(
          `INSERT INTO audit_events (actor, action, target_type, idempotency_key, detail)
           VALUES ('system', $1, 'webhook', $2, $3::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [`${input.source}.receive`, key, JSON.stringify({
            externalId: input.externalId, payload: input.payload
          })]);
        return { accepted: true, duplicated: inserted.rows.length === 0 };
      });
    } catch (error) { throw translate(error); }
  }

  private async record(
    input: { channel: IntegrationChannel; targetType: string; targetId: number; actor: string },
    entry: { action: string; idempotencyKey?: string; detail: Record<string, unknown> }
  ) {
    await inTransaction(this.database, async (client) => {
      await recordAudit(client, {
        actor: input.actor,
        action: entry.action,
        targetType: input.targetType,
        targetId: input.targetId,
        idempotencyKey: entry.idempotencyKey ?? null,
        detail: entry.detail
      });
    });
  }
}
