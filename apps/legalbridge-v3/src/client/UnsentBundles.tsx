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
interface Doc { id: number; documentNo: string | null; templateKey: string | null; templateLabel: string | null; kind: Kind; issuedOn: string | null;
              reviewedAt?: string | null; partyCheckedAt?: string | null }
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

interface PartyMail {
  partyId: number; partyName: string;
  docs: Array<{ id: number; documentNo: string | null; kind: Kind }>;
  to: Array<{ name: string | null; email: string }>; cc: Array<{ name: string | null; email: string }>;
  subject: string; body: string; mails: number; warnings: string[];
}
interface SendPart { documentIds: number[]; documentNos: string[];
  outcome: { sent: boolean; duplicated?: boolean; gate?: { reasons: string[] } } }
interface PartyResult { partyName: string; ok: boolean; message: string }
/** まとめ送りの文面。contract_unify は内容確認なので、送っても一覧に残る（返信をもらって CloudSign へ）。 */
type MailPurpose = "delivery" | "contract_unify" | `custom:${string}`;
/** まとめて送る文面。取引先向けの決まったもの＋設定で足した取引先向けの文面（/mail-purposes）。 */
const PURPOSES: Array<{ value: MailPurpose; label: string; hint: string }> = [
  { value: "delivery", label: "送付（検収書・計算書など）", hint: "取引先へ書類を送る。検収書・利用許諾計算書は専用の文面、他は「その他の書類」" },
  { value: "contract_unify", label: "契約書の統一のご案内", hint: "契約書案を添付し、問題なければ 2 週間以内の返信をもらう（相手方確認として記録）" }
];

/**
 * 選んだ相手先へ、相手先ごとに 1 通でまとめて送る（取引先へ）。宛先・件名・本文は設定の
 * 「メールの文面」から相手先ごとに組んだものを先に見せる。1 相手先ずつ順に送り、結果を相手先ごとに出す。
 */
function PartySend({ partyIds, kinds, gmailMode, onDone, onClose }: {
  partyIds: number[]; kinds: Kind[]; gmailMode: string; onDone: () => void; onClose: () => void;
}) {
  const [mails, setMails] = useState<PartyMail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<PartyResult[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [purpose, setPurpose] = useState<MailPurpose>("delivery");
  const [purposes, setPurposes] = useState(PURPOSES);
  useEffect(() => {
    api.get<{ purposes: Array<{ value: string; label: string; hint: string; audience: string }> }>("/mail-purposes")
      .then((r) => setPurposes([...PURPOSES, ...r.purposes.filter((p) => p.value.startsWith("custom:") && p.audience === "party")
        .map((p) => ({ value: p.value as MailPurpose, label: p.label, hint: p.hint }))]))
      .catch(() => setPurposes(PURPOSES));
  }, []);

  useEffect(() => {
    let live = true;
    setMails(null); setError(null); setResults([]);
    api.post<{ mails: PartyMail[] }>("/documents/unsent-bundles/preview", { partyIds, kinds, purpose })
      .then((r) => { if (live) setMails(r.mails); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : String(e)); });
    return () => { live = false; };
  }, [partyIds.join(","), kinds.join(","), purpose]);

  const ready = (mails ?? []).filter((m) => m.to.length);
  const docCount = ready.reduce((n, m) => n + m.docs.length, 0);
  const mailCount = ready.reduce((n, m) => n + m.mails, 0);

  async function send() {
    if (busy || !ready.length) return;
    if (!window.confirm(`${ready.length} 相手先へ、${mailCount} 通（${docCount} 枚）を送ります。取引先に届きます。よいですか？`)) return;
    setBusy(true); setResults([]);
    const out: PartyResult[] = [];
    for (const [i, m] of ready.entries()) {
      setProgress(`${i + 1} / ${ready.length}　${m.partyName}`);
      try {
        const r = await api.post<{ parts: SendPart[] }>("/documents/unsent-bundles/send", { partyId: m.partyId, kinds, purpose });
        const sent = r.parts.filter((p) => p.outcome.sent).reduce((n, p) => n + p.documentIds.length, 0);
        const dup = r.parts.some((p) => p.outcome.duplicated);
        const blocked = r.parts.find((p) => !p.outcome.sent && !p.outcome.duplicated);
        out.push({
          partyName: m.partyName, ok: !blocked,
          message: blocked
            ? (blocked.outcome.gate?.reasons ?? []).join("・") || "送れませんでした"
            : `${sent} 枚を送りました${dup ? "（同じ内容をもう送っていた分は送っていません）" : ""}`
        });
      } catch (e) {
        out.push({ partyName: m.partyName, ok: false, message: e instanceof ApiError ? e.message : String(e) });
      }
      setResults([...out]);
    }
    setProgress(null); setBusy(false);
    onDone();
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>選んだ相手先へまとめて送る（取引先へ）</h2>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="faint">文面：</span>
          {purposes.map((p) => (
            <button key={p.value} className="chip" aria-pressed={purpose === p.value} title={p.hint}
                    disabled={busy} onClick={() => setPurpose(p.value)}>{p.label}</button>
          ))}
        </div>
        {purpose === "delivery" ? (
          <div className="faint">
            相手先ごとに 1 通（{KIND_LABEL_LIST(kinds)}を全部添付。20 枚を超える相手先は分けて送ります）。宛先は相手先の請求先 → 主担当 →
            連絡先の全員、Cc は設定の「いつも入れる cc」。件名・本文は運用 → 設定 →「メールの文面」から組んでいます。
            送った文書はこの一覧から消えます。
          </div>
        ) : (
          <div className="faint">
            相手先ごとに 1 通（{KIND_LABEL_LIST(kinds)}を全部添付）で、契約書案の内容確認をお願いします。宛先は相手先の主担当 →
            連絡先の全員、Cc は設定の「いつも入れる cc」。文面は運用 → 設定 →「メールの文面」の「契約書の統一（書面化）のご案内」。
            送っても「送付」にはならず、この一覧に「内容確認中」で残ります。返信をもらったら、相手先の「CloudSign」から署名依頼を送ってください。
            {kinds.some((k) => k === "statement" || k === "other") && "　※ 種類で「基本契約書」「条件書」だけに絞ると、契約書案だけを添付します。"}
          </div>
        )}
        {gmailMode !== "live" && (
          <div className="alert">いまメールは{gmailMode === "dry_run" ? "検証モード（送らずに中身だけ確かめる）" : "止めて"}あります。相手先には届きません</div>
        )}
        {error && <div className="alert">{error}</div>}
        {!mails && !error && <div className="faint">宛先と文面を組んでいます…</div>}
        {mails && (
          <div className="tablewrap"><table>
            <thead><tr><th>相手先</th><th>宛先</th><th>Cc</th><th>件名</th><th>枚数</th><th>結果・注意</th></tr></thead>
            <tbody>{mails.map((m) => {
              const r = results.find((x) => x.partyName === m.partyName);
              return (
                <tr key={m.partyId} className={m.to.length ? "" : "faint"}>
                  <td>{m.partyName}</td>
                  <td>{m.to.map((p) => <div key={p.email}>{p.name ? `${p.name} ` : ""}<span className="faint">{p.email}</span></div>)}</td>
                  <td className="faint">{m.cc.map((p) => p.email).join("、")}</td>
                  <td>
                    {m.subject}
                    <div><a href="#" onClick={(e) => { e.preventDefault(); setOpen(open === m.partyId ? null : m.partyId); }}>
                      {open === m.partyId ? "本文を閉じる" : "本文を見る"}</a></div>
                    {open === m.partyId && <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85em" }}>{m.body}</pre>}
                  </td>
                  <td className="num">{m.docs.length}{m.mails > 1 ? `（${m.mails} 通）` : ""}</td>
                  <td>
                    {r && <div><span className={`tag ${r.ok ? "ok" : "warn"}`}>{r.ok ? "済" : "未"}</span> {r.message}</div>}
                    {m.warnings.map((w) => <div key={w} className="faint" style={{ fontSize: "0.85em" }}>{w}</div>)}
                  </td>
                </tr>
              );
            })}
            {!mails.length && <tr><td colSpan={6} className="faint">選んだ相手先に、この種類の未送付の文書がありません</td></tr>}
            </tbody>
          </table></div>
        )}
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button className="btn primary" disabled={busy || !ready.length} onClick={() => void send()}>
            {busy ? "送っています…" : `${ready.length} 相手先へ送る（${mailCount} 通・${docCount} 枚）`}
          </button>
          {progress && <span className="faint">{progress}　（1 通ずつ PDF を作って送っています）</span>}
          {mails && mails.length > ready.length && <span className="faint">宛先の無い {mails.length - ready.length} 相手先は送りません</span>}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL_LIST = (kinds: Kind[]) => kinds.map((k) => KIND_LABEL[k]).join("・");
const ALL_KINDS: Kind[] = ["master", "terms", "statement", "other"];

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
  /** 取引先へまとめて送る。 */
  const [partySending, setPartySending] = useState(false);
  /** 出す文書の種類。まとめ送り・1 通の送り・社内確認はこの種類だけを載せる。 */
  const [kinds, setKinds] = useState<Kind[]>(ALL_KINDS);

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

  // 種類で絞った一覧。絞った種類の文書が無い相手先は出さない。
  const shown: Bundle[] | null = bundles
    ? bundles.map((b) => ({ ...b, docs: b.docs.filter((d) => kinds.includes(d.kind)) })).filter((b) => b.docs.length)
    : null;
  const pickedShown = (shown ?? []).filter((b) => picked.has(b.partyId));
  const gmailMode = channels.find((c) => c.channel === "gmail")?.mode ?? "off";
  const current = sending ? shown?.find((b) => b.partyId === sending.partyId) ?? null : null;
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
          <span className="faint">種類</span>
          {ALL_KINDS.map((k) => (
            <button key={k} className="chip" aria-pressed={kinds.includes(k)} disabled={reviewing || partySending || !!sending}
              onClick={() => setKinds((prev) => prev.includes(k) ? (prev.length > 1 ? prev.filter((x) => x !== k) : prev) : [...prev, k])}>
              {KIND_LABEL[k]}
            </button>
          ))}
          <button className="btn btn-sm" disabled={!pickedShown.length || reviewing || partySending || !!sending}
            onClick={() => { setNotice(null); setPartySending(true); }}>
            選んだ {pickedShown.length} 相手先へまとめて送る（取引先へ）
          </button>
          <button className="btn btn-sm" disabled={!pickedShown.length || reviewing || partySending || !!sending}
            onClick={() => { setNotice(null); setReviewing(true); }}>
            選んだ {pickedShown.length} 相手先を担当者に社内確認で送る
          </button>
          <span className="faint">メールは全部を添付して内容確認。CloudSign は契約書（基本契約書・条件書）だけを 1 封筒で署名依頼。送った記録が付いた文書はここから消える</span>
        </div>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {partySending && (
          <PartySend partyIds={pickedShown.map((b) => b.partyId)} kinds={kinds} gmailMode={gmailMode}
            onDone={() => { void load(); }}
            onClose={() => { setPartySending(false); setPicked(new Set()); }} />
        )}
        {reviewing && shown && (
          <ReviewSend bundles={pickedShown}
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
              <th><input type="checkbox" aria-label="全部選ぶ" checked={!!shown?.length && pickedShown.length === shown.length}
                onChange={(e) => setPicked(e.target.checked ? new Set((shown ?? []).map((b) => b.partyId)) : new Set())} /></th>
              <th>相手先</th><th>メール</th><th>文書</th><th></th></tr></thead>
            <tbody>
              {(shown ?? []).map((b) => (
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
                        {d.partyCheckedAt && <span className="tag" title={`取引先へ内容確認で送付 ${d.partyCheckedAt.slice(0, 16).replace("T", " ")}。返信をもらったら CloudSign へ`}>　内容確認中</span>}
                      </div>
                    ))}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm" disabled={!!sending} onClick={() => { setNotice(null); setSending({ partyId: b.partyId, way: "mail" }); }}>
                      メールで 1 通に（{b.docs.length} 枚）
                    </button>
                    {b.docs.filter((d) => d.kind === "master" || d.kind === "terms").length > 0 && (
                      <button className="btn btn-sm" disabled={!!sending || !isAdmin} style={{ marginLeft: 6 }}
                        title={isAdmin ? "" : "CloudSign は admin だけ"}
                        onClick={() => { setNotice(null); setSending({ partyId: b.partyId, way: "cloudsign" }); }}>
                        CloudSign（契約書 {b.docs.filter((d) => d.kind === "master" || d.kind === "terms").length} 枚）
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown && !shown.length && <tr><td colSpan={5} className="faint">{bundles?.length ? "この種類の未送付の文書はありません" : "未送付の文書はありません"}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
