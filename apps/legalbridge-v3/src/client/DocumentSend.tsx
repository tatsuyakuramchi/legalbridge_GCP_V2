import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 決定した文書を「送る」。
 *
 *   1. 内容確認のメール（任意。飛ばして CloudSign へ行ける）
 *   2. 相手の確認（返信・Slack・電話。人が「もらった」と記録する）
 *   3. CloudSign で署名依頼
 *   4. 締結（CloudSign から結果が届くと済になる）
 *
 * 宛先は「担当者だけ」か「取引先へ、担当者を cc に」の2択。
 * 送れなかったときは理由をそのまま見せる。
 */

interface Step { key: "mail" | "confirmed" | "cloudsign" | "executed"; name: string; done: boolean; at: string | null; detail: string; optional?: boolean }
interface Timeline { steps: Step[]; current: Step | null; events: Array<{ at: string; action: string; actor: string }> }
interface Recipients {
  owner: { name: string; email: string | null } | null;
  counterparty: { name: string; email: string | null } | null;
  contacts: Array<{ name: string | null; email: string; role: string | null }>;
}
interface Outcome { sent: boolean; duplicated?: boolean; gate: { reasons: string[]; mode: string };
                    preview?: { recipient: string; bodyPreview: string } }

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function DocumentSend(
  { documentId, documentNo, templateLabel, matterId, channels, isAdmin, onChanged, onClose }: {
    documentId: number; documentNo: string | null; templateLabel: string | null;
    matterId: number | null;
    channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
    isAdmin: boolean;
    onChanged: () => void;
    onClose: () => void;
  }
) {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [recipients, setRecipients] = useState<Recipients | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Step["key"] | null>(null);
  // メール
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [subject, setSubject] = useState(`${documentNo ?? ""} ${templateLabel ?? "文書"} のご確認`.trim());
  const [body, setBody] = useState(
    `${templateLabel ?? "文書"}をお送りします。内容をご確認のうえ、問題なければご返信ください。`);
  // 確認
  const [via, setVia] = useState("メールの返信");
  const [confirmNote, setConfirmNote] = useState("");
  // CloudSign
  const [signer, setSigner] = useState("");

  const modeOf = (ch: string) => channels.find((c) => c.channel === ch)?.mode ?? "off";
  const ownerEmail = recipients?.owner?.email ?? null;

  async function load() {
    const t = await api.get<Timeline>(`/documents/${documentId}/sends`);
    setTl(t);
    setOpen((prev) => prev ?? t.current?.key ?? null);
  }
  useEffect(() => {
    setError(null);
    load().catch((e: ApiError) => setError(e.message));
    if (matterId) {
      api.get<Recipients>(`/matters/${matterId}/recipients`).then((r) => {
        setRecipients(r);
        if (!signer) setSigner(r.contacts[0]?.email ?? r.counterparty?.email ?? "");
      }).catch(() => undefined);
    }
  }, [documentId, matterId]);

  function pick(kind: "owner" | "party") {
    if (!recipients) return;
    if (kind === "owner") { setTo(ownerEmail ? [ownerEmail] : []); setCc([]); return; }
    const partyEmails = recipients.contacts.map((c) => c.email);
    if (!partyEmails.length && recipients.counterparty?.email) partyEmails.push(recipients.counterparty.email);
    setTo(partyEmails); setCc(ownerEmail ? [ownerEmail] : []);
  }

  const describe = (o: Outcome, what: string) =>
    o.sent ? `${what}を送りました`
      : o.duplicated ? `同じ${what}をすでに送っています（二度は送りません）`
      : o.preview ? `検証モードのため送っていません。送るなら：${o.preview.recipient} へ`
      : `送りませんでした：${o.gate.reasons.join("／")}`;

  async function run(fn: () => Promise<string>) {
    setBusy(true); setError(null); setNote(null);
    try { setNote(await fn()); await load(); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const sendMail = () => run(async () => {
    const all = [...to, ...extra.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)];
    const r = await api.post<{ outcome: Outcome }>(`/documents/${documentId}/send`,
      { to: all, cc, subject, body, attachPdf: true });
    return describe(r.outcome, "内容確認のメール");
  });
  const confirm = () => run(async () => {
    await api.post(`/documents/${documentId}/confirm`, { via, note: confirmNote || null });
    setConfirmNote("");
    return "相手の確認を記録しました";
  });
  const sign = () => run(async () => {
    const r = await api.post<{ outcome: Outcome }>(`/documents/${documentId}/sign`, { recipient: signer });
    return describe(r.outcome, "CloudSign の署名依頼");
  });

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>送る</h2>
        <span className="faint">内容確認のメール → 相手の確認 → CloudSign → 締結。確認メールは飛ばせます</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className="note ok">{note}</div>}

        {tl && (
          <div className="pipe">
            {tl.steps.map((s, i) => {
              const current = tl.current?.key === s.key;
              return (
                <button key={s.key} type="button"
                        className={`pipe-step${current ? " flag" : ""}${open === s.key ? " open" : ""}`}
                        title={s.detail}
                        style={s.done ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}
                        onClick={() => setOpen(s.key)}>
                  <span className="st">{s.done ? `済 ${day(s.at)}` : current ? "いま" : s.optional ? `${i + 1}（任意）` : i + 1}</span>
                  <span className="nm">{s.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {tl && (
          <div className="trace">
            {tl.steps.map((s) => (
              <div key={s.key} className="trace-line">
                <span style={{ color: s.done ? "var(--ok)" : "var(--faint)", marginRight: 6 }}>{s.done ? "✓" : "—"}</span>
                <b>{s.name}</b><span className="faint" style={{ marginLeft: 8 }}>{s.detail}</span>
              </div>
            ))}
          </div>
        )}

        {open === "mail" && (
          <div className="stack" style={{ gap: 8 }}>
            {modeOf("gmail") !== "live" && (
              <div className="note warn">メール送信は{modeOf("gmail") === "dry_run" ? "検証モード（送らずに宛先と本文を確かめる）" : "無効"}です</div>
            )}
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="faint">宛先の型：</span>
              <button className="chip" aria-pressed={to.length > 0 && cc.length === 0 && to[0] === ownerEmail}
                      disabled={!ownerEmail} onClick={() => pick("owner")}>
                担当者だけ{recipients?.owner ? `（${recipients.owner.name}）` : matterId ? "（担当者未設定）" : "（案件なし）"}
              </button>
              <button className="chip" aria-pressed={cc.length > 0} disabled={!recipients} onClick={() => pick("party")}>
                取引先へ、担当者を cc に{recipients?.counterparty ? `（${recipients.counterparty.name}）` : ""}
              </button>
            </div>
            <div className="frow"><div className="flabel"><span>To</span></div>
              <div className="fbody row" style={{ flexWrap: "wrap", gap: 4 }}>
                {to.map((a) => <span key={a} className="chip" title="外す" onClick={() => setTo(to.filter((x) => x !== a))}>{a} ×</span>)}
                <input value={extra} placeholder="追加の宛先（カンマ区切り）" style={{ flex: 1, minWidth: 200 }}
                       onChange={(e) => setExtra(e.target.value)} />
              </div></div>
            <div className="frow"><div className="flabel"><span>Cc</span></div>
              <div className="fbody row" style={{ flexWrap: "wrap", gap: 4 }}>
                {cc.length ? cc.map((a) => <span key={a} className="chip" title="外す" onClick={() => setCc(cc.filter((x) => x !== a))}>{a} ×</span>)
                  : <span className="faint">なし</span>}
              </div></div>
            <div className="frow"><div className="flabel"><span>件名</span></div>
              <div className="fbody"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div></div>
            <div className="frow"><div className="flabel"><span>本文</span></div>
              <div className="fbody"><textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="faint" style={{ marginTop: 3 }}>{documentNo ?? "この文書"} の PDF を添えます</div></div></div>
            <div className="row">
              <button className="btn primary" disabled={busy || !(to.length || extra.trim()) || !subject.trim() || !body.trim()}
                      onClick={() => void sendMail()}>内容確認のメールを送る</button>
              <button className="linky" onClick={() => setOpen("cloudsign")}>飛ばして CloudSign へ</button>
            </div>
          </div>
        )}

        {open === "confirmed" && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">相手から「これでよい」をもらったら記録します。返信メールが案件に届いていれば、やり取りの記録にも残っています。</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {["メールの返信", "Slack", "電話", "口頭"].map((v) => (
                <button key={v} className="chip" aria-pressed={via === v} onClick={() => setVia(v)}>{v}</button>
              ))}
            </div>
            <input value={confirmNote} placeholder="ひとこと（誰から・何と言われたか。任意）"
                   onChange={(e) => setConfirmNote(e.target.value)} />
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => void confirm()}>確認をもらったと記録する</button>
              <button className="linky" onClick={() => setOpen("cloudsign")}>記録せずに CloudSign へ</button>
            </div>
          </div>
        )}

        {open === "cloudsign" && (
          <div className="stack" style={{ gap: 8 }}>
            {modeOf("cloudsign") !== "live" && (
              <div className="note warn">CloudSign は{modeOf("cloudsign") === "dry_run" ? "検証モード（送らずに宛先を確かめる）" : "無効"}です</div>
            )}
            {!isAdmin && <div className="note warn">署名依頼は admin だけが送れます</div>}
            <div className="frow"><div className="flabel"><span>署名者</span></div>
              <div className="fbody">
                <input value={signer} placeholder="署名する人のメールアドレス" onChange={(e) => setSigner(e.target.value)} />
                {recipients && recipients.contacts.length > 0 && (
                  <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {recipients.contacts.map((c) => (
                      <button key={c.email} type="button" className="btn btn-sm" onClick={() => setSigner(c.email)}>
                        {c.name ?? c.email}<span className="faint" style={{ marginLeft: 4 }}>{c.role ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="faint" style={{ marginTop: 3 }}>{documentNo ?? "この文書"} の PDF を CloudSign に載せて送ります。結果が届くと「締結」が済になります</div>
              </div></div>
            <div className="row">
              <button className="btn primary" disabled={busy || !isAdmin || !signer.trim()} onClick={() => void sign()}>
                CloudSign で署名依頼を送る
              </button>
            </div>
          </div>
        )}

        {open === "executed" && tl && (
          <div className="faint">{tl.steps[3].detail}</div>
        )}
      </div>
    </div>
  );
}
