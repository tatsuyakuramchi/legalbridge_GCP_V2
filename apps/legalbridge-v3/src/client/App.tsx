import { useEffect, useState } from "react";
import { api } from "./api.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";

type View = "matters" | "conditions" | "documents";
interface Me { user?: { email: string; role: string }; readOnly: boolean }

export function App() {
  const [view, setView] = useState<View>("matters");
  const [conditionId, setConditionId] = useState<number | undefined>();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => { api.get<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);

  return (
    <div className="app">
      <nav className="rail" aria-label="主ナビゲーション">
        <div className="wordmark"><b>LegalBridge</b><span>Core</span></div>

        <div className="nav-sec">入口</div>
        <button className="nav-item" aria-current={view === "matters" ? "page" : undefined}
                onClick={() => setView("matters")}>案件</button>

        <div className="nav-sec">横断で見る</div>
        <button className="nav-item" aria-current={view === "conditions" ? "page" : undefined}
                onClick={() => { setConditionId(undefined); setView("conditions"); }}>条件</button>
        <button className="nav-item" aria-current={view === "documents" ? "page" : undefined}
                onClick={() => setView("documents")}>文書</button>

        <div className="rail-foot">
          <div className="faint">{me?.user?.email ?? "未認証"}</div>
          <div className="faint">
            {me?.user?.role ?? "—"}{me?.readOnly ? " ／ 読み取り専用" : ""}
          </div>
        </div>
      </nav>

      <main className="main">
        {view === "matters" && (
          <MattersWorkspace onOpenCondition={(id) => { setConditionId(id); setView("conditions"); }} />
        )}
        {view === "conditions" && <ConditionsWorkspace key={conditionId ?? 0} initialId={conditionId} />}
        {view === "documents" && <DocumentsWorkspace />}
      </main>
    </div>
  );
}
