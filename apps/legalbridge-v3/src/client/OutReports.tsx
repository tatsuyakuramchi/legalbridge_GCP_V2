import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 許諾先（OUT 条件）の画面に出す「この許諾先からの報告」。
 *
 * 作品 › 利用許諾計算 で入れた締め・実績は、許諾料を払う側の IN 条件（作家）に
 * 付く。OUT 条件には付かないので、ここから引いて見せないと「予定も実績も無い」
 * ように見える。直すのは台帳（作品）か IN 条件で。
 */
interface Report {
  id: number; occurredOn: string | null; period: string | null; languages: string[]; regions: string[];
  quantity: number | null; grossAmount: number | null; amount: number; currency: string;
  inConditionId: number; inConditionNo: string | null; partyName: string | null;
  workId: number | null; workTitle: string | null;
  documentId: number | null; documentNo: string | null; documentStatus: string | null;
}
interface InCondition {
  id: number; conditionNo: string | null; usageLabel: string; partyId: number | null; partyName: string | null;
  workId: number | null; workTitle: string | null; schedules: number; nextCloseOn: string | null;
}
const yen = (n: number | null | undefined, currency = "JPY") =>
  n === null || n === undefined ? "—" : currency === "JPY"
    ? `¥${Number(n).toLocaleString("ja-JP")}` : `${currency} ${(Number(n) / 100).toLocaleString("en-US")}`;

export function OutReports(
  { conditionId, reloadKey, onOpenCondition, onOpenWork, onOpenDocument }: {
    conditionId: number; reloadKey?: number;
    onOpenCondition: (id: number) => void;
    onOpenWork?: (workId: number) => void;
    onOpenDocument?: (documentId: number) => void;
  }
) {
  const [data, setData] = useState<{ events: Report[]; inConditions: InCondition[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ events: Report[]; inConditions: InCondition[] }>(`/conditions/${conditionId}/out-reports`)
      .then(setData).catch((e: ApiError) => setError(e.message));
  }, [conditionId, reloadKey]);
  if (error) return <div className="alert">{error}</div>;
  if (!data) return null;
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>この許諾先からの報告</h2>
        <span className="faint">{data.events.length} 件 · 作品 › 利用許諾計算 で入れたもの</span>
      </div>
      <div className="panel-bd stack">
        <div className="note">
          締め（予定）と報告（実績）は、許諾料を払う側の <b>IN 条件（作家）</b> に付きます。この OUT 条件には付きません。
          入れる・直すのは作品の「利用許諾計算」か IN 条件で。計算書と支払（経理提出）も IN 側から出ます。
        </div>
        {data.inConditions.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <span className="faint">対応する IN 条件（締め）</span>
            {data.inConditions.map((c) => (
              <div key={c.id} className="row" style={{ gap: 8 }}>
                <button className="linky code" onClick={() => onOpenCondition(c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
                <span>{c.partyName ?? "—"} · {c.workTitle ?? "—"} · {c.usageLabel}</span>
                <span className={`tag ${c.schedules ? "" : "warn"}`}>{c.schedules ? `締め ${c.schedules} 回${c.nextCloseOn ? ` · 次 ${c.nextCloseOn}` : ""}` : "締めなし"}</span>
                {onOpenWork && c.workId && <button className="btn btn-sm" onClick={() => onOpenWork(c.workId!)}>台帳で開く</button>}
              </div>
            ))}
          </div>
        )}
        {data.events.length > 0 ? (
          <div className="tablewrap">
            <table>
              <thead><tr><th>発生日</th><th>期間</th><th>言語・地域</th><th className="num">数量</th><th className="num">受領額</th><th className="num">許諾料</th><th>IN 条件</th><th>計算書</th></tr></thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="code">{e.occurredOn ?? "—"}</td>
                    <td>{e.period ?? "—"}</td>
                    <td>{[...e.languages, ...e.regions].join("・") || <span className="faint">—</span>}</td>
                    <td className="num">{e.quantity === null ? "—" : e.quantity.toLocaleString()}</td>
                    <td className="num">{yen(e.grossAmount, e.currency)}</td>
                    <td className="num">{yen(e.amount, e.currency)}</td>
                    <td><button className="linky code" onClick={() => onOpenCondition(e.inConditionId)}>{e.inConditionNo ?? `#${e.inConditionId}`}</button>
                      <div className="faint">{e.partyName ?? ""}{e.workTitle ? ` · ${e.workTitle}` : ""}</div></td>
                    <td>{e.documentId
                      ? <>{onOpenDocument
                            ? <button className="linky code" onClick={() => onOpenDocument(e.documentId!)}>{e.documentNo ?? `#${e.documentId}`}</button>
                            : <span className="code">{e.documentNo ?? `#${e.documentId}`}</span>}
                          {e.documentStatus === "superseded" && <span className="tag" style={{ marginLeft: 4 }}>訂正版あり</span>}</>
                      : <span className="faint">未作成</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="faint">まだ報告はありません。</div>}
      </div>
    </div>
  );
}
