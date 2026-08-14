import type { SlackDryRunEnvelope } from "./slack-dry-run.js";
import {
  evaluateSlackDispatchGate,
  type SlackDispatchGateSettings,
  type SlackDispatchGateResult
} from "./slack-dispatch-gate.js";
import type { SlackNotificationHistoryRepository } from "./slack-history-repository.js";

export interface SlackDeliveryRequest {
  userId: string;
  idempotencyKey: string;
  issueKey: string;
  headline: string;
  body: string;
  nextAction: string;
  actions: SlackDryRunEnvelope["message"]["actions"];
  // 1案件=1スレッド：既存 anchor があれば同じ DM チャンネルのスレッドへ返信する。
  // 未指定なら従来どおり conversations.open → 新規 root を作る。
  channelId?: string | null;
  rootThreadTs?: string | null;
}

export interface SlackDeliveryReceipt {
  channelId: string;
  messageTs: string;
  // 投稿先スレッドの root ts。新規 root のときは messageTs と同値、
  // 既存スレッドへの返信のときは root 側の ts。履歴にはこちらを保存し、
  // 1案件の全通知が同じアンカーを指すようにする（legacy root の判別に必要）。
  threadRootTs?: string;
}

export interface SlackDeliveryAdapter {
  readonly configured: boolean;
  send(request: SlackDeliveryRequest): Promise<SlackDeliveryReceipt>;
}

export type SlackDispatchExecution =
  | {
      status: "blocked";
      gate: SlackDispatchGateResult;
      externalSend: false;
      historyAppend: false;
    }
  | {
      status: "duplicate";
      gate: SlackDispatchGateResult;
      externalSend: false;
      historyAppend: false;
    }
  | {
      status: "sent";
      gate: SlackDispatchGateResult;
      receipt: SlackDeliveryReceipt;
      externalSend: true;
      historyAppend: true;
    };

export async function dispatchSlackNotification(options: {
  envelope: SlackDryRunEnvelope;
  gateSettings: Omit<SlackDispatchGateSettings, "adapterConfigured">;
  adapter: SlackDeliveryAdapter;
  history: SlackNotificationHistoryRepository;
  recordedBy: string;
  // 案件の canonical スレッド解決（省略時は従来どおり毎回新規 root）。
  threadAnchors?: Pick<SlackNotificationHistoryRepository, "findMatterThreadAnchor">;
}): Promise<SlackDispatchExecution> {
  const gate = evaluateSlackDispatchGate(options.envelope, {
    ...options.gateSettings,
    adapterConfigured: options.adapter.configured
  });
  if (!gate.dispatchAllowed) {
    return {
      status: "blocked",
      gate,
      externalSend: false,
      historyAppend: false
    };
  }

  const delivered = await options.history.list([options.envelope.issueKey]);
  if (delivered.some((item) =>
    item.issueKey === options.envelope.issueKey &&
    item.fingerprint === options.envelope.fingerprint &&
    (item.outcome === "sent" || item.outcome === "acknowledged")
  )) {
    return {
      status: "duplicate",
      gate,
      externalSend: false,
      historyAppend: false
    };
  }

  const userId = options.envelope.target.userId;
  if (!userId) {
    throw new Error("Slack recipient disappeared after dispatch gate evaluation");
  }
  // 1案件=1スレッド：既存 anchor があれば thread_ts を渡して同一スレッドへ集約する。
  // anchor 取得の失敗は送信を止めない（新規 root として送る＝従来動作へ縮退）。
  const matterId = options.envelope.plannedHistoryEntry.matterId;
  let anchor = null;
  if (options.threadAnchors && matterId) {
    try {
      anchor = await options.threadAnchors.findMatterThreadAnchor(matterId);
    } catch {
      anchor = null;
    }
  }
  const receipt = await options.adapter.send({
    userId,
    idempotencyKey: options.envelope.fingerprint,
    issueKey: options.envelope.issueKey,
    headline: options.envelope.message.headline,
    body: options.envelope.message.body,
    nextAction: options.envelope.message.nextAction,
    actions: options.envelope.message.actions,
    channelId: anchor?.channelId ?? null,
    rootThreadTs: anchor?.rootMessageTs ?? null
  });
  if (!/^[A-Z0-9]+$/.test(receipt.channelId) ||
      !/^\d+\.\d+$/.test(receipt.messageTs)) {
    throw new Error("Slack adapter returned an invalid delivery receipt");
  }

  await options.history.append({
    ...options.envelope.plannedHistoryEntry,
    slackChannelId: receipt.channelId,
    // スレッド返信のときは root ts を保存する（案件のアンカーを一意に保つため）。
    slackMessageTs: receipt.threadRootTs ?? receipt.messageTs,
    recordedBy: options.recordedBy
  });
  return {
    status: "sent",
    gate,
    receipt,
    externalSend: true,
    historyAppend: true
  };
}

export class DisabledSlackDeliveryAdapter implements SlackDeliveryAdapter {
  readonly configured = false;
  async send(_request: SlackDeliveryRequest): Promise<SlackDeliveryReceipt> {
    throw new Error("Slack delivery adapter is disabled");
  }
}

export class MemorySlackDeliveryAdapter implements SlackDeliveryAdapter {
  readonly configured = true;
  readonly requests: SlackDeliveryRequest[] = [];

  constructor(
    private readonly receipt: SlackDeliveryReceipt = {
      channelId: "D0123456789",
      messageTs: "1785580000.000100"
    },
    private readonly failure?: Error
  ) {}

  async send(request: SlackDeliveryRequest) {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return this.receipt;
  }
}
