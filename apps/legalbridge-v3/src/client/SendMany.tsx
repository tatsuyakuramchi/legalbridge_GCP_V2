import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { RecipientPicker, type Person } from "./RecipientPicker.js";

/**
 * 選んだ何枚かの文書を、1通・1封筒で送る。
 *
 * 同じ取引先へ発注書を数枚、あるいは発注書と検収書を1式で送る。1枚ずつ送ると
 * 相手の受信箱が同じ件名で埋まり、どれが何の組か読めなくなる。
 *
 * 相手先の違う文書は混ぜられない（サーバが弾く）。A社への便りに B社の発注書が
 * 付くのは取り返しがつかない。
 *
 * 束の画面から「発注書と検収書を 1 封筒で」と来たときは CloudSign を先に出し、
 * 署名者にその取引先の署名者（無ければ主担当）を入れておく。相手が 20 社あると、
 * 1 社ずつ探して足すのが一番時間を食う。
 */

interface Candidate {
  kind: "contact" | "staff"; name: string | null; email: string;
  belongsTo: string | null; role: string | null;
}

interface Doc { id: number; documentNo: string | null; counterparty: string | null }
interface Outcome {
  sent: boolean; duplicated?: boolean;
  gate: { reasons: string[]; mode: string };
  preview?: { recipient: string; bodyPreview: string };
  externalId?: string;
}

export function SendMany(
  { documents, channels, isAdmin, initialWay, prefillSigners, title, onDone, onClose }: {
    documents: Doc[];
    channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
    isAdmin: boolean;
    /** 最初に開いておく送り方。省略すればメール。 */
    initialWay?: "mail" | "cloudsign";
    /** 相手先の署名者（無ければ主担当）を署名者に入れておく。相手先が 1 つのときだけ効く。 */
    prefillSigners?: boolean;
    title?: string;
    onDone: () => void;
    onClose: () => void;
  }
) {
  const numbers = documents.map((d) => d.documentNo ?? `#${d.id}`);
  const parties = [...new Set(documents.map((d) => d.counterparty ?? "（相手先なし）"))];
  // 相手先が1つに揃っているときは、その名前で候補を引いておく。
  const onePartyName = parties.length === 1 ? (documents[0]?.counterparty ?? "") : "";
  const [way, setWay] = useState<"mail" | "cloudsign">(initialWay === "cloudsign" && isAdmin ? "cloudsign" : "mail");
  const [mail, setMail] = useState<Record<string, Person[]>>({ to: [], cc: [], bcc: [] });
  const [sign, setSign] = useState<Record<string, Person[]>>({ signers: [], reportees: [] });
  const signFirst = initialWay === "cloudsign" && isAdmin;
  const [subject, setSubject] = useState(
    signFirst ? `${numbers.join("・")} 署名のお願い` : `${numbers.join("・")} のご確認`);
  const [body, setBody] = useState(signFirst
    ? `${numbers.join("・")} をお送りします。内容をご確認のうえ、ご署名をお願いいたします。`
    : `${numbers.join("・")} をお送りします。内容をご確認のうえ、問題なければご返信ください。`);
  const [attachPdf, setAttachPdf] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [prefilled, setPrefilled] = useState<string | null>(null);

  // 署名者の自動入れ。取引先の連絡先のうち署名者の印が付いた人、無ければ主担当。
  // 見つからなければ何も入れない（探して足す）。
  useEffect(() => {
    if (!prefillSigners || !onePartyName) return;
    let live = true;
    api.get<{ recipients: Candidate[] }>(`/recipients/search?q=${encodeURIComponent(onePartyName)}`)
      .then((r) => {
        if (!live) return;
        const mine = r.recipients.filter((c) => c.kind === "contact" && c.belongsTo === onePartyName);
        const has = (c: Candidate, role: string) => (c.role ?? "").split(",").map((x) => x.trim()).includes(role);
        const picked = mine.filter((c) => has(c, "signer"));
        const fallback = picked.length ? picked : mine.filter((c) => has(c, "primary"));
        if (!fallback.length) { setPrefilled("取引先に署名者・主担当の連絡先が無いので、探して足してください"); return; }
        setSign((prev) => prev.signers.length ? prev
          : { ...prev, signers: fallback.map((c) => ({ email: c.email, name: c.name })) });
        setPrefilled(`署名者に取引先の${picked.length ? "署名者" : "主担当"}を入れておきました。違えば外してください`);
      })
      .catch(() => { if (live) setPrefilled(null); });
    return () => { live = false; };
  }, [prefillSigners, onePartyName]);

  const modeOf = (ch: string) => channels.find((c) => c.channel === ch)?.mode ?? "off";
  const label = { off: "止めています", dry_run: "検証（送りません）", live: "送ります" } as const;

  async function send() {
    setBusy(true); setError(null); setOutcome(null);
    try {
      const r = way === "mail"
        ? await api.post<{ outcome: Outcome }>("/documents/send-many", {
            documentIds: documents.map((d) => d.id),
            to: mail.to.map((p) => p.email), cc: mail.cc.map((p) => p.email),
            bcc: mail.bcc.map((p) => p.email), subject, body, attachPdf
          })
        : await api.post<{ outcome: Outcome }>("/documents/sign-many", {
            documentIds: documents.map((d) => d.id),
            signers: sign.signers.map((p) => ({ email: p.email, name: p.name ?? undefined })),
            reportees: sign.reportees.map((p) => ({ email: p.email, name: p.name ?? undefined })),
            subject, body
          });
      setOutcome(r.outcome);
      if (r.outcome.sent) onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const ready = way === "mail"
    ? mail.to.length > 0 && subject.trim() && body.trim()
    : sign.signers.length > 0;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{title ?? `選んだ ${documents.length} 件を送る`}</h2>
        <span className="faint">{parties.join("・")}　{numbers.join("・")}</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>やめる</button>
      </div>
      <div className="panel-bd stack">
        {/* 相手先が混ざっていたらサーバが弾くが、押す前に分かるほうがよい。 */}
        {parties.length > 1 && (
          <div className="alert">
            相手先の違う文書が混ざっています（{parties.join("・")}）。
            1通にまとめると、片方への便りにもう片方の書類が付きます。相手先ごとに選び直してください。
          </div>
        )}

        <div className="tabs">
          <button aria-selected={way === "mail"} onClick={() => setWay("mail")}>
            メール（{label[modeOf("gmail")]}）
          </button>
          <button aria-selected={way === "cloudsign"} onClick={() => setWay("cloudsign")}
                  disabled={!isAdmin}
                  title={isAdmin ? undefined : "署名依頼は admin だけです"}>
            CloudSign で署名依頼（{label[modeOf("cloudsign")]}）
          </button>
        </div>

        {way === "mail" ? (
          <RecipientPicker value={mail} onChange={setMail} initialKeyword={onePartyName}
            fields={[
              { key: "to", label: "To", hint: "宛先。1人以上" },
              { key: "cc", label: "Cc", hint: "相手にも見える写し" },
              { key: "bcc", label: "Bcc", hint: "相手には見えない写し" }
            ]} />
        ) : (
          <RecipientPicker value={sign} onChange={setSign} initialKeyword={onePartyName}
            fields={[
              { key: "signers", label: "署名者", hint: "並べた順に署名を求めます。1人以上" },
              { key: "reportees", label: "確認者・CC", hint: "署名はしませんが、書類を見られます" }
            ]} />
        )}

        <div className="frow"><div className="flabel"><span>件名</span></div>
          <div className="fbody">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div></div>
        <div className="frow"><div className="flabel"><span>本文</span></div>
          <div className="fbody">
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </div></div>

        {way === "mail" && (
          <label className="row">
            <input type="checkbox" checked={attachPdf}
                   onChange={(e) => setAttachPdf(e.target.checked)} />
            <span>PDF を添える（{documents.length} 枚）</span>
          </label>
        )}
        {way === "cloudsign" && (
          <div className="note">
            {documents.length} 枚を1つの封筒に入れて送ります。署名者は並べた順に署名します。
            {prefilled && <div className="faint" style={{ marginTop: 4 }}>{prefilled}</div>}
          </div>
        )}

        {error && <div className="alert">{error}</div>}
        {outcome && (
          <div className={outcome.sent ? "note ok" : "note warn"}>
            {outcome.sent
              ? `送りました${outcome.externalId ? `（${outcome.externalId}）` : ""}`
              : outcome.duplicated
                ? "同じ内容をすでに送っています（二重には送りません）"
                : `送っていません：${outcome.gate.reasons.join("／")}`}
            {outcome.preview && (
              <div className="faint" style={{ marginTop: 4 }}>
                宛先 {outcome.preview.recipient}／{outcome.preview.bodyPreview.slice(0, 120)}
              </div>
            )}
          </div>
        )}

        <div className="row">
          <button className="btn primary" disabled={busy || !ready || parties.length > 1}
                  onClick={() => void send()}>
            {busy ? "送っています…" : way === "mail" ? "メールで送る" : "CloudSign で署名依頼を出す"}
          </button>
          <span className="faint">
            送る前に、宛先と添える書類を確かめてください。送った記録は案件のやり取りに残ります
          </span>
        </div>
      </div>
    </div>
  );
}
