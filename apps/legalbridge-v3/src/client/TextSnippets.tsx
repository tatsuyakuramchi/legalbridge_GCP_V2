import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { forgetSnippets, loadSnippets, type Snippet } from "./SnippetPicker.js";
import { SNIPPET_CATEGORIES, SNIPPET_CATEGORY_LABEL } from "../server/snippets/categories.js";

/**
 * 定型文。文書の長文欄へ貼る文面を全社で1つ持つ。
 *
 * V2 は V1 の text_snippets を共有の定型文集として持っていた（Phase 16-1）。
 * V3 へは移していなかったので、許諾範囲や特約が各人の記憶頼みの自由記載に
 * なっていた。A-021 で v3 に写して、ここで足す・直す・外す。
 *
 * 外すのは論理削除。行は残す（書類に貼った文面の出どころを辿れるように）。
 * 足す・直す・外すは管理者と法務だけ。断られたらその旨を出す。
 */
export function TextSnippets() {
  const readOnly = useReadOnly();
  const [rows, setRows] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void reload(); }, []);
  async function reload() {
    forgetSnippets();
    setRows(await loadSnippets(true));
  }

  async function save() {
    if (!editing || !String(editing.title ?? "").trim()) return;
    setBusy(true); setError(null);
    const body = {
      category: editing.category ?? "special_terms",
      title: String(editing.title ?? "").trim(),
      body: String(editing.body ?? ""),
      sortOrder: Number(editing.sortOrder ?? 0)
    };
    try {
      if (editing.id) await api.patch(`/snippets/${editing.id}`, body);
      else await api.post("/snippets", body);
      setEditing(null);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function deactivate(s: Snippet) {
    if (!window.confirm(`「${s.title}」を一覧から外します（全員に反映されます）。`)) return;
    setError(null);
    try {
      await api.post(`/snippets/${s.id}/deactivate`);
      if (editing?.id === s.id) setEditing(null);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  const needle = q.trim().toLowerCase();
  const hits = (rows ?? []).filter((s) =>
    !needle || s.title.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle));

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}

      <div className="panel">
        <div className="panel-hd">
          <h2>定型文</h2>
          <span className="faint">文書作成の長文欄（許諾範囲・特約・仕様）から選んで入れられます</span>
          {!readOnly && (
            <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }}
                    onClick={() => setEditing({ category: "scope", sortOrder: 0 })}>
              足す
            </button>
          )}
        </div>
        <div className="panel-bd stack" style={{ gap: 8 }}>
          {editing && (
            <div className="line-card stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <select value={editing.category ?? "special_terms"}
                        onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                  {SNIPPET_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{SNIPPET_CATEGORY_LABEL[c]}</option>
                  ))}
                </select>
                <input value={editing.title ?? ""} style={{ flex: "1 1 240px" }}
                       placeholder="名前（例：許諾範囲・全世界／全言語）"
                       onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                <input type="number" min={0} max={9999} style={{ width: 90 }}
                       title="小さいほど上に出る" value={String(editing.sortOrder ?? 0)}
                       onChange={(e) => setEditing({
                         ...editing, sortOrder: Math.max(0, Number(e.target.value) || 0) })} />
              </div>
              <textarea rows={6} value={editing.body ?? ""} placeholder="本文"
                        onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn btn-sm primary" disabled={busy}
                        onClick={() => void save()}>
                  {editing.id ? "直す" : "足す"}
                </button>
                <button type="button" className="btn btn-sm"
                        onClick={() => setEditing(null)}>やめる</button>
              </div>
            </div>
          )}

          <input value={q} placeholder="名前か本文で探す"
                 onChange={(e) => setQ(e.target.value)} />

          {rows === null && <div className="faint">読み込み中…</div>}
          {rows !== null && !rows.length && (
            <div className="faint">
              定型文はまだありません。よく貼る文面をここに入れておくと、
              文書作成の長文欄から選んで入れられます。
            </div>
          )}

          {SNIPPET_CATEGORIES.map((c) => {
            const items = hits.filter((s) => s.category === c);
            if (!items.length) return null;
            return (
              <div key={c} className="stack" style={{ gap: 6 }}>
                <h3 className="faint">{SNIPPET_CATEGORY_LABEL[c]} {items.length}</h3>
                {items.map((s) => (
                  <div key={s.id} className="snip">
                    <div className="row" style={{ gap: 6 }}>
                      <b>{s.title}</b>
                      <span className="faint">順 {s.sortOrder}</span>
                      {!readOnly && (
                        <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
                          <button type="button" className="linky"
                                  onClick={() => setEditing(s)}>直す</button>
                          <button type="button" className="linky"
                                  onClick={() => void deactivate(s)}>外す</button>
                        </span>
                      )}
                    </div>
                    <p className="faint">{s.body}</p>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
