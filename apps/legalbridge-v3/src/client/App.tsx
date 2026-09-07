import { useEffect, useState } from "react";
import { api } from "./api.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";
import { MoneyWorkspace } from "./MoneyWorkspace.js";
import { WorksWorkspace } from "./WorksWorkspace.js";
import { PartiesWorkspace } from "./PartiesWorkspace.js";
import { FlowMonitorWorkspace } from "./FlowMonitorWorkspace.js";
import { OpsWorkspace, HomeWorkspace } from "./OpsWorkspace.js";

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
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => { api.get<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);

  const openCondition = (id: number) => { setConditionId(id); setView("conditions"); };

  return (
    <div className="app">
      <nav className="rail" aria-label="主ナビゲーション">
        <div className="wordmark"><b>LegalBridge</b><span>Core</span></div>
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-sec">{group.section}</div>
            {group.items.map((item) => (
              <button key={item.view} className="nav-item"
                      aria-current={view === item.view ? "page" : undefined}
                      onClick={() => {
                        if (item.view === "conditions") setConditionId(undefined);
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
        {view === "home" && <HomeWorkspace onGo={(v) => setView(v)} />}
        {view === "matters" && <MattersWorkspace onOpenCondition={openCondition} />}
        {view === "conditions" && <ConditionsWorkspace key={conditionId ?? 0} initialId={conditionId} />}
        {view === "works" && <WorksWorkspace onOpenCondition={openCondition} />}
        {view === "parties" && <PartiesWorkspace />}
        {view === "documents" && <DocumentsWorkspace />}
        {view === "money" && <MoneyWorkspace />}
        {view === "flows" && <FlowMonitorWorkspace onOpenCondition={openCondition} />}
        {view === "ops" && <OpsWorkspace />}
      </main>
    </div>
  );
}
