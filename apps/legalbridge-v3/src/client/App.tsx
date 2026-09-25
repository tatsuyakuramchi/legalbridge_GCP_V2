import { useEffect, useState } from "react";
import { api } from "./api.js";
import { ReadOnlyContext } from "./read-only.js";
import { GlobalSearch, type SearchHit } from "./GlobalSearch.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { AgreementsWorkspace } from "./AgreementsWorkspace.js";
import type { EntityKind } from "./Relations.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";
import { ClosingWorkspace } from "./ClosingWorkspace.js";
import { MoneyWorkspace } from "./MoneyWorkspace.js";
import { WorksWorkspace } from "./WorksWorkspace.js";
import { PartiesWorkspace } from "./PartiesWorkspace.js";
import { FlowMonitorWorkspace } from "./FlowMonitorWorkspace.js";
import { DriftWorkspace } from "./DriftWorkspace.js";
import { OpsWorkspace, HomeWorkspace, type OpsTab } from "./OpsWorkspace.js";
import { IntakeWorkspace } from "./IntakeWorkspace.js";

type View = "home" | "intake" | "matters" | "agreements" | "conditions" | "works" | "parties" | "documents" | "closing" | "money" | "drift" | "flows" | "ops";
interface Me {
  user?: { email: string; role: string };
  readOnly: boolean;
  site?: { label: string; dataAsOf: string | null };
}

// 入口（案件）／横断で見る／監視・運用 の3段。案件が制御レイヤー、他は参照。
const NAV: Array<{ section: string; items: Array<{ view: View; label: string }> }> = [
  { section: "入口", items: [
    { view: "home", label: "ホーム" },
    // 依頼はまず受付箱に入る。受け付けると案件になる（docs/v3-request-inbox.md）。
    { view: "intake", label: "受付箱" },
    { view: "matters", label: "案件" }
  ] },
  { section: "横断で見る", items: [
    // 契約が器で、条件はその明細。並びもその順にする。
    { view: "agreements", label: "契約" },
    { view: "conditions", label: "条件明細" },
    { view: "works", label: "作品" },
    { view: "parties", label: "取引先・担当" },
    { view: "documents", label: "文書" }
  ] },
  // 文書とお金のあいだ。予定 → 実績 → 決済文書 → 支払 を1本の表で進める
  // ところなので、紙の話と金の話の継ぎ目に、見出しを付けて置く
  // （見出しが無いと「横断で見る」の続きに読めて、何をする所か分からなかった）。
  { section: "お金の流れ", items: [
    { view: "closing", label: "支払文書処理" },
    { view: "money", label: "お金" }
  ] },
  { section: "監視・運用", items: [
    // 条件を直したあとに取り残された金額・日付を集めて直す。案件をまたぐので
    // 工程表（案件1件）とは別の入口にする。ホームの札「金額の取り残し」と同じ語にする。
    { view: "drift", label: "金額の取り残し" },
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
  /** 「金額の直し」を案件の工程表から開いたとき、その案件で絞る。 */
  const [driftMatter, setDriftMatter] = useState<number | null>(null);

  useEffect(() => { api.get<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);

  /** 受付箱の未処理＋更新あり。左の桁に件数を出して、届いた依頼を見落とさない。 */
  const [intakeCount, setIntakeCount] = useState(0);
  useEffect(() => {
    api.get<{ new: number; updated: number }>("/intake/counts")
      .then((c) => setIntakeCount(c.new + c.updated)).catch(() => setIntakeCount(0));
  }, [view]);

  /** 左の桁を畳んでいるか。畳んだ状態はこの端末に覚えておく。 */
  const [railSlim, setRailSlim] = useState(() => {
    try { return localStorage.getItem("lb.railSlim") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("lb.railSlim", railSlim ? "1" : "0"); } catch { /* 使えなくても困らない */ }
  }, [railSlim]);

  /** 開いた直後に実績のフォームを出す回。支払文書処理から渡ってくる。 */
  const [conditionSchedule, setConditionSchedule] = useState<number | null>(null);
  const openCondition = (id: number, scheduleId: number | null = null) => {
    setConditionId(id); setConditionSchedule(scheduleId); setView("conditions");
  };

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

  /** 案件の工程から「契約を登録する」で来たとき。相手先を入れた状態で契約の登録を開く。 */
  const [agreementPreset, setAgreementPreset] =
    useState<{ partyId: number; partyName: string | null; nonce: number } | null>(null);
  const startAgreement = (partyId: number, partyName: string | null) => {
    setAgreementPreset({ partyId, partyName, nonce: Date.now() });
    setFocus(null);
    setView("agreements");
  };

  /**
   * 文書を作りに行く。条件と実績を選んだ状態で「文書」画面を開く。
   * 作成のフォームは1つだけにしてあるので、どこから入っても同じものを見る。
   */
  const [compose, setCompose] =
    useState<{ conditionIds: number[]; eventIds: number[]; matterId: number | null;
               templateKey?: string | null;
               bulk?: boolean; settled?: boolean } | null>(null);
  /** 他の画面の「編集」から文書の画面へ来たときの相手。 */
  /**
   * 開く文書。ID だけだと、同じ文書をもう一度開けない。
   *
   * 一覧へ戻ってから同じ番号を開き直すと、ID が変わらないので状態が動かず、
   * 画面へ「開き直せ」が伝わらない。押しても一覧のままになっていた。
   * 押すたびに増える番号を添えて、同じ文書でも合図が飛ぶようにする。
   */
  const [openDocument, setOpenDocument] =
    useState<{ id: number; nonce: number } | undefined>();
  // 条件は複数受ける。発注書のように1枚で2件以上の条件を載せる書類があるので、
  // 案件から来たときはその案件の条件をまとめて選んだ状態にする。
  // 案件も受ける。案件や条件の画面から作った文書は、その案件に載せる。
  const startCompose = (
    conditionIds: number[], eventIds: number[] = [], matterId: number | null = null,
    templateKey: string | null = null
  ) => {
    setCompose({ conditionIds, eventIds, matterId, templateKey });
    setFocus(null);
    setOpenDocument(undefined);
    setView("documents");
  };

  /**
   * 発注書の一括作成へ移る。案件を決めた状態で開く。
   *
   * 入口が文書の画面の中にしか無く、案件から来た人は画面を移ってから
   * 案件をもう一度選び直す必要があった（同じ案件を2回選ばせていた）。
   */
  const startBulkOrders = (matterId: number) => {
    setCompose({ conditionIds: [], eventIds: [], matterId, bulk: true });
    setFocus(null);
    setOpenDocument(undefined);
    setView("documents");
  };
  /** 案件から「検収済みをまとめて入れる」へ。案件を入れた状態で開く。 */
  const startSettledImport = (matterId: number) => {
    setCompose({ conditionIds: [], eventIds: [], matterId, settled: true });
    setFocus(null);
    setOpenDocument(undefined);
    setView("documents");
  };

  /** 文書の画面へ移って、その文書を開く。下書きならそのまま編集に入る。 */
  const openDocumentAt = (documentId: number) => {
    setCompose(null);
    setFocus(null);
    setConditionId(undefined);
    setOpenDocument((prev) => ({ id: documentId, nonce: (prev?.nonce ?? 0) + 1 }));
    setView("documents");
  };

  return (
    <ReadOnlyContext.Provider value={Boolean(me?.readOnly)}>
    <div className={`app${railSlim ? " rail-slim" : ""}`}>
      <nav className="rail" aria-label="主ナビゲーション">
        {/* ウィンドウを半分にすると、この桁だけで横幅の2割を使う。畳めるようにして
            表の広い画面では中身に回す。畳んだかどうかは次に開いたときも残す。 */}
        <button className="rail-toggle" onClick={() => setRailSlim((v) => !v)}
                title={railSlim ? "ナビゲーションを開く" : "ナビゲーションを畳む"}
                aria-label={railSlim ? "ナビゲーションを開く" : "ナビゲーションを畳む"}>
          {railSlim ? "»" : "«"}
        </button>
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
                        // 左から開いたときは全社に戻す。案件から開いた絞りが
                        // 残っていると、件数が合わずに見落とす。
                        if (item.view === "drift") setDriftMatter(null);
                        setFocus(null);
                        setView(item.view);
                      }}>{item.label}
                      {item.view === "intake" && intakeCount > 0 && (
                        <span className="tag warn" style={{ marginLeft: 6 }}>{intakeCount}</span>
                      )}</button>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <div className="faint">{me?.user?.email ?? "未認証"}</div>
          <div className="faint">{me?.user?.role ?? "—"}{me?.readOnly ? " ／ 読み取り専用" : ""}</div>
          {me?.site?.label && (
            <div className="site-badge" title={me.site.dataAsOf ? `データは ${me.site.dataAsOf} 時点の写し` : undefined}>
              <b>{me.site.label}</b>
              {me.site.dataAsOf && <span>データ {me.site.dataAsOf} 時点</span>}
            </div>
          )}
        </div>
      </nav>

      <main className="main">
        {/* 押してから断られると、書いた内容が消える。先に知らせる。 */}
        {me?.readOnly && (
          <div className="note warn" style={{ marginBottom: 12 }}>
            読み取り専用で動いています。登録・変更・送信はできません。
            {me.site?.dataAsOf ? `データは ${me.site.dataAsOf} 時点の写しです。` : ""}
          </div>
        )}
        {view === "home" && (
          <HomeWorkspace onGo={(v, tab) => {
            setOpsTab(tab);
            // ホームから開くのは全社ぶん（札の件数と画面の件数を合わせる）。
            if (v === "drift") setDriftMatter(null);
            setView(v);
          }} />
        )}
        {view === "intake" && (
          <IntakeWorkspace onOpenMatter={(id) => openEntity("matter", id)}
            onCountsChange={(c) => setIntakeCount(c.new + c.updated)} />
        )}
        {view === "matters" && (
          <MattersWorkspace key={`m${focusFor("matters") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("matters")}
            onOpen={openEntity} onCompose={startCompose} onOpenDocument={openDocumentAt}
            onBulkOrders={startBulkOrders}
            onSettledImport={startSettledImport}
            onRegisterAgreement={startAgreement}
            onFixDrift={(matterId) => { setDriftMatter(matterId); setView("drift"); }} />
        )}
        {view === "conditions" && (
          <ConditionsWorkspace key={`${conditionId ?? 0}-${conditionSchedule ?? 0}`}
                               initialId={conditionId} initialSchedule={conditionSchedule}
                               onCompose={startCompose} onOpen={openEntity}
                               onOpenDocument={openDocumentAt} />
        )}
        {view === "works" && (
          <WorksWorkspace key={`w${focusFor("works") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("works")}
            onOpen={openEntity} onCompose={startCompose} />
        )}
        {view === "parties" && (
          <PartiesWorkspace key={`p${focusFor("parties") ?? 0}`} initialId={focusFor("parties")}
            onOpen={openEntity} />
        )}
        {view === "documents" && (
          <DocumentsWorkspace
            key={compose ? `c${compose.bulk ? "bulk" : ""}${compose.settled ? "settled" : ""}${compose.matterId ?? ""}${compose.conditionIds.join("-")}`
                          : openDocument ? `d${openDocument.id}` : "docs"}
            start={compose ?? undefined} openDocumentId={openDocument?.id}
            openNonce={openDocument?.nonce}
            onOpen={openEntity} />
        )}
        {view === "agreements" && (
          <AgreementsWorkspace key={`a${focusFor("agreements") ?? 0}-${agreementPreset?.nonce ?? 0}`}
            initialId={focusFor("agreements")} onOpen={openEntity}
            createPreset={agreementPreset
              ? { partyId: agreementPreset.partyId, partyName: agreementPreset.partyName } : null} />
        )}
        {view === "closing" && (
          <ClosingWorkspace onOpenCondition={openCondition} onOpenDocument={openDocumentAt}
            onRecord={(conditionId, scheduleId) => openCondition(conditionId, scheduleId)} />
        )}
        {view === "money" && <MoneyWorkspace />}
        {view === "drift" && (
          <DriftWorkspace key={`dr${driftMatter ?? 0}`} initialMatterId={driftMatter}
            onOpenDocument={openDocumentAt} onOpenCondition={openCondition}
            onOpenMatter={(id) => openEntity("matter", id)} />
        )}
        {view === "flows" && <FlowMonitorWorkspace onOpenCondition={openCondition} />}
        {view === "ops" && <OpsWorkspace key={opsTab ?? "quality"} initialTab={opsTab} />}
      </main>
    </div>
    </ReadOnlyContext.Provider>
  );
}
