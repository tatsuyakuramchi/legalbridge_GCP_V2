import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { DocPeek } from "./DocPeek.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { useReadOnly } from "./read-only.js";
import { SendMany } from "./SendMany.js";
import type { EntityKind } from "./Relations.js";
import type { DocumentSummary } from "../server/documents/repository.js";
import type { MapAgreement, PartyMap } from "../server/agreements/party-map.js";

const KIND_LABEL: Record<string, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約", termination: "解除合意", document: "文書だけ"
};
const isOrderDoc = (d: DocumentSummary) => d.templateKey === "purchase_order" || d.templateKey === "intl_purchase_order";

/**
 * 文書を探して、契約に登録して、送る。
 *
 * 文書番号だけで浮いている紙（取り込んだ契約書・覚書など）を番号・件名で探し、検索結果の
 * 「基本契約」「個別契約」「単体契約」を押すとその文書から契約を立てる（番号・件名は文書のまま）。
 * 個別契約は、この取引先の基本契約の下に入れる（選べる）。
 * 登録した文書はチェックして、メールか CloudSign で送る（送る画面は文書の一覧と同じ SendMany）。
 */
export function DocumentRegister(
  { map, version, onOpen, onChanged, onError, onAsOrder }: {
    map: PartyMap; version: number; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
    /** 発注書は契約に立てず、条件に紐づける（検索して紐づける の欄を開く）。 */
    onAsOrder: (documentId: number) => void;
  }
) {
  const readOnly = useReadOnly();
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [allParties, setAllParties] = useState(false);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [parentOf, setParentOf] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState<"mail" | "cloudsign" | null>(null);
  const [channels, setChannels] = useState<Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>>([]);
  const [isAdmin, setIsAdmin] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (search.trim()) qs.set("q", search.trim());
    // 名前で探すときは全取引先からも探せる（別の取引先で取り込んだ紙が見つかる）。
    if (!allParties || !search.trim()) qs.set("partyId", String(map.party.id));
    let live = true;
    api.get<{ documents: DocumentSummary[] }>(`/documents?${qs}`)
      .then((r) => { if (live) setDocs(r.documents.filter((d) => d.status !== "void" && d.status !== "superseded" && !d.inbound)); })
      .catch((e: ApiError) => { if (live) { setDocs([]); onError(e.message); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, allParties, map.party.id, version, reload]);
  useEffect(() => {
    api.get<{ channels: typeof channels }>("/integrations").then((r) => setChannels(r.channels)).catch(() => setChannels([]));
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin" || r.user === undefined)).catch(() => undefined);
  }, []);

  const agreements: MapAgreement[] = [...map.roots.flatMap((r) => [r as MapAgreement, ...r.children]), ...map.loose, ...map.documents];
  const masters = map.roots.filter((r) => r.kind === "master" && !r.terminatedOn);
  const sameParty = (d: DocumentSummary) => !d.counterparty || d.counterparty === map.party.name;

  async function register(d: DocumentSummary, as: "master" | "supplement" | "standalone") {
    const parentId = as === "supplement" && sameParty(d) ? Number(parentOf[d.id] ?? masters[0]?.id ?? 0) || null : null;
    setBusy(d.id);
    try {
      const r = await api.post<{ agreementNo: string; kind: string; parentNo: string | null; conditionsLinked: number }>(
        `/agreement-map/documents/${d.id}/agreement`, { as, parentId });
      const what = r.kind === "master" ? "基本契約" : r.kind === "supplement" ? `${r.parentNo ?? "基本契約"} の下の個別契約` : "単体契約";
      setPicked((p) => new Set(p).add(d.id));
      setReload((v) => v + 1);
      onChanged(`${d.documentNo ?? `#${d.id}`} を${what}として登録しました（番号 ${r.agreementNo}${r.conditionsLinked ? `・条件明細 ${r.conditionsLinked} 本を載せました` : ""}）。`
        + "締結日は図の「編集」で入れてください。送るときは下の「メールで送る」「クラウドサインで送る」から");
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(null); }
  }

  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = docs ?? [];
  const chosen = list.filter((d) => picked.has(d.id) && d.status === "issued");
  const chosenParties = [...new Set(chosen.map((d) => d.counterparty ?? ""))];
  const cloudsignOff = (channels.find((c) => c.channel === "cloudsign")?.mode ?? "off") === "off";

  return (
    <div className="panel">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
        <h2>文書を探して契約に登録・送る</h2>
        <span className="faint">番号・件名で探し、「基本契約」「個別契約」「単体契約」を押すとその文書から契約を立てます（番号・件名は文書のまま）。登録した文書はチェックしてメール・クラウドサインで送れます</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <ListSearch value={keyword} onChange={setKeyword} placeholder="文書番号・件名で探す（例：ARC-SVC-2026-0001）" label="文書を探す" />
          </div>
          <label className="faint" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={allParties} onChange={(e) => setAllParties(e.target.checked)} />
            全取引先から探す
          </label>
        </div>
        <div className="tablewrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead><tr><th></th><th>文書番号</th><th>種別・件名</th><th>日付</th><th>契約</th><th>契約として登録</th></tr></thead>
            <tbody>
              {list.map((d) => {
                const a = d.agreementId ? agreements.find((x) => x.id === d.agreementId) : undefined;
                const decided = d.status === "issued";
                return (
                  <tr key={d.id}>
                    <td>
                      <input type="checkbox" aria-label={`${d.documentNo ?? d.id} を送るものに選ぶ`} disabled={!decided}
                             title={decided ? "送るものに選ぶ" : "下書きは送れません（決定してから）"}
                             checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                    </td>
                    <td className="code" style={{ whiteSpace: "nowrap" }}>
                      {onOpen ? <button className="linky" onClick={() => onOpen("document", d.id)}>{d.documentNo ?? `#${d.id}`}</button> : d.documentNo ?? `#${d.id}`}
                      {" "}<DocPeek id={d.id} imported={d.imported} storageUrl={d.storageUrl} />
                    </td>
                    <td>
                      {d.imported && <span className="tag ghost" style={{ marginRight: 4 }}>取込</span>}
                      {d.templateLabel ?? "文書"}{d.title ? `（${d.title}）` : ""}
                      {!sameParty(d) && <span className="tag warn" style={{ marginLeft: 6 }}>相手先：{d.counterparty}</span>}
                      {d.phase === "sent" && <span className="tag ok" style={{ marginLeft: 6 }}>送信済み</span>}
                    </td>
                    <td className="faint" style={{ whiteSpace: "nowrap" }}>{d.issuedAt?.slice(0, 10) ?? "—"}</td>
                    <td>
                      {d.agreementId
                        ? (
                          <button className="linky" onClick={() => onOpen?.("agreement", d.agreementId!)}>
                            登録済み：{a ? `${a.agreementNo ?? `#${a.id}`}（${KIND_LABEL[a.kind] ?? a.kind}）` : `#${d.agreementId}`}
                          </button>
                        )
                        : <span className="tag warn">未登録</span>}
                    </td>
                    <td>
                      {d.agreementId ? null
                        : !decided ? <span className="faint">下書き（決定してから）</span>
                        : isOrderDoc(d)
                          ? <button className="btn btn-sm" disabled={readOnly} onClick={() => onAsOrder(d.id)}
                                    title="発注書は契約に立てず、条件明細に紐づけます">発注書として紐づける</button>
                          : (
                            <div className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                              <button className="btn btn-sm primary" disabled={readOnly || busy === d.id}
                                      title="この文書を基本契約にします。以後の発注書・個別契約はこの下に入ります"
                                      onClick={() => void register(d, "master")}>基本契約</button>
                              <button className="btn btn-sm" disabled={readOnly || busy === d.id || (sameParty(d) && !masters.length)}
                                      title={sameParty(d) && !masters.length ? "この取引先に基本契約がありません。先に基本契約を登録してください" : "基本契約の下の個別契約にします。載っている条件明細は基本契約に載ります"}
                                      onClick={() => void register(d, "supplement")}>個別契約</button>
                              {sameParty(d) && masters.length > 1 && (
                                <select value={parentOf[d.id] ?? String(masters[0].id)} disabled={readOnly} style={{ maxWidth: 220 }}
                                        aria-label="個別契約の親の基本契約"
                                        onChange={(e) => setParentOf((p) => ({ ...p, [d.id]: e.target.value }))}>
                                  {masters.map((m) => <option key={m.id} value={m.id}>{m.agreementNo ?? `#${m.id}`} {m.title}</option>)}
                                </select>
                              )}
                              <button className="btn btn-sm" disabled={readOnly || busy === d.id}
                                      title="その取引だけで完結する契約にします。載っている条件明細を直接持ちます"
                                      onClick={() => void register(d, "standalone")}>単体契約</button>
                            </div>
                          )}
                    </td>
                  </tr>
                );
              })}
              {docs !== null && !list.length && (
                <tr><td colSpan={6} className="faint">{search.trim() ? "当たる文書がありません" : "この取引先の文書はありません。番号で探すか、全取引先から探してください"}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span>選んだ {chosen.length} 件を</span>
          <button className="btn btn-sm primary" disabled={!chosen.length || chosenParties.length > 1} onClick={() => setSending("mail")}>メールで送る</button>
          <button className="btn btn-sm primary" disabled={!chosen.length || chosenParties.length > 1 || !isAdmin}
                  title={!isAdmin ? "クラウドサインで送れるのは管理者だけです" : cloudsignOff ? "クラウドサインの連携が止まっています（設定で確認）" : "クラウドサインで署名を依頼します"}
                  onClick={() => setSending("cloudsign")}>クラウドサインで送る</button>
          {chosenParties.length > 1 && <span className="tag warn">相手先の違う文書は 1 通にできません。相手先ごとに送ってください</span>}
        </div>
        {sending && chosen.length > 0 && chosenParties.length === 1 && (
          <SendMany key={sending} title={`${chosen[0].counterparty ?? map.party.name} へ ${chosen.length} 件を${sending === "cloudsign" ? "クラウドサインで" : "メールで"}送る`}
            documents={chosen.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: d.counterparty, imported: d.imported, storageUrl: d.storageUrl }))}
            channels={channels} isAdmin={isAdmin} initialWay={sending} prefillSigners={sending === "cloudsign"} prefillMail={sending === "mail"}
            onDone={() => { setSending(null); setPicked(new Set()); setReload((v) => v + 1); }}
            onClose={() => setSending(null)} />
        )}
      </div>
    </div>
  );
}
