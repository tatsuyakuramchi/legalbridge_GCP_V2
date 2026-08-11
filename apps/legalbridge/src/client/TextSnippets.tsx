import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { FeatureLockedNote } from "./FeatureLockedNote";
import { filterSnippets, removeSnippet, sanitizeSnippets, type Snippet } from "./snippets-store";

// テキストスニペット（Phase 16-1・サーバ共有化）。V1 の text_snippets を全社共有で読み書きする。
// 読取＝全ロール、編集＝admin/legal かつ snippets capability。旧ローカル保存（Phase 6）の
// 下書きは移行導線を残し、共有への引っ越し後にこの端末から消せる。

const STORAGE_KEY = "lb-v2-text-snippets";

const CATEGORY_LABELS: Record<string, string> = {
  special_terms: "特約・備考",
  work_item: "業務明細",
  other: "その他"
};
const CATEGORY_ORDER = ["special_terms", "work_item", "other"];

interface SharedSnippet {
  id: number;
  category: string;
  title: string;
  body: string;
  sortOrder: number;
}

function loadLocal(): Snippet[] {
  try {
    return sanitizeSnippets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch { return []; }
}

export function TextSnippets({ canEdit = false }: { canEdit?: boolean }) {
  const { push } = useToast();
  const [shared, setShared] = useState<SharedSnippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [localList, setLocalList] = useState<Snippet[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [category, setCategory] = useState("special_terms");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/v2/snippets");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { snippets?: SharedSnippet[] };
      setShared(Array.isArray(payload.snippets) ? payload.snippets : []);
      setLoadError(null);
    } catch {
      setLoadError("共有スニペットを読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); setLocalList(loadLocal()); }, [reload]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shared;
    return shared.filter((s) =>
      s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q));
  }, [shared, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, SharedSnippet[]>();
    for (const s of visible) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a); const bi = CATEGORY_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
    });
    return keys.map((key) => ({ key, label: CATEGORY_LABELS[key] ?? key, items: map.get(key) ?? [] }));
  }, [visible]);

  function resetForm() {
    setEditingId(null); setCategory("special_terms"); setTitle(""); setBody(""); setSortOrder(0);
  }

  function edit(s: SharedSnippet) {
    setEditingId(s.id); setCategory(s.category); setTitle(s.title); setBody(s.body); setSortOrder(s.sortOrder);
  }

  async function saveShared(input: { id?: number; category: string; title: string; body: string; sortOrder: number }) {
    const response = await fetch("/api/v2/snippets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
  }

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await saveShared({
        id: editingId ?? undefined, category, title: title.trim(), body, sortOrder
      });
      push(editingId ? "スニペットを更新しました" : "スニペットを追加しました");
      resetForm();
      await reload();
    } catch (error) {
      push(error instanceof Error ? error.message : "保存できませんでした");
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(s: SharedSnippet) {
    if (!window.confirm(`「${s.title}」を一覧から外します（共有全員に反映）。`)) return;
    try {
      const response = await fetch(`/api/v2/snippets/${s.id}/deactivate`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      push("スニペットを外しました");
      if (editingId === s.id) resetForm();
      await reload();
    } catch (error) {
      push(error instanceof Error ? error.message : "操作できませんでした");
    }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); push("コピーしました"); }
    catch { push("コピーできませんでした（手動で選択してください）"); }
  }

  function persistLocal(next: Snippet[]) {
    setLocalList(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota等は無視 */ }
  }

  async function migrateLocal(s: Snippet) {
    try {
      await saveShared({ category: "other", title: s.title, body: s.body, sortOrder: 0 });
      persistLocal(removeSnippet(localList, s.id));
      push("共有スニペットへ移行しました");
      await reload();
    } catch (error) {
      push(error instanceof Error ? error.message : "移行できませんでした");
    }
  }

  function deleteLocal(id: string) {
    if (!window.confirm("この端末の下書きを削除します。")) return;
    persistLocal(removeSnippet(localList, id));
  }

  const localVisible = useMemo(() => filterSnippets(localList, query), [localList, query]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>TEXT SNIPPETS</p>
          <h1>テキストスニペット</h1>
          <small>よく使う定型文を全社で共有し、ワンクリックでコピーして文書作成に貼り付け</small>
        </div>
      </div>

      {canEdit ? (
        <div className="snippet-editor">
          <div className="snippet-editor-fields">
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類">
              {CATEGORY_ORDER.map((key) => <option key={key} value={key}>{CATEGORY_LABELS[key]}</option>)}
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タイトル（例：秘密保持条項）" />
            <input
              type="number" min={0} max={9999} value={sortOrder} aria-label="表示順"
              onChange={(e) => setSortOrder(Math.max(0, Number(e.target.value) || 0))}
              title="小さいほど上に表示"
            />
          </div>
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="本文を入力…" />
          <div className="snippet-editor-actions">
            {editingId !== null && <button onClick={resetForm}>キャンセル</button>}
            <button className="primary" onClick={() => void save()} disabled={saving || !title.trim()}>
              {editingId !== null ? "更新" : "追加"}
            </button>
          </div>
        </div>
      ) : (
        <FeatureLockedNote>共有スニペットの追加・編集は管理者または法務が行えます。コピーはどなたでも可能です。</FeatureLockedNote>
      )}

      <div className="snippet-toolbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="スニペットを検索" />
        <span>{visible.length + localVisible.length}件</span>
      </div>

      {loadError && <div className="snippet-load-error" role="alert">{loadError}</div>}
      {loading && <div className="empty-state">読み込み中…</div>}

      {!loading && grouped.map((group) => (
        <div className="snippet-group" key={group.key}>
          <h2>{group.label}</h2>
          <div className="snippet-list">
            {group.items.map((s) => (
              <article key={s.id}>
                <div className="snippet-head"><strong>{s.title}</strong></div>
                <p>{s.body}</p>
                <div className="snippet-actions">
                  <button onClick={() => void copy(s.body)}>コピー</button>
                  {canEdit && <button onClick={() => edit(s)}>編集</button>}
                  {canEdit && <button className="danger" onClick={() => void deactivate(s)}>外す</button>}
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
      {!loading && !loadError && !visible.length && (
        <EmptyState
          title="共有スニペットはまだありません"
          description={canEdit
            ? "上のフォームから追加すると全社に共有されます。"
            : "管理者または法務が追加すると、ここに表示されます。"}
        />
      )}

      {localVisible.length > 0 && (
        <div className="snippet-group snippet-local">
          <h2>この端末の下書き（旧・ローカル保存）</h2>
          <small className="hint">
            以前この端末に保存したスニペットです。共有へ移行するか、不要なら削除してください。
          </small>
          <div className="snippet-list">
            {localVisible.map((s) => (
              <article key={s.id}>
                <div className="snippet-head"><strong>{s.title}</strong></div>
                <p>{s.body}</p>
                <div className="snippet-actions">
                  <button onClick={() => void copy(s.body)}>コピー</button>
                  {canEdit && <button onClick={() => void migrateLocal(s)}>共有へ移行</button>}
                  <button className="danger" onClick={() => deleteLocal(s.id)}>削除</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
