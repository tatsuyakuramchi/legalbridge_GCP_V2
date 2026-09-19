import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * システムの外で作られた文書の登録（取込文書）。
 *
 * 相手方から届いた契約書、先に紙で交わした発注書、他社のひな形で作った覚書。
 * どれもこのシステムでは作れないが、条件にぶら下がっている事実は同じで、
 * 検収も支払もそれを根拠に進む。登録できないと、その根拠だけが台帳の外に残る。
 *
 * ひな形からの発行と違って下書きの段階を置かない。相手方から届いた時点で
 * こちらにとっては確定した文書なので、直しようがない。
 */

const KINDS = [
  "業務委託契約書", "秘密保持契約書", "発注書", "発注請書", "検収書",
  "覚書", "念書", "通知書", "利用許諾契約書", "その他"
];

export function DocumentImport(
  { conditionId, matterId, onDone }:
  { conditionId?: number; matterId?: number; onDone: () => void }
) {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [v, setV] = useState({
    title: "", documentKind: KINDS[0],
    receivedOn: new Date().toISOString().slice(0, 10), note: ""
  });
  const picker = useRef<HTMLInputElement>(null);

  // 保存先が未設定なら取り込めない。押せないボタンを出しても仕方がないので、
  // 開くときに一度だけ確かめる。
  useEffect(() => {
    if (!open || configured !== null) return;
    api.get<{ configured: boolean }>("/documents/import-status")
      .then((r) => setConfigured(r.configured))
      .catch(() => setConfigured(false));
  }, [open]);

  function pick(next: File | null) {
    setFile(next);
    // ファイル名をそのまま文書名の初期値にする。ほとんどの場合それでよい。
    if (next && !v.title.trim()) {
      setV({ ...v, title: next.name.replace(/\.[^.]+$/, "") });
    }
  }

  async function save() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({
        title: v.title.trim(), documentKind: v.documentKind,
        receivedOn: v.receivedOn, filename: file.name
      });
      if (v.note.trim()) params.set("note", v.note.trim());
      if (conditionId) params.set("conditionIds", String(conditionId));
      if (matterId) params.set("matterId", String(matterId));

      const r = await api.postRaw<{ documentNo: string }>(
        `/documents/import?${params}`, file, file.type || "application/octet-stream");
      setDone(r.documentNo);
      setOpen(false); setFile(null);
      setV({ ...v, title: "", note: "" });
      if (picker.current) picker.current.value = "";
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        {done && (
          <div className="note ok">
            文書 <span className="code">{done}</span> を登録しました。
            ファイルは「文書」の画面から開けます。
          </div>
        )}
        <div className="row">
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            外で作った文書を登録
          </button>
          <span className="faint">
            相手方から届いた契約書や、先に紙で交わした発注書をここに入れます
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {configured === false && (
        <div className="note warn">
          ファイルの保存先が未設定です（GOOGLE_DRIVE_FOLDER_ID）。
          設定されるまでは取り込めません。
        </div>
      )}
      <label className="field">
        <span>ファイル</span>
        <input ref={picker} type="file"
               accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx"
               onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <small className="faint">
          PDF・Word・Excel・画像。25MB まで。中身は書き換えられません
        </small>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>文書名</span>
          <input value={v.title} placeholder="例: 業務委託契約書（甲社）"
                 onChange={(e) => setV({ ...v, title: e.target.value })} />
        </label>
        <label className="field">
          <span>種別</span>
          <select value={v.documentKind}
                  onChange={(e) => setV({ ...v, documentKind: e.target.value })}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="field">
          <span>受領日・締結日</span>
          <input type="date" value={v.receivedOn}
                 onChange={(e) => setV({ ...v, receivedOn: e.target.value })} />
        </label>
        <label className="field">
          <span>備考</span>
          <input value={v.note} placeholder="どこから受け取ったかなど"
                 onChange={(e) => setV({ ...v, note: e.target.value })} />
        </label>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button className="btn primary btn-sm"
                disabled={busy || !file || !v.title.trim() || configured === false}
                onClick={() => void save()}>
          {busy ? "登録中…" : "登録する"}
        </button>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setError(null); }}>
          やめる
        </button>
        <span className="faint">
          登録すると番号が振られ、決定済みとして扱われます（下書きにはなりません）
        </span>
      </div>
    </div>
  );
}
