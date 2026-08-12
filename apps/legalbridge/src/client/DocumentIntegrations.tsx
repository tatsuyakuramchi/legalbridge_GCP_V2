import { useEffect, useState } from "react";
import { useToast } from "./Toast";

type Gate = { dispatchAllowed: boolean; statusLabel: string; blockerLabels: string[] };
type SendHistory = {
  gmail: Array<{ recipient: string; messageId: string; recordedAt: string; recordedBy: string | null }>;
  cloudsign: Array<{ cloudSignDocumentId: string; status: string; participantCount: number; recordedAt: string; recordedBy: string | null }>;
  suggestions: Array<{ email: string; name: string; source: string }>;
};

// 送信・署名履歴＋宛先候補（W3）。従来はトーストのみで、リロードすると
// 送信済みかどうか・CloudSign の文書IDが完全に消えていた。
function useSendHistory(documentId: number, reloadKey: number) {
  const [history, setHistory] = useState<SendHistory | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/v2/documents/${documentId}/send-history`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => { if (active) setHistory(d); })
      .catch(() => { if (active) setHistory(null); });
    return () => { active = false; };
  }, [documentId, reloadKey]);
  return history;
}

function when(iso: string) {
  try { return new Date(iso).toLocaleString("ja-JP"); } catch { return iso; }
}

// 文書詳細の「外部連携」セクション。Gmail確定通知（プレビュー→送信）と
// CloudSign署名依頼（署名者→依頼→ステータス）をまとめる。いずれも
// capability が有効なときだけ表示され、実送信はサーバのゲート/ロールで守られる。
export function DocumentIntegrations({ documentId, canGmailNotify, canCloudSign }: {
  documentId: number; canGmailNotify: boolean; canCloudSign: boolean;
}) {
  const [historyReload, setHistoryReload] = useState(0);
  const history = useSendHistory(documentId, historyReload);
  // 実送信は管理者のみ（サーバ側で403）。法務が全部入力してから最後に弾かれる問題（監査A2.11）を
  // 防ぐため、ロールを取得して送信ボタンを最初から無効表示にする。
  const [isAdmin, setIsAdmin] = useState(true);
  useEffect(() => {
    fetch("/api/v2/me").then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setIsAdmin(d.user?.role === "admin")).catch(() => setIsAdmin(true));
  }, []);
  if (!canGmailNotify && !canCloudSign) return null;
  const bump = () => setHistoryReload((v) => v + 1);
  return <div className="doc-integrations">
    <h3>外部連携</h3>
    {history && (history.gmail.length > 0 || history.cloudsign.length > 0) && (
      <div className="doc-integration-card">
        <strong>送信・署名履歴</strong>
        {history.gmail.map((row, i) => <small key={`g${i}`} className="settings-effective">
          📧 {when(row.recordedAt)} → {row.recipient}（送信済み{row.recordedBy ? `・${row.recordedBy}` : ""}）
        </small>)}
        {history.cloudsign.map((row, i) => <CloudSignHistoryRow key={`c${i}`} row={row} onRefreshed={bump} />)}
      </div>
    )}
    {canGmailNotify && <GmailNotify documentId={documentId} isAdmin={isAdmin}
      suggestions={history?.suggestions ?? []} onSent={bump} />}
    {canCloudSign && <CloudSignRequest documentId={documentId} isAdmin={isAdmin}
      suggestions={history?.suggestions ?? []} onSent={bump} />}
  </div>;
}

// CloudSign 依頼行：保存済みの文書IDでいつでもステータス照会できる（リロード後も可）。
function CloudSignHistoryRow({ row, onRefreshed }: {
  row: SendHistory["cloudsign"][number]; onRefreshed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch(`/api/v2/cloudsign/${encodeURIComponent(row.cloudSignDocumentId)}/status`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setLive(d.live === false ? "（ライブ未設定）" : String(d.status ?? "不明")); onRefreshed(); }
    } finally { setBusy(false); }
  }
  return <small className="settings-effective">
    ✒ {when(row.recordedAt)} CloudSign依頼（署名者{row.participantCount}名）・状態: {live ?? row.status}
    <button type="button" className="link-button" onClick={() => void refresh()} disabled={busy}>
      {busy ? "照会中…" : "ステータス更新"}
    </button>
  </small>;
}

type Suggestion = { email: string; name: string; source: string };
function GmailNotify({ documentId, isAdmin = true, suggestions = [], onSent }: { documentId: number; isAdmin?: boolean; suggestions?: Suggestion[]; onSent?: () => void }) {
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
      // duplicate（既送信・冪等スキップ）と今回送信を区別して知らせる（監査A4.8）。
      toast.push(data.integrations?.gmail === "duplicate"
        ? "この宛先へは送信済みです（再送はしていません）" : "確定通知メールを送信しました", "success");
      onSent?.();
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }

  return <div className="doc-integration-card">
    <strong>📧 確定通知メール</strong>
    <label>宛先<input value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); setGate(null); }}
      placeholder="counterparty@example.com" /></label>
    {suggestions.length > 0 && <small className="settings-effective">候補：
      {suggestions.map((sug) => <button key={sug.email} type="button" className="link-button"
        onClick={() => { setTo(sug.email); setPreview(null); setGate(null); }}>{sug.name}（{sug.email}）</button>)}
    </small>}
    <div className="doc-integration-actions">
      <button onClick={runPreview} disabled={busy || !to.trim()}>プレビュー</button>
      <button className="primary" onClick={dispatch} disabled={busy || !gate?.dispatchAllowed || !isAdmin}
        title={!isAdmin ? "送信は管理者のみ" : !gate ? "先にプレビューで送信条件を確認してください" : undefined}>送信</button>
    </div>
    {!isAdmin && <small className="settings-effective">送信の実行は管理者のみ可能です（プレビューまで確認できます）。</small>}
    {!gate && <small className="settings-effective">プレビューを押すと送信条件を確認して送信ボタンが有効になります。</small>}
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

function CloudSignRequest({ documentId, isAdmin = true, suggestions = [], onSent }: { documentId: number; isAdmin?: boolean; suggestions?: Suggestion[]; onSent?: () => void }) {
  const [participants, setParticipants] = useState<Participant[]>([{ email: "", name: "" }]);
  const [ccList, setCcList] = useState<Participant[]>([]);
  const [sendNow, setSendNow] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null);
  const [csId, setCsId] = useState<string | null>(null);
  const [csUrl, setCsUrl] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const valid = participants.filter((p) => p.email.trim() && p.name.trim());
  const validCc = ccList.filter((c) => c.email.trim())
    .map((c) => ({ email: c.email.trim(), ...(c.name.trim() ? { name: c.name.trim() } : {}) }));

  function setParticipant(index: number, key: keyof Participant, value: string) {
    setParticipants((prev) => prev.map((p, i) => i === index ? { ...p, [key]: value } : p));
    setGate(null);
  }
  function setCc(index: number, key: keyof Participant, value: string) {
    setCcList((prev) => prev.map((c, i) => i === index ? { ...c, [key]: value } : c));
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: valid, cc: validCc, sendNow })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((data.error ?? "依頼に失敗しました。") + (data.blockers ? `（${data.blockers.join("／")}）` : ""));
        return;
      }
      setCsId(data.receipt.cloudSignDocumentId);
      setCsUrl(data.cloudSignUrl ?? null);
      setStatusLabel(data.receipt.status);
      toast.push(data.integrations?.cloudsign === "duplicate"
        ? "この文書は署名依頼済みです（再依頼はしていません）"
        : data.integrations?.cloudsign === "drafted"
          ? "CloudSignに下書きを作成しました。CloudSign画面で印影等を配置して送信してください"
          : "CloudSignへ署名依頼しました", "success");
      onSent?.();
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
    {suggestions.length > 0 && <small className="settings-effective">候補：
      {suggestions.map((sug) => <button key={sug.email} type="button" className="link-button"
        onClick={() => { setParticipants([{ email: sug.email, name: sug.name }]); setGate(null); }}>{sug.name}（{sug.email}）</button>)}
    </small>}
    {participants.map((p, index) => <div className="doc-integration-grid" key={index}>
      <input value={p.email} onChange={(e) => setParticipant(index, "email", e.target.value)} placeholder="署名者メール" />
      <input value={p.name} onChange={(e) => setParticipant(index, "name", e.target.value)} placeholder="署名者名" />
    </div>)}
    {ccList.map((c, index) => <div className="doc-integration-grid" key={`cc${index}`}>
      <input value={c.email} onChange={(e) => setCc(index, "email", e.target.value)} placeholder="CCメール（署名なしで共有）" />
      <input value={c.name} onChange={(e) => setCc(index, "name", e.target.value)} placeholder="CC名（任意）" />
    </div>)}
    <div className="doc-integration-actions">
      <button onClick={() => setParticipants((prev) => [...prev, { email: "", name: "" }])}>＋署名者</button>
      <button onClick={() => setCcList((prev) => [...prev, { email: "", name: "" }])}>＋CC</button>
      <button onClick={runPreview} disabled={busy || !valid.length}>プレビュー</button>
      <button className="primary" onClick={dispatch} disabled={busy || !gate?.dispatchAllowed || !isAdmin}
        title={!isAdmin ? "署名依頼は管理者のみ" : !gate ? "先にプレビューで依頼条件を確認してください" : undefined}>
        {sendNow ? "署名依頼（即時送信）" : "下書きを作成"}</button>
    </div>
    <div className="doc-integration-actions">
      <label><input type="radio" name={`cs-mode-${documentId}`} checked={!sendNow} onChange={() => setSendNow(false)} />
        下書きで作成（CloudSign画面で印影・項目を配置して送信・推奨）</label>
      <label><input type="radio" name={`cs-mode-${documentId}`} checked={sendNow} onChange={() => setSendNow(true)} />
        即時送信（印影等なしでそのまま送る）</label>
    </div>
    {error && <div className="async-error">{error}</div>}
    {gate && !gate.dispatchAllowed && <small className="doc-integration-blocked">
      依頼ブロック中：{gate.blockerLabels.join("／")}
    </small>}
    {csId && <div className="doc-integration-status">
      <span>CloudSign ID: {csId}／状態: {statusLabel ?? "—"}</span>
      {csUrl && <a href={csUrl} target="_blank" rel="noreferrer">CloudSignで開く{statusLabel === "draft" ? "（印影配置・送信へ）" : ""}</a>}
      <button onClick={refreshStatus} disabled={busy}>ステータス更新</button>
    </div>}
  </div>;
}
