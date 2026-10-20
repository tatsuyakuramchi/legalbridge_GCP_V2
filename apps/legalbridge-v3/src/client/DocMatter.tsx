import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect } from "./SearchSelect.js";
import type { EntityKind, LinkItem } from "./Relations.js";

/**
 * 文書の案件。いま付いている案件を出し、「案件を繋ぐ」で番号・件名から探して決める（1 文書 1 案件）。
 * /links/document/:id/matter（つながりの画面と同じ道具）。
 */
export function DocMatter({ documentId, busy, onOpen, onChanged }: {
  documentId: number; busy: boolean; onOpen?: (kind: EntityKind, id: number) => void; onChanged: (msg: string) => void;
}) {
  const [current, setCurrent] = useState<LinkItem | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<{ relations: Array<{ relation: string; items: LinkItem[] }> }>(`/links/document/${documentId}`)
      .then((r) => setCurrent(r.relations.find((x) => x.relation === "matter")?.items[0] ?? null))
      .catch(() => setCurrent(null));
  }, [documentId, version]);
  const search = async (q: string) => {
    const r = await api.get<{ candidates: LinkItem[] }>(`/links/document/${documentId}/matter/candidates?q=${encodeURIComponent(q.trim())}`);
    return r.candidates.map((c) => ({ value: String(c.id), label: `${c.code ?? ""}　${c.label}`.trim(), hint: c.note }));
  };
  async function attach(targetId: number, label: string) {
    setSaving(true);
    try {
      await api.post(`/links/document/${documentId}/matter`, { targetId });
      setEditing(false); setVersion((v) => v + 1); onChanged(`案件 ${label} に繋ぎました`);
    } catch (e) { onChanged(`⚠ ${e instanceof ApiError ? e.message : String(e)}`); }
    finally { setSaving(false); }
  }
  async function detach() {
    if (!current) return;
    setSaving(true);
    try {
      await api.del(`/links/document/${documentId}/matter/${current.id}`);
      setVersion((v) => v + 1); onChanged(`案件 ${current.code ?? ""} から外しました`);
    } catch (e) { onChanged(`⚠ ${e instanceof ApiError ? e.message : String(e)}`); }
    finally { setSaving(false); }
  }
  if (current === undefined) return <span className="faint">案件…</span>;
  return (
    <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span className="faint">案件：</span>
      {current
        ? (onOpen ? <button className="linky code" onClick={() => onOpen("matter", current.id)}>{current.code ?? `#${current.id}`}</button> : <span className="code">{current.code}</span>)
        : <span className="tag ghost">なし</span>}
      {!editing && <button className="btn btn-sm" disabled={busy || saving} onClick={() => setEditing(true)}>{current ? "案件を変える" : "案件を繋ぐ"}</button>}
      {current && !editing && <button className="linky" disabled={busy || saving} onClick={detach}>外す</button>}
      {editing && (
        <span style={{ minWidth: 300, display: "inline-block" }}>
          <SearchSelect value="" search={search} placeholder="案件番号・件名で探して決める" autoFocus disabled={saving}
                        onChange={(v, o) => { if (v) void attach(Number(v), o?.label ?? v); }} />
        </span>
      )}
      {editing && <button className="linky" onClick={() => setEditing(false)}>やめる</button>}
    </span>
  );
}

