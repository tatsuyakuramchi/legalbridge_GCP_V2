import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SendMany } from "./SendMany.js";

/**
 * 相手先ごとの未送付の文書（基本契約書・条件書・計算書）を 1 通・1 封筒で送る。
 *
 * 一括で決定した文書は、ここに相手先ごとに並ぶ。「メールで 1 通」は全部を添付して
 * 内容確認のメール、「CloudSign」は契約書（基本契約書・条件書）だけを 1 封筒で署名依頼。
 * 送った記録が付いた文書はこの一覧から消える。
 */
type Kind = "master" | "terms" | "statement" | "other";
interface Doc { id: number; documentNo: string | null; templateKey: string | null; templateLabel: string | null; kind: Kind; issuedOn: string | null }
interface Bundle { partyId: number; partyName: string; partyKind: string | null; email: string | null; docs: Doc[]; counts: Record<Kind, number> }
type Channel = { channel: string; mode: "off" | "dry_run" | "live"; configured: boolean };
const KIND_LABEL: Record<Kind, string> = { master: "基本契約書", terms: "条件書", statement: "計算書", other: "文書" };

export function UnsentBundles({ onOpenDocument }: { onOpenDocument?: (id: number) => void }) {
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sending, setSending] = useState<{ partyId: number; way: "mail" | "cloudsign" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setError(null);
    try { setBundles((await api.get<{ bundles: Bundle[] }>("/documents/unsent-bundles")).bundles); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    void load();
    api.get<{ channels?: Channel[] }>("/integrations").then((r) => setChannels(r.channels ?? [])).catch(() => undefined);
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => undefined);
  }, []);

  const current = sending ? bundles?.find((b) => b.partyId === sending.partyId) ?? null : null;
  const sendDocs = current
    ? (sending!.way === "cloudsign" ? current.docs.filter((d) => d.kind === "master" || d.kind === "terms") : current.docs)
    : [];

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>未送付の文書（相手先ごと）</h2>
        <span className="faint">決定済みで、まだ送っていない基本契約書・条件書・計算書。相手先ごとに 1 通・1 封筒で送る</span>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button className="btn btn-sm ghost" disabled={busy} onClick={() => void load()}>読み直す</button>
          <span className="faint">メールは全部を添付して内容確認。CloudSign は契約書（基本契約書・条件書）だけを 1 封筒で署名依頼。送った記録が付いた文書はここから消える</span>
        </div>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {current && sending && (
          <SendMany key={`${sending.partyId}:${sending.way}`}
            title={`${current.partyName} へ ${sendDocs.length} 枚を ${sending.way === "mail" ? "1 通で" : "1 封筒で"}送る`}
            documents={sendDocs.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: current.partyName }))}
            channels={channels} isAdmin={isAdmin} initialWay={sending.way}
            prefillMail={sending.way === "mail"} prefillSigners={sending.way === "cloudsign"}
            onDone={() => { setNotice(`${current.partyName}：送りました`); setSending(null); void load(); }}
            onClose={() => setSending(null)} />
        )}
        <div className="tablewrap">
          <table>
            <thead><tr><th>相手先</th><th>メール</th><th>文書</th><th></th></tr></thead>
            <tbody>
              {(bundles ?? []).map((b) => (
                <tr key={b.partyId}>
                  <td>{b.partyName}<div className="faint" style={{ fontSize: "0.85em" }}>{b.partyKind === "individual" ? "個人" : b.partyKind === "corporate" ? "法人" : ""}</div></td>
                  <td>{b.email ? <span className="faint">{b.email}</span> : <span className="tag warn">未登録</span>}</td>
                  <td>
                    {b.docs.map((d) => (
                      <div key={d.id}>
                        <span className="faint">{KIND_LABEL[d.kind]}</span>　
                        {onOpenDocument
                          ? <a href="#" onClick={(e) => { e.preventDefault(); onOpenDocument(d.id); }}>{d.documentNo ?? `#${d.id}`}</a>
                          : (d.documentNo ?? `#${d.id}`)}
                        {d.issuedOn && <span className="faint">　{d.issuedOn}</span>}
                      </div>
                    ))}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm" disabled={!!sending} onClick={() => { setNotice(null); setSending({ partyId: b.partyId, way: "mail" }); }}>
                      メールで 1 通に（{b.docs.length} 枚）
                    </button>
                    {(b.counts.master + b.counts.terms) > 0 && (
                      <button className="btn btn-sm" disabled={!!sending || !isAdmin} style={{ marginLeft: 6 }}
                        title={isAdmin ? "" : "CloudSign は admin だけ"}
                        onClick={() => { setNotice(null); setSending({ partyId: b.partyId, way: "cloudsign" }); }}>
                        CloudSign（契約書 {b.counts.master + b.counts.terms} 枚）
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {bundles && !bundles.length && <tr><td colSpan={4} className="faint">未送付の文書はありません</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
