import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { Succession } from "../server/parties/multi-party.js";

const STATE_LABEL: Record<Succession["state"], string> = { pending: "予定", applied: "適用済み", reverted: "戻した" };

/**
 * 契約の地位承継（docs/v3-tidy.md 型 3 の 3 社契約）。
 *
 * 売買で契約上の地位が移るとき、元の契約の相手方を発効日で 旧 → 新 に切り替える。
 * 発効日が来ると（日次か、その場で）契約・個別契約・条件の相手方が新しい取引先になる。
 * 発効日前の実績・支払文書・支払は旧の取引先宛てのまま残る。戻せる。
 */
export function Successions({ agreementId, counterpartyName, onOpen, onChanged }: {
  agreementId: number; counterpartyName: string; onOpen?: (kind: EntityKind, id: number) => void; onChanged?: () => void;
}) {
  const readOnly = useReadOnly();
  const [rows, setRows] = useState<Succession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toId, setToId] = useState("");
  const [toName, setToName] = useState<string | null>(null);
  const [on, setOn] = useState("");
  const [documentNo, setDocumentNo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.get<{ successions: Succession[] }>(`/agreements/${agreementId}/successions`)
      .then((r) => setRows(r.successions)).catch((e: ApiError) => setError(e.message));
  }, [agreementId, version]);

  async function run(job: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await job(); setVersion((v) => v + 1); onChanged?.(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function create() {
    await run(async () => {
      let documentId: number | null = null;
      if (documentNo.trim()) {
        const r = await api.get<{ documents: Array<{ id: number; documentNo: string | null }> }>(`/documents?q=${encodeURIComponent(documentNo.trim())}&limit=5`);
        documentId = r.documents.find((d) => d.documentNo === documentNo.trim())?.id ?? r.documents[0]?.id ?? null;
        if (!documentId) throw new Error(`文書 ${documentNo.trim()} が見つかりません`);
      }
      await api.post(`/agreements/${agreementId}/successions`, { toPartyId: Number(toId), effectiveOn: on, documentId, note: note.trim() || null });
      setAdding(false); setToId(""); setToName(null); setOn(""); setDocumentNo(""); setNote("");
    });
  }

  const open = (rows ?? []).some((r) => r.state === "pending");
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>地位承継 {rows?.length ? rows.length : ""}</h2>
        <span className="faint">相手方を発効日で切り替える（3 社契約）。発効日前の実績・支払はそのまま</span>
        {!readOnly && !adding && !open && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)} disabled={busy || !rows}>承継を登録する</button>
        )}
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {rows && !rows.length && !adding && <div className="faint">承継はありません。相手方は {counterpartyName} のままです。</div>}
        {rows && rows.length > 0 && (
          <table>
            <thead><tr><th>状態</th><th>誰から</th><th>誰へ</th><th>発効日</th><th>根拠</th><th>備考</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className={`tag ${r.state === "applied" ? "ok" : r.state === "pending" ? "warn" : "ghost"}`}>{STATE_LABEL[r.state]}</span></td>
                  <td>{onOpen ? <button className="linky" onClick={() => onOpen("party", r.from.id)}>{r.from.name}</button> : r.from.name}</td>
                  <td>{onOpen ? <button className="linky" onClick={() => onOpen("party", r.to.id)}>{r.to.name}</button> : r.to.name}</td>
                  <td>{r.effectiveOn}</td>
                  <td>{r.documentId && onOpen
                    ? <button className="linky code" onClick={() => onOpen("document", r.documentId!)}>{r.documentNo ?? `#${r.documentId}`}</button>
                    : <span className="faint">{r.documentNo ?? "—"}</span>}</td>
                  <td className="faint">{r.note ?? ""}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {!readOnly && r.state === "pending" && (
                      <>
                        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/successions/${r.id}/apply`).then(() => undefined))}>いま適用する</button>{" "}
                        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.del(`/successions/${r.id}`).then(() => undefined))}>消す</button>
                      </>
                    )}
                    {!readOnly && r.state === "applied" && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/successions/${r.id}/revert`).then(() => undefined))}>戻す</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {adding && (
          <div className="stack">
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ minWidth: 260 }}>
                <span>新しい相手方（譲受人）</span>
                <SearchSelect value={toId} search={searchParties} placeholder="名称・コード・カナ" valueLabel={toName}
                  onChange={(v, o) => { setToId(v); setToName(o?.label ?? null); }} autoFocus />
              </label>
              <label className="field">
                <span>発効日</span>
                <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
              </label>
              <label className="field">
                <span>根拠の文書番号</span>
                <input value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} placeholder="承継合意書の番号（任意）" />
              </label>
              <label className="field" style={{ minWidth: 220 }}>
                <span>備考</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="事業譲渡に伴う など" />
              </label>
            </div>
            <div className="faint">
              {counterpartyName} → {toName ?? "（譲受人）"}。発効日が今日以前なら、その場で契約・個別契約・条件の相手方を切り替えます。先なら日次で切り替わります。
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={create} disabled={busy || !toId || !on}>登録する</button>
              <button className="btn" onClick={() => setAdding(false)} disabled={busy}>やめる</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
