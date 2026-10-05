import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { CloudSignManual } from "./CloudSignManual.js";
import { RecipientPicker, type Person } from "./RecipientPicker.js";

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
interface Timeline { steps: Step[]; current: Step | null; events: Array<{ at: string; action: string; actor: string }>; hasAgreement?: boolean }
interface DocRecipients {
  counterparty: { id: number | null; name: string; email: string | null } | null;
  contacts: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  signers: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  signersFrom: "signer" | "primary" | null;
  requester: Person | null;
  owner: Person | null;
  origin: { label: string; no: string | null; title: string | null } | null;
}

/**
 * 送っている最中の印。メールは PDF を作って添付するので 10〜20 秒かかることがあり、
 * 何も出ないと「反応しない」と思って連打される。回る輪と経過秒を出し、ボタンは押せなくする。
 */
function Sending({ what }: { what: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSec((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="sending" role="status" aria-live="polite">
      <span className="spin" />
      <span>
        <b>{what}</b>　{sec} 秒経過。PDF を作って送っているので、しばらくお待ちください（二度押しは要りません）
      </span>
    </div>
  );
}
interface Outcome { sent: boolean; duplicated?: boolean; draft?: boolean; warnings?: string[]; externalId?: string; gate: { reasons: string[]; mode: string };
                    preview?: { recipient: string; bodyPreview: string } }

type Purpose = "owner_check" | "party_check" | "delivery";
interface Draft {
  to: Array<{ name: string | null; email: string }>; cc: Array<{ name: string | null; email: string }>;
  subject: string; body: string; warnings: string[];
}
const PURPOSES: Array<{ value: Purpose; label: string; hint: string }> = [
  { value: "owner_check", label: "担当者への確認", hint: "依頼した事業部の担当者へ。相手に出す前に内容を確かめてもらう" },
  { value: "party_check", label: "取引先への内容確認", hint: "取引先へ。問題なければ CloudSign で締結に進む" },
  { value: "delivery", label: "取引先へ送付（検収書・計算書など）", hint: "取引先へ書類を送る。検収書・利用許諾計算書は専用の文面" }
];

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
  const [docRecipients, setDocRecipients] = useState<DocRecipients | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** いま送っているもの（印の文言）。 */
  const [sendingWhat, setSendingWhat] = useState<string | null>(null);
  const [open, setOpen] = useState<Step["key"] | null>(null);
  // メール
  // 宛先。下書きが入れた相手に、取引先の連絡先・自社の人を探して足せる（To / Cc）。
  const [mailTo, setMailTo] = useState<Record<string, Person[]>>({ to: [], cc: [] });
  const to = mailTo.to ?? [];
  const cc = mailTo.cc ?? [];
  const [subject, setSubject] = useState(`${documentNo ?? ""} ${templateLabel ?? "文書"} のご確認`.trim());
  const [body, setBody] = useState(
    `${templateLabel ?? "文書"}をお送りします。内容をご確認のうえ、問題なければご返信ください。`);
  // 文面（設定の mail_templates から組んだ下書き）
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // 確認
  const [via, setVia] = useState("メールの返信");
  const [confirmNote, setConfirmNote] = useState("");
  // CloudSign。署名者は複数（並べた順に署名）、確認者・CC は署名せず見るだけ。
  const [sign, setSign] = useState<Record<string, Person[]>>({ signers: [], reportees: [] });
  const [signNote, setSignNote] = useState<string | null>(null);
  const signer = sign.signers[0]?.email ?? "";

  const modeOf = (ch: string) => channels.find((c) => c.channel === ch)?.mode ?? "off";

  async function load() {
    const t = await api.get<Timeline>(`/documents/${documentId}/sends`);
    setTl(t);
    setOpen((prev) => prev ?? t.current?.key ?? null);
  }
  useEffect(() => {
    setError(null);
    load().catch((e: ApiError) => setError(e.message));
    // 署名者の候補。取引先の署名者（無ければ主担当）を入れておき、違えば外す。
    api.get<DocRecipients>(`/documents/${documentId}/recipients`).then((r) => {
      setDocRecipients(r);
      setSign((prev) => {
        if (prev.signers.length || !r.signers.length) return prev;
        return { ...prev, signers: r.signers.map((c) => ({ email: c.email, name: c.name })) };
      });
      setSignNote(r.signers.length
        ? `署名者に取引先の${r.signersFrom === "signer" ? "署名者" : "主担当"}を入れておきました。違えば外してください`
        : r.counterparty ? "取引先に署名者・主担当の連絡先が無いので、探して足してください"
        : "この文書は取引先が決まっていません。署名者を探して足してください");
    }).catch(() => undefined);
  }, [documentId]);

  async function loadDraft(p: Purpose) {
    setError(null);
    try {
      const d = await api.get<Draft>(`/documents/${documentId}/mail-draft?purpose=${p}`);
      setPurpose(p);
      setMailTo({ to: d.to.map((x) => ({ email: x.email, name: x.name })), cc: d.cc.map((x) => ({ email: x.email, name: x.name })) });
      setSubject(d.subject); setBody(d.body); setWarnings(d.warnings);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }
  // 最初に開いたとき、支払の書類は送付、それ以外は担当者への確認の下書きを入れておく。
  useEffect(() => {
    if (open === "mail" && purpose === null) {
      void loadDraft(/検収|計算書/.test(templateLabel ?? "") ? "delivery" : "owner_check");
    }
  }, [open]);

  const describe = (o: Outcome, what: string) => describeBase(o, what)
    + (o.warnings?.length ? `\n⚠ ${o.warnings.join("\n⚠ ")}` : "");
  const describeBase = (o: Outcome, what: string) =>
    o.sent && o.draft ? `${what}を CloudSign に下書きとして作りました${o.externalId ? `（書類ID ${o.externalId}）` : ""}。送信は CloudSign の画面から行い、送ったら手で「送った」と記録してください`
      : o.sent ? `${what}を送りました`
      : o.duplicated ? `同じ宛先・同じ内容の${what}をすでに作っています（二度は作りません）。宛先を変えたなら、変えた内容で作り直されます`
      : o.preview ? `検証モードのため送っていません。送るなら：${o.preview.recipient} へ`
      : `送りませんでした：${o.gate.reasons.join("／")}`;

  async function run(fn: () => Promise<string>, what: string | null = null) {
    if (busy) return;   // 連打しても二度は送らない
    setBusy(true); setSendingWhat(what); setError(null); setNote(null);
    try { setNote(await fn()); await load(); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); setSendingWhat(null); }
  }

  const sendMail = () => run(async () => {
    const r = await api.post<{ outcome: Outcome }>(`/documents/${documentId}/send`,
      { to: to.map((p) => p.email), cc: cc.map((p) => p.email), subject, body, attachPdf: true });
    return describe(r.outcome, "内容確認のメール");
  }, "メールを送っています");
  const confirm = () => run(async () => {
    await api.post(`/documents/${documentId}/confirm`, { via, note: confirmNote || null });
    setConfirmNote("");
    return "相手の確認を記録しました";
  });
  const requestSign = () => run(async () => {
    const r = await api.post<{ outcome: Outcome }>(`/documents/${documentId}/sign`, {
      signers: sign.signers.map((p) => ({ email: p.email, name: p.name ?? null })),
      reportees: sign.reportees.map((p) => ({ email: p.email, name: p.name ?? null }))
    });
    return describe(r.outcome, "CloudSign の署名依頼");
  }, "CloudSign に下書きを作っています");

  /** 候補を欄に足す（同じ人は二度入れない。署名者と確認者の両方にも入れない）。 */
  const addPerson = (key: "signers" | "reportees", p: Person) => {
    setSign((prev) => {
      const same = (x: Person) => x.email.toLowerCase() === p.email.toLowerCase();
      if ((prev[key] ?? []).some(same)) return prev;
      const other = key === "signers" ? "reportees" : "signers";
      return { ...prev, [other]: (prev[other] ?? []).filter((x) => !same(x)), [key]: [...(prev[key] ?? []), p] };
    });
  };

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>送る</h2>
        <span className="faint">内容確認のメール → 相手の確認 → CloudSign → 締結。確認メールは飛ばせます</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className={`note ${note.includes("⚠") ? "warn" : "ok"}`} style={{ whiteSpace: "pre-line" }}>{note}</div>}
        {sendingWhat && <Sending what={sendingWhat} />}

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
              <span className="faint">何のメールか：</span>
              {PURPOSES.map((p) => (
                <button key={p.value} className="chip" aria-pressed={purpose === p.value} title={p.hint}
                        disabled={busy} onClick={() => void loadDraft(p.value)}>{p.label}</button>
              ))}
            </div>
            <div className="faint">宛先・件名・本文は、運用 → 設定 → 「メールの文面」から組みます。送る前にここで直せます。</div>
            {warnings.map((w) => <div key={w} className="note warn">{w}</div>)}
            <RecipientPicker value={mailTo} onChange={setMailTo}
              initialKeyword={docRecipients?.counterparty?.name ?? ""}
              fields={[
                { key: "to", label: "To" },
                { key: "cc", label: "Cc", hint: "写し。事業部の担当者・経理などを足せます" }
              ]} />
            <div className="frow"><div className="flabel"><span>件名</span></div>
              <div className="fbody"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div></div>
            <div className="frow"><div className="flabel"><span>本文</span></div>
              <div className="fbody"><textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="faint" style={{ marginTop: 3 }}>{documentNo ?? "この文書"} の PDF を添えます</div></div></div>
            <div className="row">
              <button className="btn primary" disabled={busy || !to.length || !subject.trim() || !body.trim()}
                      aria-busy={busy} onClick={() => void sendMail()}>{busy ? "送っています…" : "メールを送る"}</button>
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
            {signNote && <div className="faint">{signNote}</div>}
            {/* 候補から一押しで足す。取引先の署名者、事業部の担当者（依頼者）、法務の担当。 */}
            {docRecipients && (
              <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                <span className="faint">候補：</span>
                {docRecipients.contacts.map((c) => (
                  <span key={c.email} className="row" style={{ gap: 2 }}>
                    <span className="src suggested">{docRecipients.counterparty?.name ?? "取引先"}</span>
                    <span style={{ fontSize: 12 }}>{c.name ?? c.email}{c.roles.includes("signer") ? "（署名者）" : c.roles.includes("primary") ? "（主担当）" : ""}</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("signers", { email: c.email, name: c.name })}>署名者</button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", { email: c.email, name: c.name })}>CC</button>
                  </span>
                ))}
                {docRecipients.requester && (
                  <span className="row" style={{ gap: 2 }}>
                    <span className="src auto">事業部担当</span>
                    <span style={{ fontSize: 12 }}>{docRecipients.requester.name ?? docRecipients.requester.email}</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", docRecipients.requester!)}>CC</button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("signers", docRecipients.requester!)}>署名者</button>
                  </span>
                )}
                {docRecipients.owner && (
                  <span className="row" style={{ gap: 2 }}>
                    <span className="src auto">法務担当</span>
                    <span style={{ fontSize: 12 }}>{docRecipients.owner.name ?? docRecipients.owner.email}</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", docRecipients.owner!)}>CC</button>
                  </span>
                )}
              </div>
            )}
            <RecipientPicker value={sign} onChange={setSign}
              initialKeyword={docRecipients?.counterparty?.name ?? ""}
              fields={[
                { key: "signers", label: "署名者", hint: "並べた順に署名を求めます。1人以上。取引先の署名者と当社の署名者を入れます" },
                { key: "reportees", label: "確認者・CC", hint: "署名はしませんが、書類を見られます（事業部の担当者など）" }
              ]} />
            <div className="faint">{documentNo ?? "この文書"} の PDF を CloudSign に<b>下書き</b>として載せます（相手にはまだ届きません）。CloudSign の画面で確かめてから送り、送ったら下の「手で記録する」で「送った」と残します。結果が届くと「締結」が済になります</div>
            <div className="row">
              <button className="btn primary" disabled={busy || !isAdmin || sign.signers.length === 0}
                      aria-busy={busy} onClick={() => void requestSign()}>
                {busy ? "作っています…" : `CloudSign に下書きを作る（署名者 ${sign.signers.length} 人${sign.reportees.length ? `・CC ${sign.reportees.length} 人` : ""}）`}
              </button>
            </div>
            {/* 予備系では連携が無い。CloudSign の画面から直接送ったぶんを、ここで手で記録する。 */}
            <details open={modeOf("cloudsign") !== "live"} style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <summary style={{ cursor: "pointer" }}>システム外（CloudSign の画面から直接）で送った・結果が届いたときは、手で記録する</summary>
              <div style={{ marginTop: 8 }}>
                <CloudSignManual documentId={documentId} documentNo={documentNo} initial="sent"
                  defaultSigner={signer} hasAgreement={tl?.hasAgreement ?? null}
                  onDone={(m) => { void run(async () => m); }} />
              </div>
            </details>
          </div>
        )}

        {open === "executed" && tl && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">{tl.steps[3].detail}</div>
            {!tl.steps[3].done && (
              <CloudSignManual documentId={documentId} documentNo={documentNo} initial="executed"
                defaultSigner={signer} hasAgreement={tl.hasAgreement ?? null}
                onDone={(m) => { void run(async () => m); }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
