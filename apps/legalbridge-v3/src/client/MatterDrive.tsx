import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 案件の Drive フォルダ。案件ごとに1つ切り、受け渡したファイルはここに置く。
 *
 * フォルダを作る API（POST /matters/:id/drive-folder）と中身を並べる API は
 * 前からあったが、押す画面が無かった。案件単位でフォルダを切ると決めたので、
 * 案件の画面から作れて、中身が見えるようにする。
 */
interface DriveFile { id: string; name: string; link: string; mimeType: string; isFolder: boolean; modifiedTime: string | null }

export function MatterDrive(
  { matterId, folderUrl, enabled, onChanged }: {
    matterId: number; folderUrl: string | null;
    /** DRIVE_MATTER_PARENT_FOLDER_ID が設定されているか。 */
    enabled: boolean;
    onChanged: () => void;
  }
) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null); setError(null);
    if (!folderUrl || !enabled) return;
    api.get<{ files: DriveFile[] }>(`/matters/${matterId}/drive-files`)
      .then((r) => setFiles(r.files)).catch((e: ApiError) => setError(e.message));
  }, [matterId, folderUrl, enabled]);

  async function create() {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${matterId}/drive-folder`);
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!enabled && !folderUrl) {
    return <span className="faint">案件フォルダは未設定（DRIVE_MATTER_PARENT_FOLDER_ID）</span>;
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      {folderUrl ? (
        <div className="row">
          <a href={folderUrl} target="_blank" rel="noreferrer">案件フォルダを開く</a>
          <span className="faint">受け渡したファイルはここに置く。やり取りの記録には Drive のリンクで残す</span>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-sm" disabled={busy} onClick={() => void create()}>Drive に案件フォルダを作る</button>
          <span className="faint">案件番号と件名の名前で1つ。二度押しても増えません</span>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {files && files.length > 0 && (
        <ul className="stack" style={{ gap: 2, margin: 0, paddingLeft: 16 }}>
          {files.slice(0, 20).map((f) => (
            <li key={f.id}>
              <a href={f.link} target="_blank" rel="noreferrer">{f.isFolder ? "📁 " : ""}{f.name}</a>
              {f.modifiedTime && <span className="faint" style={{ marginLeft: 6 }}>{f.modifiedTime.slice(0, 10)}</span>}
            </li>
          ))}
          {files.length > 20 && <li className="faint">ほか {files.length - 20} 件</li>}
        </ul>
      )}
      {files && files.length === 0 && <span className="faint">フォルダはまだ空です</span>}
    </div>
  );
}
