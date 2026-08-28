// 案件 Slack パネルの純関数（client/server 共用）。
//
// 定型文の本文はサーバが組み立てて投稿する。画面の送信前プレビューが別実装だと、
// どちらかを直したときに静かにズレる（プレビューでは CC が見えるのに実際は付かない、等）。
// 組み立てをここに置き、サーバは <@U…>、画面は @氏名 を渡して同じ関数を通す。

export type MatterSlackTemplateId = 1 | 2 | 3;

export const MATTER_SLACK_TEMPLATES: ReadonlyArray<{ id: MatterSlackTemplateId; label: string }> = [
  { id: 1, label: "クラウドサイン送信済" },
  { id: 2, label: "文書作成完了" },
  { id: 3, label: "評価完了" }
];

/** 定型文 2/3 は閲覧リンクを載せる（1 は送信報告なのでリンクを持たない）。 */
export function templateUsesDocument(template: MatterSlackTemplateId): boolean {
  return template === 2 || template === 3;
}

/** 閲覧リンク1件。label は文書番号など（複数載せるときの見出しに使う）。 */
export interface TemplateLink {
  url: string;
  label?: string | null;
}

/**
 * 定型文の本文。to / cc は表示用に整形済みの文字列を渡す
 * （サーバ: `<@U0ABC123>` ／ 画面のプレビュー: `@山田 太郎`）。
 * 閲覧リンクは複数可（driveLinks）。1件なら従来と同じ1行、複数なら箇条書きで
 * 文書番号を添える。旧 driveLink（単数）も受ける（呼び出し側の移行を強制しない）。
 */
export function composeTemplateText(
  template: MatterSlackTemplateId,
  input: {
    to: readonly string[]; cc?: readonly string[];
    driveLink?: string | null; driveLinks?: ReadonlyArray<TemplateLink>;
  }
): string {
  const to = [...input.to];
  const cc = [...(input.cc ?? [])];
  if (template === 1) {
    // 送信の流れを「甲 → 乙 → 相手方」の形で示す（V1 準拠）。
    const chain = [...to, "相手方"].join(" → ");
    const ccPart = cc.length ? `  CC: ${cc.join(" ")}` : "";
    return `クラウドサインで送信しました。 ${chain}${ccPart}`.trim();
  }
  const lead = template === 2 ? "文書作成が完了しました。" : "評価が完了しました。";
  const head = [lead, to.join(" ")].filter((part) => part.length > 0).join(" ");
  const links = (input.driveLinks ?? (input.driveLink ? [{ url: input.driveLink }] : []))
    .map((l) => ({ url: l.url.trim(), label: l.label?.trim() || "" }))
    .filter((l) => l.url.length > 0);
  if (!links.length) return head;
  if (links.length === 1) return `${head}\n閲覧リンク: ${links[0].url}`;
  const list = links.map((l) => `・${l.label ? `${l.label}: ` : ""}${l.url}`).join("\n");
  return `${head}\n閲覧リンク:\n${list}`;
}

// ── メンション候補の絞り込み ─────────────────────────────────────────
// 候補は一覧で全件返ってくる。人数が増えると目で探すのは無理なので、V1 と同じく
// 名前で絞り込む。空白の有無で外れないように、比較時は空白を落とす
// （「山田太郎」で「山田 太郎」に当てる）。
export interface MentionCandidate {
  id: string;
  name: string;
}

function normalize(value: string): string {
  return value.replace(/[\s　]+/g, "").toLowerCase();
}

export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string
): T[] {
  const needle = normalize(query ?? "");
  if (!needle) return [...candidates];
  return candidates.filter((candidate) =>
    normalize(candidate.name).includes(needle) || normalize(candidate.id).includes(needle));
}
