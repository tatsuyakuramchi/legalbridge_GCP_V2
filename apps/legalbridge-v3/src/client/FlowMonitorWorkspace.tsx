import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

interface Pipeline { agreements: number; ordered: number; delivered: number; inspected: number; unpaid: number }
interface DueCheck { verdict: "ok" | "over_limit" | "unset" | "not_applicable"; days: number | null; limitDate: string | null; overBy: number | null }
interface Payment {
  id: number; direction: "in" | "out"; party: { name: string; kind: string } | null;
  currency: string; amount: number; basisReceivedOn: string | null; dueOn: string | null;
  status: string; due: DueCheck; allocations: Array<{ conditionNo: string | null }>;
}
interface WorkMonitor {
  workId: number; workCode: string | null; title: string;
  acquiredCount: number; grantedCount: number;
  termLimit: string | null; termLimitedBy: string | null;
  violations: Array<{
    conditionId: number; conditionNo: string | null; counterparty: string | null;
    check: { verdict: string; violations: Array<{ dimension: string; expected: string; actual: string; limitedBy: string | null }> };
  }>;
}

const DUE_LABEL: Record<DueCheck["verdict"], { text: string; tone: string }> = {
  ok: { text: "適合", tone: "ok" },
  over_limit: { text: "期日超過", tone: "out" },
  unset: { text: "期日未設定", tone: "out" },
  not_applicable: { text: "対象外", tone: "" }
};

export function FlowMonitorWorkspace({ onOpenCondition }: { onOpenCondition: (id: number) => void }) {
  const [tab, setTab] = useState<"outsourcing" | "works">("outsourcing");
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [works, setWorks] = useState<WorkMonitor[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ pipeline: Pipeline }>("/monitoring/outsourcing"),
      api.get<{ payments: Payment[] }>("/payments?direction=out"),
      api.get<{ works: WorkMonitor[] }>("/monitoring/works")
    ]).then(([p, pay, w]) => {
      setPipeline(p.pipeline); setPayments(pay.payments); setWorks(w.works);
    }).catch((e: ApiError) => setError(e.message));
  }, []);

  const flagged = payments.filter((p) => p.due.verdict === "over_limit" || p.due.verdict === "unset");
  const violating = works.filter((w) => w.violations.length > 0);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>フロー監視</h1>
        <p>案件をまたいで積み上がるものを見る。案件は1件の実行、ここは全案件を横断した遵守状況と作品ごとの権利上限。</p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="tabs">
        <button aria-selected={tab === "outsourcing"} onClick={() => setTab("outsourcing")}>
          業務委託（取適法）{flagged.length ? ` ${flagged.length}` : ""}
        </button>
        <button aria-selected={tab === "works"} onClick={() => setTab("works")}>
          作品運用{violating.length ? ` ${violating.length}` : ""}
        </button>
      </div>

      {tab === "outsourcing" && (
        <div className="stack">
          {pipeline && (
            <div className="pipe">
              {([["①", "基本契約", pipeline.agreements, ""],
                 ["②", "発注", pipeline.ordered, ""],
                 ["③", "納品・報告", pipeline.delivered, ""],
                 ["④", "検収", pipeline.inspected, ""],
                 ["⑤", "支払", pipeline.unpaid, flagged.length ? "flag" : ""]] as const).map(([no, name, count, cls]) => (
                <div key={name} className={`pipe-step ${cls}`}>
                  <span className="st">{no}</span><span className="nm">{name}</span>
                  <span className="ct">{count}</span>
                </div>
              ))}
            </div>
          )}

          {flagged.length > 0 && (
            <div className="alert">
              支払期日に問題があるものが {flagged.length} 件あります（受領日から60日以内かつできる限り短い期間内に定める必要があります）。
            </div>
          )}

          <div className="panel">
            <div className="panel-hd"><h2>支払期日の遵守状況</h2><span className="faint">自社が支払う側のみ</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>相手先</th><th>適用</th><th className="num">税抜</th>
                  <th>受領日</th><th>期日</th><th className="num">日数</th><th>判定</th><th>状態</th>
                </tr></thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.party?.name ?? "—"}</td>
                      <td>{p.party?.kind === "individual"
                        ? <span className="tag warn">対象</span> : <span className="tag">対象外</span>}</td>
                      <td className="num">{money(p.amount, p.currency)}</td>
                      <td className="code">{p.basisReceivedOn ?? "—"}</td>
                      <td className="code">{p.dueOn ?? "—"}</td>
                      <td className="num">{p.due.days ?? "—"}</td>
                      <td>
                        <span className={`tag ${DUE_LABEL[p.due.verdict].tone}`}>{DUE_LABEL[p.due.verdict].text}</span>
                        {p.due.overBy && <div className="faint">上限 {p.due.limitDate}</div>}
                      </td>
                      <td><span className="tag">{p.status}</span></td>
                    </tr>
                  ))}
                  {!payments.length && <tr><td colSpan={8} className="faint">支払がありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>検査しているルール</h2></div>
            <div className="panel-bd stack">
              <div className="note">
                <b>取引条件の書面明示</b> — 発注書の必須項目が埋まっていなければ発行できない（テンプレートの
                required で宣言する）。
              </div>
              <div className="note">
                <b>支払期日は受領日から60日以内</b> — 納品の受領日を起算点に自動計算し、期日の既定値にする。
                61日以降になっていれば一覧に出し、データ品質の記録に残す。
              </div>
              <div className="faint">
                判定ルールは運用で調整できる想定です。起算日の定義（継続的な役務の扱い）を含め、
                最終的な適法性の判断は法務が行う前提で設計しています。
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "works" && (
        <div className="stack">
          {violating.length > 0 && (
            <div className="alert">
              権利の上限を外れている展開が {violating.reduce((n, w) => n + w.violations.length, 0)} 件あります。
            </div>
          )}
          <div className="panel">
            <div className="panel-hd"><h2>作品ごとの権利上限</h2><span className="faint">展開の多い順</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>作品</th><th className="num">取得</th><th className="num">展開</th>
                  <th>期間の上限</th><th>照合</th>
                </tr></thead>
                <tbody>
                  {works.map((w) => (
                    <tr key={w.workId}>
                      <td><span className="code">{w.workCode ?? `#${w.workId}`}</span>
                          <div className="faint">{w.title}</div></td>
                      <td className="num">{w.acquiredCount}</td>
                      <td className="num">{w.grantedCount}</td>
                      <td className="code">{w.termLimit ?? "期限なし"}
                          {w.termLimitedBy && <div className="faint">{w.termLimitedBy}</div>}</td>
                      <td>
                        {w.violations.length === 0
                          ? <span className="tag ok">すべて上限内</span>
                          : w.violations.map((v) => (
                              <div key={v.conditionId} style={{ marginBottom: 4 }}>
                                <span className="tag out">上限外</span>{" "}
                                <span className="code" style={{ cursor: "pointer" }}
                                      onClick={() => onOpenCondition(v.conditionId)}>
                                  {v.conditionNo ?? `#${v.conditionId}`}
                                </span>
                                <div className="faint">
                                  {v.check.violations.map((x) => `${x.dimension}：${x.actual}（上限 ${x.expected}）`).join(" ／ ")}
                                </div>
                              </div>
                            ))}
                      </td>
                    </tr>
                  ))}
                  {!works.length && <tr><td colSpan={5} className="faint">展開のある作品がありません</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="panel-bd" style={{ paddingTop: 10 }}>
              <div className="faint">
                照合は個々の取得条件ではなく、構成パート全部の取得条件の積に対して行います。
                本文が商品化まで取れていても挿絵が出版までなら、作品としては商品化できません。
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
