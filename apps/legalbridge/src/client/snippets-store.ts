// テキストスニペットのストア純関数（Phase 6・クライアント完結）。
// 永続化は localStorage（ブラウザ単位）。共有スニペットが要る場合は将来DBテーブル判断。
// 配列操作を純関数化してユニットテスト可能にする。

export interface Snippet {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export function upsertSnippet(list: Snippet[], snippet: Snippet): Snippet[] {
  const index = list.findIndex((s) => s.id === snippet.id);
  if (index === -1) return [snippet, ...list];
  const next = list.slice();
  next[index] = snippet;
  return next;
}

export function removeSnippet(list: Snippet[], id: string): Snippet[] {
  return list.filter((s) => s.id !== id);
}

export function filterSnippets(list: Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q));
}

// 保存データの健全化（localStorage の破損・型不一致に耐える）。
export function sanitizeSnippets(value: unknown): Snippet[] {
  if (!Array.isArray(value)) return [];
  const out: Snippet[] = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const title = typeof rec.title === "string" ? rec.title : "";
      const body = typeof rec.body === "string" ? rec.body : "";
      const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt : "";
      if (id && (title || body)) out.push({ id, title, body, updatedAt });
    }
  }
  return out;
}
