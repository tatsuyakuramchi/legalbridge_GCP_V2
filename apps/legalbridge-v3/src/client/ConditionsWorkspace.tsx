import { useEffect, useState } from "react";
import { ConditionEvents } from "./ConditionEvents.js";
import { DocumentImport } from "./DocumentImport.js";
import { ConditionSchedules } from "./ConditionSchedules.js";
import { ConditionRevisions } from "./ConditionRevisions.js";
import { ConditionEdit } from "./ConditionEdit.js";
import { ConditionMatters, ConditionScopes } from "./ConditionLinks.js";
import { Relations, type EntityKind } from "./Relations.js";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { CONDITION_KIND_LABEL, StatusTag } from "./labels.js";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import type { ConditionDetail, ConditionSummary, EnvelopeCheck, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError, money, rate } from "./api.js";
import { CreateForm, int, text } from "./CreateForm.js";

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
  /** 実際に計算に使った版。契約変更の適用開始日をまたぐと、渡した版と変わる。 */
  appliedVersion: {
    id: number; conditionNo: string | null; effectiveFrom: string | null; switched: boolean;
  } | null;
};
type WriteResult = {
  changed: Array<{ target: string; rows: number }>;
  resolvesThrough: Array<{ target: string; rows: number }>;
  revisedTo?: number;
};

export function ConditionsWorkspace(
  { initialId, onCompose, onOpen }:
  {
    initialId?: number;
    onCompose?: (conditionIds: number[], eventIds?: number[]) => void;
    onOpen?: (kind: EntityKind, id: number) => void;
  }
) {
  const [rows, setRows] = useState<ConditionSummary[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "in" | "out">("all");
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sales, setSales] = useState("");
  const [royalty, setRoyalty] = useState<RoyaltyPreview | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState(false);
  const search = useDebounced(keyword);

  function reload(select?: number) {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("direction", filter);
    if (search.trim()) params.set("q", search.trim());
    const query = params.toString() ? `?${params}` : "";
    api.get<{ conditions: ConditionSummary[] }>(`/conditions${query}`)
      .then((r) => {
        setRows(r.conditions);
        if (select) setSelected(select);
        else if (!selected && r.conditions[0]) setSelected(r.conditions[0].id);
      })
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reload(); }, [filter, search]);

  useEffect(() => {
    if (!selected) return;
    // ここでは結果を消さない。改訂は保存の直後に選択が新版へ移るので、
    // 消すと「改訂しました」が出た瞬間に消える。消すのは行を選んだときだけ。
    setEditing(false);
    api.get<DetailResponse>(`/conditions/${selected}`)
      .then(setDetail)
      .catch((e: ApiError) => setError(e.message));
    setStmtOpen(false); setStmtDone(null); setStmtPeriod(""); setStmtOn("");
  }, [selected]);

  // 予定・実績・文書は繋がっているので、どれか1つが動いたら全部引き直す。
  // 予定から実績にしたのに実績の表が古いままだと、入ったのかどうか分からない。
  const [flowVersion, setFlowVersion] = useState(0);
  async function refreshFlow() {
    setFlowVersion((v) => v + 1);
    if (selected) setDetail(await api.get<DetailResponse>(`/conditions/${selected}`));
  }

  // 計算書の発行。試算とは別物で、こちらは実績が立ち AG も進む。
  const [stmtOpen, setStmtOpen] = useState(false);
  const [stmtTemplate, setStmtTemplate] = useState("");
  const [stmtPeriod, setStmtPeriod] = useState("");
  const [stmtOn, setStmtOn] = useState("");
  const [stmtBusy, setStmtBusy] = useState(false);
  const [stmtDone, setStmtDone] = useState<string | null>(null);
  const [templates, setTemplates] = useState<
    Array<{ templateKey: string; label: string; category: string | null }>>([]);

  useEffect(() => {
    if (!stmtOpen || templates.length) return;
    api.get<{ templates: Array<{ templateKey: string; label: string; category: string | null }> }>(
      "/document-templates")
      .then((r) => { setTemplates(r.templates); setStmtTemplate(r.templates[0]?.templateKey ?? ""); })
      .catch((e: ApiError) => setError(e.message));
  }, [stmtOpen]);

  /**
   * 条件から計算書を出す。文書を先に発行してから結び付ける手順は実務の順番と
   * 逆だったので、下書き→発行→確定をサーバ側で1本にしてある。
   */
  async function issueStatement() {
    if (!detail) return;
    setStmtBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { documentNo: string } }>(
        `/conditions/${detail.id}/statement-documents`,
        {
          templateKey: stmtTemplate, period: stmtPeriod.trim(),
          occurredOn: stmtOn || null,
          reported: { salesInput: Number(sales.replace(/[^0-9]/g, "")) || 0 }
        });
      setStmtDone(r.document.documentNo);
      setStmtOpen(false);
      await refreshFlow();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setStmtBusy(false); }
  }

  // ロイヤリティの試算。保存しないので何度でも押せる。
  async function previewRoyalty() {
    if (!detail) return;
    setError(null);
    try {
      setRoyalty(await api.post<RoyaltyPreview>(`/conditions/${detail.id}/royalty-preview`, {
        period: "試算", occurredOn: stmtOn || null,
        reported: { salesInput: Number(sales.replace(/[^0-9]/g, "")) || 0 }
      }));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }


  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>条件明細</h1>
        <p>
          条件明細は契約（合意）の中の1行です。金額と料率をここが持ち、期間と更新は契約が持ちます。
          取得（IN）と許諾（OUT）を同じ一覧で扱います。書類は条件明細の出力物なので、
          書類を作り直しても条件明細は動きません。
        </p>
      </header>

      <div className="filters">
        {(["all", "in", "out"] as const).map((value) => (
          <button key={value} className="chip" aria-pressed={filter === value}
                  onClick={() => setFilter(value)}>
            {value === "all" ? "すべて" : value === "in" ? "IN 取得" : "OUT 許諾"}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        {!creating && <button className="btn primary btn-sm" onClick={() => setCreating(true)}>条件を登録</button>}
      </div>

      {creating && (
        <ConditionCreateForm
          onDone={(r: { id: number }) => { setCreating(false); reload(r.id); }}
          onCancel={() => setCreating(false)} />
      )}

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <div className="panel">
          <div className="panel-hd">
            <h2>一覧</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="名称・条件番号・相手先" label="条件を絞り込む" />
          </div>
          <ListCount shown={rows.length} keyword={search} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr><th>番号</th><th>種類</th><th>向き</th><th>名称 / 相手先</th><th>載っている契約</th><th className="num">金額・料率</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selected ? "sel" : ""} tabIndex={0}
                      aria-selected={row.id === selected}
                      onClick={() => { setResult(null); setSelected(row.id); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault(); setResult(null); setSelected(row.id);
                        }
                      }}>
                    <td className="code">
                      {row.conditionNo ?? `#${row.id}`}
                      {/* 有効でない版は一覧でも見分けが付かないと、
                          適用待ちや旧版を開いて「直せない」と戸惑う。 */}
                      {row.status !== "active" && (
                        <div style={{ marginTop: 3 }}>
                          <StatusTag kind="condition" value={row.status} />
                          {row.status === "scheduled" && row.effectiveFrom && (
                            <span className="faint">　{row.effectiveFrom}〜</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td><span className="tag">{CONDITION_KIND_LABEL[row.kind] ?? row.kind}</span></td>
                    <td><span className={`tag ${row.direction}`}>{row.direction === "in" ? "IN" : "OUT"}</span></td>
                    <td>{row.name}<div className="faint">{row.counterparty?.name ?? "未設定"}</div></td>
                    {/* 条件は契約の明細。どの契約の行かが見えないと、条件そのものが
                        書類のように見える。 */}
                    <td className="faint">
                      {row.agreement
                        ? <><span className="code">{row.agreement.agreementNo ?? `#${row.agreement.id}`}</span>
                            <div>{row.agreement.title}</div></>
                        : "契約に載っていません"}
                    </td>
                    <td className="num">
                      {row.pricingModel === "revenue_rate" ? rate(row.ratePpm) : money(row.flatAmount, row.currency)}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={6} className="faint">
                    {search.trim() ? `「${search}」に一致する条件明細はありません` : "条件明細がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ListLimit shown={rows.length} />
        </div>

        <div className="stack">
          {detail && (
            <>
              {editing && (
                <ConditionEdit detail={detail}
                  onCancel={() => setEditing(false)}
                  onDone={async (r) => {
                    setEditing(false);
                    setResult(r);
                    // 改訂されたら新版へ移る。旧版を見続けても直せない。
                    const next = r.revisedTo ?? detail.id;
                    if (next !== detail.id) setSelected(next);
                    else setDetail(await api.get<DetailResponse>(`/conditions/${detail.id}`));
                    reload();
                  }} />
              )}

              <div className="panel">
                <div className="panel-hd">
                  <h2 className="code">{detail.conditionNo ?? `#${detail.id}`}</h2>
                  <span className="tag">{CONDITION_KIND_LABEL[detail.kind] ?? detail.kind}</span>
                  <span className={`tag ${detail.direction}`}>{detail.direction === "in" ? "IN 取得" : "OUT 許諾"}</span>
                  <StatusTag kind="condition" value={detail.status} />
                  {!editing && detail.status !== "void" && detail.status !== "superseded" && (
                    <span className="row" style={{ marginLeft: "auto" }}>
                      {/* 条件は文書の元。ここから作れないと、文書の画面へ行って
                          条件を探し直すことになる。 */}
                      {onCompose && (
                        <button className="btn btn-sm primary"
                                onClick={() => onCompose([detail.id])}>この条件で文書を作る</button>
                      )}
                      <button className="btn btn-sm" onClick={() => setEditing(true)}>編集</button>
                    </span>
                  )}
                </div>
                <div className="panel-bd stack">
                  {/* 条件は契約の明細。どの契約の行なのかを先に出す。 */}
                  <div className="note">
                    {detail.agreementId ? (<>
                      <b>{detail.agreementTitle ?? `契約 #${detail.agreementId}`}</b> の条件明細です。
                      {onOpen && (
                        <button className="btn btn-sm" style={{ marginLeft: 8 }}
                                onClick={() => onOpen("agreement", detail.agreementId!)}>
                          契約を開く
                        </button>
                      )}
                    </>) : (<>
                      どの契約にも載っていない条件明細です。条件は契約の明細なので、
                      下の「つながり」から契約に載せてください。
                    </>)}
                  </div>
                  <div className="title">{detail.name}</div>
                  <dl className="dl">
                    <dt>相手先</dt><dd>{detail.counterparty?.name ?? "未設定"}</dd>
                    <dt>作品</dt><dd>{detail.work?.title ?? "—"}{detail.workPartName ? `／${detail.workPartName}` : ""}</dd>
                    <dt>期間</dt><dd className="code">{detail.termStart ?? "—"} → {detail.termEnd ?? "期限なし"}</dd>
                    <dt>算定</dt><dd>{
                      detail.pricingModel === "revenue_rate" ? `売上料率 ${rate(detail.ratePpm)}`
                      : detail.pricingModel === "unit_rate" ? `単価 ${money(detail.unitAmount, detail.currency)} × 数量`
                      : money(detail.flatAmount, detail.currency)
                    }</dd>
                    <dt>税区分</dt><dd>{
                      { taxable: "課税 10%", reduced: "軽減 8%", exempt: "非課税・不課税" }[detail.taxCategory]
                    }</dd>
                    {detail.paymentTerms && (<><dt>支払条件</dt><dd>{detail.paymentTerms}</dd></>)}
                    {detail.spec && (<><dt>仕様・成果物</dt><dd style={{ whiteSpace: "pre-wrap" }}>{detail.spec}</dd></>)}
                    {detail.deliverableOwnership && (<><dt>帰属先</dt>
                      <dd>{detail.deliverableOwnership === "orderer" ? "発注者（譲渡型）" : "受注者（利用許諾型）"}</dd></>)}
                    {detail.notes && (<><dt>備考</dt><dd>{detail.notes}</dd></>)}
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
                <div className="panel-hd">
                  <h2>この条件から出た文書</h2>
                  <span className="faint">契約書・発注書はここから。検収書・計算書は下の実績から</span>
                  {onCompose && detail.status !== "void" && detail.status !== "superseded" && (
                    <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                            onClick={() => onCompose([detail.id])}>文書を作る</button>
                  )}
                </div>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>文書番号</th><th>状態</th><th>決定日</th></tr></thead>
                    <tbody>
                      {detail.documents.map((d) => (
                        <tr key={d.id}>
                          <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                          <td><StatusTag kind="document" value={d.status} /></td>
                          <td className="code">{d.issuedAt?.slice(0, 10) ?? "—"}</td>
                        </tr>
                      ))}
                      {!detail.documents.length && <tr><td colSpan={3} className="faint">まだ文書は出ていません</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="panel-bd">
                  <DocumentImport conditionId={detail.id} onDone={refreshFlow} />
                </div>
              </div>

              {detail.direction === "out" && detail.pricingModel === "revenue_rate" && (
                <div className="panel">
                  <div className="panel-hd"><h2>ロイヤリティ試算</h2><span className="faint">保存しません</span></div>
                  <div className="panel-bd stack">
                    <div className="form-grid">
                      <label className="field">
                        <span>報告売上</span>
                        <input value={sales} onChange={(e) => setSales(e.target.value)} placeholder="例: 4896000" />
                      </label>
                      <label className="field">
                        <span>対象日</span>
                        <input type="date" value={stmtOn}
                               onChange={(e) => setStmtOn(e.target.value)} />
                        <small className="faint">
                          契約変更をまたぐときは、その日に効いていた版で計算します
                        </small>
                      </label>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={previewRoyalty} disabled={!sales}>試算する</button>
                      {royalty && !stmtOpen && (
                        <button className="btn primary" onClick={() => { setStmtOpen(true); setStmtDone(null); }}>
                          この内容で計算書を出す
                        </button>
                      )}
                    </div>

                    {stmtDone && (
                      <div className="note ok">
                        計算書 <span className="code">{stmtDone}</span> を決定しました。
                        金額は決定のときに計算し直しています（試算の値は使いません）。
                      </div>
                    )}

                    {stmtOpen && (
                      <div className="stack" style={{ gap: 8 }}>
                        <div className="form-grid">
                          <label className="field">
                            <span>ひな形</span>
                            <select value={stmtTemplate} onChange={(e) => setStmtTemplate(e.target.value)}>
                              {templates.map((t) => (
                                <option key={t.templateKey} value={t.templateKey}>
                                  {t.category ? `${t.category}／${t.label}` : t.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            <span>対象期間</span>
                            <input value={stmtPeriod} placeholder="2026Q2 / 2026-06"
                                   onChange={(e) => setStmtPeriod(e.target.value)} />
                          </label>
                          <label className="field">
                            <span>発生日</span>
                            <input type="date" value={stmtOn}
                                   onChange={(e) => setStmtOn(e.target.value)} />
                          </label>
                        </div>
                        <div className="row">
                          <button className="btn primary btn-sm"
                                  disabled={stmtBusy || !stmtTemplate || !stmtPeriod.trim()}
                                  onClick={() => void issueStatement()}>決定して確定する</button>
                          <button className="btn btn-sm" onClick={() => setStmtOpen(false)}>やめる</button>
                          <span className="faint">実績が1件立ち、AGの消化もここで進みます</span>
                        </div>
                      </div>
                    )}
                    {royalty?.appliedVersion?.switched && (
                      <div className="note warn">
                        契約変更の適用開始日をまたぐので、
                        <b>{royalty.appliedVersion.effectiveFrom} から適用の
                        {royalty.appliedVersion.conditionNo ?? `#${royalty.appliedVersion.id}`}</b>
                        で計算しました。対象日を変えると版も変わります。
                      </div>
                    )}

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

              <ConditionRevisions conditionId={detail.id} onOpen={(id) => {
                setResult(null); setSelected(id);
              }} />

              <ConditionSchedules conditionId={detail.id} reloadKey={flowVersion}
                editable={detail.status === "active" || detail.status === "draft"}
                onChanged={refreshFlow} />

              <ConditionEvents conditionId={detail.id} currency={detail.currency}
                reloadKey={flowVersion}
                editable={detail.status === "active" || detail.status === "draft"}
                onCompose={onCompose}
                onChanged={refreshFlow} />

              <ConditionMatters detail={detail} onDone={async () => {
                setDetail(await api.get<DetailResponse>(`/conditions/${detail.id}`));
                refreshFlow();
              }} />

              <ConditionScopes detail={detail} onDone={async () => {
                setDetail(await api.get<DetailResponse>(`/conditions/${detail.id}`));
              }} />

              {/* 案件は上に専用のパネルがある（新しく作れる）ので、ここには出さない。 */}
              <Relations kind="condition" id={detail.id} reloadKey={flowVersion}
                exclude={["matters"]} onOpen={onOpen} onChanged={refreshFlow} />

              {result && (
                <div className="panel">
                  <div className="panel-hd"><h2>保存の結果</h2><span className="faint">どこが書き換わったか</span></div>
                  <div className="panel-bd">
                    {(
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
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
