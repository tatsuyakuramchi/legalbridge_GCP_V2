import { useCallback, useEffect, useState } from "react";

// データ品質センター（Phase 4・読み取り専用）。横断整合スキャンの俯瞰＋drill導線。
// 権限未付与のカテゴリ（available:false）は縮退注記。

type Severity = "high" | "medium" | "low";
type Sample = { id: number; label: string; detail: string; link?: { view: string; id?: number } | null };
type Category = { key: string; label: string; description: string; severity: Severity; available: boolean; count: number; samples: Sample[] };
type Summary = { totalIssues: number; highIssues: number; categoriesWithIssues: number; scannedCategories: number; unavailableCategories: number };
type Report = { categories: Category[]; summary: Summary };

const sevLabel: Record<Severity, string> = { high: "重大", medium: "注意", low: "軽微" };

export function DataQuality({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/v2/data-quality", { signal });
      if (!res.ok) { setReport(null); setError(res.status === 403 ? "閲覧権限がありません" : "取得に失敗しました"); return; }
      setReport(await res.json());
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setReport(null); setError("通信に失敗しました");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort(); }, [load]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>DATA QUALITY</p>
          <h1>データ品質センター</h1>
          <small>作品・条件・素材・権利・受領の横断整合をスキャン（読み取り専用）{loading ? "・スキャン中" : ""}</small>
        </div>
        <button className="primary" onClick={() => load()} disabled={loading}>再スキャン</button>
      </div>

      {error && <div className="async-error"><span>{error}</span></div>}

      {report && <>
        <div className="dq-summary">
          <article className={report.summary.highIssues ? "warn" : ""}><span>重大な問題</span><strong>{report.summary.highIssues}</strong></article>
          <article><span>検知した問題（合計）</span><strong>{report.summary.totalIssues}</strong></article>
          <article><span>該当カテゴリ</span><strong>{report.summary.categoriesWithIssues} / {report.summary.scannedCategories}</strong></article>
          {report.summary.unavailableCategories > 0 && <article className="muted"><span>権限未付与</span><strong>{report.summary.unavailableCategories}</strong></article>}
        </div>

        <div className="dq-list">
          {report.categories.map((c) => (
            <article key={c.key} className={`dq-card sev-${c.severity}${!c.available ? " unavailable" : ""}`}>
              <div className="dq-card-head" onClick={() => c.available && c.count > 0 && setOpen((o) => ({ ...o, [c.key]: !o[c.key] }))}>
                <div>
                  <span className={`dq-sev sev-${c.severity}`}>{sevLabel[c.severity]}</span>
                  <strong>{c.label}</strong>
                  <em>{c.description}</em>
                </div>
                <div className="dq-count">
                  {c.available ? <b>{c.count}</b> : <small>未スキャン</small>}
                </div>
              </div>
              {!c.available && <small className="hint">表示権限（GRANT）が未付与のためスキャンできませんでした。付与後に自動表示されます。</small>}
              {c.available && c.count === 0 && <small className="hint">問題は検出されませんでした。</small>}
              {c.available && open[c.key] && c.samples.length > 0 && (
                <table className="dq-samples">
                  <tbody>{c.samples.map((s) => <tr key={s.id}>
                    <td>{s.label}</td><td className="muted">{s.detail}</td>
                    <td>{s.link && onNavigate && <button onClick={() => onNavigate(s.link!.view)}>開く</button>}</td>
                  </tr>)}</tbody>
                </table>
              )}
              {c.available && c.count > c.samples.length && open[c.key] && (
                <small className="hint">先頭 {c.samples.length} 件を表示（全 {c.count} 件）。</small>
              )}
            </article>
          ))}
        </div>
      </>}

      {!report && !error && <div className="empty-state">スキャン結果を読み込んでいます…</div>}
    </section>
  );
}
