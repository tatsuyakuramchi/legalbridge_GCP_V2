import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { RecipientPicker, type Person } from "./RecipientPicker.js";

/**
 * 案件のやり取り。担当者との Slack、メールの送受信、ファイルの受け渡し、メモ。
 *
 * 時系列（下）と、いま送る・残すための入力欄（上）。送信は外部へ出ていく
 * ので、止まった理由はそのまま見せる（黙って送らないのが一番まずい）。
 * 受信は webhook と取り込みが書くので、ここは読むだけ。
 */

export interface Communication {
  id: number; matterId: number;
  channel: "slack" | "email" | "cloudsign" | "drive" | "note";
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
  slack: { requesterSlackId: string | null; channelId: string | null; threadTs: string | null;
           /** 宛先が無いとき、依頼者のメールから引いた社員の Slack ID。 */
           fromRequesterEmail?: { slackId: string; name: string } | null;
           /** 法務相談窓口。channelId が null なら未設定。threadTs があればこの案件のスレッドがある。 */
           consult?: { channelId: string | null; label: string | null; threadTs: string | null } };
}
interface Channels {
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}
interface SendResult {
  outcome: { sent: boolean; duplicated?: boolean; gate: { reasons: string[]; mode: string };
             preview?: { recipient: string; subject: string | null; bodyPreview: string } };
  communication: Communication | null;
}

const CHANNEL_LABEL = { slack: "Slack", email: "メール", cloudsign: "CloudSign", drive: "Drive", note: "メモ" } as const;
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
  // 型で入れたあと、取引先の連絡先・自社の人を探して To / Cc に足せる。
  const [mailTo, setMailTo] = useState<Record<string, Person[]>>({ to: [], cc: [] });
  const to = (mailTo.to ?? []).map((p) => p.email);
  const cc = (mailTo.cc ?? []).map((p) => p.email);
  const people = (emails: string[]): Person[] => emails.map((email) => ({
    email, name: recipients?.contacts.find((c) => c.email === email)?.name
      ?? (email === ownerEmail ? recipients?.owner?.name ?? null : null)
  }));
  const setTo = (emails: string[]) => setMailTo((m) => ({ ...m, to: people(emails) }));
  const setCc = (emails: string[]) => setMailTo((m) => ({ ...m, cc: people(emails) }));
  const [documentId, setDocumentId] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [driveTitle, setDriveTitle] = useState("");
  const [driveDirection, setDriveDirection] = useState<"in" | "out">("in");
  const [open, setOpen] = useState<Set<number>>(new Set());
  /** Slack の宛先を変えたら読み直す。 */
  const [recipientsVersion, setRecipientsVersion] = useState(0);
  const [slackEditing, setSlackEditing] = useState(false);
  /** Slack の送り先。依頼者（DM・スレッド）か、法務相談窓口のチャンネルか。 */
  const [slackTarget, setSlackTarget] = useState<"direct" | "consult">("direct");
  /** 本文の頭に付けるメンション。 */
  const [mentions, setMentions] = useState<SlackPerson[]>([]);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<{ communications: Communication[] }>(`/matters/${matterId}/communications`),
      api.get<Recipients>(`/matters/${matterId}/recipients`),
      api.get<Channels>("/integrations")
    ]).then(([c, r, i]) => { setRows(c.communications); setRecipients(r); setChannels(i.channels); })
      .catch((e: ApiError) => setError(e.message));
  }, [matterId, reloadKey, recipientsVersion]);

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
        const r = await api.post<SendResult>(`/matters/${matterId}/communications/slack`, {
          body, target: slackTarget, mentions: mentions.map((m) => m.slackId)
        });
        setNote(describeOutcome(r, slackTarget === "consult" ? "法務相談窓口への Slack" : "Slack"));
        if (r.outcome.sent) {
          setBody(""); setMentions([]);
          // 窓口のスレッドを立てたら、宛先の表示（スレッドに続けます）を読み直す。
          if (slackTarget === "consult") setRecipientsVersion((v) => v + 1);
        }
      } else if (mode === "email") {
        const r = await api.post<SendResult>(`/matters/${matterId}/communications/email`, {
          to, cc, subject, body,
          documentId: documentId ? Number(documentId) : null, attachPdf: Boolean(documentId)
        });
        setNote(describeOutcome(r, "メール"));
        if (r.outcome.sent) { setBody(""); setSubject(""); setDocumentId(""); }
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
    : mode === "slack" && slackTarget === "consult" ? Boolean(body.trim() && recipients?.slack.consult?.channelId)
    : mode === "email" ? Boolean(body.trim() && subject.trim() && to.length > 0)
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
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="faint">送り先：</span>
            <button className="chip" aria-pressed={slackTarget === "direct"} onClick={() => setSlackTarget("direct")}>
              依頼者・担当者へ
            </button>
            <button className="chip" aria-pressed={slackTarget === "consult"} onClick={() => setSlackTarget("consult")}>
              法務相談窓口へ{recipients.slack.consult?.label ? `（${recipients.slack.consult.label}）` : ""}
            </button>
          </div>
        )}

        {mode === "slack" && recipients && slackTarget === "consult" && (
          <div className="faint">
            {!recipients.slack.consult?.channelId
              ? <span className="tag warn">法務相談窓口のチャンネルが未設定です。運用 → 設定 の「法務相談窓口（Slack）」でチャンネル ID を入れてください</span>
              : recipients.slack.consult.threadTs
                ? <>この案件の窓口スレッド（<span className="code">{recipients.slack.consult.label ?? recipients.slack.consult.channelId}</span>）に続けます</>
                : <>
                    <span className="code">{recipients.slack.consult.label ?? recipients.slack.consult.channelId}</span> に
                    この案件のスレッドを立てて送ります（案件番号・件名・相手先を親にして、本文はその下に返信）。
                    返信は自動でこの記録に入ります
                  </>}
          </div>
        )}

        {mode === "slack" && recipients && slackTarget === "direct" && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className={recipients.slack.channelId || recipients.slack.requesterSlackId || recipients.slack.fromRequesterEmail ? "faint" : ""}>
                宛先：{recipients.slack.channelId
                  ? <>この案件のスレッド（<span className="code">{recipients.slack.channelId}</span>）に続けます</>
                  : recipients.slack.requesterSlackId
                    ? <><span className="code">{recipients.slack.requesterSlackId}</span> へ送ります。最初の1通がこの案件のスレッドになります</>
                    : recipients.slack.fromRequesterEmail
                      ? <>依頼者 {recipients.slack.fromRequesterEmail.name}（<span className="code">{recipients.slack.fromRequesterEmail.slackId}</span>）へ DM。依頼者のメールから社員を引きました</>
                      : <span className="tag warn">宛先がありません。「宛先を決める」で選んでください</span>}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setSlackEditing((v) => !v)}>
                {slackEditing ? "閉じる" : recipients.slack.channelId || recipients.slack.requesterSlackId ? "宛先を変える" : "宛先を決める"}
              </button>
            </div>
            {slackEditing && (
              <SlackRecipientPicker matterId={matterId} current={recipients.slack.requesterSlackId}
                onSaved={(msg) => { setSlackEditing(false); setNote(msg); setRecipientsVersion((v) => v + 1); }}
                onError={setError} />
            )}
          </div>
        )}

        {mode === "slack" && recipients && (
          <MentionPicker value={mentions} onChange={setMentions} />
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
            <RecipientPicker value={mailTo} onChange={setMailTo}
              initialKeyword={recipients.counterparty?.name ?? ""}
              fields={[
                { key: "to", label: "To" },
                { key: "cc", label: "Cc", hint: "写し。事業部の担当者・経理などを足せます" }
              ]} />
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
            {mode === "note" ? "メモを残す" : mode === "slack" ? (slackTarget === "consult" ? "法務相談窓口へ送る" : "Slack で送る") : mode === "email" ? "メールを送る" : "リンクを残す"}
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
          {!rows.length && <li className="faint empty">まだ記録がありません</li>}
        </ol>
      </div>
    </div>
  );
}

/**
 * 案件の Slack の宛先を決める。社員（Slack ID の登録がある人）から選ぶか、
 * メンバー ID（U…）・チャンネル ID（C…）を貼る。社員の Slack ID は「取引先・担当」の
 * 担当者の一覧で登録する。
 */
function SlackRecipientPicker(
  { matterId, current, onSaved, onError }: {
    matterId: number; current: string | null;
    onSaved: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const [staff, setStaff] = useState<Array<{ id: number; name: string; department: string | null; slackUserId?: string | null; status: string }>>([]);
  const [q, setQ] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ staff: typeof staff }>("/staff").then((r) => setStaff(r.staff)).catch(() => setStaff([]));
  }, []);
  const withSlack = staff.filter((s) => s.slackUserId && s.status !== "retired");
  const shown = withSlack.filter((s) => !q.trim() || `${s.name} ${s.department ?? ""}`.includes(q.trim())).slice(0, 30);

  async function save(slackId: string | null, label: string) {
    setBusy(true);
    try {
      await api.put(`/matters/${matterId}/slack-recipient`, { slackId });
      onSaved(slackId ? `Slack の宛先を ${label} にしました` : "Slack の宛先を外しました");
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="note stack" style={{ gap: 6 }}>
      <input value={q} placeholder="社員の名前・部門で探す" onChange={(e) => setQ(e.target.value)} />
      <div className="picker" style={{ maxHeight: 200, overflowY: "auto" }}>
        {shown.map((s) => (
          <div key={s.id} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "2px 0" }}>
            <span>{s.name}<span className="faint">　{s.department ?? ""}</span><span className="code faint">　{s.slackUserId}</span></span>
            <button className="btn btn-sm" disabled={busy || s.slackUserId === current}
                    onClick={() => void save(s.slackUserId!, s.name)}>この人に送る</button>
          </div>
        ))}
        {!shown.length && (
          <span className="faint">
            {withSlack.length ? "当たる社員がいません" : "Slack ID を登録した社員がいません。「取引先・担当」の担当者の一覧で Slack ID を入れてください"}
          </span>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input value={manual} placeholder="メンバー ID（U…）かチャンネル ID（C…）を貼る" style={{ flex: 1 }}
               onChange={(e) => setManual(e.target.value)} />
        <button className="btn btn-sm" disabled={busy || !/^[UWCGucwg][A-Za-z0-9]{6,}$/.test(manual.trim())}
                onClick={() => void save(manual.trim(), manual.trim())}>この ID にする</button>
        {current && <button className="btn btn-sm" disabled={busy} onClick={() => void save(null, "")}>宛先を外す</button>}
      </div>
      <small className="faint">
        宛先を変えると、次の1通から新しいスレッドになります（これまでのやり取りは残ります）。
        メンバー ID は Slack のプロフィールの「⋮」→「メンバー ID をコピー」で取れます。
      </small>
    </div>
  );
}

interface SlackPerson { slackId: string; name: string }

/**
 * メンションする人を選ぶ。社員（Slack ID の登録がある人）を名前・部門で探して足す。
 * 送ると本文の頭に @名前 が付く（Slack の <@U…>）。
 */
function MentionPicker({ value, onChange }: { value: SlackPerson[]; onChange: (v: SlackPerson[]) => void }) {
  const [staff, setStaff] = useState<Array<{ id: number; name: string; department: string | null; slackUserId?: string | null; status: string }>>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    api.get<{ staff: typeof staff }>("/staff").then((r) => setStaff(r.staff)).catch(() => setStaff([]));
  }, []);
  const chosen = new Set(value.map((v) => v.slackId));
  const hits = q.trim()
    ? staff.filter((s) => s.slackUserId && s.status !== "retired" && !chosen.has(s.slackUserId)
        && `${s.name} ${s.department ?? ""}`.includes(q.trim())).slice(0, 8)
    : [];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="faint">メンション：</span>
        {value.map((p) => (
          <span key={p.slackId} className="tag accent">
            @{p.name}
            <button className="linky" aria-label={`${p.name} を外す`} style={{ marginLeft: 4 }}
                    onClick={() => onChange(value.filter((v) => v.slackId !== p.slackId))}>×</button>
          </span>
        ))}
        <input value={q} placeholder="社員の名前・部門で探して @ を付ける" style={{ minWidth: 300 }}
               onChange={(e) => setQ(e.target.value)} />
      </div>
      {hits.length > 0 && (
        <div className="picker">
          {hits.map((s) => (
            <button key={s.id} className="chip" onClick={() => { onChange([...value, { slackId: s.slackUserId!, name: s.name }]); setQ(""); }}>
              {s.name}<span className="faint">　{s.department ?? ""}</span>
            </button>
          ))}
        </div>
      )}
      {q.trim() && !hits.length && (
        <span className="faint">当たる社員がいません（Slack ID は「取引先・担当」の担当者の一覧で登録します）</span>
      )}
    </div>
  );
}
