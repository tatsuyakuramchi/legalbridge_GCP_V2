import { useState } from "react";
import { useToast } from "./Toast";

type Gate = { dispatchAllowed: boolean; statusLabel: string; blockerLabels: string[] };

// 文書詳細の「外部連携」セクション。Gmail確定通知（プレビュー→送信）と
// CloudSign署名依頼（署名者→依頼→ステータス）をまとめる。いずれも
// capability が有効なときだけ表示され、実送信はサーバのゲート/ロールで守られる。
export function DocumentIntegrations({
  documentId,
  canGmailNotify,
  canCloudSign,
  backlogMode = "disabled"
}: {
  documentId: number;
  canGmailNotify: boolean;
  canCloudSign: boolean;
  backlogMode?: "disabled" | "readonly" | "live";
}) {
  if (!canGmailNotify && !canCloudSign && backlogMode === "disabled") return null;
  return <div className="doc-integrations">
    <h3>外部連携</h3>
    {backlogMode !== "disabled" && <BacklogDispatch documentId={documentId} mode={backlogMode} />}
    {canGmailNotify && <GmailNotify documentId={documentId} />}
    {canCloudSign && <CloudSignRequest documentId={documentId} />}
  </div>;
}

function GmailNotify({ documentId }: { documentId: number }) {
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<{ subject: string; bodyText: string } | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function runPreview() {
    setBusy(true); setError(""); setPreview(null); setGate(null);
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/gmail-notification/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "プレビューに失敗しました。"); return; }
      setPreview(data.preview); setGate(data.gate);
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }
  async function dispatch() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/gmail-notification/dispatch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "送信に失敗しました。" + (data.blockers ? `（${data.blockers.join("／")}）` : ""));
        return;
      }
      toast.push("確定通知メールを送信しました", "success");
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }

  return <div className="doc-integration-card">
    <strong>📧 確定通知メール</strong>
    <label>宛先<input value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); setGate(null); }}
      placeholder="counterparty@example.com" /></label>
    <div className="doc-integration-actions">
      <button onClick={runPreview} disabled={busy || !to.trim()}>プレビュー</button>
      <button className="primary" onClick={dispatch} disabled={busy || !gate?.dispatchAllowed}>送信</button>
    </div>
    {error && <div className="async-error">{error}</div>}
    {preview && <div className="doc-integration-preview">
      <div><b>件名：</b>{preview.subject}</div>
      <pre>{preview.bodyText}</pre>
    </div>}
    {gate && !gate.dispatchAllowed && <small className="doc-integration-blocked">
      送信ブロック中：{gate.blockerLabels.join("／")}
    </small>}
  </div>;
}

type Participant = { email: string; name: string };

function CloudSignRequest({ documentId }: { documentId: number }) {
  const [participants, setParticipants] = useState<Participant[]>([{ email: "", name: "" }]);
  const [gate, setGate] = useState<Gate | null>(null);
  const [csId, setCsId] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const valid = participants.filter((p) => p.email.trim() && p.name.trim());

  function setParticipant(index: number, key: keyof Participant, value: string) {
    setParticipants((prev) => prev.map((p, i) => i === index ? { ...p, [key]: value } : p));
    setGate(null);
  }

  async function runPreview() {
    setBusy(true); setError(""); setGate(null);
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/cloudsign/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participants: valid })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "プレビューに失敗しました。"); return; }
      setGate(data.gate);
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }
  async function dispatch() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/cloudsign/dispatch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participants: valid })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((data.error ?? "依頼に失敗しました。") + (data.blockers ? `（${data.blockers.join("／")}）` : ""));
        return;
      }
      setCsId(data.receipt.cloudSignDocumentId);
      setStatusLabel(data.receipt.status);
      toast.push("CloudSignへ署名依頼しました", "success");
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }
  async function refreshStatus() {
    if (!csId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/cloudsign/${encodeURIComponent(csId)}/status`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "ステータス取得に失敗しました。"); return; }
      setStatusLabel(data.live ? `${data.status.status}${data.status.completed ? "（完了）" : ""}` : "未有効");
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }

  return <div className="doc-integration-card">
    <strong>🖋 電子署名依頼（CloudSign）</strong>
    {participants.map((p, index) => <div className="doc-integration-grid" key={index}>
      <input value={p.email} onChange={(e) => setParticipant(index, "email", e.target.value)} placeholder="署名者メール" />
      <input value={p.name} onChange={(e) => setParticipant(index, "name", e.target.value)} placeholder="署名者名" />
    </div>)}
    <div className="doc-integration-actions">
      <button onClick={() => setParticipants((prev) => [...prev, { email: "", name: "" }])}>＋署名者</button>
      <button onClick={runPreview} disabled={busy || !valid.length}>プレビュー</button>
      <button className="primary" onClick={dispatch} disabled={busy || !gate?.dispatchAllowed}>署名依頼</button>
    </div>
    {error && <div className="async-error">{error}</div>}
    {gate && !gate.dispatchAllowed && <small className="doc-integration-blocked">
      依頼ブロック中：{gate.blockerLabels.join("／")}
    </small>}
    {csId && <div className="doc-integration-status">
      <span>CloudSign ID: {csId}／状態: {statusLabel ?? "—"}</span>
      <button onClick={refreshStatus} disabled={busy}>ステータス更新</button>
    </div>}
  </div>;
}


function BacklogDispatch({
  documentId,
  mode
}: {
  documentId: number;
  mode: "readonly" | "live";
}) {
  const [preview, setPreview] = useState<{
    issue: { issueKey: string; summary: string; statusName: string | null };
    attachmentFilename: string;
    existingAttachment: { id: number; name: string; size: number } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function inspect() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/backlog`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPreview(null);
        setError(data.error ?? "Backlog課題を確認できませんでした。");
        return;
      }
      setPreview(data);
    } catch {
      setPreview(null);
      setError("Backlogへの接続に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function dispatch() {
    if (mode !== "live" || busy) return;
    if (!preview) {
      setError("先に接続確認を実行してください。");
      return;
    }
    if (preview.existingAttachment) {
      toast.push("同名PDFはBacklogへ登録済みです", "info");
      return;
    }
    if (!window.confirm(`${preview.issue.issueKey} に ${preview.attachmentFilename} を添付してコメントを追加します。実行しますか？`)) {
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/backlog/dispatch`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Backlogへの登録に失敗しました。");
        return;
      }
      toast.push(data.reused ? "Backlog登録済みのPDFを確認しました" : "BacklogへPDFを登録しました", "success");
      await inspect();
    } catch {
      setError("Backlogへの登録に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return <div className="doc-integration-card">
    <strong>📎 Backlog課題へPDF登録</strong>
    <small>{mode === "live"
      ? "課題を確認後、確定PDFを同じ課題のコメントへ添付します。"
      : "参照モードです。課題・既存添付のみ確認し、Backlogは変更しません。"}</small>
    <div className="doc-integration-actions">
      <button onClick={inspect} disabled={busy}>{busy ? "確認中…" : "接続確認"}</button>
      {mode === "live" && <button className="primary"
        onClick={dispatch}
        disabled={busy || !preview || Boolean(preview.existingAttachment)}>
        {preview?.existingAttachment ? "登録済み" : "Backlogへ登録"}
      </button>}
    </div>
    {error && <div className="async-error">{error}</div>}
    {preview && <div className="doc-integration-preview">
      <div><b>課題：</b>{preview.issue.issueKey} {preview.issue.summary}</div>
      <div><b>状態：</b>{preview.issue.statusName ?? "—"}</div>
      <div><b>PDF：</b>{preview.attachmentFilename}</div>
      <div><b>既存添付：</b>{preview.existingAttachment ? `あり（${preview.existingAttachment.name}）` : "なし"}</div>
    </div>}
  </div>;
}
