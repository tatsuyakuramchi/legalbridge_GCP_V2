import { addBusinessDays } from "../core/business-days.js";
import { SERVICE_COMPLETION_KEY } from "./settlement-docs.js";

/**
 * 文書の送付・受領（A-074）。
 *
 * 送付・受領は保存せず、監査記録から関数 v3.document_delivery(id) で導く。ここは
 * その呼び名と、受領を追うかどうか（種類ごとの決まり）だけを持つ。
 *
 * 記録の作り方：
 *   送付済みにする … document.sent_manual（detail.via）。発生日は occurred_at に置く
 *   送付を取り消す … document.send_cleared
 *   受領を記録     … document.received（detail.via）
 *   受領を取り消す … document.receipt_cleared
 *   過去分         … document.sent_manual（via = 'past'）＋ document.received（via = 'past'）
 */

export const SENT_VIA = ["post", "hand", "email_other", "cloudsign_ui", "past", "other"] as const;
export type ManualSentVia = (typeof SENT_VIA)[number];
export const RECEIVED_VIA = ["signed_copy", "reply", "verbal", "past", "other"] as const;
export type ManualReceivedVia = (typeof RECEIVED_VIA)[number];

export const SENT_VIA_LABEL: Record<string, string> = {
  gmail: "メール", cloudsign: "CloudSign", post: "郵送", hand: "手渡し", email_other: "別のメール",
  cloudsign_ui: "CloudSign の画面", past: "過去分", other: "その他"
};
export const RECEIVED_VIA_LABEL: Record<string, string> = {
  signed_copy: "署名済みの控え", reply: "メールの返信", verbal: "口頭・電話", confirmed: "相手の確認",
  cloudsign: "CloudSign 締結", deemed: "みなし確認", past: "過去分", other: "その他"
};

export const sentViaLabel = (via: string | null | undefined): string =>
  via ? SENT_VIA_LABEL[via] ?? via : "";
export const receivedViaLabel = (via: string | null | undefined): string =>
  via ? RECEIVED_VIA_LABEL[via] ?? via : "";

/**
 * 受領を追うか。
 *   signature … 署名して返してもらう（検収書・通知書で金額や内容が変わったとき＝署名欄がある）
 *   deemed    … 期限までに異議がなければ確認とみなす（役務提供完了通知書）
 *   none      … 追わない（計算書・署名欄の無い検収書）
 * 期限はどちらも送付日から 10 営業日。
 */
export type ReceiptRule = "signature" | "deemed" | "none";
export const RECEIPT_BUSINESS_DAYS = 10;

export function receiptRuleFor(templateKey: string | null | undefined,
                               renderedValues: Record<string, unknown> | null | undefined): ReceiptRule {
  const key = String(templateKey ?? "");
  const signs = renderedValues?.needsSignature === true || renderedValues?.needsSignature === "true";
  if (key === SERVICE_COMPLETION_KEY) return signs ? "signature" : "deemed";
  if (/inspection|acceptance|delivery/.test(key)) return signs ? "signature" : "none";
  return "none";
}

export type ReceiptState = "none" | "na" | "await" | "late" | "received";

/** 1 枚の受領の状態。送っていなければ none（まだ問わない）。 */
export function receiptOf(input: {
  rule: ReceiptRule; sentOn: string | null; receivedOn: string | null; receivedVia: string | null; today: string;
}): { state: ReceiptState; dueOn: string | null; on: string | null; via: string | null } {
  // 追わない種類でも、受け取ったと記録したなら受領として出す。
  if (input.rule === "none") {
    return input.receivedOn ? { state: "received", dueOn: null, on: input.receivedOn, via: input.receivedVia }
      : { state: "na", dueOn: null, on: null, via: null };
  }
  if (input.receivedOn) return { state: "received", dueOn: null, on: input.receivedOn, via: input.receivedVia };
  if (!input.sentOn) return { state: "none", dueOn: null, on: null, via: null };
  const dueOn = addBusinessDays(input.sentOn, RECEIPT_BUSINESS_DAYS);
  const over = !!dueOn && input.today > dueOn;
  if (over && input.rule === "deemed") return { state: "received", dueOn, on: dueOn, via: "deemed" };
  return { state: over ? "late" : "await", dueOn, on: null, via: null };
}

/** 日時（ISO・Date）を東京の日付に。 */
export function tokyoDate(at: unknown): string | null {
  if (at === null || at === undefined || at === "") return null;
  const d = at instanceof Date ? at : new Date(String(at));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
