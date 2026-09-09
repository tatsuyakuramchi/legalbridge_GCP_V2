import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 案件のやり取り。担当者との Slack、メールの送受信、ファイルの受け渡し、メモ。
 *
 * 時系列（下）と、いま送る・残すための入力欄（上）。送信は外部へ出ていく
 * ので、止まった理由はそのまま見せる（黙って送らないのが一番まずい）。
 * 受信は webhook と取り込みが書くので、ここは読むだけ。
 */

export interface Communication {
  id: number; matterId: number;
  channel: "slack" | "email" | "drive" | "note";
  direction: "in" | "out" | "note";
  occurredAt: string; actor: string; counterpart: string | null;
  subject: string | null; body: string | null;
  externalRef: string | null; externalUrl: string | null;
  documentId: number | null; documentNo: string | null;
  evidence: Record<string, unknown>;
}
interface Recipients {
  owner: { name: string; email: string | null; department: string | null } | null;
  requesterEmail: string | null;
  counterparty: { name: string; email: string | null } | null;
  contacts: Array<{ name: string | null; email: string; role: string | null; department: string | null }>;
  slack: { requesterSlackId: string | null; channelId: string | null; threadTs: string | null };
}
interface Channels {
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}
interface SendResult {
  outcome: { sent: boolean; duplicated?: boolean; gate: { reasons: string[]; mode: string };
             preview?: { recipient: string; subject: string | null; bodyPreview: string } };
  communication: Communication | null;
}

const CHANNEL_LABEL = { slack: "Slack", email: "メール", drive: "Drive", note: "メモ" } as const;
type Mode = "note" | "slack" | "email" | "drive";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function MatterTimeline(
  { matterId, documents, reloadKey }: {
    matterId: number;
    /** 添えられる文書（決定済みだけ）。 */
    documents: Array<{ id: number; documentNo: string | null; status: string; templateLabel: string | null }>;
    reloadKey?: number;
  }
) {
  const [rows, setRows] = useState<Communication[]>([]);
  const [recipients, setRecipients] = useState<Recipients | null>(null);
  const [channels, setChannels] = useState<Channels["channels"]>([]);
  const [mode, setMode] = useState<Mode>("note");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  // メールの宛先。担当者だけ（to 担当者）か、取引先へ担当者を写しに（to 取引先 cc 担当者）。
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [driveTitle, setDriveTitle] = useState("");
  const [driveDirection, setDriveDirection] = useState<"in" | "out">("in");
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<{ communications: Communication[] }>(`/matters/${matterId}/communications`),
      api.get<Recipients>(`/matters/${matterId}/recipients`),
      api.get<Channels>("/integrations")
    ]).then(([c, r, i]) => { setRows(c.communications); setRecipients(r); setChannels(i.channels); })
      .catch((e: ApiError) => setError(e.message));
  }, [matterId, reloadKey]);

  async function reload() {
    const c = await api.get<{ communications: Communication[] }>(`/matters/${matterId}/communications`);
    setRows(c.communications);
  }

  const modeOf = (ch: string) => channels.find((c) => c.channel === ch)?.mode ?? "off";
  const issued = documents.filter((d) => d.status === "issued");
  const ownerEmail = recipients?.owner?.email ?? null;

  /** 宛先の型。担当者だけ／取引先へ担当者を cc に。 */
  function pickRecipients(kind: "owner" | "party") {
    if (!recipients) return;
    if (kind === "owner") {
      setTo(ownerEmail ? [ownerEmail] : []); setCc([]);
      return;
    }
    const partyEmails = recipients.contacts.map((c) => c.email);
    if (!partyEmails.length && recipients.counterparty?.email) partyEmails.push(recipients.counterparty.email);
    setTo(partyEmails); setCc(ownerEmail ? [ownerEmail] : []);
  }

  function describeOutcome(r: SendResult, what: string) {
    if (r.outcome.sent) return `${what}を送りました`;
    if (r.outcome.duplicated) return `同じ内容の${what}をすでに送っています（二度は送りません）`;
    const reasons = r.outcome.gate.reasons.join("／");
    return r.outcome.preview
      ? `検証モードのため送っていません。送るなら：${r.outcome.preview.recipient} へ「${r.outcome.preview.bodyPreview.slice(0, 60)}」`
      : `送りませんでした：${reasons}`;
  }

  async function submit() {
    setBusy(true); setError(null); setNote(null);
    try {
      if (mode === "note") {
        await api.post(`/matters/${matterId}/communications/note`, { body });
        setBody("");
      } else if (mode === "slack") {
        const r = await api.post<SendResult>(`/matters/${matterId}/communications/slack`, { body });
        setNote(describeOutcome(r, "Slack"));
        if (r.outcome.sent) setBody("");
      } else if (mode === "email") {
        const all = [...to, ...extra.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)];
        const r = await api.post<SendResult>(`/matters/${matterId}/communications/email`, {
          to: all, cc, subject, body,
          documentId: documentId ? Number(documentId) : null, attachPdf: Boolean(documentId)
        });
        setNote(describeOutcome(r, "メール"));
        if (r.outcome.sent) { setBody(""); setSubject(""); setExtra(""); setDocumentId(""); }
      } else {
        await api.post(`/matters/${matterId}/communications/drive`,
          { url: driveUrl, title: driveTitle || null, direction: driveDirection, note: body || null });
        setDriveUrl(""); setDriveTitle(""); setBody("");
        setNote("Drive のリンクを残しました");
      }
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const canSubmit = mode === "drive" ? Boolean(driveUrl.trim())
    : mode === "email" ? Boolean(body.trim() && subject.trim() && (to.length || extra.trim()))
    : Boolean(body.trim());

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>やり取りの記録</h2>
        <span className="faint">担当者との Slack、メールの送受信、ファイルの受け渡し。受信は自動で入る</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className="note ok">{note}</div>}

        <div className="tabs" style={{ marginBottom: 0 }}>
          {(["note", "slack", "email", "drive"] as Mode[]).map((m) => (
            <button key={m} aria-selected={mode === m}
                    onClick={() => { setMode(m); setNote(null); setError(null); setBody(""); }}>
              {m === "note" ? "メモ" : m === "slack" ? "Slack で送る" : m === "email" ? "メールで送る" : "Drive のリンク"}
              {(m === "slack" || m === "email") && modeOf(m === "email" ? "gmail" : "slack") !== "live" && (
                <span className="faint">（{modeOf(m === "email" ? "gmail" : "slack") === "dry_run" ? "検証" : "無効"}）</span>
              )}
            </button>
          ))}
        </div>

        {mode === "slack" && recipients && (
          <div className="faint">
            宛先：{recipients.slack.channelId
              ? <>この案件のスレッド（<span className="code">{recipients.slack.channelId}</span>）に続けます</>
              : recipients.slack.requesterSlackId
                ? <>依頼者 <span className="code">{recipients.slack.requesterSlackId}</span> へ DM。最初の1通がこの案件のスレッドになります</>
                : "この案件に Slack の宛先がありません（依頼者の Slack ID もスレッドも未登録）"}
          </div>
        )}

        {mode === "email" && recipients && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="faint">宛先の型：</span>
              <button className="chip" aria-pressed={to.length > 0 && cc.length === 0 && to[0] === ownerEmail}
                      disabled={!ownerEmail} onClick={() => pickRecipients("owner")}>
                担当者だけ{recipients.owner ? `（${recipients.owner.name}）` : "（担当者未設定）"}
              </button>
              <button className="chip" aria-pressed={cc.length > 0}
                      onClick={() => pickRecipients("party")}>
                取引先へ、担当者を cc に{recipients.counterparty ? `（${recipients.counterparty.name}）` : ""}
              </button>
              {!ownerEmail && <span className="faint">担当者のメールが無いので cc に入れられません</span>}
            </div>
            <div className="frow">
              <div className="flabel"><span>To</span></div>
              <div className="fbody">
                <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                  {to.map((a) => (
                    <span key={a} className="chip" onClick={() => setTo(to.filter((x) => x !== a))} title="外す">{a} ×</span>
                  ))}
                  <input value={extra} placeholder="追加の宛先（カンマ区切り）" style={{ flex: 1, minWidth: 200 }}
                         onChange={(e) => setExtra(e.target.value)} />
                </div>
                {recipients.contacts.length > 0 && (
                  <div className="faint" style={{ marginTop: 3 }}>
                    取引先の連絡先：{recipients.contacts.map((c) => `${c.name ?? ""} <${c.email}>`).join("、")}
                  </div>
                )}
              </div>
            </div>
            <div className="frow">
              <div className="flabel"><span>Cc</span></div>
              <div className="fbody row" style={{ flexWrap: "wrap", gap: 4 }}>
                {cc.length ? cc.map((a) => (
                  <span key={a} className="chip" onClick={() => setCc(cc.filter((x) => x !== a))} title="外す">{a} ×</span>
                )) : <span className="faint">なし</span>}
              </div>
            </div>
            <div className="frow">
              <div className="flabel"><span>件名</span></div>
              <div className="fbody"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            </div>
            <div className="frow">
              <div className="flabel"><span>添える文書</span></div>
              <div className="fbody">
                <select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                  <option value="">添えない</option>
                  {issued.map((d) => (
                    <option key={d.id} value={String(d.id)}>{d.documentNo} {d.templateLabel ?? ""}</option>
                  ))}
                </select>
                <div className="faint" style={{ marginTop: 3 }}>決定済みの文書だけ。PDF にして付けます</div>
              </div>
            </div>
          </div>
        )}

        {mode === "drive" && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="frow">
              <div className="flabel"><span>リンク</span></div>
              <div className="fbody">
                <input value={driveUrl} placeholder="https://drive.google.com/…" onChange={(e) => setDriveUrl(e.target.value)} />
              </div>
            </div>
            <div className="frow">
              <div className="flabel"><span>名前</span></div>
              <div className="fbody"><input value={driveTitle} placeholder="ファイルの呼び名（任意）" onChange={(e) => setDriveTitle(e.target.value)} /></div>
            </div>
            <div className="frow">
              <div className="flabel"><span>向き</span></div>
              <div className="fbody row">
                <button className="chip" aria-pressed={driveDirection === "in"} onClick={() => setDriveDirection("in")}>受け取った</button>
                <button className="chip" aria-pressed={driveDirection === "out"} onClick={() => setDriveDirection("out")}>渡した</button>
              </div>
            </div>
          </div>
        )}

        <textarea rows={mode === "email" ? 6 : 3} value={body}
                  placeholder={mode === "note" ? "電話・打合せ・口頭で決まったことなど"
                    : mode === "slack" ? "担当者へ送る内容"
                    : mode === "email" ? "本文" : "添える一言（任意）"}
                  onChange={(e) => setBody(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {mode === "note" ? "メモを残す" : mode === "slack" ? "Slack で送る" : mode === "email" ? "メールを送る" : "リンクを残す"}
          </button>
          {mode !== "note" && mode !== "drive" && (
            <span className="faint">送ったものはそのまま下に残ります。送れなかったときは理由が出ます</span>
          )}
        </div>

        <ol className="hist" style={{ marginTop: 6 }}>
          {rows.map((c) => (
            <li key={c.id}>
              <span className="tick"><span className="pip" /></span>
              <span className="meta">
                <span className="row" style={{ gap: 7, flexWrap: "wrap" }}>
                  <span className={`tag ${c.direction === "in" ? "in" : c.direction === "out" ? "accent" : ""}`}>
                    {CHANNEL_LABEL[c.channel]}{c.direction === "in" ? " 受信" : c.direction === "out" ? " 送信" : ""}
                  </span>
                  <span className="code faint">{when(c.occurredAt)}</span>
                  <span>{c.actor}{c.counterpart ? ` → ${c.counterpart}` : ""}</span>
                  {c.documentNo && <span className="code">{c.documentNo}</span>}
                  {c.externalUrl && <a href={c.externalUrl} target="_blank" rel="noreferrer">開く</a>}
                </span>
                {c.subject && <b>{c.subject}</b>}
                {c.body && (
                  <span style={{ whiteSpace: "pre-wrap" }}>
                    {open.has(c.id) || c.body.length <= 240 ? c.body : `${c.body.slice(0, 240)}…`}
                    {c.body.length > 240 && (
                      <button className="linky" style={{ marginLeft: 6 }}
                              onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}>
                        {open.has(c.id) ? "畳む" : "全部読む"}
                      </button>
                    )}
                  </span>
                )}
                {Array.isArray((c.evidence as any).attachments) && ((c.evidence as any).attachments as any[]).length > 0 && (
                  <span className="faint">添付：{((c.evidence as any).attachments as any[]).map((a) => a.filename).join("、")}</span>
                )}
              </span>
            </li>
          ))}
          {!rows.length && <li className="faint">まだ記録がありません</li>}
        </ol>
      </div>
    </div>
  );
}
