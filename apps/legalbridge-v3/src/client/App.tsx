import { useEffect, useState } from "react";
import { api } from "./api.js";
import { GlobalSearch, type SearchHit } from "./GlobalSearch.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";
import { MoneyWorkspace } from "./MoneyWorkspace.js";
import { WorksWorkspace } from "./WorksWorkspace.js";
import { PartiesWorkspace } from "./PartiesWorkspace.js";
import { FlowMonitorWorkspace } from "./FlowMonitorWorkspace.js";
import { OpsWorkspace, HomeWorkspace, type OpsTab } from "./OpsWorkspace.js";

type View = "home" | "matters" | "conditions" | "works" | "parties" | "documents" | "money" | "flows" | "ops";
interface Me { user?: { email: string; role: string }; readOnly: boolean }

// 入口（案件）／横断で見る／監視・運用 の3段。案件が制御レイヤー、他は参照。
const NAV: Array<{ section: string; items: Array<{ view: View; label: string }> }> = [
  { section: "入口", items: [
    { view: "home", label: "ホーム" },
    { view: "matters", label: "案件" }
  ] },
  { section: "横断で見る", items: [
    { view: "conditions", label: "条件" },
    { view: "works", label: "作品" },
    { view: "parties", label: "取引先・担当" },
    { view: "documents", label: "文書" },
    { view: "money", label: "お金" }
  ] },
  { section: "監視・運用", items: [
    { view: "flows", label: "フロー監視" },
    { view: "ops", label: "運用" }
  ] }
];

export function App() {
  const [view, setView] = useState<View>("home");
  const [conditionId, setConditionId] = useState<number | undefined>();
  /** 検索結果から開いたときに、その画面で選んでおく行。 */
  const [focus, setFocus] = useState<{ view: View; id: number } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [opsTab, setOpsTab] = useState<OpsTab | undefined>();

  useEffect(() => { api.get<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);

  const openCondition = (id: number) => { setConditionId(id); setView("conditions"); };

  /**
   * 検索結果から開く。
   * 画面を切り替えるだけでは、押した相手をもう一度探させることになる。
   * 行を選べる画面には ID を渡して、開いた時点で選んでおく。
   */
  const openHit = (hit: SearchHit) => {
    if (hit.target === "condition") return openCondition(hit.id);
    setConditionId(undefined);
    const next = ({ matter: "matters", document: "documents", party: "parties",
                    work: "works", payment: "money" } as const)[hit.target];
    setFocus({ view: next, id: hit.id });
    setView(next);
  };

  /** その画面に渡す選択。別の画面へ移ったら持ち越さない。 */
  const focusFor = (view: View) => (focus && focus.view === view ? focus.id : undefined);

  /**
   * 文書を作りに行く。条件と実績を選んだ状態で「文書」画面を開く。
   * 作成のフォームは1つだけにしてあるので、どこから入っても同じものを見る。
   */
  const [compose, setCompose] = useState<{ conditionId: number; eventIds: number[] } | null>(null);
  const startCompose = (conditionId: number, eventIds: number[] = []) => {
    setCompose({ conditionId, eventIds });
    setFocus(null);
    setView("documents");
  };

  return (
    <div className="app">
      <nav className="rail" aria-label="主ナビゲーション">
        <div className="wordmark"><b>LegalBridge</b><span>Core</span></div>
        <GlobalSearch onOpen={openHit} />
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-sec">{group.section}</div>
            {group.items.map((item) => (
              <button key={item.view} className="nav-item"
                      aria-current={view === item.view ? "page" : undefined}
                      onClick={() => {
                        if (item.view === "conditions") setConditionId(undefined);
                        setFocus(null);
                        setView(item.view);
                      }}>{item.label}</button>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <div className="faint">{me?.user?.email ?? "未認証"}</div>
          <div className="faint">{me?.user?.role ?? "—"}{me?.readOnly ? " ／ 読み取り専用" : ""}</div>
        </div>
      </nav>

      <main className="main">
        {view === "home" && <HomeWorkspace onGo={(v, tab) => { setOpsTab(tab); setView(v); }} />}
        {view === "matters" && (
          <MattersWorkspace key={`m${focusFor("matters") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("matters")} />
        )}
        {view === "conditions" && (
          <ConditionsWorkspace key={conditionId ?? 0} initialId={conditionId}
                               onCompose={startCompose} />
        )}
        {view === "works" && (
          <WorksWorkspace key={`w${focusFor("works") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("works")} />
        )}
        {view === "parties" && (
          <PartiesWorkspace key={`p${focusFor("parties") ?? 0}`} initialId={focusFor("parties")} />
        )}
        {view === "documents" && (
          <DocumentsWorkspace key={compose ? `c${compose.conditionId}` : "docs"}
                              start={compose ?? undefined} />
        )}
        {view === "money" && <MoneyWorkspace />}
        {view === "flows" && <FlowMonitorWorkspace onOpenCondition={openCondition} />}
        {view === "ops" && <OpsWorkspace key={opsTab ?? "quality"} initialTab={opsTab} />}
      </main>
    </div>
  );
}
