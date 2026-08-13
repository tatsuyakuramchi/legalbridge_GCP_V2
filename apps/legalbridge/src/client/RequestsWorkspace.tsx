import { useEffect, useState } from "react";
import { extractVariables } from "./extract-variables";
import { EmptyState } from "./EmptyState";
import { CartButton } from "./MergeCart";

// 依頼（Backlog課題取込・Phase 3・読み取り）。Backlog課題を一覧し、課題を起点に
// リーガル文書の作成へ導く（issueKey を文書作成に引き継ぐ）。書き戻しは別途。
// BACKLOG_MODE=readonly＋接続情報が無い場合は未設定として案内する。

type Issue = {
  id: number; issueKey: string; summary: string; description: string | null;
  statusName: string | null; assigneeName: string | null;
  created: string | null; updated: string | null;
};

const fmt = (v: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

const COMMENT_TOKEN = "COMMIT_BACKLOG_COMMENT";

export function RequestsWorkspace({ onCreateDocument, canComment = false }: { onCreateDocument: (issueKey: string, seed?: Record<string, string>) => void; canComment?: boolean }) {
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentMsg, setCommentMsg] = useState("");

  async function postComment(issueKey: string) {
    if (!commentText.trim()) return;
    if (!window.confirm(`${issueKey} にBacklogコメントを投稿します。`)) return;
    setCommentBusy(true); setCommentMsg("");
    try {
      const res = await fetch(`/api/v2/backlog/issues/${encodeURIComponent(issueKey)}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: commentText, confirmation: COMMENT_TOKEN })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCommentMsg(data.error ?? (res.status === 503 ? "コメント書き戻しは無効です" : res.status === 502 ? "Backlogへの投稿に失敗しました" : "投稿に失敗しました"));
        return;
      }
      setCommentMsg("投稿しました"); setCommentText(""); setCommentFor(null);
    } catch { setCommentMsg("通信に失敗しました"); }
    finally { setCommentBusy(false); }
  }

  const [keyword, setKeyword] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [host, setHost] = useState("");
  // 概要（Backlog の詳細本文）は既定で3行に畳み、行ごとに全文へ展開できる。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // プロジェクト固有ID一覧（3-2b 同期実装前の参照・オンデマンド読取）。
  const [metaOpen, setMetaOpen] = useState(false);
  const [meta, setMeta] = useState<{ statuses: { id: number; name: string }[]; customFields: { id: number; name: string; typeId: number }[] } | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState("");

  async function loadMetadata() {
    const next = !metaOpen;
    setMetaOpen(next);
    if (!next || meta) return;
    setMetaLoading(true); setMetaError("");
    try {
      const res = await fetch("/api/v2/backlog/metadata");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMetaError(res.status === 403 ? "この一覧は管理者/法務のみ参照できます" : res.status === 502 ? "Backlog APIへの接続に失敗しました" : "取得に失敗しました");
        return;
      }
      if (data.enabled === false) { setMetaError("Backlog連携が未設定です"); return; }
      setMeta({ statuses: data.statuses ?? [], customFields: data.customFields ?? [] });
    } catch { setMetaError("通信に失敗しました"); }
    finally { setMetaLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      const params = new URLSearchParams();
      if (keyword.trim()) params.set("keyword", keyword.trim());
      params.set("count", "50");
      try {
        const res = await fetch(`/api/v2/backlog/issues?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) {
          setIssues([]);
          setError(res.status === 403 ? "閲覧権限がありません" : res.status === 502 ? "Backlog APIへの接続に失敗しました" : "取得に失敗しました");
          return;
        }
        const data = await res.json();
        setEnabled(data.enabled !== false);
        setIssues(data.issues ?? []);
        setHost(String(data.host ?? ""));
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setIssues([]); setError("通信に失敗しました");
      } finally { setLoading(false); }
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [keyword]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>REQUESTS</p>
          <h1>依頼（Backlog課題）</h1>
          <small>Backlog課題を起点にリーガル文書を作成します（読み取り）。書き戻しは今後追加。</small>
        </div>
      </div>

      {!enabled && (
        <div className="empty-state">
          Backlog連携が未設定です。<code>BACKLOG_MODE=readonly</code> と接続情報（ホスト・プロジェクト・APIキー）を設定すると課題が表示されます。
        </div>
      )}

      {enabled && <>
        <div className="matter-toolbar">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="課題を検索（件名・キーワード）" />
          <span>{loading ? "読込中…" : `${issues.length}件`}</span>
          <button type="button" onClick={loadMetadata}>{metaOpen ? "プロジェクトID一覧を閉じる" : "プロジェクトID一覧"}</button>
        </div>

        {metaOpen && (
          <div className="request-metadata">
            <small className="hint">ステータス／カスタム属性の実ID（Backlog 連携の同期設定に使う参照値）。読み取りのみ。</small>
            {metaLoading && <p>読込中…</p>}
            {metaError && <div className="async-error"><span>{metaError}</span></div>}
            {meta && (
              <div className="request-metadata-grid">
                <div>
                  <h4>ステータス（status ID）</h4>
                  {meta.statuses.length ? (
                    <ul>{meta.statuses.map((s) => <li key={s.id}><code>{s.id}</code> {s.name}</li>)}</ul>
                  ) : <p className="hint">なし</p>}
                </div>
                <div>
                  <h4>カスタム属性（custom field ID）</h4>
                  {meta.customFields.length ? (
                    <ul>{meta.customFields.map((f) => <li key={f.id}><code>{f.id}</code> {f.name} <span className="hint">type {f.typeId}</span></li>)}</ul>
                  ) : <p className="hint">なし</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="async-error"><span>{error}</span></div>}

        <div className="request-list">
          {issues.map((issue) => {
            const extracted = extractVariables(issue.description);
            const varEntries = Object.entries(extracted.variables);
            return (
            <article key={issue.id}>
              <div className="request-main">
                <span className="request-key">{issue.issueKey}</span>
                <strong>{issue.summary || "（件名なし）"}</strong>
              </div>
              <dl>
                <div><dt>状態</dt><dd>{issue.statusName ?? "—"}</dd></div>
                <div><dt>担当</dt><dd>{issue.assigneeName ?? "—"}</dd></div>
                <div><dt>更新</dt><dd>{fmt(issue.updated)}</dd></div>
              </dl>
              {issue.description?.trim()
                ? <div className="request-description">
                    <span className="request-vars-label">概要（Backlog本文）</span>
                    <pre className={expanded[issue.issueKey] ? "" : "clamped"}>{issue.description}</pre>
                    <button type="button" className="link-button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [issue.issueKey]: !prev[issue.issueKey] }))}>
                      {expanded[issue.issueKey] ? "折りたたむ" : "全文を表示"}
                    </button>
                  </div>
                : <p className="muted-note">概要（本文）は未記入です。</p>}
              {varEntries.length > 0 && (
                <div className="request-vars">
                  <span className="request-vars-label">抽出変数（文書へ引き継ぎ）</span>
                  {varEntries.map(([field, value]) => <span key={field} className="request-var"><b>{field}</b>{value}</span>)}
                </div>
              )}
              <div className="request-actions">
                {host && <a className="link-button" href={`https://${host}/view/${encodeURIComponent(issue.issueKey)}`}
                  target="_blank" rel="noreferrer">Backlogで開く</a>}
                <CartButton kind="issue" item={{ key: issue.issueKey, label: issue.summary || issue.issueKey }} />
                {canComment && <button onClick={() => { setCommentFor(commentFor === issue.issueKey ? null : issue.issueKey); setCommentText(""); setCommentMsg(""); }}>コメント書き戻し</button>}
                <button className="primary" onClick={() => onCreateDocument(issue.issueKey, extracted.variables)}>この課題で文書作成</button>
              </div>
              {canComment && commentFor === issue.issueKey && (
                <div className="request-comment">
                  <textarea rows={3} value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Backlogに投稿するコメント…" />
                  {commentMsg && <small className="hint">{commentMsg}</small>}
                  <div className="request-comment-actions">
                    <button onClick={() => setCommentFor(null)} disabled={commentBusy}>キャンセル</button>
                    <button className="primary" onClick={() => postComment(issue.issueKey)} disabled={commentBusy || !commentText.trim()}>{commentBusy ? "投稿中…" : "Backlogに投稿"}</button>
                  </div>
                </div>
              )}
            </article>
            );
          })}
          {!loading && !error && !issues.length && <EmptyState compact icon="◫" title="該当する課題がありません" description="Backlog の対象プロジェクト・絞り込み条件をご確認ください。" />}
        </div>
      </>}
    </section>
  );
}
