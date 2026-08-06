import { useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import {
  filterSnippets, removeSnippet, sanitizeSnippets, upsertSnippet, type Snippet
} from "./snippets-store";

// テキストスニペット（Phase 6・クライアント完結）。よく使う定型文を保存し、
// ワンクリックでクリップボードにコピーして文書作成に貼り付ける。
// 保存は localStorage（この端末のみ）。サーバ・DB非依存。

const STORAGE_KEY = "lb-v2-text-snippets";

function load(): Snippet[] {
  try {
    return sanitizeSnippets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch { return []; }
}

function newId(): string {
  // crypto.randomUUID が無い環境向けフォールバック。
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function TextSnippets() {
  const { push } = useToast();
  const [list, setList] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { setList(load()); }, []);

  function persist(next: Snippet[]) {
    setList(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota等は無視 */ }
  }

  const visible = useMemo(() => filterSnippets(list, query), [list, query]);

  function save() {
    if (!title.trim() && !body.trim()) return;
    const snippet: Snippet = {
      id: editingId ?? newId(),
      title: title.trim() || "（無題）",
      body,
      updatedAt: new Date().toISOString()
    };
    persist(upsertSnippet(list, snippet));
    setTitle(""); setBody(""); setEditingId(null);
    push(editingId ? "スニペットを更新しました" : "スニペットを追加しました");
  }

  function edit(s: Snippet) { setEditingId(s.id); setTitle(s.title); setBody(s.body); }
  function cancel() { setEditingId(null); setTitle(""); setBody(""); }
  function del(id: string) {
    if (!window.confirm("このスニペットを削除します。")) return;
    persist(removeSnippet(list, id));
    if (editingId === id) cancel();
  }
  async function copy(s: Snippet) {
    try { await navigator.clipboard.writeText(s.body); push("コピーしました"); }
    catch { push("コピーできませんでした（手動で選択してください）"); }
  }

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>TEXT SNIPPETS</p>
          <h1>テキストスニペット</h1>
          <small>よく使う定型文を保存してコピー（この端末のブラウザに保存・サーバ非保存）</small>
        </div>
      </div>

      <div className="snippet-editor">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タイトル（例：秘密保持条項）" />
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="本文を入力…" />
        <div className="snippet-editor-actions">
          {editingId && <button onClick={cancel}>キャンセル</button>}
          <button className="primary" onClick={save} disabled={!title.trim() && !body.trim()}>{editingId ? "更新" : "追加"}</button>
        </div>
      </div>

      <div className="snippet-toolbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="スニペットを検索" />
        <span>{visible.length}件</span>
      </div>

      <div className="snippet-list">
        {visible.map((s) => (
          <article key={s.id}>
            <div className="snippet-head"><strong>{s.title}</strong></div>
            <p>{s.body}</p>
            <div className="snippet-actions">
              <button onClick={() => copy(s)}>コピー</button>
              <button onClick={() => edit(s)}>編集</button>
              <button className="danger" onClick={() => del(s.id)}>削除</button>
            </div>
          </article>
        ))}
        {!visible.length && <div className="empty-state">スニペットはまだありません。上のフォームから追加してください。</div>}
      </div>
    </section>
  );
}
