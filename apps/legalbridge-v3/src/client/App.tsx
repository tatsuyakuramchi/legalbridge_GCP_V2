import { useEffect, useState } from "react";
import { api } from "./api.js";
import { GlobalSearch, type SearchHit } from "./GlobalSearch.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { AgreementsWorkspace } from "./AgreementsWorkspace.js";
import type { EntityKind } from "./Relations.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";
import { MoneyWorkspace } from "./MoneyWorkspace.js";
import { WorksWorkspace } from "./WorksWorkspace.js";
import { PartiesWorkspace } from "./PartiesWorkspace.js";
import { FlowMonitorWorkspace } from "./FlowMonitorWorkspace.js";
import { OpsWorkspace, HomeWorkspace, type OpsTab } from "./OpsWorkspace.js";

type View = "home" | "matters" | "agreements" | "conditions" | "works" | "parties" | "documents" | "money" | "flows" | "ops";
interface Me { user?: { email: string; role: string }; readOnly: boolean }

// 入口（案件）／横断で見る／監視・運用 の3段。案件が制御レイヤー、他は参照。
const NAV: Array<{ section: string; items: Array<{ view: View; label: string }> }> = [
  { section: "入口", items: [
    { view: "home", label: "ホーム" },
    { view: "matters", label: "案件" }
  ] },
  { section: "横断で見る", items: [
    // 契約が器で、条件はその明細。並びもその順にする。
    { view: "agreements", label: "契約" },
    { view: "conditions", label: "条件明細" },
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
   * つながりから相手を開く。どの画面のどの関連から押しても、同じところへ行く。
   * これが無いと、繋がっているのが見えるだけで辿れない。
   */
  const openEntity = (kind: EntityKind, id: number) => {
    if (kind === "condition") return openCondition(id);
    if (kind === "document") return openDocumentAt(id);
    setConditionId(undefined);
    const next = ({ matter: "matters", document: "documents", party: "parties",
                    work: "works", agreement: "agreements" } as const)[kind];
    if (!next) return;
    setFocus({ view: next, id });
    setView(next);
  };

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
  const [compose, setCompose] =
    useState<{ conditionIds: number[]; eventIds: number[]; matterId: number | null } | null>(null);
  /** 他の画面の「編集」から文書の画面へ来たときの相手。 */
  const [openDocument, setOpenDocument] = useState<number | undefined>();
  // 条件は複数受ける。発注書のように1枚で2件以上の条件を載せる書類があるので、
  // 案件から来たときはその案件の条件をまとめて選んだ状態にする。
  // 案件も受ける。案件や条件の画面から作った文書は、その案件に載せる。
  const startCompose = (conditionIds: number[], eventIds: number[] = [], matterId: number | null = null) => {
    setCompose({ conditionIds, eventIds, matterId });
    setFocus(null);
    setOpenDocument(undefined);
    setView("documents");
  };

  /** 文書の画面へ移って、その文書を開く。下書きならそのまま編集に入る。 */
  const openDocumentAt = (documentId: number) => {
    setCompose(null);
    setFocus(null);
    setConditionId(undefined);
    setOpenDocument(documentId);
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
            onOpenCondition={openCondition} initialId={focusFor("matters")}
            onOpen={openEntity} onCompose={startCompose} onOpenDocument={openDocumentAt} />
        )}
        {view === "conditions" && (
          <ConditionsWorkspace key={conditionId ?? 0} initialId={conditionId}
                               onCompose={startCompose} onOpen={openEntity} />
        )}
        {view === "works" && (
          <WorksWorkspace key={`w${focusFor("works") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("works")}
            onOpen={openEntity} />
        )}
        {view === "parties" && (
          <PartiesWorkspace key={`p${focusFor("parties") ?? 0}`} initialId={focusFor("parties")}
            onOpen={openEntity} />
        )}
        {view === "documents" && (
          <DocumentsWorkspace
            key={compose ? `c${compose.conditionIds.join("-")}` : openDocument ? `d${openDocument}` : "docs"}
            start={compose ?? undefined} openDocumentId={openDocument}
            onOpen={openEntity} />
        )}
        {view === "agreements" && (
          <AgreementsWorkspace key={`a${focusFor("agreements") ?? 0}`}
            initialId={focusFor("agreements")} onOpen={openEntity} />
        )}
        {view === "money" && <MoneyWorkspace />}
        {view === "flows" && <FlowMonitorWorkspace onOpenCondition={openCondition} />}
        {view === "ops" && <OpsWorkspace key={opsTab ?? "quality"} initialTab={opsTab} />}
      </main>
    </div>
  );
}
