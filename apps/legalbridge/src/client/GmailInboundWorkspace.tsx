import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";

type Attachment = { attachmentId: string; filename: string; mimeType: string; sizeBytes: number };
type Message = { messageId: string; subject: string; from: string; date: string | null; attachments: Attachment[] };

// Gmail受信取込：対象メールボックスの契約候補メール（PDF添付）を一覧し、
// 添付PDFを別タブで開く。読取専用。capability が無効なら live=false 表示。
export function GmailInboundWorkspace() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [mailbox, setMailbox] = useState("");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/v2/gmail-inbound/contracts${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
      { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { setMessages(data.messages ?? []); setMailbox(data.mailbox ?? ""); setLive(Boolean(data.live)); })
      .catch((cause) => { if (cause?.name !== "AbortError") setError("受信メールを取得できませんでした。"); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [reload]);

  return <section className="page">
    <div className="page-title"><div><p>GMAIL INBOUND</p><h1>受信取込</h1>
      <small>{mailbox ? `${mailbox} の契約候補メール（PDF添付）` : "対象メールボックスの契約候補メール"}</small></div></div>
    {!live && <div className="outbound-overlap">Gmail受信取込は現在無効です（有効化すると一覧が表示されます）。</div>}
    <div className="matter-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Gmail検索クエリ（空欄で既定：has:attachment filename:pdf）" onKeyDown={(e) => { if (e.key === "Enter") setReload((v) => v + 1); }} />
      <button onClick={() => setReload((v) => v + 1)}>{loading ? "取得中…" : "検索"}</button>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    <div className="condition-table-wrap"><table className="condition-table">
      <thead><tr><th>件名</th><th>差出人</th><th>日付</th><th>添付</th></tr></thead>
      <tbody>{messages.map((message) => <tr key={message.messageId}>
        <td><b>{message.subject || "（無題）"}</b></td>
        <td>{message.from}</td>
        <td>{message.date ?? "—"}</td>
        <td>{message.attachments.map((attachment) => <a key={attachment.attachmentId} className="drive-link"
          href={`/api/v2/gmail-inbound/messages/${encodeURIComponent(message.messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`}
          target="_blank" rel="noreferrer">{attachment.filename}</a>)}</td>
      </tr>)}</tbody>
    </table></div>
    {live && !loading && !messages.length && <EmptyState icon="✉" title="契約候補メールがありません" compact />}
  </section>;
}
