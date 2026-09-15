import { DomainError } from "../core/errors.js";
import type { MatterKind } from "../matters/write-service.js";

/**
 * Slack からの法務依頼。
 *
 * 依頼者に V3 の画面を開かせない。Slack の中で完結させて、案件だけが
 * こちらに立つ。V2 は依頼種別ごとに動的なモーダルを組み立てていたが、
 * V3 の案件は取引モデルが3つしかないので、選ばせるのはそれだけにする。
 *
 * モーダルの組み立てと送信内容の読み取りは純関数にしてある。Slack を
 * 相手にせずに規則を確かめられるようにするため。
 */

export const INTAKE_COMMANDS = new Set(["/法務依頼", "/legal-request"]);
export const INTAKE_CALLBACK_ID = "legalbridge_intake";

/** 依頼種別。V3 の案件の取引モデルに1対1で対応させる。 */
export const REQUEST_TYPES: Array<{ value: MatterKind; label: string; hint: string }> = [
  { value: "outsourcing", label: "業務委託・発注", hint: "外部へ仕事を頼む。取適法の検査が付く" },
  { value: "work", label: "作品の権利", hint: "許諾を出す・取る。権利範囲を確かめる" },
  { value: "single", label: "その他の相談", hint: "契約書のレビュー、NDA など" }
];

export interface IntakeSubmission {
  kind: MatterKind;
  title: string;
  counterpartyName: string | null;
  dueOn: string | null;
  detail: string | null;
  requesterSlackId: string;
  requesterName: string | null;
}

/** 受付フォーム。Slack の Block Kit。 */
export function buildIntakeModal(options: { channelId?: string } = {}) {
  return {
    type: "modal",
    callback_id: INTAKE_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId: options.channelId ?? null }),
    title: { type: "plain_text", text: "法務への依頼" },
    submit: { type: "plain_text", text: "依頼する" },
    close: { type: "plain_text", text: "やめる" },
    blocks: [
      {
        type: "input", block_id: "kind",
        label: { type: "plain_text", text: "依頼の種類" },
        element: {
          type: "static_select", action_id: "value",
          placeholder: { type: "plain_text", text: "選んでください" },
          options: REQUEST_TYPES.map((t) => ({
            text: { type: "plain_text", text: t.label }, value: t.value
          }))
        }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn",
          text: REQUEST_TYPES.map((t) => `*${t.label}*：${t.hint}`).join("　／　") }]
      },
      {
        type: "input", block_id: "title",
        label: { type: "plain_text", text: "件名" },
        element: { type: "plain_text_input", action_id: "value",
                   placeholder: { type: "plain_text", text: "◯◯のイラスト制作を依頼したい" } }
      },
      {
        type: "input", block_id: "counterparty", optional: true,
        label: { type: "plain_text", text: "相手先" },
        element: { type: "plain_text_input", action_id: "value",
                   placeholder: { type: "plain_text", text: "株式会社◯◯ / 個人名" } },
        hint: { type: "plain_text", text: "分かる範囲で。未登録でも構いません" }
      },
      {
        type: "input", block_id: "due", optional: true,
        label: { type: "plain_text", text: "希望の期日" },
        element: { type: "datepicker", action_id: "value" }
      },
      {
        type: "input", block_id: "detail", optional: true,
        label: { type: "plain_text", text: "詳しい内容" },
        element: { type: "plain_text_input", action_id: "value", multiline: true }
      }
    ]
  };
}

const pick = (state: any, block: string): string | null => {
  const v = state?.values?.[block]?.value;
  const raw = v?.value ?? v?.selected_option?.value ?? v?.selected_date ?? null;
  const s = String(raw ?? "").trim();
  return s ? s : null;
};

/** 送信内容を読み取る。足りないものは受け付けずに理由を返す。 */
export function parseSubmission(payload: any): IntakeSubmission {
  const view = payload?.view;
  if (view?.callback_id !== INTAKE_CALLBACK_ID) {
    throw new DomainError("VALIDATION", "この受付フォームの送信ではありません");
  }
  const kind = pick(view.state, "kind") as MatterKind | null;
  const title = pick(view.state, "title");
  if (!kind || !REQUEST_TYPES.some((t) => t.value === kind)) {
    throw new DomainError("VALIDATION", "依頼の種類を選んでください");
  }
  if (!title) throw new DomainError("VALIDATION", "件名を書いてください");

  return {
    kind, title,
    counterpartyName: pick(view.state, "counterparty"),
    dueOn: pick(view.state, "due"),
    detail: pick(view.state, "detail"),
    requesterSlackId: String(payload?.user?.id ?? ""),
    requesterName: payload?.user?.name ? String(payload.user.name) : null
  };
}

/** 受け付けたことを Slack へ返す文面。案件番号を必ず含める。 */
export function buildAcknowledgement(input: {
  matterNo: string | null; matterId: number; submission: IntakeSubmission;
  counterpartyResolved: string | null;
}): string {
  const type = REQUEST_TYPES.find((t) => t.value === input.submission.kind)?.label ?? input.submission.kind;
  const lines = [
    `依頼を受け付けました：*${input.matterNo ?? `#${input.matterId}`}*`,
    `種類：${type}`,
    `件名：${input.submission.title}`
  ];
  if (input.submission.counterpartyName) {
    lines.push(input.counterpartyResolved
      ? `相手先：${input.counterpartyResolved}`
      : `相手先：${input.submission.counterpartyName}（未登録のため、法務側で登録します）`);
  }
  if (input.submission.dueOn) lines.push(`希望の期日：${input.submission.dueOn}`);
  return lines.join("\n");
}
