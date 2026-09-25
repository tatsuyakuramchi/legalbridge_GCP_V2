import type { TermHistory as History } from "../server/agreements/term-history.js";

/**
 * 更新履歴。契約と条件明細で同じ表。
 *
 *   2024-04-01  2025-03-31  Start  締結
 *   2025-04-01  2026-03-31  (1)    自動更新（1年）
 *   2026-04-01  2027-03-31  End    解除合意 …-T01
 *
 * 行は保存せず計算で出るので、日付が進めば表も伸びる。最終行の終了日が
 * 「いまの終了日」。契約チェック・満了通知・期限一覧が見るのもこの日。
 */
export function TermHistoryTable({ history, compact }: { history: History; compact?: boolean }) {
  if (!history.rows.length) {
    return <span className="faint">期間が入っていません</span>;
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="tablewrap">
        <table className={compact ? "compact" : undefined}>
          <thead><tr><th>開始</th><th>終了</th><th>区分</th><th>根拠</th></tr></thead>
          <tbody>
            {history.rows.map((r, i) => {
              const last = i === history.rows.length - 1;
              return (
                <tr key={`${r.start}-${i}`}>
                  <td className="code">{r.start || "—"}</td>
                  <td className="code">{last ? <b>{r.end ?? "期限なし"}</b> : (r.end ?? "期限なし")}</td>
                  <td className="code">{r.label}</td>
                  <td className={r.kind === "terminated" ? "" : "faint"}
                      style={r.kind === "terminated" ? { color: "var(--out)" } : undefined}>{r.basis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="faint" style={{ fontSize: 11.5 }}>
        いまの終了日 <b className="code">{history.currentEnd ?? "期限なし"}</b>
        {history.renewals > 0 && `　更新 ${history.renewals} 回`}
        {history.terminated ? "　解除済み" : history.stopped ? "　以後は更新しない" : ""}
      </div>
    </div>
  );
}
