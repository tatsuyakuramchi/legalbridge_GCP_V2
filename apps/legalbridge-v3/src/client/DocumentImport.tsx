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
 *
 * もう 1 つの入口が「番号を先に取る」。法務がワンオフで作る文書（覚書・念書・
 * 通知書など）は、番号を本文に書き込んでから登録したい。番号だけの下書き
 * （ファイル待ち）を作って番号を出し、あとで「ファイルを付ける」で発行済みにする。
 * 番号の接頭辞は種別ごと（サーバの import-kinds.ts）。
 */

export interface ImportKind { kind: string; prefix: string }

const FALLBACK_KINDS: ImportKind[] = [
  { kind: "業務委託契約書", prefix: "SVC" }, { kind: "秘密保持契約書", prefix: "NDA" },
  { kind: "発注書", prefix: "EPO" }, { kind: "発注請書", prefix: "POA" }, { kind: "検収書", prefix: "EAC" },
  { kind: "覚書", prefix: "MOU" }, { kind: "念書", prefix: "LOU" }, { kind: "通知書", prefix: "NTC" },
  { kind: "利用許諾契約書", prefix: "LIC" }, { kind: "その他", prefix: "IMP" }
];

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx";
const today = () => new Date().toISOString().slice(0, 10);

/** 保存先の設定と種別の表。開いたときに一度だけ聞く。 */
function useImportStatus(open: boolean) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [kinds, setKinds] = useState<ImportKind[]>(FALLBACK_KINDS);
  useEffect(() => {
    if (!open || configured !== null) return;
    api.get<{ configured: boolean; kinds?: ImportKind[] }>("/documents/import-status")
      .then((r) => { setConfigured(r.configured); if (r.kinds?.length) setKinds(r.kinds); })
      .catch(() => setConfigured(false));
  }, [open]);
  return { configured, kinds };
}

function CopyNo({ no }: { no: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex" }}>
      <b className="code" style={{ fontSize: 14 }}>{no}</b>
      <button type="button" className="btn btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(no).then(() => setCopied(true)).catch(() => undefined);
              }}>{copied ? "コピーしました" : "番号をコピー"}</button>
    </span>
  );
}

export function DocumentImport(
  { conditionId, matterId, requestId, onDone, onOpenDocument }: {
    conditionId?: number; matterId?: number;
    /** デイリータスクの依頼。付けると登録した文書がその作業に繋がる。 */
    requestId?: number;
    onDone: () => void;
    onOpenDocument?: (id: number) => void;
  }
) {
  const [mode, setMode] = useState<"closed" | "import" | "reserve">("closed");
  const open = mode !== "closed";
  const { configured, kinds } = useImportStatus(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reserved, setReserved] = useState<{ id: number; documentNo: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [v, setV] = useState({
    title: "", documentKind: FALLBACK_KINDS[0].kind, receivedOn: today(), note: ""
  });
  const picker = useRef<HTMLInputElement>(null);

  function pick(next: File | null) {
    setFile(next);
    // ファイル名をそのまま文書名の初期値にする。ほとんどの場合それでよい。
    if (next && !v.title.trim()) {
      setV({ ...v, title: next.name.replace(/\.[^.]+$/, "") });
    }
  }

  function close() { setMode("closed"); setError(null); }

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
      if (requestId) params.set("requestId", String(requestId));

      const r = await api.postRaw<{ documentNo: string }>(
        `/documents/import?${params}`, file, file.type || "application/octet-stream");
      setDone(r.documentNo); setReserved(null);
      setMode("closed"); setFile(null);
      setV({ ...v, title: "", note: "" });
      if (picker.current) picker.current.value = "";
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function reserve() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number; documentNo: string }>("/documents/reserve", {
        title: v.title.trim(), documentKind: v.documentKind,
        conditionIds: conditionId ? [conditionId] : [],
        matterId: matterId ?? null, requestId: requestId ?? null
      });
      setReserved(r); setDone(null);
      setMode("closed");
      setV({ ...v, title: "" });
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const prefix = kinds.find((k) => k.kind === v.documentKind)?.prefix ?? "IMP";
  const year = new Date().getFullYear();

  if (!open) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        {done && (
          <div className="note ok">
            文書 <span className="code">{done}</span> を登録しました。
            ファイルは「文書」の画面から開けます。
          </div>
        )}
        {reserved && (
          <div className="note ok stack" style={{ gap: 4 }}>
            <span>番号を取りました：<CopyNo no={reserved.documentNo} /></span>
            <span className="faint">
              この番号を本文に書き込んで PDF にしたら、文書
              {onOpenDocument
                ? <button className="linky code" onClick={() => onOpenDocument(reserved.id)}>{reserved.documentNo}</button>
                : <span className="code">{reserved.documentNo}</span>}
              の「ファイルを付ける」で登録してください（それまでは「ファイル待ち」の下書きです）。
            </span>
          </div>
        )}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn btn-sm" onClick={() => setMode("import")}>
            外で作った文書を登録
          </button>
          <button className="btn btn-sm" onClick={() => setMode("reserve")}>
            番号を先に取る
          </button>
          <span className="faint">
            相手方から届いた契約書や、先に紙で交わした発注書は「登録」。
            法務がワンオフで作る文書は「番号を先に取る」→ 本文に書き込んで → ファイルを付ける
          </span>
        </div>
      </div>
    );
  }

  const kindField = (
    <label className="field">
      <span>種別</span>
      <select value={v.documentKind}
              onChange={(e) => setV({ ...v, documentKind: e.target.value })}>
        {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind}（{k.prefix}）</option>)}
      </select>
      <small className="faint">番号は ARC-{prefix}-{year}-（連番）になります</small>
    </label>
  );

  if (mode === "reserve") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <b>番号を先に取る</b>
        <span className="faint">
          種別ごとの番号を 1 つ確保し、番号だけの下書き（ファイル待ち）を作ります。
          本文に番号を書き込んでから、その文書の「ファイルを付ける」で登録します。使わなかった番号は文書の画面で破棄できます。
        </span>
        <div className="form-grid">
          {kindField}
          <label className="field">
            <span>文書名</span>
            <input value={v.title} placeholder="例: 覚書（甲社・納期変更）"
                   onChange={(e) => setV({ ...v, title: e.target.value })} />
          </label>
        </div>
        {error && <div className="alert">{error}</div>}
        <div className="row">
          <button className="btn primary btn-sm" disabled={busy || !v.title.trim()}
                  onClick={() => void reserve()}>
            {busy ? "確保中…" : "番号を取る"}
          </button>
          <button className="btn btn-sm" onClick={close}>やめる</button>
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
        <input ref={picker} type="file" accept={ACCEPT}
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
        {kindField}
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
        <button className="btn btn-sm" onClick={close}>やめる</button>
        <span className="faint">
          登録すると番号が振られ、決定済みとして扱われます（下書きにはなりません）
        </span>
      </div>
    </div>
  );
}

/**
 * 先に取った番号の文書にファイルを付ける（文書の詳細から）。
 * 付けると発行済みになり、送付や実績の紐づけができるようになる。
 */
export function DocumentAttachFile(
  { documentId, documentNo, onDone }: { documentId: number; documentNo: string | null; onDone: () => void }
) {
  const [open, setOpen] = useState(false);
  const { configured } = useImportStatus(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [receivedOn, setReceivedOn] = useState(today());
  const [note, setNote] = useState("");

  async function attach() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ receivedOn, filename: file.name });
      if (note.trim()) params.set("note", note.trim());
      await api.postRaw(`/documents/${documentId}/import-file?${params}`, file,
        file.type || "application/octet-stream");
      setOpen(false); setFile(null);
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return <button className="btn primary" onClick={() => setOpen(true)}>ファイルを付ける</button>;
  }
  return (
    <div className="note stack" style={{ gap: 8 }}>
      <b>{documentNo ?? `#${documentId}`} にファイルを付ける</b>
      {configured === false && (
        <div className="note warn">ファイルの保存先が未設定です（GOOGLE_DRIVE_FOLDER_ID）。設定されるまでは付けられません。</div>
      )}
      <label className="field">
        <span>ファイル（番号を書き込んだもの）</span>
        <input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small className="faint">PDF・Word・Excel・画像。25MB まで</small>
      </label>
      <div className="form-grid">
        <label className="field"><span>締結日・作成日</span>
          <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></label>
        <label className="field"><span>備考</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button className="btn primary btn-sm" disabled={busy || !file || configured === false}
                onClick={() => void attach()}>{busy ? "登録中…" : "付けて決定済みにする"}</button>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setError(null); }}>やめる</button>
      </div>
    </div>
  );
}
