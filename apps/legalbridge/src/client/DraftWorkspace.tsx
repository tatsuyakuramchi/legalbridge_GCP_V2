import { useEffect, useMemo, useState } from "react";
import type { DocumentDraftSummary, DocumentFormSchema } from "../types";

export function DraftWorkspace({
  templates,
  onResume,
  initialQuery = ""
}: {
  templates: DocumentFormSchema[];
  onResume: (issueKey: string, templateType: string) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [drafts, setDrafts] = useState<DocumentDraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [staleDays, setStaleDays] = useState("30");
  const [staleCount, setStaleCount] = useState<number | null>(null);
  const [purging, setPurging] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState("");
  useEffect(() => { if (initialQuery) setQuery(initialQuery); }, [initialQuery]);
  const labels = useMemo(
    () => new Map(templates.map((template) => [template.templateKey, template.label])),
    [templates]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ limit: "100" });
      if (query.trim()) params.set("q", query.trim());
      fetch(`/api/v2/document-drafts?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "draft list failed");
          setDrafts(result.drafts ?? []);
        })
        .catch((reason) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError("下書き一覧を取得できませんでした");
        })
        .finally(() => setLoading(false));
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, refreshToken]);

  async function previewStale() {
    setCleanupMsg(""); setStaleCount(null);
    const days = Number(staleDays);
    if (!Number.isInteger(days) || days < 1) { setCleanupMsg("日数は1以上で指定してください"); return; }
    try {
      const res = await fetch(`/api/v2/document-drafts/stale?days=${days}`);
      if (!res.ok) { setCleanupMsg("対象の取得に失敗しました"); return; }
      const data = await res.json();
      setStaleCount(data.count ?? 0);
    } catch { setCleanupMsg("通信に失敗しました"); }
  }

  async function purgeStale() {
    const days = Number(staleDays);
    if (!Number.isInteger(days) || days < 1) return;
    if (!window.confirm(`更新から${days}日以上経過した下書きを一括削除します。元に戻せません。`)) return;
    setPurging(true); setCleanupMsg("");
    try {
      const res = await fetch("/api/v2/document-drafts/purge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setCleanupMsg(data.error ?? "一括削除に失敗しました"); return; }
      setCleanupMsg(`${data.purgedCount}件の古い下書きを削除しました。`);
      setStaleCount(null); setRefreshToken((c) => c + 1);
    } catch { setCleanupMsg("通信に失敗しました"); }
    finally { setPurging(false); }
  }

  async function removeDraft(draft: DocumentDraftSummary) {
    if (!window.confirm(`${draft.issueKey} の下書きを破棄します。元に戻せません。`)) return;
    const params = new URLSearchParams({ template_type: draft.templateType });
    const response = await fetch(
      `/api/v2/document-drafts/${encodeURIComponent(draft.issueKey)}?${params.toString()}`,
      { method: "DELETE" }
    );
    if (!response.ok) {
      setError("下書きを破棄できませんでした");
      return;
    }
    setRefreshToken((current) => current + 1);
  }

  return (
    <section className="page draft-workspace">
      <div className="page-title">
        <div>
          <p>DRAFT WORKSPACE</p>
          <h1>下書き</h1>
          <small>作成途中の文書を選んで、入力を再開できます</small>
        </div>
      </div>

      {initialQuery && (
        <div className="deep-link-notice">
          Slackで案内された受付番号 <strong>{initialQuery}</strong> の下書きを表示しています。
        </div>
      )}

      <div className="draft-toolbar">
        <input
          aria-label="下書きを検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="受付番号、文書種別、文書番号、更新者で検索"
        />
        <span>{loading ? "読込中" : `${drafts.length}件`}</span>
      </div>

      <div className="draft-cleanup">
        <span>古い下書きの整理：更新から</span>
        <input aria-label="日数" value={staleDays} onChange={(e) => setStaleDays(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" />
        <span>日以上</span>
        <button onClick={previewStale}>対象を確認</button>
        {staleCount != null && <>
          <b>{staleCount}件</b>
          <button className="danger" onClick={purgeStale} disabled={purging || staleCount === 0}>{purging ? "削除中…" : "一括削除"}</button>
        </>}
        {cleanupMsg && <em>{cleanupMsg}</em>}
      </div>

      {error && (
        <div className="async-error">
          <span>{error}</span>
          <button onClick={() => setRefreshToken((current) => current + 1)}>再試行</button>
        </div>
      )}

      {!loading && !error && drafts.length === 0 && (
        <div className="empty-state">保存済みの下書きはありません。</div>
      )}

      <div className="draft-list">
        {drafts.map((draft) => (
          <article key={draft.id}>
            <div className="draft-list-main">
              <span>{draft.issueKey}</span>
              <strong>{labels.get(draft.templateType) ?? draft.templateType}</strong>
              <small>{draft.templateType}</small>
            </div>
            <dl>
              <div><dt>更新日時</dt><dd>{formatDateTime(draft.updatedAt)}</dd></div>
              <div><dt>更新者</dt><dd>{draft.updatedBy ?? "未記録"}</dd></div>
              <div><dt>文書番号</dt><dd>{draft.documentNumber ?? "確定前"}</dd></div>
            </dl>
            <div className="draft-list-actions">
              <button onClick={() => removeDraft(draft)}>下書きを削除</button>
              <button className="primary" onClick={() => onResume(draft.issueKey, draft.templateType)}>
                作業を再開
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
