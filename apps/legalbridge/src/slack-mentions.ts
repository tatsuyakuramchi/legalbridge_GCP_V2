// Slack 記法（<@U…> 等）を人が読める文字列へ置換する純関数（client/server 共用）。
//
// V1 の worker は Backlog 課題の本文へ「依頼者: <@U0ABC123>」のように Slack の
// ユーザーIDをそのまま書き込んでいた（services/worker/server.ts の backlogDescription）。
// そのため既存課題の本文・Slack スレッドの発言には生の Slack ユーザーIDが残っており、
// 依頼一覧の「概要」や抽出変数にIDが露出する。表示・抽出の前段でここを通し、
// 担当者マスタ（staff.slack_user_id → staff_name）の氏名へ置き換える。
//
// 解決できないIDは情報を落とさず `@U0ABC123` の見た目だけ整える（担当者マスタに
// Slack ID を登録すれば次回から氏名になる、という運用導線を残すため）。

export type SlackNameLookup =
  | Record<string, string>
  | Map<string, string>
  | ReadonlyArray<{ id: string; name: string }>
  | ((id: string) => string | undefined);

// <@U0ABC123> / <@U0ABC123|display-name>（ボットIDの B…、旧 W… も同形）
const USER_MENTION = /<@([A-Z0-9][A-Z0-9._-]*)(?:\|([^>]*))?>/g;
// <#C0ABC123|general> / <#C0ABC123>
const CHANNEL_MENTION = /<#([A-Z0-9][A-Z0-9._-]*)(?:\|([^>]*))?>/g;
// <!here> / <!channel> / <!everyone> / <!subteam^S123|@team>
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const SUBTEAM_MENTION = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g;
// <https://example.com|ラベル> / <mailto:a@example.com|a@example.com>
const ESCAPED_LINK = /<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/g;

function toResolver(lookup: SlackNameLookup): (id: string) => string | undefined {
  if (typeof lookup === "function") return lookup;
  if (lookup instanceof Map) return (id) => lookup.get(id);
  if (Array.isArray(lookup)) {
    const map = new Map(lookup.map((entry) => [entry.id, entry.name]));
    return (id) => map.get(id);
  }
  const record = lookup as Record<string, string>;
  return (id) => record[id];
}

const clean = (value: string | undefined) => {
  const trimmed = (value ?? "").trim();
  // Slack の `|display` は `@name` 形式で来ることがあるので先頭の @ は落とす。
  return trimmed.replace(/^@+/, "").trim();
};

/**
 * Slack ユーザーID単体を表示名へ。未解決なら `U0ABC123` をそのまま返す。
 * （スレッド一覧の発言者欄のように、記法ではなく生IDが入る箇所で使う。）
 */
export function slackDisplayName(id: string | null | undefined, lookup: SlackNameLookup): string {
  const raw = (id ?? "").trim();
  if (!raw) return "";
  return clean(toResolver(lookup)(raw)) || raw;
}

/**
 * 本文中の Slack 記法を人が読める表記へ置換する。
 * - <@U…>        → @氏名（担当者マスタに無ければ @U…）
 * - <@U…|name>   → @name（マスタ優先）
 * - <#C…|general>→ #general
 * - <!here>      → @here
 * - <https://…|ラベル> → ラベル
 */
export function resolveSlackMentions(text: string | null | undefined, lookup: SlackNameLookup): string {
  const source = text ?? "";
  if (!source || !source.includes("<")) return source;
  const resolve = toResolver(lookup);
  return source
    .replace(SUBTEAM_MENTION, (_m, label?: string) => `@${clean(label) || "team"}`)
    .replace(SPECIAL_MENTION, (_m, keyword: string) => `@${keyword}`)
    .replace(USER_MENTION, (_m, id: string, label?: string) => `@${clean(resolve(id)) || clean(label) || id}`)
    .replace(CHANNEL_MENTION, (_m, id: string, label?: string) => `#${clean(label) || id}`)
    .replace(ESCAPED_LINK, (_m, url: string, label?: string) =>
      clean(label) || url.replace(/^mailto:/, ""));
}

/** 本文に Slack のユーザー記法（<@U…>）が含まれるか。 */
export function hasSlackUserMention(text: string | null | undefined): boolean {
  USER_MENTION.lastIndex = 0;
  return USER_MENTION.test(text ?? "");
}

// 解決後も残った Slack ユーザーID（`@U0ABC123`）。担当者マスタ未登録の合図。
const UNRESOLVED_ID = /@[UWB][A-Z0-9]{6,}\b/;

/** 氏名へ解決できなかった Slack ユーザーIDが残っているか（運用への案内表示用）。 */
export function hasUnresolvedSlackId(text: string | null | undefined): boolean {
  return UNRESOLVED_ID.test(text ?? "");
}
