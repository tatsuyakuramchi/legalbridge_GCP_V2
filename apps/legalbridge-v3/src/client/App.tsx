import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { ReadOnlyContext } from "./read-only.js";
import { GlobalSearch, type SearchHit } from "./GlobalSearch.js";
import { MattersWorkspace } from "./MattersWorkspace.js";
import { ConditionsWorkspace } from "./ConditionsWorkspace.js";
import { AgreementsWorkspace } from "./AgreementsWorkspace.js";
import { AgreementMapWorkspace } from "./AgreementMapWorkspace.js";
import type { EntityKind } from "./Relations.js";
import { DocumentsWorkspace } from "./DocumentsWorkspace.js";
import { ClosingWorkspace } from "./ClosingWorkspace.js";
import { MoneyWorkspace } from "./MoneyWorkspace.js";
import { WorksWorkspace, type DocBack } from "./WorksWorkspace.js";
import { PartiesWorkspace } from "./PartiesWorkspace.js";
import { FlowMonitorWorkspace } from "./FlowMonitorWorkspace.js";
import { DriftWorkspace } from "./DriftWorkspace.js";
import { OpsWorkspace, HomeWorkspace, type OpsTab } from "./OpsWorkspace.js";
import { IntakeWorkspace } from "./IntakeWorkspace.js";
import { DailyTasksWorkspace, type TaskCtx } from "./DailyTasksWorkspace.js";
import { WorkbenchWorkspace, WORKBENCH_STEPS, newWorkbenchState, loadWorkbenchState, type WorkbenchEntry, type WorkbenchState } from "./WorkbenchWorkspace.js";
import { DealsWorkspace } from "./DealsWorkspace.js";
import { PayDocsWorkspace, type AuthorTarget } from "./PayDocsWorkspace.js";
import { RingiWorkspace } from "./RingiWorkspace.js";
import { RptWorkspace } from "./RptWorkspace.js";
import type { DocFlow } from "./FlowBar.js";
import { formatHash, parseHash, pushRoute, routePath, type Route } from "./route.js";

type View = "home" | "intake" | "daily" | "matters" | "workbench" | "paydocs" | "deals" | "agreements" | "agreement-map" | "conditions" | "works" | "parties" | "documents" | "ringi" | "rpt" | "closing" | "money" | "drift" | "flows" | "ops";
interface Me {
  user?: { email: string; role: string };
  readOnly: boolean;
  site?: { label: string; dataAsOf: string | null };
}

// 入口（案件）／横断で見る／監視・運用 の3段。案件が制御レイヤー、他は参照。
const NAV: Array<{ section: string; items: Array<{ view: View; label: string }> }> = [
  { section: "入口", items: [
    { view: "home", label: "ホーム" },
    // 依頼はまず受付箱に入り、そこで振り分ける（docs/v3-request-inbox.md）。
    // 軽微ならデイリータスク、大きければ案件。どちらも作業テーブルは tasks。
    { view: "intake", label: "受付箱" },
    { view: "daily", label: "デイリータスク" },
    { view: "matters", label: "案件" }
  ] },
  // 文書は作業テーブル、お金は取引管理。どちらも「決める台帳（条件・作品・契約）」とは別の、進める画面。
  { section: "作業", items: [
    // 文書を作る・登録する・繋ぐのはこの 1 枚だけ。デイリータスク・案件からも同じ画面に入る。
    // 以前の「取引を進める」（基礎情報 → 契約 → 条件 → 文書 → 送信）はここに一本化した。
    { view: "workbench", label: "作業テーブル" },
    // 計算書・検収書・役務提供完了通知書を回ごとに 起点 → 文書 → 送付 → 受領 → 支払 まで（A-074）。
    // 以前の「取引管理」「支払文書処理」はここへまとめた（取引管理の表は案件・条件明細の中に残る）。
    { view: "paydocs", label: "支払文書" }
  ] },
  { section: "横断で見る", items: [
    // 契約が器で、条件はその明細。並びもその順にする。
    { view: "agreements", label: "契約" },
    // 取引先ごとの基本契約の木。画面によって基本契約の見え方が違う原因（ずれ）を直す。
    { view: "agreement-map", label: "取引先⇔基本契約" },
    { view: "conditions", label: "条件明細" },
    { view: "works", label: "作品" },
    { view: "parties", label: "取引先・担当" },
    { view: "documents", label: "文書" },
    // 稟議（R-）と取締役会決議（B-）。文書・契約に繋いで /法務検索 で引ける。
    { view: "ringi", label: "稟議" },
    // 取引が会社法の利益相反・会計の関連当事者に当たるかの判定と、取締役会の議案。
    { view: "rpt", label: "関連当事者" }
  ] },
  // 文書とお金のあいだ。予定 → 実績 → 決済文書 → 支払 を1本の表で進める
  // ところなので、紙の話と金の話の継ぎ目に、見出しを付けて置く
  // （見出しが無いと「横断で見る」の続きに読めて、何をする所か分からなかった）。
  { section: "お金の流れ", items: [
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

const sameEntry = (a: WorkbenchEntry, b: WorkbenchEntry) =>
  a.kind === b.kind && (a.kind === "task" ? a.taskId === (b as typeof a).taskId
    : a.kind === "matter" ? a.matterId === (b as typeof a).matterId
    : a.kind === "round" ? a.conditionId === (b as typeof a).conditionId && a.scheduleId === (b as typeof a).scheduleId && a.eventId === (b as typeof a).eventId
    : a.kind === "conditions" ? a.conditionIds.join(",") === (b as typeof a).conditionIds.join(",") && (a.templateKey ?? null) === ((b as typeof a).templateKey ?? null)
    : a.kind === "bulk" ? a.mode === (b as typeof a).mode && (a.matterId ?? null) === ((b as typeof a).matterId ?? null)
    : a.kind === "document" ? a.documentId === (b as typeof a).documentId && a.mode === (b as typeof a).mode
    : a.partyId === (b as typeof a).partyId);

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
  /** デイリータスクの終わっていない作業。 */
  const [dailyCount, setDailyCount] = useState(0);
  useEffect(() => {
    api.get<{ new: number; updated: number }>("/intake/counts")
      .then((c) => setIntakeCount(c.new + c.updated)).catch(() => setIntakeCount(0));
    api.get<{ open: number }>("/tasks/counts")
      .then((c) => setDailyCount(c.open)).catch(() => setDailyCount(0));
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
    if (hit.target === "agreement") return openEntity("agreement", hit.id);
    if (hit.target === "request") { setConditionId(undefined); setFocus({ view: "intake", id: hit.id }); setView("intake"); return; }
    setConditionId(undefined);
    const next = ({ matter: "matters", document: "documents", party: "parties",
                    work: "works", payment: "money" } as const)[hit.target];
    setFocus({ view: next, id: hit.id });
    setView(next);
  };

  /**
   * いま進めているデイリータスク（A-064）。作業の「文書を作る」から作品・条件明細・台帳の
   * 画面へ移ったあとも持ち続け、そこで作った文書をその作業に繋ぐ（requestId）。
   * 左のメニューから別の画面を開いたら解除する（作業と関係ない文書まで繋がないように）。
   */
  const [taskCtx, setTaskCtx] = useState<TaskCtx | null>(null);
  /**
   * 作業テーブルの進み具合。文書の画面へ行って決定して戻っても、どこまで済んだかが残る
   * （画面を離れると部品の中の状態は消えるので、ここに持つ）。
   */
  const [workbench, setWorkbench] = useState<WorkbenchState | null>(null);
  /** 取引管理の回から決済文書を作る：作業テーブルへ（この回の実績を渡す）。 */
  const issueRound = (h: { conditionId: number; conditionName: string; roundLabel: string; scheduleId: number | null; eventId: number | null }) =>
    startWorkbench({ kind: "round", conditionId: h.conditionId, scheduleId: h.scheduleId, eventId: h.eventId,
                     label: `${h.conditionName} ${h.roundLabel}` });
  const startWorkbench = (entry: WorkbenchEntry) => {
    // 同じ入口の途中の状態があれば続きから（画面の状態 → 手元に残したもの → 新規）。
    setWorkbench((prev) => (prev && sameEntry(prev.entry, entry) ? prev : loadWorkbenchState(entry) ?? newWorkbenchState(entry)));
    setFocus(null); setConditionId(undefined);
    setView("workbench");
  };

  /**
   * 支払文書の「作家の報告と計算書」をこの作家で開く（作品のタブ・デイリータスク・文書の画面の戻りから）。
   * 以前の 作品 › 利用許諾計算（A-074 で支払文書へ移した）。
   */
  const [payAuthor, setPayAuthor] = useState<(AuthorTarget & { nonce: number }) | null>(null);
  // 左のメニューから支払文書を開き直したときは一覧から（作家を持ち越さない）。
  useEffect(() => { if (view !== "paydocs") setPayAuthor(null); }, [view]);
  const openAuthor = (a: AuthorTarget) => {
    setPayAuthor({ ...a, nonce: Date.now() }); setConditionId(undefined); setFocus(null); setView("paydocs");
  };

  /** その画面に渡す選択。別の画面へ移ったら持ち越さない。 */
  const focusFor = (view: View) => (focus && focus.view === view ? focus.id : undefined);


  /**
   * 案件の工程から「契約を登録する」で来たとき。相手先を入れた状態で契約の登録を開く。
   */
  const [agreementPreset, setAgreementPreset] =
    useState<{ partyId: number; partyName: string | null; nonce: number } | null>(null);
  const startAgreement = (partyId: number, partyName: string | null) => {
    setAgreementPreset({ partyId, partyName, nonce: Date.now() });
    setFocus(null);
    setView("agreements");
  };

  /**
   * 文書の画面の上に出す「流れ」。契約 → 条件明細 → 文書 → 送信 と順に進めている途中なら、
   * いまどの段階か・戻る先を持つ。左のメニューから開いたときは持たない（素の文書の画面）。
   */
  const [docFlow, setDocFlow] = useState<DocFlow | null>(null);
  /** 作業テーブルの②から 1 枚作りに来た。決定したらその単位を済みにして、作業テーブルへ戻れる。 */
  const workbenchFlow = (unitKey: string, label: string): DocFlow => ({
    title: `作業テーブル：${label}`, steps: WORKBENCH_STEPS, step: 1,
    back: { label: "作業テーブル", go: () => { setFocus(null); setView("workbench"); } },
    onIssued: (documentId) => setWorkbench((s) => s && ({
      ...s, results: { ...s.results, [unitKey]: { status: "issued", documentIds: [documentId] } }
    }))
  });
  /** 契約の画面で条件明細を登録して、そのまま文書を作りに来た。 */
  const agreementFlow =(agreement: { id: number; label: string }): DocFlow => ({
    title: `契約 ${agreement.label}`, steps: ["契約を登録", "条件明細を登録", "文書を作る", "送る"], step: 2,
    back: { label: `契約 ${agreement.label}`, go: () => openEntity("agreement", agreement.id) }
  });
  /** 条件明細の画面で条件を登録して、そのまま文書を作りに来た。 */
  const conditionFlow = (conditionId: number): DocFlow => ({
    title: "条件明細", steps: ["条件明細を登録", "文書を作る", "送る"], step: 1,
    back: { label: "条件明細", go: () => openCondition(conditionId) }
  });

  /**
   * 文書を作りに行く。条件と実績を選んだ状態で「文書」画面を開く。
   * 作成のフォームは1つだけにしてあるので、どこから入っても同じものを見る。
   */
  const [compose, setCompose] =
    useState<{ conditionIds: number[]; eventIds: number[]; matterId: number | null;
               /** デイリータスクから来たとき、その元の依頼（作った文書を依頼に繋ぐ）。 */
               requestId?: number | null;
               templateKey?: string | null;
               bulk?: boolean; settled?: boolean;
               /** 訂正版。退かせる元の文書と理由。 */
               supersedesId?: number | null; supersedesExtraIds?: number[]; reason?: string | null } | null>(null);
  /** 他の画面の「編集」から文書の画面へ来たときの相手。 */
  /**
   * 開く文書。ID だけだと、同じ文書をもう一度開けない。
   *
   * 一覧へ戻ってから同じ番号を開き直すと、ID が変わらないので状態が動かず、
   * 画面へ「開き直せ」が伝わらない。押しても一覧のままになっていた。
   * 押すたびに増える番号を添えて、同じ文書でも合図が飛ぶようにする。
   */
  const [openDocument, setOpenDocument] =
    useState<{ id: number; nonce: number; edit?: boolean } | undefined>();
  // 条件は複数受ける。発注書のように1枚で2件以上の条件を載せる書類があるので、
  // 案件から来たときはその案件の条件をまとめて選んだ状態にする。
  // 案件も受ける。案件や条件の画面から作った文書は、その案件に載せる。
  /**
   * 文書の画面から戻る先（台帳の回）。台帳から計算書を作りに来た・台帳から
   * 決定した文書を開いたときに持つ。文書の画面の上に「← 台帳へ戻る」を出す。
   */
  const [docBack, setDocBack] = useState<DocBack | null>(null);
  const goBack = (back: DocBack) => {
    setCompose(null); setOpenDocument(undefined);
    openAuthor({ partyId: back.partyId, workId: back.workId ?? null });
  };
  const startCompose = (
    conditionIds: number[], eventIds: number[] = [], matterId: number | null = null,
    templateKey: string | null = null, back: DocBack | null = null,
    revise: { supersedesIds: number[]; reason: string } | null = null,
    requestId: number | null = null,
    flow: DocFlow | null = null
  ) => {
    // 文書を作るのは作業テーブル。条件明細・作品・契約・案件・工程表の「文書を作る」は、
    // 流れの帯（契約・条件明細・作業テーブル）も訂正・台帳の戻り先も無ければ、作業テーブルの
    // ①（要る文書を決める）に条件を渡して開く。文書の画面に直接入るのは、流れの途中か訂正だけ。
    if (!flow && !revise && !back) {
      startWorkbench({ kind: "conditions", conditionIds, eventIds, matterId, requestId: requestId ?? (matterId ? null : taskCtx?.requestId ?? null),
                       templateKey });
      return;
    }
    setDocBack(back);
    setDocFlow(flow);
    // 作業から離れて作品・条件明細の画面で作った文書も、その作業に繋ぐ（案件の文書は案件へ）。
    setCompose({ conditionIds, eventIds, matterId, requestId: requestId ?? (matterId ? null : taskCtx?.requestId ?? null), templateKey,
                 supersedesId: revise?.supersedesIds[0] ?? null, supersedesExtraIds: revise?.supersedesIds.slice(1) ?? [],
                 reason: revise?.reason ?? null });
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
  const startBulkOrders = (matterId: number) => startWorkbench({ kind: "bulk", mode: "orders", matterId });
  /** 案件から「検収済みをまとめて入れる」へ。案件を入れた状態で開く。 */
  const startSettledImport = (matterId: number) => startWorkbench({ kind: "bulk", mode: "settled", matterId });

  /** 文書の画面へ移って、その文書を開く。流れの途中（取引の「開いて送る」）なら帯を付ける。 */
  const openDocumentAt = (documentId: number, back: DocBack | null = null, flow: DocFlow | null = null, edit = false) => {
    setDocBack(back);
    setDocFlow(flow);
    setCompose(null);
    setFocus(null);
    setConditionId(undefined);
    setOpenDocument((prev) => ({ id: documentId, nonce: (prev?.nonce ?? 0) + 1, edit }));
    setView("documents");
  };

  // ---- URL（第 3 段）。画面と選んだ行をハッシュに写し、戻る・進む・リンクで同じ場所を開く。client/route.ts
  /** 取引先⇔基本契約 の中の切り替え（マップ／整理する）と、選んだ取引先。 */
  const [mapMode, setMapMode] = useState<"map" | "tidy">("map");
  const [mapParty, setMapParty] = useState<number | undefined>();
  /** 文書の送る流れで開く段（URL から来たとき）。 */
  const [docStep, setDocStep] = useState<string | null>(null);
  /** URL から来た場所を適用している最中（書き戻さない）。 */
  const applyingRoute = useRef(false);
  const VIEWS = useRef(new Set<string>(NAV.flatMap((g) => g.items.map((i) => i.view)).concat(["closing", "deals"])));

  const applyRoute = (r: Route | null) => {
    applyingRoute.current = true;
    try {
      if (!r || !VIEWS.current.has(r.view)) { setFocus(null); setView("home"); return; }
      const v = r.view as View;
      setTaskCtx(null); setDocFlow(null); setCompose(null); setDocBack(null);
      if (v === "conditions") { setConditionId(r.id ?? undefined); setConditionSchedule(null); setFocus(null); setView(v); return; }
      if (v === "documents") {
        setDocStep(r.params.step ?? null);
        if (r.id) setOpenDocument((prev) => ({ id: r.id!, nonce: (prev?.nonce ?? 0) + 1, edit: r.params.draft === "1" }));
        else setOpenDocument(undefined);
        setFocus(null); setView(v); return;
      }
      if (v === "ops") { setOpsTab((r.params.sub as OpsTab | undefined) ?? undefined); setFocus(null); setView(v); return; }
      if (v === "agreement-map") { setMapMode(r.params.mode === "tidy" ? "tidy" : "map"); setMapParty(r.id ?? undefined); }
      if (v === "drift") setDriftMatter(r.id ?? null);
      setConditionId(undefined);
      setFocus(r.id ? { view: v, id: r.id } : null);
      setView(v);
    } finally {
      // 状態の反映は次の描画。書き戻しの effect もそのあとに走るので、そこで解く。
      window.setTimeout(() => { applyingRoute.current = false; }, 0);
    }
  };
  useEffect(() => {
    applyRoute(parseHash(window.location.hash));
    const onPop = () => applyRoute(parseHash(window.location.hash));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentRoute = (): Route => {
    const params: Record<string, string> = {};
    let id: number | undefined;
    if (view === "conditions") id = conditionId;
    else if (view === "documents") { id = openDocument?.id; if (openDocument?.edit) params.draft = "1"; if (docStep) params.step = docStep; }
    else if (view === "ops") { if (opsTab) params.sub = opsTab; }
    else if (view === "agreement-map") { id = mapParty ?? focusFor(view); if (mapMode === "tidy") params.mode = "tidy"; }
    else if (view === "drift") id = driftMatter ?? undefined;
    else id = focusFor(view);
    return { view, id, params };
  };
  useEffect(() => {
    if (applyingRoute.current) return;
    const r = currentRoute();
    // 画面の中の段（?step=）は部品が足す。道が同じなら上書きしない。
    const cur = window.location.hash;
    if (routePath(formatHash(r)) === routePath(cur) && cur.includes("?")) return;
    pushRoute(r);
  }, [view, focus, conditionId, openDocument, opsTab, mapMode, mapParty, driftMatter]); // eslint-disable-line react-hooks/exhaustive-deps

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
                        // 左から開いたら、進めていたデイリータスクとの繋がりは解く。
                        setTaskCtx(null);
                        // 左の「文書」は素の文書の画面。流れの帯も外す。
                        setDocFlow(null);
                        setFocus(null);
                        setView(item.view);
                      }}>{item.label}
                      {item.view === "intake" && intakeCount > 0 && (
                        <span className="tag warn" style={{ marginLeft: 6 }}>{intakeCount}</span>
                      )}
                      {item.view === "daily" && dailyCount > 0 && (
                        <span className="tag in" style={{ marginLeft: 6 }}>{dailyCount}</span>
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
        {taskCtx && view !== "daily" && (
          <div className="note" style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              <b>デイリータスク {taskCtx.requestNo ?? `#${taskCtx.requestId}`}</b>「{taskCtx.title}」の作業中です。
              ここで作った文書はその作業に自動で繋がります。
            </span>
            <button className="btn btn-sm" onClick={() => { setFocus({ view: "daily", id: taskCtx.taskId }); setView("daily"); }}>やることの一覧に戻る</button>
            <button className="linky" onClick={() => setTaskCtx(null)}>繋がずに作る</button>
          </div>
        )}
        {view === "home" && (
          <HomeWorkspace intakeCount={intakeCount} dailyCount={dailyCount} onGo={(v, tab) => {
            setOpsTab(tab);
            // ホームから開くのは全社ぶん（札の件数と画面の件数を合わせる）。
            if (v === "drift") setDriftMatter(null);
            setView(v);
          }} />
        )}
        {view === "intake" && (
          <IntakeWorkspace key={`i${focusFor("intake") ?? 0}`} initialId={focusFor("intake")}
            onOpenMatter={(id) => openEntity("matter", id)}
            onOpenTask={(taskId) => { setFocus({ view: "daily", id: taskId }); setView("daily"); }}
            onCountsChange={(c) => setIntakeCount(c.new + c.updated)} />
        )}
        {view === "daily" && (
          <DailyTasksWorkspace key={`t${focusFor("daily") ?? 0}`} initialId={focusFor("daily")}
            onOpenMatter={(id) => openEntity("matter", id)}
            onOpenDocument={openDocumentAt}
            onOpenLedger={(workId, partyId) => openAuthor({ partyId, workId })}
            onOpenRequest={(id) => { setFocus({ view: "intake", id }); setView("intake"); }}
            // デイリータスクからの行き先は作業テーブル 1 つ（その作業の文脈で開く）。
            onGo={(ctx) => {
              setTaskCtx(ctx); setConditionId(undefined);
              startWorkbench({ kind: "task", taskId: ctx.taskId, requestId: ctx.requestId });
            }}
            onCountsChange={(c) => setDailyCount(c.open)} />
        )}
        {view === "deals" && (
          <DealsWorkspace onOpenCondition={openCondition} onOpenDocument={openDocumentAt}
            onOpenMatter={(id) => openEntity("matter", id)}
            // 決済文書は作業テーブルで作る（この回の実績を渡す）。決定したら取引管理へ戻れる。
            onIssueDocument={issueRound} />
        )}
        {view === "paydocs" && (
          <PayDocsWorkspace onOpenCondition={openCondition} onOpenDocument={openDocumentAt}
            onOpenDraft={(id) => openDocumentAt(id, null, null, true)}
            onIssueRound={issueRound}
            onComposeEvents={(conditionIds, eventIds, templateKey) => startCompose(conditionIds, eventIds, null, templateKey)}
            onOpenClosing={() => setView("closing")}
            author={payAuthor} onOpenAuthor={openAuthor}
            onLedgerCompose={(ids, events, key, back, revise) => startCompose(ids, events, null, key, back, revise ?? null)}
            onOpenRequest={(id) => { setFocus({ view: "intake", id }); setView("intake"); }} />
        )}
        {view === "workbench" && (
          <WorkbenchWorkspace state={workbench} onState={setWorkbench}
            onOpenDeals={() => { setFocus(null); setView("paydocs"); }}
            onCompose={(unit, a) => startCompose(a.conditionIds, a.eventIds, a.matterId, a.templateKey || null, null, null, a.requestId,
                                                 workbenchFlow(unit.key, unit.label))}
            // 訂正版・下敷きの下書きは、文書の画面を「直す」状態で開く。決定したらこの単位を済みにする。
            onOpenDraft={(unit, id) => openDocumentAt(id, null, workbenchFlow(unit.key, unit.label), true)}
            onOpenDocument={(id) => openDocumentAt(id, null, workbench
              ? { title: "作業テーブル", steps: WORKBENCH_STEPS, step: 2, back: { label: "作業テーブル", go: () => { setFocus(null); setView("workbench"); } } }
              : null)}
            onOpenTask={(taskId) => { setFocus({ view: "daily", id: taskId }); setView("daily"); }}
            onOpenMatter={(id) => openEntity("matter", id)}
            onOpenCondition={openCondition} />
        )}
        {view === "matters" && (
          <MattersWorkspace key={`m${focusFor("matters") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("matters")}
            onOpen={openEntity} onCompose={startCompose} onOpenDocument={openDocumentAt}
            onBulkOrders={startBulkOrders}
            onSettledImport={startSettledImport}
            onRegisterAgreement={startAgreement}
            // 案件の「作業テーブルで文書を作る」。取引の型は作業テーブルが案件の種類と条件から推す。
            onOpenTrade={(m) => startWorkbench({ kind: "matter", matterId: m.id })}
            onIssueRound={issueRound}
            onFixDrift={(matterId) => { setDriftMatter(matterId); setView("drift"); }} />
        )}
        {view === "conditions" && (
          <ConditionsWorkspace key={`${conditionId ?? 0}-${conditionSchedule ?? 0}`}
                               initialId={conditionId} initialSchedule={conditionSchedule}
                               onCompose={startCompose} onOpen={openEntity}
                               onOpenDocument={openDocumentAt}
                               onIssueRound={issueRound}
                               // 条件を登録したら、その条件で文書を作る画面へ進む（戻る先はその条件）。
                               onCreated={({ conditionIds, templateKey }) =>
                                 startCompose(conditionIds, [], null, templateKey, null, null, null, conditionFlow(conditionIds[0]))} />
        )}
        {view === "works" && (
          <WorksWorkspace key={`w${focusFor("works") ?? 0}`}
            onOpenCondition={openCondition} initialId={focusFor("works")}
            onOpenDocument={openDocumentAt}
            onOpen={openEntity} onCompose={startCompose}
            payDocs={{ onIssueRound: issueRound, onOpenDraft: (id) => openDocumentAt(id, null, null, true), onOpenAuthor: openAuthor }} />
        )}
        {view === "parties" && (
          <PartiesWorkspace key={`p${focusFor("parties") ?? 0}`} initialId={focusFor("parties")}
            onOpen={openEntity} />
        )}
        {view === "documents" && (
          <DocumentsWorkspace
            key={compose ? `c${compose.bulk ? "bulk" : ""}${compose.settled ? "settled" : ""}${compose.matterId ?? ""}${compose.conditionIds.join("-")}r${compose.supersedesId ?? ""}`
                          : openDocument ? `d${openDocument.id}` : "docs"}
            start={compose ?? undefined} openDocumentId={openDocument?.id}
            openNonce={openDocument?.nonce} openAsDraft={openDocument?.edit} openStep={docStep}
            onSelectDocument={(id) => { setDocStep(null); setOpenDocument((prev) => (prev?.id === id ? prev : { id, nonce: (prev?.nonce ?? 0) + 1 })); }}
            onBack={docBack ? { label: docBack.label, go: () => goBack(docBack) } : undefined}
            flow={docFlow}
            // 新しく作るのは作業テーブルで（相手先を選んで始める）。一括も作業テーブルの一括モードで。
            onOpenWorkbench={(mode) => { if (mode) startWorkbench({ kind: "bulk", mode }); else { setWorkbench(null); setFocus(null); setView("workbench"); } }}
            // 訂正版・下敷きは作業テーブルの①で決める（文書の画面はそこへ送るだけ）。
            onOpenWorkbenchFor={(documentId, mode) => startWorkbench({ kind: "document", documentId, mode })}
            onOpen={openEntity} />
        )}
        {view === "agreements" && (
          <AgreementsWorkspace key={`a${focusFor("agreements") ?? 0}-${agreementPreset?.nonce ?? 0}`}
            initialId={focusFor("agreements")} onOpen={openEntity}
            createPreset={agreementPreset
              ? { partyId: agreementPreset.partyId, partyName: agreementPreset.partyName } : null}
            // 契約の画面で条件明細を登録したら、その条件で文書を作る画面へ進む（戻る先はその契約）。
            onCompose={(conditionIds, agreement, templateKey) =>
              startCompose(conditionIds, [], null, templateKey, null, null, null, agreementFlow(agreement))} />
        )}
        {view === "agreement-map" && (
          <AgreementMapWorkspace key={`am${focusFor("agreement-map") ?? mapParty ?? 0}`}
            initialPartyId={focusFor("agreement-map") ?? mapParty} onOpen={openEntity}
            onRegisterAgreement={startAgreement}
            initialMode={mapMode} onModeChange={setMapMode} onPartyChange={setMapParty} />
        )}
        {view === "closing" && (
          <ClosingWorkspace onOpenCondition={openCondition} onOpenDocument={openDocumentAt}
            onRecord={(conditionId, scheduleId) => openCondition(conditionId, scheduleId)} />
        )}
        {view === "ringi" && (
          <RingiWorkspace key={`r${focusFor("ringi") ?? 0}`} initialId={focusFor("ringi")}
                          onOpen={(kind, id) => openEntity(kind, id)} />
        )}
        {view === "rpt" && <RptWorkspace />}
        {view === "money" && <MoneyWorkspace />}
        {view === "drift" && (
          <DriftWorkspace key={`dr${driftMatter ?? 0}`} initialMatterId={driftMatter}
            onOpenDocument={openDocumentAt} onOpenCondition={openCondition}
            onOpenMatter={(id) => openEntity("matter", id)} />
        )}
        {view === "flows" && <FlowMonitorWorkspace onOpenCondition={openCondition} />}
        {view === "ops" && <OpsWorkspace key={opsTab ?? "quality"} initialTab={opsTab} onTabChange={setOpsTab} />}
      </main>
    </div>
    </ReadOnlyContext.Provider>
  );
}
