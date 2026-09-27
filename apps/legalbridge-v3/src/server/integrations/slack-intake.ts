import { DomainError } from "../core/errors.js";
import type { MatterKind } from "../matters/write-service.js";

/**
 * Slack からの法務依頼。
 *
 * 依頼者に V3 の画面を開かせない。Slack の中で完結させて、案件だけが
 * こちらに立つ。依頼者には「何をしたいか」で選ばせ、V3 の案件の取引モデル
 * （3つ）はこちらで当てる（REQUEST_PURPOSES）。
 *
 * モーダルの組み立てと送信内容の読み取りは純関数にしてある。Slack を
 * 相手にせずに規則を確かめられるようにするため。
 */

export const INTAKE_COMMANDS = new Set(["/法務依頼", "/legal-request"]);
export const INTAKE_CALLBACK_ID = "legalbridge_intake";

/** 依頼種別（法務側の分類）。V3 の案件の取引モデルに1対1で対応させる。受付箱で法務が選び直せる。 */
export const REQUEST_TYPES: Array<{ value: MatterKind; label: string; hint: string }> = [
  { value: "outsourcing", label: "業務委託・発注", hint: "外部へ仕事を頼む。取適法の検査が付く" },
  { value: "work", label: "作品の権利", hint: "許諾を出す・取る。権利範囲を確かめる" },
  { value: "single", label: "その他の相談", hint: "契約書のレビュー、NDA など" }
];

/**
 * 依頼の内容（依頼者側の言葉）。事業部の人は「取引モデル」では考えないので、
 * 「何をしたいか」で選ばせ、法務側の分類（kind）はこちらで当てる。
 * 支払の書類（検収書・利用許諾計算書）は、対象の発注書・契約書の番号を必須にする
 * （V1 と同じ。どの契約の支払かが分からないと作れない）。
 */
export type RequestPurpose =
  | "order" | "inspection" | "royalty" | "review" | "nda"
  | "license_in" | "license_out" | "trade" | "consult";

export const REQUEST_PURPOSES: Array<{
  value: RequestPurpose; label: string; hint: string; kind: MatterKind;
  /** 対象の番号が要るとき、その呼び方。 */
  needsDocNo?: string;
}> = [
  { value: "order", kind: "outsourcing", label: "社外に仕事を頼みたい（発注書・業務委託契約）",
    hint: "イラスト・デザイン・制作・開発などを、社外の人や会社にお願いする" },
  { value: "inspection", kind: "outsourcing", label: "納品を受けたので支払いたい（検収書）",
    hint: "発注した仕事の納品物を確認した。支払のための検収書を作る", needsDocNo: "発注書番号" },
  { value: "royalty", kind: "work", label: "利用許諾料を支払いたい（利用許諾計算書）",
    hint: "売上・部数などの報告をもとに、許諾料の計算書を作る", needsDocNo: "契約書番号" },
  { value: "review", kind: "single", label: "相手から届いた契約書を見てほしい",
    hint: "相手のひな形・修正案のチェック" },
  { value: "nda", kind: "single", label: "秘密保持契約（NDA）を結びたい",
    hint: "打合せ・企画の前に情報を守る約束をする" },
  { value: "license_in", kind: "work", label: "他社の作品・キャラクターを使いたい",
    hint: "権利者から使ってよいという許諾をもらう" },
  { value: "license_out", kind: "work", label: "自社の作品を他社に使わせたい",
    hint: "グッズ化・翻訳・配信などの許諾を出す" },
  { value: "trade", kind: "single", label: "商品を仕入れる・売る契約をしたい",
    hint: "売買・取引の基本契約" },
  { value: "consult", kind: "single", label: "その他の相談",
    hint: "どれに当たるか分からないときもこちら" }
];

/** 開いたままの古いフォーム（取引モデルで選ばせていた）から届いたときの読み替え。 */
const LEGACY_PURPOSE: Record<string, RequestPurpose> = {
  outsourcing: "order", work: "license_in", single: "consult"
};

export const purposeOf = (value: string | null | undefined) =>
  REQUEST_PURPOSES.find((p) => p.value === value) ?? null;

/** 依頼者に見せる「依頼の内容」。内容が無い（手動・メール・古い依頼）なら法務側の分類。 */
export function requestLabel(s: { kind?: string | null; purpose?: string | null }): string {
  return purposeOf(s.purpose)?.label
    ?? REQUEST_TYPES.find((t) => t.value === s.kind)?.label ?? String(s.kind ?? "");
}

export interface IntakeSubmission {
  kind: MatterKind;
  /** 依頼者が選んだ内容。Slack 以外（手動・メール）には無い。 */
  purpose?: RequestPurpose | null;
  /** 支払の書類の対象（発注書番号・契約書番号）。 */
  targetDocNo?: string | null;
  title: string;
  counterpartyName: string | null;
  dueOn: string | null;
  detail: string | null;
  requesterSlackId: string;
  requesterName: string | null;
}

/** 入力の誤りを、モーダルのどの欄に出すか。 */
export class IntakeFieldError extends DomainError {
  constructor(readonly block: string, message: string) {
    super("VALIDATION", message);
  }
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
        label: { type: "plain_text", text: "何をお願いしたいですか" },
        // 選択肢は説明つきのラジオボタンで並べる（プルダウンには説明を付けられない）。
        element: {
          type: "radio_buttons", action_id: "value",
          options: REQUEST_PURPOSES.map((p) => ({
            text: { type: "plain_text", text: p.label },
            description: { type: "plain_text", text: p.hint },
            value: p.value
          }))
        }
      },
      {
        type: "input", block_id: "title",
        label: { type: "plain_text", text: "件名" },
        element: { type: "plain_text_input", action_id: "value",
                   placeholder: { type: "plain_text", text: "例：◯◯のイラスト制作を外注したい／9月納品分の検収" } }
      },
      {
        type: "input", block_id: "target_doc", optional: true,
        label: { type: "plain_text", text: "対象の発注書番号・契約書番号" },
        element: { type: "plain_text_input", action_id: "value",
                   placeholder: { type: "plain_text", text: "例：ARC-PO-2026-1001" } },
        hint: { type: "plain_text",
                text: "検収書・利用許諾計算書のときは必ず書いてください。複数あるときは読点（、）で区切る" }
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
        element: { type: "plain_text_input", action_id: "value", multiline: true,
                   placeholder: { type: "plain_text",
                     text: "検収書なら納品日・納品物・金額、計算書なら対象期間・売上や部数など" } }
      },
      // 資料はフォームでは受け取らない（依頼番号が決まる前はリンクを作れない）。
      // 送信後の確認 DM に、その依頼専用のアップロード用リンクが付く（A-055）。
      {
        type: "context",
        elements: [{ type: "mrkdwn",
          text: "📎 *レビューしてほしい文書・参考資料の添付方法*：依頼の送信後に届く DM の"
            + "「資料アップロードページ」のリンクから上げてください（この依頼専用・30 日有効）。" }]
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

/** 送信内容を読み取る。足りないものは受け付けずに理由を返す（どの欄かも添える）。 */
export function parseSubmission(payload: any): IntakeSubmission {
  const view = payload?.view;
  if (view?.callback_id !== INTAKE_CALLBACK_ID) {
    throw new DomainError("VALIDATION", "この受付フォームの送信ではありません");
  }
  const chosen = pick(view.state, "kind");
  const purpose = purposeOf(chosen ? LEGACY_PURPOSE[chosen] ?? chosen : null);
  if (!purpose) throw new IntakeFieldError("kind", "何をお願いしたいかを選んでください");
  const title = pick(view.state, "title");
  if (!title) throw new IntakeFieldError("title", "件名を書いてください");
  const targetDocNo = pick(view.state, "target_doc");
  if (purpose.needsDocNo && !targetDocNo) {
    throw new IntakeFieldError("target_doc",
      `対象の${purpose.needsDocNo}を書いてください（どの契約の支払かを特定するため）`);
  }

  return {
    kind: purpose.kind, purpose: purpose.value, targetDocNo,
    title,
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
  const lines = [
    `依頼を受け付けました：*${input.matterNo ?? `#${input.matterId}`}*`,
    `依頼の内容：${requestLabel(input.submission)}`,
    `件名：${input.submission.title}`
  ];
  if (input.submission.counterpartyName) {
    lines.push(input.counterpartyResolved
      ? `相手先：${input.counterpartyResolved}`
      : `相手先：${input.submission.counterpartyName}（未登録のため、法務側で登録します）`);
  }
  if (input.submission.targetDocNo) lines.push(`対象の番号：${input.submission.targetDocNo}`);
  if (input.submission.dueOn) lines.push(`希望の期日：${input.submission.dueOn}`);
  return lines.join("\n");
}
