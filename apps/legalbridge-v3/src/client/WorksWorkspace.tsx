import { useEffect, useState } from "react";
import type { ConditionSummary, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError } from "./api.js";

interface WorkRow { id: number; workCode: string | null; title: string; kind: string; status: string }
interface Part { id: number; partNo: number; name: string; partType: string; royaltyBearing: boolean }

const DIMENSION_LABEL: Record<string, string> = {
  region: "地域", language: "言語", media: "媒体", channel: "チャネル"
};

export function WorksWorkspace({ onOpenCondition }: { onOpenCondition: (id: number) => void }) {
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [selected, setSelected] = useState<number | undefined>();
  const [envelope, setEnvelope] = useState<RightsEnvelope | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ works: WorkRow[] }>("/works")
      .then((r) => { setWorks(r.works); if (r.works[0]) setSelected(r.works[0].id); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

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

      <div className="filters">
        {works.map((w) => (
          <button key={w.id} className="chip" aria-pressed={w.id === selected} onClick={() => setSelected(w.id)}>
            {w.title}
          </button>
        ))}
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
        </div>
      )}
    </section>
  );
}
