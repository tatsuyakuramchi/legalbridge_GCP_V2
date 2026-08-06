import { useEffect, useState } from "react";

// 依頼（Backlog課題取込・Phase 3・読み取り）。Backlog課題を一覧し、課題を起点に
// リーガル文書の作成へ導く（issueKey を文書作成に引き継ぐ）。書き戻しは別途。
// BACKLOG_MODE=readonly＋接続情報が無い場合は未設定として案内する。

type Issue = {
  id: number; issueKey: string; summary: string;
  statusName: string | null; assigneeName: string | null;
  created: string | null; updated: string | null;
};

const fmt = (v: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

export function RequestsWorkspace({ onCreateDocument }: { onCreateDocument: (issueKey: string) => void }) {
  const [keyword, setKeyword] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
        </div>

        {error && <div className="async-error"><span>{error}</span></div>}

        <div className="request-list">
          {issues.map((issue) => (
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
              <div className="request-actions">
                <button className="primary" onClick={() => onCreateDocument(issue.issueKey)}>この課題で文書作成</button>
              </div>
            </article>
          ))}
          {!loading && !error && !issues.length && <div className="empty-state">該当する課題がありません。</div>}
        </div>
      </>}
    </section>
  );
}
