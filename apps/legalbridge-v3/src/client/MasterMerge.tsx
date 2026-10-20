import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { MapAgreement, MapNode } from "../server/agreements/party-map.js";
import type { MergeMastersPreview } from "../server/agreements/master-merge.js";

/**
 * 基本契約の二重作成を 1 本に寄せる。残す側を選ぶ → 試算 → 統合 → 下の決定済み文書を訂正版で出し直す。
 */
export function MasterMerge({ a, roots, onOpen, onDone, onError, onCancel }: {
  a: MapAgreement; roots: MapNode[]; onOpen?: (kind: EntityKind, id: number) => void;
  onDone: (msg: string) => void; onError: (msg: string) => void; onCancel: () => void;
}) {
  const readOnly = useReadOnly();
  const others = roots.filter((r) => r.kind === "master" && r.id !== a.id && r.status !== "terminated");
  const [intoId, setIntoId] = useState<string>(others[0] ? String(others[0].id) : "");
  const [preview, setPreview] = useState<MergeMastersPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState<MergeMastersPreview | null>(null);
  const [results, setResults] = useState<Array<{ documentId: number; documentNo: string | null; status: string; newDocumentNo?: string | null; message?: string }> | null>(null);
  useEffect(() => {
    if (!intoId) { setPreview(null); return; }
    api.get<MergeMastersPreview>(`/agreement-map/merge-masters/preview?fromId=${a.id}&intoId=${intoId}`)
      .then(setPreview).catch((e: ApiError) => { setPreview(null); onError(e.message); });
  }, [a.id, intoId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function merge() {
    if (!preview) return;
    if (!window.confirm(`${a.agreementNo ?? `#${a.id}`} を ${preview.into.agreementNo ?? ""} に寄せます。個別契約 ${preview.moves.supplements}・条件 ${preview.moves.conditions}・文書 ${preview.moves.documents} を付け替え、${a.agreementNo ?? ""} は解除扱いにします。`)) return;
    setBusy(true);
    try {
      const r = await api.post<MergeMastersPreview>("/agreement-map/merge-masters", { fromId: a.id, intoId: Number(intoId) });
      setMerged(r);
      if (!r.reissue.length) onDone(`${r.from.agreementNo ?? ""} を ${r.into.agreementNo ?? ""} に寄せました`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reissue(ids: number[]) {
    setBusy(true);
    try {
      const r = await api.post<{ reissued: number; results: NonNullable<typeof results> }>("/agreement-map/merge-masters/reissue", { documentIds: ids });
      setResults(r.results);
      const bad = r.results.filter((x) => x.status !== "reissued");
      onDone(`訂正版を ${r.reissued} 枚出しました${bad.length ? `（${bad.length} 枚は出せませんでした）` : ""}。出し直した版は未送付なので、下の「送る」から送ってください`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (merged) {
    return (
      <div className="amap-form stack" style={{ gap: 8 }}>
        <div className="note ok">{merged.from.agreementNo ?? ""} を {merged.into.agreementNo ?? ""} に寄せました。</div>
        {merged.reissue.length > 0 && (
          <>
            <div>下の決定済み文書には基本契約の件名・締結日が本文に入っているので、訂正版で出し直します（元の決定日のまま。今の版は退きます）。</div>
            <table>
              <thead><tr><th>文書番号</th><th>件名</th><th>決定日</th><th>結果</th></tr></thead>
              <tbody>
                {merged.reissue.map((d) => {
                  const r = results?.find((x) => x.documentId === d.id);
                  return (
                    <tr key={d.id}>
                      <td className="code">{onOpen ? <button className="linky" onClick={() => onOpen("document", d.id)}>{d.documentNo}</button> : d.documentNo}</td>
                      <td>{d.title ?? ""}</td><td className="faint">{d.issuedOn ?? ""}</td>
                      <td>{r ? (r.status === "reissued" ? <span className="tag ok">訂正版 {r.newDocumentNo ?? ""}</span> : <span className="tag danger">{r.message ?? "失敗"}</span>) : <span className="faint">未</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!results && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={readOnly || busy} onClick={() => void reissue(merged.reissue.map((d) => d.id))}>
                  {merged.reissue.length} 枚を訂正版で出し直す
                </button>
                <button className="btn" onClick={onCancel}>あとで</button>
              </div>
            )}
            {results && <div className="row"><button className="btn" onClick={onCancel}>閉じる</button></div>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="amap-form stack" style={{ gap: 8 }}>
      <div className="faint">二重に作った基本契約を 1 本に寄せます。この契約の下の個別契約・条件・文書・案件を残す側へ付け替え、この契約は解除扱い（番号は残る）になります。</div>
      {!others.length && <div className="note warn">寄せる先になる基本契約がありません。</div>}
      {others.length > 0 && (
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>残す基本契約：</span>
          <select value={intoId} onChange={(e) => setIntoId(e.target.value)}>
            {others.map((r) => <option key={r.id} value={r.id}>{r.agreementNo ?? `#${r.id}`}　{r.title}{r.executedOn ? `（締結 ${r.executedOn}）` : ""}{r.primary ? "・既定" : ""}</option>)}
          </select>
        </div>
      )}
      {preview && (
        <div className="note">
          付け替えるもの：個別契約 {preview.moves.supplements}・条件 {preview.moves.conditions}・文書 {preview.moves.documents}・案件 {preview.moves.matters}
          {preview.reissue.length > 0 && <div className="faint">統合のあとに出し直す決定済み文書：{preview.reissue.map((d) => d.documentNo).join("・")}</div>}
          {preview.blockers.map((b) => <div key={b} style={{ color: "var(--out)" }}>✕ {b}</div>)}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn danger" disabled={readOnly || busy || !preview || preview.blockers.length > 0} onClick={() => void merge()}>
          {preview?.into.agreementNo ?? "残す側"} に寄せる
        </button>
        <button className="btn" onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}
