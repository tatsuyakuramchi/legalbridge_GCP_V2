import { useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * システム外で扱った CloudSign の状態を手で記録する。
 *
 * 予備系（ローカル）では CloudSign 連携が動かないので、署名依頼は CloudSign の
 * 画面から直接送る。そのままだと「送る」の段が進まず、締結も記録されない。
 * ここで「送った」「締結した」「辞退・取下げ」を記録すると、連携で送ったときと
 * 同じ形で監査と案件のやり取りに残り、段と合意の状態が進む。
 */
type ManualStatus = "sent" | "executed" | "terminated";

const LABEL: Record<ManualStatus, string> = {
  sent: "署名依頼を送った", executed: "締結した", terminated: "辞退・取下げ"
};
const today = () => new Date().toISOString().slice(0, 10);

export function CloudSignManual(
  { documentId, documentNo, initial, defaultSigner, hasAgreement, onDone, onClose }: {
    documentId: number;
    documentNo: string | null;
    /** 最初に選んでおく状態。CloudSign の段なら sent、締結の段なら executed。 */
    initial?: ManualStatus;
    defaultSigner?: string | null;
    /** 合意に繋がっているか。無ければ締結は記録できない（合意の状態を動かすので）。 */
    hasAgreement?: boolean | null;
    onDone: (message: string) => void;
    onClose?: () => void;
  }
) {
  const [status, setStatus] = useState<ManualStatus>(initial ?? "sent");
  const [at, setAt] = useState(today());
  const [signer, setSigner] = useState(defaultSigner ?? "");
  const [externalId, setExternalId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const no = documentNo ?? `#${documentId}`;

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ status: string; agreementUpdated: boolean }>(
        `/documents/${documentId}/cloudsign-status`,
        { status, at: at || null, signer: signer.trim() || null,
          externalId: externalId.trim() || null, note: note.trim() || null });
      onDone(status === "sent"
        ? `${no}：CloudSign で署名依頼を送ったと記録しました`
        : r.agreementUpdated
          ? `${no}：${LABEL[status]}と記録し、合意の状態を進めました`
          : `${no}：${LABEL[status]}と記録しました（合意の状態はそのまま）`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="faint">
        CloudSign の画面から直接送った・結果が届いたときは、ここで手で記録します。
        連携で送ったときと同じ形で監査とやり取りの記録に残ります。
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {(Object.keys(LABEL) as ManualStatus[]).map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={status === k} onClick={() => setStatus(k)}>{LABEL[k]}</button>
        ))}
      </div>
      {status === "executed" && hasAgreement === false && (
        <div className="note">{no} は合意に繋がっていないので、締結はこの文書の状態としてだけ残ります（発注書・検収書はこれで足ります）。契約書なら先に「つながり」から合意を付けてください。</div>
      )}
      <div className="frow"><div className="flabel"><span>日付</span></div>
        <div className="fbody"><input type="date" value={at} onChange={(e) => setAt(e.target.value)} /></div></div>
      <div className="frow"><div className="flabel"><span>{status === "sent" ? "署名者" : "相手"}</span></div>
        <div className="fbody"><input value={signer} placeholder="署名する人のメールアドレスか名前（任意）" onChange={(e) => setSigner(e.target.value)} /></div></div>
      <div className="frow"><div className="flabel"><span>CloudSign の書類ID</span></div>
        <div className="fbody"><input value={externalId} placeholder="CloudSign の URL 末尾など（任意）" onChange={(e) => setExternalId(e.target.value)} /></div></div>
      <div className="frow"><div className="flabel"><span>ひとこと</span></div>
        <div className="fbody"><input value={note} placeholder="任意" onChange={(e) => setNote(e.target.value)} /></div></div>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {LABEL[status]}と記録する
        </button>
        {onClose && <button className="btn" onClick={onClose}>閉じる</button>}
      </div>
    </div>
  );
}
