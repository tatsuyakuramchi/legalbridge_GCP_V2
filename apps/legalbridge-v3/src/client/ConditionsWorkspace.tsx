import { useEffect, useState } from "react";
import type { ConditionDetail, ConditionSummary, EnvelopeCheck, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError, money, rate } from "./api.js";

type DetailResponse = ConditionDetail & {
  envelopeCheck: { envelope: RightsEnvelope; check: EnvelopeCheck } | null;
};
type WriteResult = {
  changed: Array<{ target: string; rows: number }>;
  resolvesThrough: Array<{ target: string; rows: number }>;
  revisedTo?: number;
};

export function ConditionsWorkspace({ initialId }: { initialId?: number }) {
  const [rows, setRows] = useState<ConditionSummary[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "in" | "out">("all");
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = filter === "all" ? "" : `?direction=${filter}`;
    api.get<{ conditions: ConditionSummary[] }>(`/conditions${query}`)
      .then((r) => {
        setRows(r.conditions);
        if (!selected && r.conditions[0]) setSelected(r.conditions[0].id);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [filter]);

  useEffect(() => {
    if (!selected) return;
    setResult(null);
    api.get<DetailResponse>(`/conditions/${selected}`)
      .then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  async function raiseMg() {
    if (!detail) return;
    setError(null);
    try {
      const next = (detail.mgAmount ?? 0) + 100000;
      setResult(await api.patch<WriteResult>(`/conditions/${detail.id}`, { mgAmount: next }));
      setDetail(await api.get<DetailResponse>(`/conditions/${detail.id}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>条件</h1>
        <p>取得（IN）と許諾（OUT）を同じ一覧で扱う。文書は条件の出力物なので、作り直しても条件は動かない。</p>
      </header>

      <div className="filters">
        {(["all", "in", "out"] as const).map((value) => (
          <button key={value} className="chip" aria-pressed={filter === value}
                  onClick={() => setFilter(value)}>
            {value === "all" ? "すべて" : value === "in" ? "IN 取得" : "OUT 許諾"}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <div className="panel">
          <div className="panel-hd"><h2>一覧</h2></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>条件番号</th><th>向き</th><th>名称 / 相手先</th><th className="num">金額・料率</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selected ? "sel" : ""}
                      onClick={() => setSelected(row.id)}>
                    <td className="code">{row.conditionNo ?? `#${row.id}`}</td>
                    <td><span className={`tag ${row.direction}`}>{row.direction === "in" ? "IN" : "OUT"}</span></td>
                    <td>{row.name}<div className="faint">{row.counterparty?.name ?? "未設定"}</div></td>
                    <td className="num">
                      {row.pricingModel === "revenue_rate" ? rate(row.ratePpm) : money(row.flatAmount, row.currency)}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={4} className="faint">条件がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="stack">
          {detail && (
            <>
              <div className="panel">
                <div className="panel-hd">
                  <h2 className="code">{detail.conditionNo ?? `#${detail.id}`}</h2>
                  <span className={`tag ${detail.direction}`}>{detail.direction === "in" ? "IN 取得" : "OUT 許諾"}</span>
                  <span className="tag">{detail.status}</span>
                </div>
                <div className="panel-bd stack">
                  <div className="title">{detail.name}</div>
                  <dl className="dl">
                    <dt>相手先</dt><dd>{detail.counterparty?.name ?? "未設定"}</dd>
                    <dt>作品</dt><dd>{detail.work?.title ?? "—"}{detail.workPartName ? `／${detail.workPartName}` : ""}</dd>
                    <dt>期間</dt><dd className="code">{detail.termStart ?? "—"} → {detail.termEnd ?? "期限なし"}</dd>
                    <dt>算定</dt><dd>{detail.pricingModel === "revenue_rate" ? `売上料率 ${rate(detail.ratePpm)}` : money(detail.flatAmount, detail.currency)}</dd>
                    <dt>MG / AG</dt><dd className="code">{money(detail.mgAmount, detail.currency)} / {money(detail.agAmount, detail.currency)}</dd>
                  </dl>
                  {detail.scopes.length > 0 && (
                    <div className="chips">
                      {detail.scopes.map((s) => (
                        <span key={`${s.scopeType}:${s.label}`} className="tag accent">{s.label}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {detail.envelopeCheck && (
                <div className="panel">
                  <div className="panel-hd">
                    <h2>権利の上限との照合</h2>
                    <span className={`tag ${detail.envelopeCheck.check.verdict === "inside" ? "ok" : "out"}`}>
                      {detail.envelopeCheck.check.verdict === "inside" ? "上限内"
                        : detail.envelopeCheck.check.verdict === "outside" ? "上限外" : "判定不能"}
                    </span>
                  </div>
                  <div className="panel-bd">
                    {detail.envelopeCheck.check.violations.length === 0
                      ? <div className="faint">作品の権利包絡（構成パート全部の取得条件の積）に収まっています。</div>
                      : (
                        <table>
                          <thead><tr><th>次元</th><th>上限</th><th>この条件</th><th>狭めている条件</th></tr></thead>
                          <tbody>
                            {detail.envelopeCheck.check.violations.map((v) => (
                              <tr key={v.dimension}>
                                <td>{v.dimension}</td><td>{v.expected}</td>
                                <td className="bad">{v.actual}</td>
                                <td className="code faint">{v.limitedBy ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                  </div>
                </div>
              )}

              <div className="panel">
                <div className="panel-hd"><h2>この条件から出た文書</h2></div>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>文書番号</th><th>状態</th><th>発行</th></tr></thead>
                    <tbody>
                      {detail.documents.map((d) => (
                        <tr key={d.id}>
                          <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                          <td>{d.status}</td>
                          <td className="code">{d.issuedAt?.slice(0, 10) ?? "—"}</td>
                        </tr>
                      ))}
                      {!detail.documents.length && <tr><td colSpan={3} className="faint">まだ文書は出ていません</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel-hd"><h2>金額を変更する</h2><span className="faint">保存先はひとつ</span></div>
                <div className="panel-bd stack">
                  <button className="btn primary" onClick={raiseMg}>MG を 10万円 上げる</button>
                  {result && (
                    <div className="trace">
                      {result.revisedTo && (
                        <div className="trace-line">実績があるため改訂しました（新しい条件 #{result.revisedTo}）</div>
                      )}
                      {result.changed.map((c) => (
                        <div key={c.target} className="trace-line">書き換え：{c.target}（{c.rows}行）</div>
                      ))}
                      {result.resolvesThrough.map((r) => (
                        <div key={r.target} className="trace-line faint">参照で追随：{r.target} {r.rows}件</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
