import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { StatementModelRule } from "../server/royalty/statement-model.js";

/**
 * 取引モデル（利用形態）ごとの、利用許諾料計算書の出し分け表。
 *
 * ひな形の本文は1つで変えない。モデルに要らない欄は、本文へ渡す値を空にして
 * 消している。どのモデルで何が出るかをここで見られるようにする。
 */
export function StatementModels() {
  const [models, setModels] = useState<StatementModelRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ models: StatementModelRule[] }>("/royalty/statement-models")
      .then((r) => setModels(r.models)).catch((e: ApiError) => setError(e.message));
  }, []);
  const mark = (on: boolean) => on ? <span className="tag ok">出す</span> : <span className="tag ghost">空にする</span>;
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>計算書の表示（取引モデル別）</h2>
        <span className="faint">ひな形の本文は共通。モデルに要らない欄は値を空にして消します</span>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="tablewrap">
        <table>
          <thead><tr>
            <th>取引モデル</th><th>日付の見出し</th><th>算定の基礎</th>
            <th>数量・見本・有償数量</th><th>受領情報（入金企業・権利者・入金通貨）</th>
          </tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.usageType}>
                <td>{m.label} <span className="faint code">{m.usageType}</span></td>
                <td>{m.dateLabel}</td>
                <td>{m.basisLabel}</td>
                <td>{mark(m.quantityRows)}</td>
                <td>{mark(m.receiptBlock)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-bd faint">
        1枚に複数の取引モデルが載るときは、どれか1つでも「出す」なら出します。
        利用形態の付いていない旧い計算書は、これまでどおりの表示のままです。
      </div>
    </div>
  );
}
