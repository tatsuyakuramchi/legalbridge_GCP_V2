import { useState } from "react";
import { api, ApiError } from "./api.js";
import {
  SIGN_STATUSES, SIGN_STATUS_LABEL, type SignState, type SignStatus
} from "../server/documents/sign-state.js";

/**
 * 文書の CloudSign の状態（未送信／送信済／締結済／取下げ）の札と、手で直すスイッチ。
 *
 * 札は束の画面の発注書・検収書の欄に出す。押すとその場でスイッチが開き、
 * CloudSign の記録が古い・間違っているときに人が現状を上書きできる。
 * 記録は連携で届いたものと同じ列（監査とやり取り）に残り、いちばん新しい
 * ものが状態になる。
 */

const CLASS: Record<SignStatus, string> = {
  unsent: "ghost", sent: "accent", executed: "ok", terminated: "out"
};
const md = (d: string | null) => (d ? d.slice(5) : null);
const today = () => new Date().toISOString().slice(0, 10);

export function SignTag(
  { sign, onClick, disabled }: { sign: SignState; onClick?: () => void; disabled?: boolean }
) {
  const label = `${SIGN_STATUS_LABEL[sign.status]}${sign.at ? ` ${md(sign.at)}` : ""}`;
  const via = sign.source === "manual" ? "手で記録" : sign.source === "cloudsign" ? "CloudSign から" : "記録なし";
  const title = onClick ? `CloudSign：${via}。押すと手で直せます` : `CloudSign：${via}`;
  if (!onClick) return <span className={`tag ${CLASS[sign.status]}`} title={title}>CS {label}</span>;
  return (
    <button type="button" className={`tag ${CLASS[sign.status]} tagbtn`} title={title}
            disabled={disabled} onClick={onClick}>
      CS {label}{sign.source === "manual" ? <span className="faint">（手）</span> : null}
    </button>
  );
}

export function SignSwitch(
  { documentId, documentNo, current, onDone, onClose }: {
    documentId: number;
    documentNo: string | null;
    current: SignState;
    onDone: (message: string) => void;
    onClose: () => void;
  }
) {
  const [status, setStatus] = useState<SignStatus>(current.status === "unsent" ? "sent" : current.status);
  const [at, setAt] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const no = documentNo ?? `#${documentId}`;

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${documentId}/cloudsign-status`,
        { status, at: at || null, note: note.trim() || null });
      onDone(`${no}：CloudSign の状態を「${SIGN_STATUS_LABEL[status]}」と記録しました`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="signsw" onClick={(e) => e.stopPropagation()}>
      <div className="faint">CloudSign の状態を手で記録（いま：{SIGN_STATUS_LABEL[current.status]}）</div>
      {error && <div className="alert">{error}</div>}
      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
        {SIGN_STATUSES.map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={status === k}
                  onClick={() => setStatus(k)}>{SIGN_STATUS_LABEL[k]}</button>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input type="date" value={at} onChange={(e) => setAt(e.target.value)} />
        <input className="inline-input" value={note} placeholder="ひとこと（任意）"
               onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm primary" disabled={busy} onClick={() => void submit()}>記録する</button>
        <button type="button" className="btn btn-sm" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
