/**
 * 束ねた計算書の内訳。取引モデル（＝条件）ごとに1行で、合計はその和。
 *
 * 案件の「実績から計算書」と、文書の作成フォームの両方で同じものを出す。
 * 出す場所によって内訳の読み方が変わると、どちらが正しいのか分からなくなる。
 */

export interface StatementLine {
  conditionId: number | null;
  contractTitle: string;
  contractNumber: string;
  conditionName: string;
  methodLabel: string;
  salesJpy: number;
  ratePct: number;
  paymentJpy: number;
  basisNote: string;
}

export interface StatementTotals {
  currency: string;
  basis: number;
  netExTax: number;
  tax: number;
  totalIncTax: number;
  withholdingTax: number;
  netTransfer: number;
  netMinor: number;
}

/** 束ねの金額はサーバが主単位（円）で返す。最小通貨単位の money() と混ぜない。 */
export const majorMoney = (value: number, currency: string) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency }).format(value);

export function StatementBreakdown(
  { lines, totals }: { lines: StatementLine[]; totals: StatementTotals }
) {
  const yen = (v: number) => majorMoney(v, totals.currency);
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr><th>取引モデル</th><th>算定方法</th><th className="num">根拠額</th>
              <th className="num">料率</th><th className="num">実額（税抜）</th><th>但し書き</th></tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.conditionId ?? i}>
              <td>{l.conditionName}</td>
              <td>{l.methodLabel}</td>
              <td className="num">{yen(l.salesJpy)}</td>
              <td className="num">{l.ratePct ? `${l.ratePct}%` : "—"}</td>
              <td className="num">{yen(l.paymentJpy)}</td>
              <td className="faint">{l.basisNote}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4}><b>合計（税抜）</b></td>
            <td className="num"><b>{yen(totals.netExTax)}</b></td>
            <td />
          </tr>
          <tr>
            <td colSpan={4}>消費税</td>
            <td className="num">{yen(totals.tax)}</td>
            <td className="faint">条件ごとの税区分で計算します</td>
          </tr>
          <tr>
            <td colSpan={4}><b>合計（税込）</b></td>
            <td className="num"><b>{yen(totals.totalIncTax)}</b></td>
            <td className="faint">
              {totals.withholdingTax > 0
                ? `源泉 ${yen(totals.withholdingTax)} を引いた振込額 ${yen(totals.netTransfer)}`
                : ""}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
