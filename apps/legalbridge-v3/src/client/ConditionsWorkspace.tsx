import { useEffect, useState } from "react";
import type { ConditionDetail, ConditionSummary, EnvelopeCheck, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError, money, rate } from "./api.js";

type DetailResponse = ConditionDetail & {
  envelopeCheck: { envelope: RightsEnvelope; check: EnvelopeCheck } | null;
};
type RoyaltyPreview = {
  fee: {
    gross_ex_tax: number; after_acceptance: number;
    mg_topup_this_time: number; mg_floor_applied: boolean;
    ag_offset_this_time: number; ag_remaining_after: number;
    actual_ex_tax: number; tax_amount: number; total_inc_tax: number;
    formula_breakdown: string;
  };
  payment: { withholdingEnabled: boolean; withholdingTax: number; netTransfer: number };
  agConsumedBefore: number;
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
  const [sales, setSales] = useState("");
  const [royalty, setRoyalty] = useState<RoyaltyPreview | null>(null);

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

  // ロイヤリティの試算。保存しないので何度でも押せる。
  async function previewRoyalty() {
    if (!detail) return;
    setError(null);
    try {
      setRoyalty(await api.post<RoyaltyPreview>(`/conditions/${detail.id}/royalty-preview`, {
        period: "試算",
        reported: { salesInput: Number(sales.replace(/[^0-9]/g, "")) || 0 }
      }));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

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

              {detail.direction === "out" && detail.pricingModel === "revenue_rate" && (
                <div className="panel">
                  <div className="panel-hd"><h2>ロイヤリティ試算</h2><span className="faint">保存しません</span></div>
                  <div className="panel-bd stack">
                    <label className="field">
                      <span>報告売上</span>
                      <input value={sales} onChange={(e) => setSales(e.target.value)} placeholder="例: 4896000" />
                    </label>
                    <div className="row">
                      <button className="btn" onClick={previewRoyalty} disabled={!sales}>試算する</button>
                    </div>
                    {royalty && (
                      <table>
                        <tbody>
                          <tr><td>グロス</td><td className="num">{money(royalty.fee.gross_ex_tax, detail.currency)}</td>
                              <td className="faint">{royalty.fee.formula_breakdown}</td></tr>
                          <tr><td>MG下限の上乗せ</td><td className="num">{money(royalty.fee.mg_topup_this_time, detail.currency)}</td>
                              <td className="faint">{royalty.fee.mg_floor_applied ? "下限が適用された" : "—"}</td></tr>
                          <tr><td>AG相殺</td><td className="num">{money(royalty.fee.ag_offset_this_time, detail.currency)}</td>
                              <td className="faint">消化済み {money(royalty.agConsumedBefore, detail.currency)} ／ 残 {money(royalty.fee.ag_remaining_after, detail.currency)}</td></tr>
                          <tr><td><b>税抜実額</b></td><td className="num"><b>{money(royalty.fee.actual_ex_tax, detail.currency)}</b></td>
                              <td className="faint">消費税 {money(royalty.fee.tax_amount, detail.currency)}</td></tr>
                          {royalty.payment.withholdingEnabled && (
                            <tr><td>源泉</td><td className="num">{money(royalty.payment.withholdingTax, detail.currency)}</td>
                                <td className="faint">振込 {money(royalty.payment.netTransfer, detail.currency)}</td></tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

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
