import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import type { AgreementParty, AgreementPartyRole } from "../server/agreements/parties.js";

/**
 * 契約の当事者（三社間契約。A-068）。
 *
 * 主たる相手先（乙）は契約の登録・付け替えで決める。ここでは丙・丁 … にあたる
 * 他の当事者を足す・立場を直す・順を入れ替える・外す・主たる相手先と入れ替える。
 * 条件明細と支払の相手先は 1 社のまま（金銭の向きは 2 者間で決まる）。
 */

export const ROLE_LABEL: Record<AgreementPartyRole, string> = {
  co_party: "共同当事者", agent: "窓口・代理", guarantor: "保証人", rights_holder: "権利者", other: "その他"
};
const ROLES = Object.keys(ROLE_LABEL) as AgreementPartyRole[];

export function AgreementParties(
  { agreementId, parties: initial, onOpen, onChanged, compact }: {
    agreementId: number;
    /** 契約の行が持っている当事者。無ければ読む。 */
    parties?: AgreementParty[];
    onOpen?: (kind: "party", id: number) => void;
    /** 当事者が変わったとき（相手先の表示・件数を読み直す）。 */
    onChanged?: (msg: string) => void;
    /** 図の中など、狭いところ。説明を省く。 */
    compact?: boolean;
  }
) {
  const readOnly = useReadOnly();
  const [parties, setParties] = useState<AgreementParty[] | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newPartyId, setNewPartyId] = useState("");
  const [newRole, setNewRole] = useState<AgreementPartyRole>("co_party");
  const [newNote, setNewNote] = useState("");

  useEffect(() => { if (initial) setParties(initial); }, [initial]);
  useEffect(() => {
    if (initial) return;
    api.get<{ parties: AgreementParty[] }>(`/agreements/${agreementId}/parties`)
      .then((r) => setParties(r.parties)).catch((e: ApiError) => setError(e.message));
  }, [agreementId, initial]);

  async function run(action: () => Promise<{ parties: AgreementParty[] }>, done: string) {
    setBusy(true); setError(null);
    try {
      const r = await action();
      setParties(r.parties);
      onChanged?.(done);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const extras = (parties ?? []).filter((p) => !p.primary);
  const primary = (parties ?? []).find((p) => p.primary) ?? null;

  return (
    <div className="stack" style={{ gap: 6 }}>
      {!compact && (
        <div className="faint">
          当社が甲、主たる相手先が乙。三社間契約では丙以降をここに足します。条件明細・支払の相手先は 1 社のままです。
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      <div className="tablewrap">
        <table>
          <thead><tr><th style={{ width: 40 }}></th><th>取引先</th><th>立場</th><th>メモ</th><th></th></tr></thead>
          <tbody>
            {primary && (
              <tr>
                <td className="code">{primary.ordinal}</td>
                <td>
                  {onOpen ? <button className="linky" onClick={() => onOpen("party", primary.partyId)}>{primary.name}</button> : primary.name}
                  {primary.merged && <span className="faint" title="統合前の取引先を指しています"> 統合元</span>}
                </td>
                <td><span className="tag accent">主たる相手先</span></td>
                <td className="faint">—</td>
                <td className="faint" style={{ whiteSpace: "nowrap" }}>契約の付け替えで変える</td>
              </tr>
            )}
            {extras.map((p) => (
              <tr key={p.partyId}>
                <td className="code">{p.ordinal}</td>
                <td>
                  {onOpen ? <button className="linky" onClick={() => onOpen("party", p.partyId)}>{p.name}</button> : p.name}
                  {p.merged && <span className="faint" title="統合前の取引先を指しています"> 統合元</span>}
                </td>
                <td>
                  <select value={p.role} disabled={readOnly || busy}
                          onChange={(e) => void run(
                            () => api.patch(`/agreements/${agreementId}/parties/${p.partyId}`, { role: e.target.value }),
                            `${p.name} の立場を変えました`)}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </td>
                <td className="faint">{p.note ?? "—"}</td>
                <td className="row" style={{ gap: 4, whiteSpace: "nowrap" }}>
                  {extras.length > 1 && p.seq > 2 && (
                    <button className="btn btn-sm" disabled={readOnly || busy} title="頭書きの順を一つ上げる"
                            onClick={() => void run(
                              () => api.patch(`/agreements/${agreementId}/parties/${p.partyId}`, { seq: p.seq - 1 }),
                              `${p.name} の順を上げました`)}>↑</button>
                  )}
                  <button className="btn btn-sm" disabled={readOnly || busy} title="この取引先を主たる相手先（乙）にする。いまの相手先はこの席に下がる"
                          onClick={() => {
                            if (!window.confirm(`${p.name} を主たる相手先にしますか？\nいまの主たる相手先（${primary?.name ?? ""}）は ${p.ordinal} に下がります。条件明細・文書の相手先は変わりません。`)) return;
                            void run(() => api.post(`/agreements/${agreementId}/parties/${p.partyId}/make-primary`, {}),
                                     `${p.name} を主たる相手先にしました`);
                          }}>主たる相手先にする</button>
                  <button className="btn btn-sm danger" disabled={readOnly || busy}
                          onClick={() => void run(() => api.del(`/agreements/${agreementId}/parties/${p.partyId}`),
                                                  `${p.name} を当事者から外しました`)}>外す</button>
                </td>
              </tr>
            ))}
            {!extras.length && (
              <tr><td colSpan={5} className="faint">他の当事者はいません（2 者間の契約）</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {adding ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ minWidth: 260 }}>
            <SearchSelect value={newPartyId} onChange={(v) => setNewPartyId(v)} search={searchParties}
              placeholder="取引先名・コードで探す" autoFocus />
          </div>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as AgreementPartyRole)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="メモ（任意）" style={{ width: 200 }} />
          <button className="btn btn-sm primary" disabled={busy || !newPartyId}
                  onClick={() => void run(
                    () => api.post(`/agreements/${agreementId}/parties`,
                                   { partyId: Number(newPartyId), role: newRole, note: newNote || null }),
                    "当事者を足しました").then(() => { setAdding(false); setNewPartyId(""); setNewNote(""); })}>
            足す
          </button>
          <button className="btn btn-sm" onClick={() => setAdding(false)}>やめる</button>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-sm" disabled={readOnly} onClick={() => setAdding(true)}>当事者を足す</button>
          {!compact && <span className="faint">三社間契約のもう 1 社など。主たる相手先と同じ取引先は足せません</span>}
        </div>
      )}
    </div>
  );
}

/** 当事者の短い札。一覧・図で「＋丙 ◯◯（共同当事者）」と出す。 */
export function PartyChips({ parties, onOpen }: {
  parties: AgreementParty[]; onOpen?: (kind: "party", id: number) => void;
}) {
  const extras = parties.filter((p) => !p.primary);
  if (!extras.length) return null;
  return (
    <>
      {extras.map((p) => (
        <span key={p.partyId} className="tag ghost" title={`${p.roleLabel}${p.note ? `：${p.note}` : ""}`}>
          {p.ordinal}{" "}
          {onOpen ? <button className="linky" onClick={() => onOpen("party", p.partyId)}>{p.name}</button> : p.name}
          <span className="faint">（{p.roleLabel}）</span>
        </span>
      ))}
    </>
  );
}
