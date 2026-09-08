import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

interface Row {
  conditionId: number; conditionNo: string | null; conditionName: string;
  partyId: number; partyName: string; workTitle: string | null; currency: string;
  billed: number; received: number; outstanding: number; overdue: number;
  oldestDueOn: string | null; statements: number;
}
interface Summary {
  currency: string; billed: number; received: number;
  outstanding: number; overdue: number; conditions: number;
}

/**
 * 債権マップ。許諾で得るはずの額と、実際に入った額の差。
 * 「得るはず」は計算書の正味額の累計で、見込みでは水増ししない。
 */
export function ReceivableMap({ onOpenCondition }: { onOpenCondition?: (id: number) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Summary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [onlyOutstanding, setOnlyOutstanding] = useState(true);

  useEffect(() => {
    api.get<{ rows: Row[]; totals: Summary[] }>("/monitoring/receivables")
      .then((r) => { setRows(r.rows); setTotals(r.totals); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  const shown = onlyOutstanding ? rows.filter((r) => r.outstanding !== 0) : rows;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>債権マップ</h2>
        <span className="faint">許諾で得るはずの額と入った額の差</span>
      </div>
      <div className="panel-bd">
        {error && <div className="alert">{error}</div>}

        <div className="tiles">
          {totals.map((t) => (
            <div key={t.currency} className="tile">
              <div className="title">未収（{t.currency}）</div>
              <div className="num">{money(t.outstanding, t.currency)}</div>
              <div className="faint">
                請求 {money(t.billed, t.currency)} ／ 入金 {money(t.received, t.currency)}
                {t.overdue > 0 && <> ／ <span className="danger">期日超過 {money(t.overdue, t.currency)}</span></>}
              </div>
            </div>
          ))}
          {!totals.length && <p className="faint">計算書を出した許諾条件がまだありません。</p>}
        </div>

        <p className="faint">
          「請求」は計算書の正味額の累計。計算書を出していない期間は債権として立っていないので
          数えない。見込みで水増しすると、取り立てるべき額が分からなくなる。
        </p>

        {rows.length > 0 && (
          <>
            <label className="row" style={{ gap: 6, alignItems: "center", margin: "10px 0" }}>
              <input type="checkbox" checked={onlyOutstanding}
                     onChange={(e) => setOnlyOutstanding(e.target.checked)} />
              <span>未収があるものだけ表示（{rows.filter((r) => r.outstanding !== 0).length} / {rows.length}）</span>
            </label>

            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>条件</th><th>相手先</th><th>作品</th>
                    <th className="num">請求</th><th className="num">入金</th>
                    <th className="num">未収</th><th className="num">期日超過</th><th>最古の期日</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.conditionId} className={r.overdue > 0 ? "overdue" : undefined}>
                      <td>
                        <button className="btn btn-sm" onClick={() => onOpenCondition?.(r.conditionId)}>
                          {r.conditionNo ?? `#${r.conditionId}`}
                        </button>
                        <div className="faint">{r.conditionName}</div>
                      </td>
                      <td>{r.partyName}</td>
                      <td className="faint">{r.workTitle ?? "—"}</td>
                      <td className="num">{money(r.billed, r.currency)}</td>
                      <td className="num">{money(r.received, r.currency)}</td>
                      <td className="num"><b>{money(r.outstanding, r.currency)}</b></td>
                      <td className="num">
                        {r.overdue > 0
                          ? <span className="danger">{money(r.overdue, r.currency)}</span>
                          : "—"}
                      </td>
                      <td className="code">{r.oldestDueOn ?? "—"}</td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr><td colSpan={8} className="faint">未収はありません。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
