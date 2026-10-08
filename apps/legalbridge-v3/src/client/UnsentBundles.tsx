import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SendMany } from "./SendMany.js";
import { RecipientPicker, type Person } from "./RecipientPicker.js";

/**
 * 相手先ごとの未送付の文書（基本契約書・条件書・計算書）を 1 通・1 封筒で送る。
 *
 * 一括で決定した文書は、ここに相手先ごとに並ぶ。「メールで 1 通」は全部を添付して
 * 内容確認のメール、「CloudSign」は契約書（基本契約書・条件書）だけを 1 封筒で署名依頼。
 * 送った記録が付いた文書はこの一覧から消える。
 *
 * 社内確認：相手先を選んで、選んだ担当者へまとめて送る（相手先ごとに 1 通。相手先へは
 * 送っていない扱いで、ここに残る）。担当者の確認が済んだら、相手先へ普通に送る。
 */
type Kind = "master" | "terms" | "statement" | "other";
interface Doc { id: number; documentNo: string | null; templateKey: string | null; templateLabel: string | null; kind: Kind; issuedOn: string | null; reviewedAt?: string | null }
interface Bundle { partyId: number; partyName: string; partyKind: string | null; email: string | null; docs: Doc[]; counts: Record<Kind, number> }
type Channel = { channel: string; mode: "off" | "dry_run" | "live"; configured: boolean };
const KIND_LABEL: Record<Kind, string> = { master: "基本契約書", terms: "条件書", statement: "計算書", other: "文書" };
/** send-many が一度に受ける枚数。超える相手先は分けて送る。 */
const PER_MAIL = 20;
interface ReviewResult { partyName: string; ok: boolean; message: string }

/**
 * 選んだ相手先の文書を、選んだ担当者へ社内確認として送る。相手先ごとに 1 通（件名に相手先名）。
 * 1 通ずつ順に送るので、相手先が多くても途中で切れない。結果は相手先ごとに出す。
 */
function ReviewSend({ bundles, onDone, onClose }: { bundles: Bundle[]; onDone: () => void; onClose: () => void }) {
  const [mail, setMail] = useState<Record<string, Person[]>>({ to: [], cc: [] });
  const [subjectHead, setSubjectHead] = useState("【社内確認】");
  const [body, setBody] = useState("相手先へ送る前に、内容の確認をお願いします。問題なければご返信ください。");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<ReviewResult[]>([]);
  const total = bundles.reduce((n, b) => n + b.docs.length, 0);

  async function send() {
    if (busy || !mail.to.length) return;
    if (!window.confirm(`${bundles.length} 相手先分（${total} 枚）を、${mail.to.map((p) => p.email).join("・")} へ社内確認として送ります。よいですか？`)) return;
    setBusy(true); setResults([]);
    const out: ReviewResult[] = [];
    for (const [i, b] of bundles.entries()) {
      setProgress(`${i + 1} / ${bundles.length}　${b.partyName}`);
      for (let start = 0; start < b.docs.length; start += PER_MAIL) {
        const docs = b.docs.slice(start, start + PER_MAIL);
        const part = b.docs.length > PER_MAIL ? `（${start / PER_MAIL + 1}）` : "";
        try {
          const r = await api.post<{ outcome: { sent: boolean; duplicated?: boolean; gate?: { reasons: string[] } } }>("/documents/send-many", {
            documentIds: docs.map((d) => d.id),
            to: mail.to.map((p) => p.email), cc: mail.cc.map((p) => p.email), bcc: [],
            subject: `${subjectHead}${b.partyName} ${docs.map((d) => d.documentNo ?? `#${d.id}`).join("・")}`.trim(),
            body: `${b.partyName} 宛ての文書（${docs.length} 枚）です。\n\n${body}`,
            attachPdf: true, internal: true
          });
          out.push({ partyName: `${b.partyName}${part}`, ok: r.outcome.sent || Boolean(r.outcome.duplicated),
                     message: r.outcome.sent ? `${docs.length} 枚を送りました`
                       : r.outcome.duplicated ? "同じ内容をもう送っています"
                       : (r.outcome.gate?.reasons ?? []).join("・") || "送れませんでした" });
        } catch (e) {
          out.push({ partyName: `${b.partyName}${part}`, ok: false, message: e instanceof ApiError ? e.message : String(e) });
        }
        setResults([...out]);
      }
    }
    setProgress(null); setBusy(false);
    onDone();
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>選んだ {bundles.length} 相手先（{total} 枚）を担当者に社内確認で送る</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        <div className="faint">
          相手先ごとに 1 通（件名に相手先名と文書番号）で、PDF を添えて送ります。相手先へは送っていない扱いなので、
          この一覧に残ります（「社内確認済」と出ます）。担当者の確認が済んだら、相手先へ普通に送ってください。
        </div>
        <RecipientPicker value={mail} onChange={setMail}
          fields={[{ key: "to", label: "To", hint: "当社の担当者。1 人以上" }, { key: "cc", label: "Cc", hint: "写し（当社の人）" }]} />
        <div className="frow"><div className="flabel"><span>件名の頭</span></div>
          <div className="fbody"><input value={subjectHead} onChange={(e) => setSubjectHead(e.target.value)} />
            <small className="faint">このあとに相手先名と文書番号が付きます</small></div></div>
        <div className="frow"><div className="flabel"><span>本文</span></div>
          <div className="fbody"><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></div></div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button className="btn primary" disabled={busy || !mail.to.length || !body.trim()} onClick={() => void send()}>
            {busy ? "送っています…" : "社内確認で送る"}
          </button>
          {progress && <span className="faint">{progress}　（1 通ずつ PDF を作って送っています）</span>}
        </div>
        {results.length > 0 && (
          <div className="tablewrap"><table>
            <thead><tr><th>相手先</th><th>結果</th></tr></thead>
            <tbody>{results.map((r, i) => (
              <tr key={i}><td>{r.partyName}</td><td><span className={`tag ${r.ok ? "ok" : "warn"}`}>{r.ok ? "済" : "未"}</span> {r.message}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

export function UnsentBundles({ onOpenDocument }: { onOpenDocument?: (id: number) => void }) {
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sending, setSending] = useState<{ partyId: number; way: "mail" | "cloudsign" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 社内確認でまとめて送る相手先。 */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reviewing, setReviewing] = useState(false);

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
          <button className="btn btn-sm" disabled={!picked.size || reviewing || !!sending}
            onClick={() => { setNotice(null); setReviewing(true); }}>
            選んだ {picked.size} 相手先を担当者に社内確認で送る
          </button>
          <span className="faint">メールは全部を添付して内容確認。CloudSign は契約書（基本契約書・条件書）だけを 1 封筒で署名依頼。送った記録が付いた文書はここから消える</span>
        </div>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {reviewing && bundles && (
          <ReviewSend bundles={bundles.filter((b) => picked.has(b.partyId))}
            onDone={() => { void load(); }}
            onClose={() => { setReviewing(false); setPicked(new Set()); }} />
        )}
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
            <thead><tr>
              <th><input type="checkbox" aria-label="全部選ぶ" checked={!!bundles?.length && picked.size === bundles.length}
                onChange={(e) => setPicked(e.target.checked ? new Set((bundles ?? []).map((b) => b.partyId)) : new Set())} /></th>
              <th>相手先</th><th>メール</th><th>文書</th><th></th></tr></thead>
            <tbody>
              {(bundles ?? []).map((b) => (
                <tr key={b.partyId}>
                  <td><input type="checkbox" aria-label={`${b.partyName} を選ぶ`} checked={picked.has(b.partyId)}
                    onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(b.partyId); else n.delete(b.partyId); setPicked(n); }} /></td>
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
                        {d.reviewedAt && <span className="tag" title={`社内確認で送付 ${d.reviewedAt.slice(0, 16).replace("T", " ")}`}>　社内確認済</span>}
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
              {bundles && !bundles.length && <tr><td colSpan={5} className="faint">未送付の文書はありません</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
