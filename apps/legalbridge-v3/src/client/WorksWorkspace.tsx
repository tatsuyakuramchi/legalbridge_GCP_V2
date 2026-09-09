import { useEffect, useState } from "react";
import { ListSearch, useDebounced } from "./ListTools.js";
import type { ConditionSummary, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { Relations, type EntityKind } from "./Relations.js";
import { CreateForm, int, text } from "./CreateForm.js";

interface WorkRow { id: number; workCode: string | null; title: string; kind: string; status: string }
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
    Promise.all([
      api.get<{ envelope: RightsEnvelope; parts: Part[] }>(`/works/${selected}/envelope`),
      api.get<{ conditions: ConditionSummary[] }>(`/conditions?workId=${selected}`)
    ]).then(([e, c]) => {
      setEnvelope(e.envelope); setParts(e.parts); setConditions(c.conditions);
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
        <CreateForm
          title="作品の登録"
          path="/works"
          initial={{ kind: "own", status: "planning" }}
          fields={[
            { name: "title", label: "作品名", required: true },
            { name: "titleKana", label: "カナ" },
            { name: "kind", label: "種別", type: "select", required: true,
              options: [{ value: "own", label: "自社作品" }, { value: "source_ip", label: "原作IP" },
                        { value: "derivative", label: "派生作品" }] },
            { name: "status", label: "状態", type: "select", required: true,
              options: [{ value: "planning", label: "企画中" }, { value: "in_production", label: "制作中" },
                        { value: "released", label: "発売済" }, { value: "archived", label: "終了" }] },
            { name: "businessLine", label: "事業区分" },
            { name: "parentWorkId", label: "親作品ID", type: "number",
              visibleWhen: (v) => v.kind === "derivative",
              hint: "指定すると系譜に登録する" },
            { name: "remarks", label: "備考", type: "textarea" }
          ]}
          toPayload={(v) => ({
            title: text(v.title), titleKana: text(v.titleKana), kind: v.kind, status: v.status,
            businessLine: text(v.businessLine), parentWorkId: int(v.parentWorkId), remarks: text(v.remarks)
          })}
          onDone={(r) => { setCreating(null); reloadWorks(r.id); }}
          onCancel={() => setCreating(null)}
        />
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
    </section>
  );
}
