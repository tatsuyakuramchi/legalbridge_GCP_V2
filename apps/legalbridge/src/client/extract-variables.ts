// Backlog課題本文からの変数自動抽出（Phase 3・純関数・クライアント完結）。
// 「ラベル：値」「【ラベル】値」形式を拾い、別名表で文書フォームの正規フィールド名へ
// 対応付ける。抽出は補助であり、フォーム値を上書きしない（空欄のみ埋める運用）。

export interface ExtractedPair { key: string; value: string; }
export interface ExtractResult {
  // 正規フィールド名 → 値（フォーム初期化用）。
  variables: Record<string, string>;
  // 生の「ラベル: 値」対（プレビュー表示用）。
  raw: ExtractedPair[];
}

// ラベル別名 → 文書フォームの正規フィールド名。プロジェクトのテンプレ命名に合わせる。
export const DEFAULT_ALIASES: Record<string, string> = {
  "件名": "PROJECT_TITLE", "タイトル": "PROJECT_TITLE", "案件名": "PROJECT_TITLE", "案件": "PROJECT_TITLE",
  "相手方": "COUNTERPARTY", "取引先": "COUNTERPARTY", "契約相手": "COUNTERPARTY", "相手先": "COUNTERPARTY",
  "作品": "WORK_TITLE", "作品名": "WORK_TITLE",
  "金額": "AMOUNT", "契約金額": "AMOUNT", "対価": "AMOUNT",
  "通貨": "CURRENCY",
  "期限": "DUE_DATE", "納期": "DUE_DATE", "締切": "DUE_DATE", "希望納期": "DUE_DATE",
  "担当": "ASSIGNEE", "担当者": "ASSIGNEE",
  "地域": "TERRITORY", "許諾地域": "TERRITORY",
  "備考": "REMARKS", "特記事項": "REMARKS"
};

function normalizeKey(key: string): string {
  return key.replace(/[【】\[\]（）()]/g, "").replace(/\s+/g, "").trim();
}

// 1行から「ラベル：値」を抽出（全角/半角コロン、【ラベル】値 に対応）。
function parseLine(line: string): ExtractedPair | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // 【ラベル】値
  const bracket = trimmed.match(/^[【\[]\s*([^】\]]+?)\s*[】\]]\s*(.+)$/);
  if (bracket) {
    const key = normalizeKey(bracket[1]);
    const value = bracket[2].trim();
    return key && value ? { key, value } : null;
  }
  // ラベル：値 / ラベル: 値（値にコロンを含む場合は最初のコロンで分割）
  const colon = trimmed.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
  if (colon) {
    const key = normalizeKey(colon[1]);
    const value = colon[2].trim();
    return key && value ? { key, value } : null;
  }
  return null;
}

export function extractVariables(text: string | null | undefined, aliases: Record<string, string> = DEFAULT_ALIASES): ExtractResult {
  const raw: ExtractedPair[] = [];
  const variables: Record<string, string> = {};
  const source = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const line of source.split("\n")) {
    const pair = parseLine(line);
    if (!pair) continue;
    raw.push(pair);
    const field = aliases[pair.key];
    // 最初に現れた値を優先（重複ラベルは上書きしない）。
    if (field && !(field in variables)) variables[field] = pair.value;
  }
  return { variables, raw };
}

// 抽出値でフォームを非破壊シード（既存の非空値は保持、空欄のみ補完）。
export function seedFormData(
  current: Record<string, unknown>,
  variables: Record<string, string>
): Record<string, unknown> {
  const next = { ...current };
  for (const [field, value] of Object.entries(variables)) {
    const existing = next[field];
    if (existing === undefined || existing === null || existing === "") next[field] = value;
  }
  return next;
}
