import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";

type ConditionLine = {
  id: number; lineNo: number | null; documentId: number | null; documentNumber: string | null;
  matterId: number | null; templateType: string | null; direction: string | null;
  flowDirection: string | null; transactionKind: string | null; conditionName: string;
  vendorName: string; workTitle: string; territory: string | null; currency: string | null;
  amountExTax: number | null; mgAmount: number | null; ratePct: number | null; termStart: string | null;
};
type SummaryRow = { direction: string; currency: string; lineCount: number; totalAmount: number; totalMg: number };
type DirFilter = "all" | "payable" | "receivable";

const directionLabels: Record<string, string> = { payable: "支払", receivable: "受取" };
const flowLabels: Record<string, string> = { in: "イン", out: "アウト" };

function money(currency: string | null, amount: number | null) {
  if (amount === null) return "—";
  return `${currency ?? "JPY"} ${amount.toLocaleString("ja-JP")}`;
}

function ConditionSummary({ summary }: { summary: SummaryRow[] }) {
  if (!summary.length) return null;
  const cards = (["receivable", "payable"] as const).map((dir) => {
    const groups = summary.filter((s) => s.direction === dir);
    return {
      dir,
      label: directionLabels[dir],
      count: groups.reduce((sum, g) => sum + g.lineCount, 0),
      amounts: groups.filter((g) => g.totalAmount > 0).map((g) => money(g.currency, g.totalAmount))
    };
  }).filter((card) => card.count > 0);
  if (!cards.length) return null;
  return <div className="condition-summary-cards">
    {cards.map((card) => (
      <article key={card.dir} className={`cond-summary ${card.dir}`}>
        <span>{card.label}</span>
        <strong>{card.amounts.length ? card.amounts.join(" / ") : "金額未設定"}</strong>
        <small>{card.count}件</small>
      </article>
    ))}
  </div>;
}

export function ConditionLinesWorkspace({ onOpenDocument }:
  { onOpenDocument?: (documentId: number) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DirFilter>("all");
  const [rows, setRows] = useState<ConditionLine[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    fetch("/api/v2/condition-lines/summary")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setSummary(data.groups ?? []))
      .catch(() => setSummary([]));
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      fetch(`/api/v2/condition-lines?${new URLSearchParams({ q: query, limit: "300" })}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setRows(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("条件明細を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, reload]);

  const counts = {
    all: rows.length,
    payable: rows.filter((r) => r.direction === "payable").length,
    receivable: rows.filter((r) => r.direction === "receivable").length
  };
  const chips: Array<{ key: DirFilter; label: string; count: number }> = [
    { key: "all", label: "すべて", count: counts.all },
    { key: "payable", label: "支払", count: counts.payable },
    { key: "receivable", label: "受取", count: counts.receivable }
  ];
  const visible = rows.filter((r) => filter === "all" || r.direction === filter);

  return <section className="page">
    <div className="page-title"><div><p>CONDITION LINES</p><h1>条件明細</h1>
      <small>契約条件を横断で検索・確認します（消化実績・検収は今後追加）</small></div></div>
    <ConditionSummary summary={summary} />
    <div className="matter-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="条件名、文書番号、相手方、作品名で検索" />
      <span>{loading ? "検索中…" : `${visible.length}件`}</span>
    </div>
    <div className="matter-chips">
      {chips.map((chip) => (
        <button key={chip.key} className={`matter-chip ${filter === chip.key ? "active" : ""}`}
          onClick={() => setFilter(chip.key)}>{chip.label}<em>{chip.count}</em></button>
      ))}
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    {!loading && !visible.length
      ? <EmptyState icon="≣" title={rows.length ? "この絞り込みに該当する条件明細はありません" : "条件明細がありません"}
          description={rows.length ? "別の向き・キーワードをお試しください。" : "契約取込・アウト条件追記で登録された条件がここに表示されます。"} />
      : <div className="panel condition-table-wrap">
        <table className="condition-table">
          <thead><tr>
            <th>条件名</th><th>向き</th><th>相手方</th><th>作品</th>
            <th>地域</th><th>金額</th><th>料率</th><th>文書</th>
          </tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className={row.documentId ? "row-link" : ""}
                onClick={() => row.documentId && onOpenDocument?.(row.documentId)}>
                <td><b>{row.conditionName || "（無題）"}</b>{row.termStart && <><br /><small>開始 {row.termStart}</small></>}</td>
                <td>
                  <span className={`cond-dir ${row.direction ?? ""}`}>{directionLabels[row.direction ?? ""] ?? "—"}</span>
                  {row.flowDirection && <small> / {flowLabels[row.flowDirection] ?? row.flowDirection}</small>}
                </td>
                <td>{row.vendorName || "—"}</td>
                <td>{row.workTitle || "—"}</td>
                <td>{row.territory || "—"}</td>
                <td>{money(row.currency, row.amountExTax ?? row.mgAmount)}</td>
                <td>{row.ratePct !== null ? `${row.ratePct}%` : "—"}</td>
                <td>{row.documentNumber ?? "未発番"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
  </section>;
}
