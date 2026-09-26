import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 依頼者が上げた資料（A-055）と、依頼者に渡すアップロード用リンク。
 * 受付箱の依頼と、案件のやり取りの両方に出す。
 */

const KIND_LABEL: Record<string, string> = {
  counterparty_draft: "相手方ドラフト", own_draft: "自社ドラフト", reference: "参考資料"
};
interface Upload {
  id: number; uploadNo: string; kind: string; fileName: string; sizeBytes: number | null;
  driveUrl: string | null; uploaderEmail: string | null; note: string | null; uploadedAt: string;
}

export function UploadsPanel(
  { target, id, canWrite: given }: { target: "intake" | "matters"; id: number; canWrite?: boolean }
) {
  // 呼び出し側が権限を知らなければ自分で確かめる（リンクを作れるのは admin/legal）。
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    if (given !== undefined) return;
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, [given]);
  const canWrite = given ?? (!readOnly && (role === "admin" || role === "legal"));
  const [items, setItems] = useState<Upload[] | null>(null);
  const [link, setLink] = useState<{ url: string | null; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setItems(null); setLink(null); setCopied(false);
    // 表がまだ無い（SQL 未適用）ときは一覧を出さないだけにする。
    api.get<{ uploads: Upload[] }>(`/${target}/${id}/uploads`).then((r) => setItems(r.uploads)).catch(() => setItems([]));
  }, [target, id]);

  async function makeLink() {
    setError(null);
    try { setLink(await api.post<{ url: string | null; reason?: string }>(`/${target}/${id}/upload-link`)); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }
  async function copy() {
    if (!link?.url) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>依頼者の資料</h2>
        <span className="faint">{items ? `${items.length} 件` : ""}</span>
        {canWrite && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => void makeLink()}>アップロード用リンクを作る</button>}
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {link && (link.url ? (
          <div className="note">
            <div>依頼者にこのリンクを送ってください（30 日有効・V3 に入れない人でも開けます）。</div>
            <div className="row" style={{ gap: 8 }}>
              <input readOnly value={link.url} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-sm" onClick={() => void copy()}>{copied ? "コピーしました" : "コピー"}</button>
            </div>
          </div>
        ) : <div className="note warn">リンクを作れません：{link.reason}</div>)}
        <div className="tablewrap">
          <table>
            <thead><tr><th>受付番号</th><th>ファイル</th><th>種別</th><th>上げた人</th><th>日時</th></tr></thead>
            <tbody>
              {(items ?? []).map((u) => (
                <tr key={u.id}>
                  <td className="code">{u.uploadNo}</td>
                  <td>
                    {u.driveUrl ? <a href={u.driveUrl} target="_blank" rel="noreferrer">{u.fileName}</a> : u.fileName}
                    {u.note && <div className="faint">{u.note}</div>}
                  </td>
                  <td className="faint">{KIND_LABEL[u.kind] ?? u.kind}</td>
                  <td className="faint">{u.uploaderEmail ?? "—"}</td>
                  <td className="faint">{u.uploadedAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
              {items && !items.length && <tr><td colSpan={5} className="faint">まだ上がっていません。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
