import type { MatterKind } from "../matters/write-service.js";
import type { BacklogIssue } from "../integrations/adapters.js";

/**
 * Backlog の課題から、受付箱に入れるときの推定値を作る。純関数。
 *
 * 推定は受付の初期値にすぎない。確定は法務が受付箱で行う。
 * だから当てにならないときは null を返し、それらしい値で埋めない。
 */

/**
 * 案件の取引モデルの推定。V1 の課題種別は「契約審査」に発注書もライセンスも
 * 入っているので、課題種別だけでは決まらない。件名の語も見る。
 */
export function guessKind(issueTypeName: string | null | undefined,
                          summary: string | null | undefined): MatterKind | null {
  const type = String(issueTypeName ?? "");
  const text = `${type} ${String(summary ?? "")}`;
  if (/納品|検収|発注|業務委託|制作|製造|外注/.test(text)) return "outsourcing";
  if (/利用許諾|ライセンス|許諾|出版|印税|原作|翻訳|サブライセンス/.test(text)) return "work";
  if (/法務相談|事務手続|NDA|秘密保持|相談|売買/.test(text)) return "single";
  return null;
}

/** カスタム属性の値。選択型は名前にする。 */
export function customField(issue: BacklogIssue, name: string): string | null {
  const field = (issue.customFields ?? []).find((f) => f?.name === name);
  if (!field) return null;
  const v = field.value as any;
  const raw = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x.name : x)).join("、")
    : v && typeof v === "object" ? v.name ?? v.id ?? null
    : v;
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

/** 説明欄の Slack メンション（<@U…>）から依頼者を拾う。V1 の Slack 受付はここに書く。 */
export function requesterSlackId(description: string | null | undefined): string | null {
  const m = String(description ?? "").match(/<@([A-Z0-9]+)>/);
  return m ? m[1] : null;
}

/** 日付（YYYY-MM-DD）だけを取り出す。読めなければ null。 */
export function dateOnly(v: string | null | undefined): string | null {
  const m = String(v ?? "").match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Backlog の updatedSince 用。東京の日付。 */
export function tokyoDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Slack 受付で立てた課題の件名から依頼番号を読む（「[REQ-2026-00012] 件名」）。
 * 課題を立ててからキーを控えるまでの間に取得が走っても、別の依頼として二重に入れないため。
 */
export function requestNoInSummary(summary: string | null | undefined): string | null {
  const m = String(summary ?? "").match(/^\[(REQ-\d{4}-\d{5})\]/);
  return m ? m[1] : null;
}

/** 受付箱に入れる形。 */
export interface IntakeFromIssue {
  kind: MatterKind | null;
  title: string;
  detail: string | null;
  counterpartyName: string | null;
  dueOn: string | null;
  requesterSlackId: string | null;
  requesterName: string | null;
}

export function fromIssue(issue: BacklogIssue): IntakeFromIssue {
  const title = String(issue.summary ?? "").trim() || issue.issueKey;
  return {
    kind: guessKind(issue.issueType?.name, issue.summary),
    title: title.slice(0, 300),
    detail: issue.description ? String(issue.description).slice(0, 8000) : null,
    counterpartyName: customField(issue, "取引先名称"),
    dueOn: dateOnly(customField(issue, "希望納期")) ?? dateOnly(issue.dueDate ?? null),
    requesterSlackId: requesterSlackId(issue.description),
    requesterName: issue.createdUser?.name ?? null
  };
}

/** 課題の写し。原票として画面に出す項目だけを持つ。 */
export function snapshotOf(issue: BacklogIssue): Record<string, unknown> {
  return {
    issueKey: issue.issueKey,
    summary: issue.summary ?? null,
    description: issue.description ? String(issue.description).slice(0, 8000) : null,
    issueType: issue.issueType?.name ?? null,
    status: issue.status?.name ?? null,
    createdUser: issue.createdUser?.name ?? null,
    created: issue.created ?? null,
    updated: issue.updated ?? null,
    customFields: (issue.customFields ?? []).map((f) => ({
      name: f?.name ?? null, value: customField(issue, String(f?.name ?? ""))
    }))
  };
}
