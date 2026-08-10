import type { PendingInspectionRepository, PendingInspectionRow } from "../inspections/repository.js";

// 検収待ちダイジェスト（Phase 9-4）。検収書未作成の発注書を集計し Slack へ定期投稿する。
// スナップショット通知のため台帳・重複抑止は不要（毎回全量）。新規 grant 不要（documents SELECT）。

const MAX_LINES = 20;

export function composeInspectionDigest(rows: PendingInspectionRow[]): string {
  const header = `:clipboard: 検収待ちの発注書（${rows.length}件）`;
  const shown = rows.slice(0, MAX_LINES);
  const lines = shown.map((r) => {
    const doc = r.documentNumber ?? "未発番";
    const matter = r.matterCode ? `${r.matterCode} ${r.matterTitle ?? ""}`.trim() : (r.matterTitle ?? "");
    const issue = r.issueKey ? `（課題 ${r.issueKey}）` : "";
    return `• ${doc}${matter ? `｜${matter}` : ""}${issue}`;
  });
  const overflow = rows.length > MAX_LINES ? [`…他 ${rows.length - MAX_LINES} 件`] : [];
  return [header, ...lines, ...overflow].join("\n");
}

export interface InspectionDigestSummary {
  dryRun: boolean;
  pending: number;
  sent: boolean;
}

export interface RunInspectionDigestDeps {
  repo: PendingInspectionRepository;
  // 実送信関数。undefined のときは dry-run（投稿せず件数のみ）。
  post?: (text: string) => Promise<boolean>;
}

export async function runInspectionDigest(deps: RunInspectionDigestDeps): Promise<InspectionDigestSummary> {
  const rows = await deps.repo.list("", true, 200);
  const pending = rows.length;
  const dryRun = !deps.post;
  if (!pending || dryRun) return { dryRun, pending, sent: false };
  const sent = await deps.post!(composeInspectionDigest(rows));
  return { dryRun: false, pending, sent };
}
