import { useEffect, useMemo, useState } from "react";
import {
  buildLicenseMatrix, buildGrantCoverage, exclusivityLabel, splitTerms,
  type RightsLine
} from "../rights-aggregation";
import { ExportButtons } from "./ExportButtons";
import type { ExportColumn } from "./export-util";

// ライセンスマトリクス（R4・承認済みモックの実装）。作品×地域の一望。
// データは /works/rights-matrix（許諾側の条件明細・作品紐付きのみ）。
// 集計・被り判定は権利ツリーと同じ共通モジュール＝2画面で結果が食い違わない。
// セルクリックで該当作品の権利ツリータブへ移動して詳細（独占区分・期間・計算条件）を見る。

type ConflictIndex = Map<number, { count: number; cells: Set<string> }>;

const exportColumns: ExportColumn<RightsLine>[] = [
  { header: "作品", value: (l) => l.workTitle ?? "" },
  { header: "権利", value: (l) => l.name },
  { header: "地域", value: (l) => l.territory ?? "" },
  { header: "言語", value: (l) => l.language ?? "" },
  { header: "独占区分", value: (l) => exclusivityLabel(l.exclusivity) ?? "未設定" },
  { header: "期間", value: (l) => [l.termStart, l.termEnd].filter(Boolean).join("〜") },
  { header: "相手先", value: (l) => l.party ?? "" },
  { header: "文書番号", value: (l) => l.documentNumber ?? "" }
];

export function LicenseMatrixWorkspace({ onOpenWork }: { onOpenWork?: (workId: number) => void }) {
  const [lines, setLines] = useState<RightsLine[] | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [rightFilter, setRightFilter] = useState("");
  const [onlyConflicts, setOnlyConflicts] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v2/works/rights-matrix")
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((data) => { if (!cancelled) setLines(data.lines ?? []); })
      .catch((cause) => {
        if (!cancelled) setError(cause?.message === "403" ? "閲覧権限がありません" : "許諾データを取得できませんでした");
      });
    return () => { cancelled = true; };
  }, []);

  const rightNames = useMemo(
    () => [...new Set((lines ?? []).map((line) => line.name))].sort((a, b) => a.localeCompare(b, "ja")),
    [lines]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return (lines ?? []).filter((line) =>
      (!needle || String(line.workTitle ?? "").toLowerCase().includes(needle)) &&
      (!rightFilter || line.name === rightFilter));
  }, [lines, keyword, rightFilter]);

  const matrix = useMemo(() => buildLicenseMatrix(filtered), [filtered]);

  // 被り判定は作品単位（権利ツリーと同じカバレッジ判定）。セル強調用に地域|言語の索引も作る。
  const conflicts: ConflictIndex = useMemo(() => {
    const index: ConflictIndex = new Map();
    const byWork = new Map<number, RightsLine[]>();
    for (const line of filtered) {
      if (line.workId == null) continue;
      (byWork.get(line.workId) ?? byWork.set(line.workId, []).get(line.workId)!).push(line);
    }
    for (const [workId, workLines] of byWork) {
      const coverage = buildGrantCoverage(workLines);
      if (!coverage.conflicts.length) continue;
      index.set(workId, {
        count: coverage.conflicts.filter((c) => c.severity === "error").length || coverage.conflicts.length,
        cells: new Set(coverage.conflicts.map((c) => c.territory))
      });
    }
    return index;
  }, [filtered]);

  const rows = onlyConflicts ? matrix.rows.filter((row) => conflicts.has(row.workId)) : matrix.rows;
  const parties = new Set(filtered.map((line) => line.party).filter(Boolean));

  if (error) return <section className="page"><h1>ライセンスマトリクス</h1><div className="async-error">{error}</div></section>;

  return <section className="page">
    <div className="page-title">
      <div><p>LICENSE MATRIX</p><h1>ライセンスマトリクス</h1>
        <small>作品 × 許諾地域の一望。どの作品がどの地域でまだ空いているか、誰に出しているかを俯瞰します</small></div>
    </div>

    <div className="rights-summary">
      <article><span>対象作品</span><strong>{matrix.rows.length}作品</strong></article>
      <article><span>許諾明細</span><strong>{filtered.length}件</strong></article>
      <article><span>許諾先</span><strong>{parties.size}社</strong></article>
      <article className={conflicts.size ? "conflict-error" : ""}>
        <span>被りのある作品</span>
        <strong>{conflicts.size ? `⚠ ${conflicts.size}作品` : "なし"}</strong>
      </article>
    </div>

    <div className="matrix-filters">
      <input type="search" value={keyword} onChange={(e) => setKeyword(e.target.value)}
        placeholder="作品名・作品コードで絞り込み" />
      <button type="button" className={`matter-chip ${rightFilter === "" ? "active" : ""}`}
        onClick={() => setRightFilter("")}>すべての権利</button>
      {rightNames.map((name) => <button key={name} type="button"
        className={`matter-chip ${rightFilter === name ? "active" : ""}`}
        onClick={() => setRightFilter(rightFilter === name ? "" : name)}>{name}</button>)}
      <button type="button" className={`matter-chip conflict-chip ${onlyConflicts ? "active" : ""}`}
        onClick={() => setOnlyConflicts((v) => !v)}>⚠ 被りのみ</button>
      <span className="matrix-spacer" />
      <ExportButtons filename="license-matrix" sheetName="ライセンスマトリクス"
        columns={exportColumns} rows={filtered} />
    </div>

    {lines === null ? <p className="hub-note">読み込んでいます…</p> :
      !rows.length ? <div className="empty-state">
        {onlyConflicts ? "被りのある作品はありません。" :
          "許諾側の条件明細（作品に紐付くもの）がまだありません。「条件を登録する」の利用許諾アウトで登録すると、ここに一覧されます。"}
      </div> :
      <div className="panel matrix-wrap"><div className="table-scroll"><table className="rights-matrix">
        <thead><tr>
          <th>作品</th>
          {matrix.territories.map((territory) => <th key={territory}
            className={territory === matrix.territories[0] && /全世界|世界|worldwide|global|all/i.test(territory) ? "world" : ""}>
            {/全世界|世界|worldwide|global|all/i.test(territory) ? "🌐 " : ""}{territory}
          </th>)}
        </tr></thead>
        <tbody>{rows.map((row) => {
          const conflict = conflicts.get(row.workId);
          return <tr key={row.workId}>
            <th>
              <button type="button" className="matrix-work" onClick={() => onOpenWork?.(row.workId)}>
                {row.workTitle}
              </button>
              {conflict && <span className="row-flag">⚠ 被り {conflict.count}件</span>}
            </th>
            {matrix.territories.map((territory) => {
              const cell = row.cells[territory];
              const conflicted = conflict?.cells.has(territory) ?? false;
              return <td key={territory}
                className={conflicted ? "cell-conflict" : cell ? "" : "cell-open"}>
                {cell && filtered
                  .filter((line) => line.workId === row.workId &&
                    (splitTerms(line.territory).includes(territory) ||
                     (!splitTerms(line.territory).length && territory === "（地域未設定）")))
                  .map((line) => <button key={line.id} type="button" className="grant-chip clickable"
                    onClick={() => onOpenWork?.(row.workId)}>
                    <strong>{line.name}
                      {exclusivityLabel(line.exclusivity) &&
                        <em className={`excl excl-${line.exclusivity}`}>{exclusivityLabel(line.exclusivity)}</em>}
                    </strong>
                    <span>{splitTerms(line.language).join("・") || "言語未設定"} → {line.party ?? "(取引先未設定)"}</span>
                    {(line.termStart || line.termEnd) &&
                      <small>{[line.termStart, line.termEnd].filter(Boolean).join(" 〜 ")}</small>}
                    {line.documentNumber && <small>{line.documentNumber}</small>}
                  </button>)}
              </td>;
            })}
          </tr>;
        })}</tbody>
      </table></div></div>}

    <p className="hub-note">セル＝その地域で出している許諾（権利・独占区分・言語→相手先）。空欄＝未許諾。赤枠＝被り（非独占同士・期間が重ならない許諾は被りにしません）。クリックで作品の権利ツリーへ。</p>
  </section>;
}
