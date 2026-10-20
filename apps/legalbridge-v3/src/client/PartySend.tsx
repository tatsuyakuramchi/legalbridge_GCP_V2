import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SendMany } from "./SendMany.js";
import type { EntityKind } from "./Relations.js";
import type { DocumentSummary } from "../server/documents/repository.js";
import type { MapNode, PartyMap } from "../server/agreements/party-map.js";

/**
 * 取引先⇔基本契約 の図の下で、契約の構造を見ながら送る。
 * 決定済みの文書を 基本契約 → その下の個別契約・発注書 の順に並べ、送ったか（決定済み／送信済み）を出す。
 * チェックして「1 通で送る」を押すと、文書の一覧と同じ送る画面（SendMany）がここに開く。
 */
export function PartySend({ map, version, onOpen }: { map: PartyMap; version: number; onOpen?: (kind: EntityKind, id: number) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [channels, setChannels] = useState<Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>>([]);
  const [isAdmin, setIsAdmin] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api.get<{ documents: DocumentSummary[] }>(`/documents?partyId=${map.party.id}&status=issued`)
      .then((r) => setDocs(r.documents.filter((d) => d.status === "issued" && !d.inbound)))
      .catch((e: ApiError) => setError(e.message));
  }, [map.party.id, version, reload]);
  useEffect(() => {
    api.get<{ channels: typeof channels }>("/integrations").then((r) => setChannels(r.channels)).catch(() => setChannels([]));
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin" || r.user === undefined)).catch(() => undefined);
  }, []);

  // 契約ごとに束ねる。個別契約（supplement）は親の基本契約の下に。契約に付いていない文書は「契約なし」。
  const byAgreement = new Map<number | null, DocumentSummary[]>();
  for (const d of docs) byAgreement.set(d.agreementId, [...(byAgreement.get(d.agreementId) ?? []), d]);
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = docs.filter((d) => picked.has(d.id));
  const row = (d: DocumentSummary) => (
    <div key={d.id} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0" }}>
      <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
      {onOpen ? <button className="linky code" onClick={() => onOpen("document", d.id)}>{d.documentNo ?? `#${d.id}`}</button> : <span className="code">{d.documentNo}</span>}
      <span>{d.templateLabel ?? ""}</span>
      <span className="faint">{d.title ?? ""}</span>
      <span className={`tag ${d.phase === "sent" ? "ok" : "warn"}`}>{d.phase === "sent" ? `送信済み${d.sentAt ? ` ${d.sentAt.slice(0, 10)}` : ""}` : "決定済み・未送付"}</span>
    </div>
  );
  const group = (a: { id: number; agreementNo: string | null; title: string; kind: string }, depth: number) => {
    const list = byAgreement.get(a.id) ?? [];
    if (!list.length) return null;
    return (
      <div key={a.id} style={{ marginLeft: depth * 18 }}>
        <div className="faint" style={{ marginTop: 6 }}><span className="code">{a.agreementNo ?? `#${a.id}`}</span>　{a.title}</div>
        {list.map(row)}
      </div>
    );
  };
  const seen = new Set<number>();
  const rootBlocks = map.roots.map((r: MapNode) => {
    seen.add(r.id); r.children.forEach((c) => seen.add(c.id));
    const own = group(r, 0);
    const kids = r.children.map((c) => group(c, 1)).filter(Boolean);
    if (!own && !kids.length) return null;
    return <div key={r.id}>{own ?? <div className="faint" style={{ marginTop: 6 }}><span className="code">{r.agreementNo ?? `#${r.id}`}</span>　{r.title}</div>}{kids}</div>;
  }).filter(Boolean);
  const others = docs.filter((d) => d.agreementId === null || !seen.has(d.agreementId));

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>送る</h2>
        <span className="faint">決定済みの文書を契約ごとに。チェックして 1 通で送る（同じ取引先なので何枚でも）</span>
        {chosen.length > 0 && !sending && (
          <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} onClick={() => setSending(true)}>選んだ {chosen.length} 件を 1 通で送る</button>
        )}
      </div>
      <div className="panel-bd stack" style={{ gap: 6 }}>
        {error && <div className="alert">{error}</div>}
        {!docs.length && <div className="faint">決定済みの文書はありません。</div>}
        {rootBlocks}
        {others.length > 0 && (
          <div>
            <div className="faint" style={{ marginTop: 6 }}>契約に付いていない文書（発注書・計算書など）</div>
            {others.map(row)}
          </div>
        )}
        {sending && chosen.length > 0 && (
          <SendMany title={`${map.party.name} へ ${chosen.length} 件を 1 通で送る`}
            documents={chosen.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: d.counterparty }))}
            channels={channels} isAdmin={isAdmin} prefillSigners
            onDone={() => { setSending(false); setPicked(new Set()); setReload((v) => v + 1); }}
            onClose={() => setSending(false)} />
        )}
      </div>
    </div>
  );
}
