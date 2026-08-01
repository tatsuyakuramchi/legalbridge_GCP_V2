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
}

export interface SlackDeliveryReceipt {
  channelId: string;
  messageTs: string;
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
  const receipt = await options.adapter.send({
    userId,
    idempotencyKey: options.envelope.fingerprint,
    issueKey: options.envelope.issueKey,
    headline: options.envelope.message.headline,
    body: options.envelope.message.body,
    nextAction: options.envelope.message.nextAction,
    actions: options.envelope.message.actions
  });
  if (!/^[A-Z0-9]+$/.test(receipt.channelId) ||
      !/^\d+\.\d+$/.test(receipt.messageTs)) {
    throw new Error("Slack adapter returned an invalid delivery receipt");
  }

  await options.history.append({
    ...options.envelope.plannedHistoryEntry,
    slackChannelId: receipt.channelId,
    slackMessageTs: receipt.messageTs,
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
