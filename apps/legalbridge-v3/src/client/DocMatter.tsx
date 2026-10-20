import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect } from "./SearchSelect.js";
import type { EntityKind, LinkItem } from "./Relations.js";

/**
 * 文書・契約の案件。いま付いている案件を出し、「案件を繋ぐ」で番号・件名から探して決める。
 * 文書は 1 文書 1 案件（/links/document/:id/matter）、契約は複数持てる（/links/agreement/:id/matters）。
 * つながりの画面と同じ道具。
 */
export function DocMatter({ documentId, agreementId, busy, onOpen, onChanged }: {
  documentId?: number; agreementId?: number; busy: boolean; onOpen?: (kind: EntityKind, id: number) => void; onChanged: (msg: string) => void;
}) {
  const kind = agreementId ? "agreement" : "document";
  const id = agreementId ?? documentId ?? 0;
  const relation = agreementId ? "matters" : "matter";
  const [items, setItems] = useState<LinkItem[] | undefined>(undefined);
  const current = items === undefined ? undefined : items[0] ?? null;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<{ relations: Array<{ relation: string; items: LinkItem[] }> }>(`/links/${kind}/${id}`)
      .then((r) => setItems(r.relations.find((x) => x.relation === relation)?.items ?? []))
      .catch(() => setItems([]));
  }, [kind, id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = async (q: string) => {
    const r = await api.get<{ candidates: LinkItem[] }>(`/links/${kind}/${id}/${relation}/candidates?q=${encodeURIComponent(q.trim())}`);
    return r.candidates.map((c) => ({ value: String(c.id), label: `${c.code ?? ""}　${c.label}`.trim(), hint: c.note }));
  };
  async function attach(targetId: number, label: string) {
    setSaving(true);
    try {
      await api.post(`/links/${kind}/${id}/${relation}`, { targetId });
      setEditing(false); setVersion((v) => v + 1); onChanged(`案件 ${label} に繋ぎました`);
    } catch (e) { onChanged(`⚠ ${e instanceof ApiError ? e.message : String(e)}`); }
    finally { setSaving(false); }
  }
  async function detach(target: LinkItem | null = current ?? null) {
    if (!target) return;
    setSaving(true);
    try {
      await api.del(`/links/${kind}/${id}/${relation}/${target.id}`);
      setVersion((v) => v + 1); onChanged(`案件 ${target.code ?? ""} から外しました`);
    } catch (e) { onChanged(`⚠ ${e instanceof ApiError ? e.message : String(e)}`); }
    finally { setSaving(false); }
  }
  if (items === undefined) return <span className="faint">案件…</span>;
  const multi = kind === "agreement";
  return (
    <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span className="faint">案件：</span>
      {!items.length && <span className="tag ghost">なし</span>}
      {items.map((m) => (
        <span key={m.id} className="row" style={{ gap: 4, alignItems: "center" }}>
          {onOpen ? <button className="linky code" onClick={() => onOpen("matter", m.id)}>{m.code ?? `#${m.id}`}</button> : <span className="code">{m.code}</span>}
          {!editing && <button className="linky" disabled={busy || saving} title={`${m.code ?? ""} から外す`} onClick={() => void detach(m)}>外す</button>}
        </span>
      ))}
      {!editing && <button className="btn btn-sm" disabled={busy || saving} onClick={() => setEditing(true)}>
        {items.length ? (multi ? "案件を足す" : "案件を変える") : "案件を繋ぐ"}
      </button>}
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

