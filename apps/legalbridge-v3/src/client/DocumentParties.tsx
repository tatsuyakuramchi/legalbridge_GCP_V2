import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { DocumentParty, DocumentPartyRole } from "../server/parties/multi-party.js";
import { DOCUMENT_PARTY_ROLE_LABEL, DOCUMENT_PARTY_ROLES } from "../server/parties/multi-party.js";

/**
 * 文書の関係当事者（docs/v3-tidy.md 型 3）。
 *
 * 文書は 1 件のまま、関わる取引先を役割つきで並べる（連名の条件書・3 社契約）。
 * 宛名（相手方・受取人）は別に決まるので、ここでは外せない。
 * ここに載せた取引先の木（整理する）にも同じ 1 件が出て、CloudSign の署名者の候補にも入る。
 */
export function DocumentParties({ documentId, onOpen, onChanged }: {
  documentId: number; onOpen?: (kind: EntityKind, id: number) => void; onChanged?: () => void;
}) {
  const readOnly = useReadOnly();
  const [rows, setRows] = useState<DocumentParty[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [partyId, setPartyId] = useState("");
  const [partyName, setPartyName] = useState<string | null>(null);
  const [role, setRole] = useState<DocumentPartyRole>("signer");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ parties: DocumentParty[] }>(`/documents/${documentId}/parties`)
      .then((r) => setRows(r.parties)).catch((e: ApiError) => setError(e.message));
  }, [documentId]);

  async function save(next: Array<{ partyId: number; role: DocumentPartyRole; note: string | null }>) {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ parties: DocumentParty[] }>(`/documents/${documentId}/parties`, { parties: next });
      setRows(r.parties); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const current = () => (rows ?? []).map((r) => ({ partyId: r.partyId, role: r.role, note: r.note }));

  async function add() {
    if (!partyId) return;
    await save([...current(), { partyId: Number(partyId), role, note: note.trim() || null }]);
    setAdding(false); setPartyId(""); setPartyName(null); setNote("");
  }
  async function remove(r: DocumentParty) {
    await save(current().filter((x) => !(x.partyId === r.partyId && x.role === r.role)));
  }

  const others = (rows ?? []).filter((r) => !(r.addressee && r.role === "counterparty"));
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>関係当事者 {rows ? rows.length : ""}</h2>
        <span className="faint">連名の条件書・3 社契約など。宛名は変えず、関わる取引先を役割つきで持つ</span>
        {!readOnly && !adding && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)} disabled={busy || !rows}>足す</button>
        )}
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {rows && !rows.length && <div className="faint">宛名の取引先だけです。連名なら「足す」。</div>}
        {rows && rows.length > 0 && (
          <table>
            <thead><tr><th>役割</th><th>取引先</th><th>備考</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className={`tag ${r.addressee ? "accent" : "ghost"}`}>{DOCUMENT_PARTY_ROLE_LABEL[r.role]}</span></td>
                  <td>
                    {onOpen ? <button className="linky" onClick={() => onOpen("party", r.partyId)}>{r.partyName}</button> : r.partyName}
                    {r.addressee && <span className="faint">　宛名</span>}
                  </td>
                  <td className="faint">{r.note ?? ""}</td>
                  <td style={{ textAlign: "right" }}>
                    {!readOnly && !(r.addressee && r.role === "counterparty") && (
                      <button className="btn btn-sm" onClick={() => remove(r)} disabled={busy}>外す</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {adding && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ minWidth: 260 }}>
              <span>取引先</span>
              <SearchSelect value={partyId} search={searchParties} placeholder="名称・コード・カナ" valueLabel={partyName}
                onChange={(v, o) => { setPartyId(v); setPartyName(o?.label ?? null); }} autoFocus />
            </label>
            <label className="field">
              <span>役割</span>
              <select value={role} onChange={(e) => setRole(e.target.value as DocumentPartyRole)}>
                {DOCUMENT_PARTY_ROLES.filter((x) => x !== "counterparty").map((x) => <option key={x} value={x}>{DOCUMENT_PARTY_ROLE_LABEL[x]}</option>)}
              </select>
            </label>
            <label className="field" style={{ minWidth: 200 }}>
              <span>備考</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="取り分 20%・連帯署名 など" />
            </label>
            <button className="btn primary" onClick={add} disabled={busy || !partyId}>足す</button>
            <button className="btn" onClick={() => setAdding(false)} disabled={busy}>やめる</button>
          </div>
        )}
        {others.length > 0 && (
          <div className="faint">ここに載せた取引先の「整理する」の木にも、この文書が「関係当事者として」出ます。CloudSign の署名者の候補にも入ります。</div>
        )}
      </div>
    </div>
  );
}
