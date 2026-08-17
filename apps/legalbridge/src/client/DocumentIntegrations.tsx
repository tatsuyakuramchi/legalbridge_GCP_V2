import { useEffect, useState } from "react";
import { useToast } from "./Toast";

type Gate = { dispatchAllowed: boolean; statusLabel: string; blockerLabels: string[] };

// 案件添付の種別（attachments-repository の ATTACHMENT_KINDS と対応）。
// 添付候補の一覧に生のキーが出ると、どれが相手方ドラフトか読み取れない。
const ATTACHMENT_KIND_LABELS: Record<string, string> = {
  counterparty_draft: "相手方ドラフト",
  own_draft: "自社ドラフト",
  reference: "参考資料"
};
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
export function DocumentIntegrations({ documentId, canGmailNotify, canCloudSign, matterId = null }: {
  documentId: number; canGmailNotify: boolean; canCloudSign: boolean; matterId?: number | null;
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
    {canCloudSign && <CloudSignRequest documentId={documentId} matterId={matterId} isAdmin={isAdmin}
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

function CloudSignRequest({ documentId, matterId = null, isAdmin = true, suggestions = [], onSent }: { documentId: number; matterId?: number | null; isAdmin?: boolean; suggestions?: Suggestion[]; onSent?: () => void }) {
  const [participants, setParticipants] = useState<Participant[]>([{ email: "", name: "" }]);
  const [ccList, setCcList] = useState<Participant[]>([]);
  const [sendNow, setSendNow] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null);
  // 送る実体がテンプレート描画か、案件に添付したPDFか（プレビューで判明する）。
  type Source = { kind: "template" | "attachment"; ready: boolean; reason?: string };
  const [source, setSource] = useState<Source | null>(null);
  const [csId, setCsId] = useState<string | null>(null);
  const [csUrl, setCsUrl] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const valid = participants.filter((p) => p.email.trim() && p.name.trim());
  const validCc = ccList.filter((c) => c.email.trim())
    .map((c) => ({ email: c.email.trim(), ...(c.name.trim() ? { name: c.name.trim() } : {}) }));

  // 取引先マスタからの自動補完：文書の相手先メールが解決できていて、署名者がまだ
  // 空欄なら 1 人目に自動入力する（上書き自由・依頼はプレビュー→ボタンを押すまで行われない）。
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !suggestions.length) return;
    setParticipants((prev) => {
      const untouched = prev.length === 1 && !prev[0].email.trim() && !prev[0].name.trim();
      if (!untouched) return prev;
      setPrefilled(true);
      return [{ email: suggestions[0].email, name: suggestions[0].name }];
    });
  }, [suggestions, prefilled]);

  // 同じ案件の他の確定文書（一括依頼の添付候補）。
  type MatterDoc = { id: number; documentNumber: string | null; templateType: string };
  const [matterDocs, setMatterDocs] = useState<MatterDoc[]>([]);
  const [attachIds, setAttachIds] = useState<number[]>([]);
  useEffect(() => {
    setMatterDocs([]); setAttachIds([]);
    if (matterId == null) return;
    const controller = new AbortController();
    fetch(`/api/v2/matters/${matterId}`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("matter fetch failed")))
      .then((d) => setMatterDocs((d.documents ?? []).filter((doc: MatterDoc) => doc.id !== documentId)))
      .catch(() => { /* 添付候補が取れなくても単独依頼は可能 */ });
    return () => controller.abort();
  }, [matterId, documentId]);
  function toggleAttach(idToToggle: number) {
    setAttachIds((prev) => prev.includes(idToToggle) ? prev.filter((x) => x !== idToToggle) : [...prev, idToToggle]);
  }

  // 署名者・CC の検索引用（担当者マスタ＋取引先マスタの横断検索）。
  // 取引先の自動補完が効かない文書（相手先未解決・メール未登録）でもここから引ける。
  type SearchHit = { id: string; label: string; description?: string;
    values: { email?: string; staff_name?: string; contact_name?: string; vendor_name?: string } };
  const [staffQuery, setStaffQuery] = useState("");
  const [staffResults, setStaffResults] = useState<SearchHit[]>([]);
  const [vendorResults, setVendorResults] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!staffQuery.trim()) { setStaffResults([]); setVendorResults([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const search = (type: string) =>
        fetch(`/api/v2/master-data/search?type=${type}&q=${encodeURIComponent(staffQuery)}`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : Promise.reject(new Error("search failed")))
          .then((d) => (d.items ?? []).filter((it: SearchHit) => it.values?.email));
      Promise.all([search("staff"), search("vendor")])
        .then(([staff, vendors]) => { setStaffResults(staff); setVendorResults(vendors); })
        .catch((e) => { if (e.name !== "AbortError") { setStaffResults([]); setVendorResults([]); } });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [staffQuery]);

  function addParticipantEntry(entry: Participant) {
    setParticipants((prev) => {
      const rows = prev.filter((p) => p.email.trim() || p.name.trim());
      if (rows.some((p) => p.email.trim().toLowerCase() === entry.email.toLowerCase())) return prev;
      return [...rows, entry];
    });
    setGate(null);
  }
  function addCcEntry(entry: Participant) {
    setCcList((prev) => {
      const rows = prev.filter((c) => c.email.trim() || c.name.trim());
      if (rows.some((c) => c.email.trim().toLowerCase() === entry.email.toLowerCase())) return prev;
      return [...rows, entry];
    });
  }

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
      setSource(data.source ?? null);
    } catch { setError("通信に失敗しました。"); } finally { setBusy(false); }
  }
  async function dispatch() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v2/documents/${documentId}/cloudsign/dispatch`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: valid, cc: validCc, sendNow, attachDocumentIds: attachIds })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // CloudSign が返した一文（宛先名など）と再試行可否まで見せる。
        // 原因が分からないまま同じ操作を繰り返すのを避ける。
        setError([
          data.error ?? "依頼に失敗しました。",
          data.blockers ? `（${data.blockers.join("／")}）` : "",
          data.upstreamMessage ? `\nCloudSignの応答：${data.upstreamMessage}` : "",
          data.retryable ? "\n時間をおいて再実行してください。" : ""
        ].join(""));
        return;
      }
      setCsId(data.receipt.cloudSignDocumentId);
      setCsUrl(data.cloudSignUrl ?? null);
      setStatusLabel(data.receipt.status);
      toast.push(data.integrations?.cloudsign === "duplicate"
        ? "この文書は署名依頼済みです（再依頼はしていません）"
        : data.integrations?.cloudsign === "drafted"
          ? `CloudSignに下書きを作成しました${data.attachedCount ? `（添付${data.attachedCount + 1}件）` : ""}。CloudSign画面で印影等を配置して送信してください`
          : `CloudSignへ署名依頼しました${data.attachedCount ? `（添付${data.attachedCount + 1}件）` : ""}`, "success");
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
    {suggestions.length > 0 && <small className="settings-effective">取引先マスタ：
      {suggestions.map((sug) => <span key={sug.email}>
        {sug.name}（{sug.email}）
        <button type="button" className="link-button"
          onClick={() => addParticipantEntry({ email: sug.email, name: sug.name })}>署名者へ</button>
        <button type="button" className="link-button"
          onClick={() => addCcEntry({ email: sug.email, name: sug.name })}>CCへ</button>
      </span>)}
      {prefilled && <em>（1人目に自動入力済み・修正可）</em>}
    </small>}
    <div className="doc-integration-grid">
      <input value={staffQuery} onChange={(e) => setStaffQuery(e.target.value)}
        placeholder="担当者・取引先を検索して引用（氏名・会社名・部署・メール）" />
      <span />
    </div>
    {staffResults.length > 0 && <small className="settings-effective">担当者マスタ：
      {staffResults.map((item) => <span key={`s${item.id}`}>
        {item.label}{item.description ? `（${item.description}）` : ""}
        <button type="button" className="link-button"
          onClick={() => addParticipantEntry({ email: item.values.email ?? "", name: item.values.staff_name ?? item.label })}>署名者へ</button>
        <button type="button" className="link-button"
          onClick={() => addCcEntry({ email: item.values.email ?? "", name: item.values.staff_name ?? item.label })}>CCへ</button>
      </span>)}
    </small>}
    {vendorResults.length > 0 && <small className="settings-effective">取引先マスタ：
      {vendorResults.map((item) => <span key={`v${item.id}`}>
        {item.label}{item.description ? `（${item.description}）` : ""}
        <button type="button" className="link-button"
          onClick={() => addParticipantEntry({ email: item.values.email ?? "", name: item.values.contact_name || item.values.vendor_name || item.label })}>署名者へ</button>
        <button type="button" className="link-button"
          onClick={() => addCcEntry({ email: item.values.email ?? "", name: item.values.contact_name || item.values.vendor_name || item.label })}>CCへ</button>
      </span>)}
    </small>}
    {staffQuery.trim() !== "" && staffResults.length === 0 && vendorResults.length === 0 &&
      <small className="settings-effective">該当がありません（担当者・取引先の台帳にメール登録が必要です）。</small>}
    {matterDocs.length > 0 && <small className="settings-effective">
      同じ案件の文書をまとめて添付（1つのCloudSign書類として依頼）。
      案件に添付したPDF（相手方ドラフト等）も選べます：
      {matterDocs.map((doc) => <label key={doc.id} style={{ display: "inline-flex", gap: "0.3em", marginRight: "0.8em" }}>
        <input type="checkbox" checked={attachIds.includes(doc.id)} onChange={() => toggleAttach(doc.id)} />
        {doc.documentNumber ?? `#${doc.id}`}（{ATTACHMENT_KIND_LABELS[doc.templateType] ?? doc.templateType}）
      </label>)}
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
    {source?.kind === "attachment" && (source.ready
      ? <small className="settings-effective">
        テンプレートを持たない文書のため、案件に添付したPDFをそのまま送ります。
      </small>
      : <small className="doc-integration-blocked">
        添付から依頼できません：{source.reason ?? "送信できるファイルがありません"}
      </small>)}
    {csId && <div className="doc-integration-status">
      <span>CloudSign ID: {csId}／状態: {statusLabel ?? "—"}</span>
      {csUrl && <a href={csUrl} target="_blank" rel="noreferrer">CloudSignで開く{statusLabel === "draft" ? "（印影配置・送信へ）" : ""}</a>}
      <button onClick={refreshStatus} disabled={busy}>ステータス更新</button>
    </div>}
  </div>;
}
