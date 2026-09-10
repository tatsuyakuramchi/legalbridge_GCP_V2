import { useEffect, useState } from "react";
import { ListSearch, useDebounced } from "./ListTools.js";
import type { ConditionSummary, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import { Relations, type EntityKind } from "./Relations.js";
import { CreateForm, int, text } from "./CreateForm.js";
import { WorkCreateForm } from "./WorkCreateForm.js";
import { EVENT_TYPE_LABEL } from "./labels.js";

interface WorkRow { id: number; workCode: string | null; title: string; kind: string; status: string }

/**
 * 作品にぶら下がっている動き。
 *
 * 作品が軸なのに、この画面は取得条件と展開条件までしか見せていなかった。
 * 実績も計算書も支払も作品にぶら下がるのに、条件を1本ずつ開いて数え直さないと
 * 「この作品はいくら生んだのか」が読めなかった。
 */
interface Activity {
  events: Array<{ id: number; eventType: string; occurredOn: string | null; period: string | null;
                  quantity: number | null; amount: number; currency: string;
                  conditionId: number; conditionNo: string | null; conditionName: string;
                  documentId: number | null; documentNo: string | null }>;
  statements: Array<{ id: number; period: string; currency: string; netAmount: number;
                      taxAmount: number; conditionNo: string | null; conditionName: string;
                      documentId: number; documentNo: string | null; documentStatus: string }>;
  payments: Array<{ id: number; paymentNo: string | null; direction: string; currency: string;
                    amount: number; taxAmount: number; withholdingAmount: number;
                    dueOn: string | null; paidOn: string | null; status: string;
                    partyName: string | null }>;
  documents: Array<{ id: number; documentNo: string | null; status: string;
                     issuedAt: string | null; templateLabel: string | null }>;
}
interface Part { id: number; partNo: number; name: string; partType: string; royaltyBearing: boolean }

const DIMENSION_LABEL: Record<string, string> = {
  region: "地域", language: "言語", media: "媒体", channel: "チャネル"
};

export function WorksWorkspace(
  { onOpenCondition, initialId, onOpen }: {
    onOpenCondition: (id: number) => void;
    initialId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
  }
) {
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [envelope, setEnvelope] = useState<RightsEnvelope | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"work" | "part" | null>(null);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);

  function reloadWorks(select?: number) {
    const q = search.trim();
    api.get<{ works: WorkRow[] }>(`/works${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => { setWorks(r.works); if (select) setSelected(select); else if (!selected && r.works[0]) setSelected(r.works[0].id); })
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reloadWorks(); }, [search]);

  function reloadParts() {
    if (!selected) return;
    api.get<{ envelope: RightsEnvelope; parts: Part[] }>(`/works/${selected}/envelope`)
      .then((e) => { setEnvelope(e.envelope); setParts(e.parts); })
      .catch((e: ApiError) => setError(e.message));
  }

  useEffect(() => {
    if (!selected) return;
    setActivity(null);
    Promise.all([
      api.get<{ envelope: RightsEnvelope; parts: Part[] }>(`/works/${selected}/envelope`),
      api.get<{ conditions: ConditionSummary[] }>(`/conditions?workId=${selected}`),
      api.get<Activity>(`/works/${selected}/activity`)
    ]).then(([e, c, a]) => {
      setEnvelope(e.envelope); setParts(e.parts); setConditions(c.conditions); setActivity(a);
    }).catch((e: ApiError) => setError(e.message));
  }, [selected]);

  const acquired = conditions.filter((c) => c.direction === "in");
  const granted = conditions.filter((c) => c.direction === "out");

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>作品</h1>
        <p>許諾できる上限は、構成パート全部の取得条件の積で決まる。個々の取得条件と比べると誤判定するので、ここを軸に見る。</p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="row" style={{ marginBottom: 10 }}>
        {creating === null && (
          <>
            <button className="btn primary btn-sm" onClick={() => setCreating("work")}>作品を登録</button>
            {selected && <button className="btn btn-sm" onClick={() => setCreating("part")}>パートを追加</button>}
          </>
        )}
      </div>

      {creating === "work" && (
        <WorkCreateForm
          onDone={(r) => { setCreating(null); reloadWorks(r.id); }}
          onCancel={() => setCreating(null)} />
      )}

      {creating === "part" && selected && (
        <CreateForm
          title="構成パートの追加"
          path={`/works/${selected}/parts`}
          initial={{ partType: "unspecified", royaltyBearing: "1" }}
          fields={[
            { name: "name", label: "パート名", required: true, placeholder: "本文 / 挿絵 / 装丁 など" },
            { name: "partType", label: "種類", type: "select",
              options: [{ value: "unspecified", label: "未指定" }, { value: "text", label: "文章" },
                        { value: "illustration", label: "イラスト" }, { value: "design", label: "デザイン" },
                        { value: "music", label: "音楽" }, { value: "photo", label: "写真" }] },
            { name: "royaltyBearing", label: "ロイヤリティの対象", type: "checkbox" },
            { name: "remarks", label: "備考", type: "textarea" }
          ]}
          toPayload={(v) => ({
            name: text(v.name), partType: text(v.partType),
            royaltyBearing: v.royaltyBearing === "1", remarks: text(v.remarks)
          })}
          onDone={() => { setCreating(null); reloadParts(); }}
          onCancel={() => setCreating(null)}
        >
          <p className="faint">パートを足すと、この作品で確認すべき権利が1つ増える。許諾できる上限は全パートの取得条件の積で決まる。</p>
        </CreateForm>
      )}

      <div className="panel">
        <div className="panel-hd">
          <h2>作品を選ぶ</h2>
          <ListSearch value={keyword} onChange={setKeyword}
            placeholder="作品名・作品コード" label="作品を絞り込む" />
        </div>
        <div className="list-count">
          {search.trim()
            ? <span>「{search}」に一致 <b className="num">{works.length}</b> 件</span>
            : <span><b className="num">{works.length}</b> 件</span>}
          {works.length >= 200 && <span className="faint">200 件まで。絞り込むと残りも見つかります</span>}
        </div>
        <div className="panel-bd">
          {works.length ? (
            <div className="filters">
              {works.map((w) => (
                <button key={w.id} className="chip" aria-pressed={w.id === selected}
                        onClick={() => setSelected(w.id)}>
                  {w.title}
                </button>
              ))}
            </div>
          ) : (
            <div className="faint">
              {search.trim() ? `「${search}」に一致する作品はありません` : "作品がありません"}
            </div>
          )}
        </div>
      </div>

      {envelope && (
        <div className="split">
          <div className="stack">
            <div className="panel">
              <div className="panel-hd">
                <h2 className="code">{envelope.workCode ?? `#${envelope.workId}`}</h2>
                <span>{envelope.title}</span>
                <span className="tag">{envelope.acquiredCount}件の取得条件</span>
              </div>
              <div className="panel-bd">
                {envelope.acquiredCount === 0 ? (
                  <div className="note">この作品には取得条件がありません。上限が決まらないため、展開の照合もできません。</div>
                ) : (
                  <table>
                    <thead><tr><th>次元</th><th>上限</th><th>狭めている取得条件</th></tr></thead>
                    <tbody>
                      {envelope.scopes.map((s) => (
                        <tr key={s.scopeType}>
                          <td>{DIMENSION_LABEL[s.scopeType] ?? s.scopeType}</td>
                          <td>{s.labels.join("・")}</td>
                          <td className="faint">—</td>
                        </tr>
                      ))}
                      <tr>
                        <td>期間</td>
                        <td>{envelope.termLimit ? `${envelope.termLimit} まで` : "期限なし"}</td>
                        <td className="code faint">{envelope.termLimitedBy ?? "—"}</td>
                      </tr>
                      <tr>
                        <td>独占</td>
                        <td>{envelope.exclusivityLimit === "non_exclusive" ? "非独占のみ"
                          : envelope.exclusivityLimit === "exclusive" ? "独占可" : "—"}</td>
                        <td className="code faint">{envelope.exclusivityLimitedBy ?? "—"}</td>
                      </tr>
                      <tr>
                        <td>再許諾</td>
                        <td>{envelope.sublicensable ? "可" : "不可"}</td>
                        <td className="code faint">{envelope.sublicenseLimitedBy ?? "—"}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
                <div className="faint" style={{ marginTop: 9 }}>
                  上限に指定の無い次元は無制限として扱います（取得条件が地域を挙げていなければ全世界）。
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-hd"><h2>構成パート</h2></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>No</th><th>名称</th><th>種別</th><th>課金</th></tr></thead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={p.id}>
                        <td className="num">{p.partNo}</td><td>{p.name}</td><td>{p.partType}</td>
                        <td>{p.royaltyBearing ? <span className="tag ok">対象</span> : <span className="tag">対象外</span>}</td>
                      </tr>
                    ))}
                    {!parts.length && <tr><td colSpan={4} className="faint">パートがありません</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="panel">
              <div className="panel-hd"><h2>取得（IN）</h2><span className="faint">上限を決めているもの</span></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>条件番号</th><th>権利者</th><th>期間</th></tr></thead>
                  <tbody>
                    {acquired.map((c) => (
                      <tr key={c.id} onClick={() => onOpenCondition(c.id)}>
                        <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                        <td>{c.counterparty?.name ?? "—"}</td>
                        <td className="code">{c.termStart ?? "—"} → {c.termEnd ?? "期限なし"}</td>
                      </tr>
                    ))}
                    {!acquired.length && <tr><td colSpan={3} className="faint">取得条件がありません</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <div className="panel-hd"><h2>展開（OUT）</h2><span className="faint">上限との照合は条件詳細で</span></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>条件番号</th><th>展開先</th><th>期間</th></tr></thead>
                  <tbody>
                    {granted.map((c) => (
                      <tr key={c.id} onClick={() => onOpenCondition(c.id)}>
                        <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                        <td>{c.counterparty?.name ?? "—"}</td>
                        <td className="code">{c.termStart ?? "—"} → {c.termEnd ?? "—"}</td>
                      </tr>
                    ))}
                    {!granted.length && <tr><td colSpan={3} className="faint">まだ展開していません</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 作品からも条件明細へ辿れる。付け外しもここからできる。 */}
          {selected && <Relations kind="work" id={selected} onOpen={onOpen} />}
        </div>
      )}

      {/* 作品でいま何が起きているか。条件を1本ずつ開かずに読めるようにする。
          表が並ぶので、権利の話の2段組みには入れず、下に幅いっぱいで置く。 */}
      {envelope && activity && <WorkActivity activity={activity} onOpen={onOpen} />}
    </section>
  );
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  planned: "予定", approved: "承認済み", paid: "支払済み", canceled: "取消"
};

/**
 * 作品の動き。実績 → 計算書 → 文書 → 支払 の順に並べる。
 * 権利の話（上限・展開）とは別の軸なので、パネルを分けてある。
 */
function WorkActivity(
  { activity, onOpen }: { activity: Activity; onOpen?: (kind: EntityKind, id: number) => void }
) {
  const paid = activity.payments.filter((p) => p.status === "paid").length;
  const sum = (rows: Array<{ netAmount: number }>) =>
    rows.reduce((total, r) => total + r.netAmount, 0);
  const currency = activity.statements[0]?.currency ?? "JPY";

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>この作品の動き</h2>
        <span className="faint">
          実績 <b className="num">{activity.events.length}</b> 件 ／
          計算書 <b className="num">{activity.statements.length}</b> 件 ／
          文書 <b className="num">{activity.documents.length}</b> 件 ／
          支払 <b className="num">{activity.payments.length}</b> 件（うち支払済み {paid} 件）
        </span>
      </div>
      <div className="panel-bd stack">
        {activity.statements.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row">
              <b>計算書</b>
              <span className="faint">
                実額の合計 {money(sum(activity.statements), currency)}（税抜）
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>文書番号</th><th>取引モデル</th><th>期間</th>
                           <th className="num">実額（税抜）</th><th></th></tr></thead>
                <tbody>
                  {activity.statements.slice(0, 10).map((s) => (
                    <tr key={s.id}>
                      <td className="code">{s.documentNo ?? `#${s.documentId}`}</td>
                      <td>{s.conditionName}</td>
                      <td>{s.period}</td>
                      <td className="num">{money(s.netAmount, s.currency)}</td>
                      <td>
                        {onOpen && (
                          <button className="btn btn-sm"
                                  onClick={() => onOpen("document", s.documentId)}>開く</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activity.events.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>実績</b>
            <div className="tablewrap">
              <table>
                <thead><tr><th>発生日</th><th>取引モデル</th><th>種類</th><th>期間</th>
                           <th className="num">数量</th><th className="num">金額</th>
                           <th>結んだ文書</th></tr></thead>
                <tbody>
                  {activity.events.slice(0, 10).map((e) => (
                    <tr key={e.id}>
                      <td className="code">{e.occurredOn ?? "—"}</td>
                      <td>{e.conditionName}</td>
                      <td>{EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}</td>
                      <td>{e.period ?? "—"}</td>
                      <td className="num">{e.quantity ?? "—"}</td>
                      <td className="num">{money(e.amount, e.currency)}</td>
                      <td className="code faint">{e.documentNo ?? "（未結）"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {activity.events.length > 10 && (
              <span className="faint">直近 10 件。残りは条件明細の実績で見られます</span>
            )}
          </div>
        )}

        {activity.payments.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>支払・入金</b>
            <div className="tablewrap">
              <table>
                <thead><tr><th>支払番号</th><th>相手先</th><th>向き</th>
                           <th className="num">金額</th><th>期日</th><th>状態</th></tr></thead>
                <tbody>
                  {activity.payments.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
                      <td>{p.partyName ?? "—"}</td>
                      <td>{p.direction === "in" ? "入金" : "支払"}</td>
                      <td className="num">{money(p.amount, p.currency)}</td>
                      <td className="code">{p.dueOn ?? "—"}</td>
                      <td>{PAYMENT_STATUS_LABEL[p.status] ?? p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activity.documents.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>文書</b>
            <div className="picker">
              {activity.documents.slice(0, 20).map((d) => (
                <button key={d.id} className="btn btn-sm" style={{ textAlign: "left" }}
                        disabled={!onOpen} onClick={() => onOpen?.("document", d.id)}>
                  <span className="code">{d.documentNo ?? "（下書き）"}</span>
                  {" "}{d.templateLabel ?? "—"}
                </button>
              ))}
            </div>
          </div>
        )}

        {!activity.events.length && !activity.statements.length
          && !activity.documents.length && !activity.payments.length && (
          <div className="faint">
            この作品ではまだ実績も文書も動いていません。条件明細に実績を入れると、ここに並びます。
          </div>
        )}
      </div>
    </div>
  );
}
