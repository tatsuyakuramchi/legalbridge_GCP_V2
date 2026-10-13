import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect, searchParties, type SearchOption } from "./SearchSelect.js";
import { DocumentSet } from "./DocumentSet.js";
import { DocumentImport } from "./DocumentImport.js";
import type { DocFlow } from "./FlowBar.js";
import type { PrepareMode, WorkbenchCandidate, WorkbenchPlan } from "../server/workbench/plan-service.js";
import { MASTER_DOC, PATTERN_LABEL, type WorkbenchPattern } from "../server/workbench/catalog.js";

/**
 * 作業テーブル。文書を「作る・登録する・繋ぐ」のはこの 1 枚だけ。
 *
 *   ① 要る文書と用意の仕方を決める … 依頼・案件・相手先から候補を出し、文書ごとに
 *        ひな形で作る／既にある文書を使う／外の文書を登録／あとで（今回は用意しない）を選ぶ
 *   ② 作る・登録する … 1 件ずつ進める。基本契約＋本体は 1 つのフォーム（DocumentSet）、
 *        外の文書は取込（DocumentImport）、1 枚だけなら文書の画面（流れの帯つき。決定すると戻る）
 *   ③ まとめ … 番号・状態を並べて、作業（案件）へ戻る
 *
 * 以前は「取引を進める」「条件明細」「作品」「デイリータスク」の 4 画面から別々の作り方で
 * 文書の画面へ飛び、決定すると全社の文書一覧に着いていた。
 */

export type WorkbenchEntry =
  | { kind: "task"; taskId: number; requestId: number }
  | { kind: "matter"; matterId: number }
  | { kind: "party"; partyId: number; workIds?: number[] }
  /** 取引管理の回から（決済文書を作る。実績を渡す）。 */
  | { kind: "round"; conditionId: number; scheduleId: number | null; eventId: number | null; label: string }
  /** 条件明細・作品・契約・案件の「文書を作る」から（選んだ条件で。ひな形が決まっていればそれを既定に）。 */
  | { kind: "conditions"; conditionIds: number[]; eventIds?: number[]; matterId?: number | null; requestId?: number | null; templateKey?: string | null };

export type UnitKind = "set" | "single" | "external";
export interface WorkUnit {
  key: string;
  kind: UnitKind;
  label: string;
  /** single のとき。 */
  templateKey?: string;
  conditionIds?: number[];
  /** 決済文書に渡す実績（取引管理の回から）。 */
  eventIds?: number[];
  /** set のとき：基本契約のひな形と本体のひな形。 */
  masterKey?: string; masterLabel?: string; mainOptions?: Array<{ key: string; label: string }>;
}
export interface UnitResult {
  status: "issued" | "draft" | "registered" | "linked";
  documentIds: number[];
}

export interface WorkbenchState {
  entry: WorkbenchEntry;
  /** 推した型を手で変えたとき。 */
  pattern?: WorkbenchPattern | null;
  step: "pick" | "work" | "done";
  modes: Record<string, PrepareMode>;
  templateKeys: Record<string, string>;
  /** 「既にある文書を使う」で選んだ文書。 */
  existingPick: Record<string, number | null>;
  /** 候補に無い文書を足したもの（ひな形の鍵）。 */
  extras: string[];
  units: WorkUnit[];
  /** ①で「既にある」を選んで繋いだ文書。 */
  linked: Array<{ label: string; documentId: number }>;
  results: Record<string, UnitResult>;
}

export const WORKBENCH_STEPS = ["要る文書を決める", "作る・登録する", "まとめ"];

export const newWorkbenchState = (entry: WorkbenchEntry): WorkbenchState =>
  ({ entry, pattern: null, step: "pick", modes: {}, templateKeys: {}, existingPick: {}, extras: [], units: [], linked: [], results: {} });

const MODE_LABEL: Record<PrepareMode, string> = {
  create: "ひな形で作る", existing: "既にある文書を使う", external: "外の文書を登録", later: "あとで", skip: "今回は用意しない"
};
const MODE_HINT: Record<PrepareMode, string> = {
  create: "文書の画面でひな形から作って決定する",
  existing: "この作業に繋ぐだけ。新しく番号は振らない",
  external: "相手方の文書や社内で起案した文書にファイルを付けて登録し、当社の文書番号を振る",
  later: "実績が出てから作る（この画面では作らない）",
  skip: "この作業では用意しない"
};

/** 文書を探す（全体検索。相手先・状態・種類を問わない）。 */
const searchAllDocuments = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ documents: Array<{ id: number; documentNo: string | null; templateLabel: string | null; title: string | null;
                                              counterparty: string | null; status: string; phase: string }> }>(
    `/documents?q=${encodeURIComponent(q)}`);
  const phase: Record<string, string> = { draft: "下書き", decided: "決定済み", sent: "送信済み", superseded: "訂正版あり", void: "無効" };
  return r.documents.filter((d) => d.status !== "void").slice(0, 20).map((d) => ({
    value: String(d.id), label: `${d.documentNo ?? `#${d.id}`}　${d.title ?? d.templateLabel ?? ""}`,
    hint: [d.counterparty, phase[d.phase] ?? d.phase].filter(Boolean).join("・")
  }));
};

export function WorkbenchWorkspace(
  { state, onState, onCompose, onOpenDocument, onOpenTask, onOpenMatter, onOpenCondition, onOpenDeals }: {
    /** null なら入口（相手先を選ぶ）。 */
    state: WorkbenchState | null;
    onState: (next: WorkbenchState | null) => void;
    /** 1 枚だけ作る。文書の画面を流れの帯つきで開く（決定したらこの画面へ戻る）。 */
    onCompose: (unit: WorkUnit, args: { conditionIds: number[]; eventIds: number[]; matterId: number | null; requestId: number | null; templateKey: string }) => void;
    onOpenDocument: (id: number) => void;
    onOpenTask: (taskId: number) => void;
    onOpenMatter: (matterId: number) => void;
    onOpenCondition: (conditionId: number) => void;
    /** 取引管理の回から来たとき、戻る先。 */
    onOpenDeals?: () => void;
  }
) {
  const readOnly = useReadOnly();
  if (!state) return <EntryPicker onPick={(entry) => onState(newWorkbenchState(entry))} />;
  return <Workbench key={entryKey(state.entry)} state={state} onState={onState} readOnly={readOnly}
                    onCompose={onCompose} onOpenDocument={onOpenDocument} onOpenTask={onOpenTask}
                    onOpenMatter={onOpenMatter} onOpenCondition={onOpenCondition} onOpenDeals={onOpenDeals} />;
}

const entryKey = (e: WorkbenchEntry) =>
  e.kind === "task" ? `t${e.taskId}` : e.kind === "matter" ? `m${e.matterId}`
    : e.kind === "round" ? `r${e.conditionId}-${e.scheduleId ?? 0}-${e.eventId ?? 0}`
    : e.kind === "conditions" ? `c${e.conditionIds.join(".")}-${e.matterId ?? 0}-${e.templateKey ?? ""}`
    : `p${e.partyId}-${(e.workIds ?? []).join(".")}`;

function EntryPicker({ onPick }: { onPick: (entry: WorkbenchEntry) => void }) {
  return (
    <section className="stack">
      <div className="panel">
        <div className="panel-hd"><h2>作業テーブル</h2><span className="faint">文書を作る・登録する・繋ぐのはここだけ</span></div>
        <div className="panel-bd stack" style={{ gap: 10 }}>
          <span>ふだんは デイリータスク か 案件 の「作業テーブルで文書を作る」から入ります。作業も案件も無い単発の文書は、相手先を選んで始めます。</span>
          <div style={{ maxWidth: 420 }}>
            <SearchSelect value="" search={searchParties} placeholder="相手先を探す（名前・コード）"
                          onChange={(v) => { if (v) onPick({ kind: "party", partyId: Number(v) }); }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Workbench(
  { state, onState, readOnly, onCompose, onOpenDocument, onOpenTask, onOpenMatter, onOpenCondition, onOpenDeals }: {
    state: WorkbenchState; onState: (next: WorkbenchState | null) => void; readOnly: boolean;
    onCompose: (unit: WorkUnit, args: { conditionIds: number[]; eventIds: number[]; matterId: number | null; requestId: number | null; templateKey: string }) => void;
    onOpenDocument: (id: number) => void; onOpenTask: (taskId: number) => void; onOpenMatter: (matterId: number) => void;
    onOpenCondition: (conditionId: number) => void; onOpenDeals?: () => void;
  }
) {
  const [plan, setPlan] = useState<WorkbenchPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Array<{ templateKey: string; label: string; category: string | null }>>([]);
  const [agreements, setAgreements] = useState<Array<{ id: number; agreementNo: string | null; title: string; status: string; kind: string }>>([]);
  const [channels, setChannels] = useState<Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const patch = (next: Partial<WorkbenchState>) => onState({ ...state, ...next });

  const e = state.entry;
  useEffect(() => {
    const q = new URLSearchParams();
    if (e.kind === "task") q.set("taskId", String(e.taskId));
    if (e.kind === "matter") q.set("matterId", String(e.matterId));
    if (e.kind === "party") { q.set("partyId", String(e.partyId)); if (e.workIds?.length) q.set("workIds", e.workIds.join(",")); }
    if (e.kind === "conditions") {
      q.set("conditionIds", e.conditionIds.join(","));
      if (e.matterId) q.set("matterId", String(e.matterId));
      if (e.requestId) q.set("requestId", String(e.requestId));
    }
    if (e.kind === "round") {
      q.set("conditionId", String(e.conditionId));
      if (e.scheduleId) q.set("scheduleId", String(e.scheduleId));
      if (e.eventId) q.set("eventId", String(e.eventId));
    }
    if (state.pattern) q.set("pattern", state.pattern);
    setError(null);
    api.get<WorkbenchPlan>(`/workbench/plan?${q}`)
      .then((p) => {
        setPlan(p);
        // 既定の用意の仕方は、候補の「suggested」。人が選び直した分は残す。
        const modes = { ...state.modes }; const keys = { ...state.templateKeys };
        let extras = state.extras;
        const want = e.kind === "conditions" ? e.templateKey ?? null : null;
        const first = Object.keys(state.modes).length === 0;
        for (const c of p.candidates) {
          const hit = want !== null && c.options.some((o) => o.key === want);
          // ひな形を決めて来たときは、その文書だけ「作る」。ほかは既にあるものを使うか、今回は用意しない。
          modes[c.id] ??= first && want ? (hit ? "create" : c.suggested === "existing" ? "existing" : c.role === "settlement" ? "later" : "skip") : c.suggested;
          keys[c.id] ??= hit ? want! : c.templateKey;
        }
        if (first && want && !p.candidates.some((c) => c.options.some((o) => o.key === want)) && !extras.includes(want)) {
          extras = [...extras, want];
        }
        if (Object.keys(modes).length !== Object.keys(state.modes).length || Object.keys(keys).length !== Object.keys(state.templateKeys).length
            || extras !== state.extras) {
          onState({ ...state, modes, templateKeys: keys, extras });
        }
        if (p.ctx.partyId) {
          api.get<{ agreements: typeof agreements }>(`/agreements?partyId=${p.ctx.partyId}`).then((a) => setAgreements(a.agreements)).catch(() => undefined);
        }
      })
      .catch((x: ApiError) => setError(x.message));
  }, [entryKey(e), state.pattern]);
  useEffect(() => {
    api.get<{ templates: typeof templates }>("/document-templates").then((r) => setTemplates(r.templates)).catch(() => undefined);
    api.get<{ channels?: typeof channels }>("/integrations").then((r) => setChannels(r.channels ?? [])).catch(() => undefined);
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => undefined);
  }, []);

  // 文書の画面で決定して戻ってきたとき（流れの帯の onIssued が結果を書く）、全部済んでいればまとめへ。
  useEffect(() => {
    if (state.step === "work" && state.units.length && state.units.every((u) => state.results[u.key])) onState({ ...state, step: "done" });
  }, [state.step, state.units, state.results]);

  const ctx = plan?.ctx ?? null;
  const conditionIds = useMemo(() => (plan?.conditions ?? []).map((c) => c.id), [plan]);
  const requestId = ctx?.requestId ?? null;
  const matterId = ctx?.matterId ?? null;

  /** ①で決めた用意の仕方から、②で進める単位を組む。 */
  function buildUnits(): WorkUnit[] {
    if (!plan) return [];
    const by = (id: string) => plan.candidates.find((c) => c.id === id);
    const master = by("master"); const main = by("main");
    const mode = (id: string) => state.modes[id] ?? by(id)?.suggested ?? "skip";
    const key = (id: string) => state.templateKeys[id] ?? by(id)?.templateKey ?? "";
    const units: WorkUnit[] = [];
    const bundle = Boolean(master && main && ctx?.setDomain && mode("master") === "create" && mode("main") === "create");
    if (bundle && master && main) {
      units.push({ key: "set", kind: "set", label: `${master.label}＋${main.label}`, masterKey: master.templateKey, masterLabel: master.label,
                   mainOptions: [...main.options].sort((a, b) => (a.key === key("main") ? -1 : b.key === key("main") ? 1 : 0)) });
    }
    for (const c of plan.candidates) {
      if (bundle && (c.id === "master" || c.id === "main")) continue;
      const m = mode(c.id);
      if (m === "create") units.push({ key: c.id, kind: "single", label: c.options.find((o) => o.key === key(c.id))?.label ?? c.label,
                                       templateKey: key(c.id), conditionIds: c.role === "master" ? [] : conditionIds,
                                       // 決済文書は、その回の実績を渡す（納品日・検収日・数量が本文に入る）。
                                       eventIds: c.role === "settlement"
                                         ? (ctx?.round?.eventId ? [ctx.round.eventId] : e.kind === "conditions" ? (e.eventIds ?? []) : []) : [] });
      if (m === "external") units.push({ key: c.id, kind: "external", label: c.label });
    }
    for (const t of state.extras) {
      const tpl = templates.find((x) => x.templateKey === t);
      const m = state.modes[`x:${t}`] ?? "create";
      if (m === "create") units.push({ key: `x:${t}`, kind: "single", label: tpl?.label ?? t, templateKey: t, conditionIds,
                                       eventIds: e.kind === "conditions" ? (e.eventIds ?? []) : [] });
      if (m === "external") units.push({ key: `x:${t}`, kind: "external", label: tpl?.label ?? t });
    }
    return units;
  }

  /** ① → ②。既にある文書は、ここで作業・案件に繋ぐ。 */
  async function start() {
    if (!plan) return;
    setBusy(true); setError(null);
    try {
      const linked: WorkbenchState["linked"] = [];
      for (const c of plan.candidates) {
        if ((state.modes[c.id] ?? c.suggested) !== "existing") continue;
        const pick = state.existingPick[c.id] ?? c.existing[0]?.id ?? null;
        if (!pick) continue;
        if (requestId) await api.post(`/intake/${requestId}/documents`, { documentId: pick });
        else if (matterId) await api.post(`/matters/${matterId}/documents`, { documentId: pick });
        linked.push({ label: c.label, documentId: pick });
      }
      const units = buildUnits();
      onState({ ...state, units, linked, step: units.length ? "work" : "done" });
    } catch (x) { setError(x instanceof ApiError ? x.message : String(x)); }
    finally { setBusy(false); }
  }

  const done = (key: string, result: UnitResult) => {
    const results = { ...state.results, [key]: result };
    const left = state.units.filter((u) => !results[u.key]);
    onState({ ...state, results, step: left.length ? "work" : "done" });
  };

  const back = () => (e.kind === "task" ? onOpenTask(e.taskId) : e.kind === "matter" ? onOpenMatter(e.matterId)
    : e.kind === "round" ? (onOpenDeals ? onOpenDeals() : onOpenCondition(e.conditionId))
    : e.kind === "conditions" ? (e.matterId ? onOpenMatter(e.matterId) : onOpenCondition(e.conditionIds[0]))
    : onState(null));
  const backLabel = e.kind === "task" ? "作業に戻る" : e.kind === "matter" ? "案件に戻る" : e.kind === "round" ? "取引管理に戻る"
    : e.kind === "conditions" ? (e.matterId ? "案件に戻る" : "条件明細に戻る") : "相手先を選び直す";

  return (
    <section className="stack">
      {/* 文脈の帯 */}
      <div className="flow-bar">
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ fontSize: 12.5 }}>作業テーブル</b>
          {ctx && (<>
            <span className="tag accent">{ctx.kind === "task" ? "デイリータスク" : ctx.kind === "matter" ? "案件" : ctx.kind === "round" ? "取引管理" : ctx.kind === "conditions" ? "条件明細" : "相手先"}</span>
            <span><b>{ctx.title}</b></span>
            {ctx.round && <span className="code faint">{ctx.round.conditionNo ?? ""} {ctx.round.roundLabel ?? ""}{ctx.round.eventId ? "・実績あり" : ""}</span>}
            {!ctx.round && (ctx.requestNo ?? ctx.matterNo) && <span className="code faint">{ctx.requestNo ?? ctx.matterNo}</span>}
            {ctx.partyName && <span className="faint">相手先：{ctx.partyName}</span>}
          </>)}
          <div className="pipe" style={{ flex: "1 1 280px" }}>
            {WORKBENCH_STEPS.map((name, i) => {
              const cur = state.step === "pick" ? 0 : state.step === "work" ? 1 : 2;
              const isDone = i < cur; const now = i === cur;
              return (
                <div key={name} className={`pipe-step${now ? " flag" : ""}`} style={isDone ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}>
                  <span className="st">{isDone ? "済" : now ? "いま" : i + 1}</span><span className="nm">{name}</span>
                </div>
              );
            })}
          </div>
          <button className="btn btn-sm" onClick={back}>← {backLabel}</button>
          <button className="linky" title="いまの作業テーブルを閉じて、相手先から別の文書を始める" onClick={() => onState(null)}>別の作業を始める</button>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!plan && !error && <div className="faint">読み込み中…</div>}

      {plan && state.step === "pick" && (
        <PickStep plan={plan} state={state} patch={patch} templates={templates} agreements={agreements}
                  busy={busy || readOnly} onStart={() => void start()} onOpenDocument={onOpenDocument} onOpenCondition={onOpenCondition} />
      )}

      {plan && state.step === "work" && (
        <WorkStep plan={plan} state={state} agreements={agreements} channels={channels} isAdmin={isAdmin}
                  onDone={done} onBackToPick={() => patch({ step: "pick" })}
                  onComposeUnit={(u) => onCompose(u, { conditionIds: u.conditionIds ?? conditionIds, eventIds: u.eventIds ?? [], matterId, requestId, templateKey: u.templateKey ?? "" })}
                  onOpenDocument={onOpenDocument} />
      )}

      {plan && state.step === "done" && (
        <DoneStep state={state} ctxNo={ctx?.requestNo ?? ctx?.matterNo ?? null} onOpenDocument={onOpenDocument}
                  onBack={back} backLabel={backLabel} onRestart={() => onState(newWorkbenchState(state.entry))} />
      )}
    </section>
  );
}

function PickStep(
  { plan, state, patch, templates, agreements, busy, onStart, onOpenDocument, onOpenCondition }: {
    plan: WorkbenchPlan; state: WorkbenchState; patch: (next: Partial<WorkbenchState>) => void;
    templates: Array<{ templateKey: string; label: string; category: string | null }>;
    agreements: Array<{ id: number; agreementNo: string | null; title: string; status: string; kind: string }>;
    busy: boolean; onStart: () => void; onOpenDocument: (id: number) => void; onOpenCondition: (id: number) => void;
  }
) {
  const ctx = plan.ctx;
  const mode = (c: WorkbenchCandidate) => state.modes[c.id] ?? c.suggested;
  const setMode = (id: string, m: PrepareMode) => patch({ modes: { ...state.modes, [id]: m } });
  const [addKey, setAddKey] = useState("");
  const counts = plan.candidates.reduce((a, c) => { const m = mode(c); a[m] = (a[m] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const extrasN = state.extras.length;
  const anything = (counts.create ?? 0) + (counts.existing ?? 0) + (counts.external ?? 0) + extrasN > 0;
  const bundle = Boolean(ctx.setDomain) && plan.candidates.some((c) => c.id === "master" && mode(c) === "create")
    && plan.candidates.some((c) => c.id === "main" && mode(c) === "create");

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>① 要る文書と、その用意の仕方を決める</h2>
        <span className="faint">取引の型：</span>
        <span className="chips">
          {(Object.keys(PATTERN_LABEL) as WorkbenchPattern[]).map((p) => (
            <button key={p} type="button" className="chip" aria-pressed={ctx.pattern === p}
                    onClick={() => patch({ pattern: p, modes: {}, templateKeys: {} })}>{PATTERN_LABEL[p]}</button>
          ))}
        </span>
      </div>
      <div className="panel-bd stack" style={{ gap: 12 }}>
        {/* 繋いである条件 */}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="faint">本体の文書に載せる条件明細：</span>
          {plan.conditions.length === 0 && <span className="tag warn">まだ無い。条件明細を登録してから作る（基本契約だけなら無くてよい）</span>}
          {plan.conditions.map((c) => (
            <button key={c.id} className="linky" onClick={() => onOpenCondition(c.id)}>
              <span className="code">{c.conditionNo ?? `#${c.id}`}</span> {c.name}
            </button>
          ))}
          {plan.otherConditions.length > 0 && (
            <span className="faint">（型に合わない条件 {plan.otherConditions.length} 件は載せない：{plan.otherConditions.map((c) => c.name).join("・")}）</span>
          )}
        </div>
        {plan.linkedDocuments.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="faint">この{ctx.kind === "task" ? "作業" : ctx.kind === "round" || ctx.kind === "conditions" ? "条件" : "案件"}に既に繋がっている文書：</span>
            {plan.linkedDocuments.map((d) => (
              <button key={d.id} className="linky" onClick={() => onOpenDocument(d.id)}>
                <span className="code">{d.documentNo ?? `#${d.id}`}</span> {d.templateLabel ?? d.title ?? ""}
              </button>
            ))}
          </div>
        )}

        {plan.candidates.length === 0 && (
          <div className="note">この型には決まった候補がありません。下の「候補に無い文書を足す」からひな形を選ぶか、取引の型を変えてください。</div>
        )}

        {plan.candidates.map((c) => {
          const m = mode(c);
          const modes: PrepareMode[] = c.role === "settlement" ? ["later", "create", "existing", "external", "skip"] : ["create", "existing", "external", "skip"];
          const key = state.templateKeys[c.id] ?? c.templateKey;
          return (
            <div key={c.id} className="stack" style={{ gap: 8, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 8,
                                                         background: m === "skip" || m === "later" ? "var(--sunken)" : "var(--surface)" }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <b style={{ fontSize: 14 }}>{c.label}</b>
                <span className={`tag ${c.needed === "now" ? "ok" : "warn"}`}>{c.needed === "now" ? "要る" : "あとで要る"}</span>
                <span className="faint">{c.why}</span>
                {c.agreements.some((a) => a.live) && (
                  <span className="faint">契約の記録：{c.agreements.filter((a) => a.live).map((a) => a.agreementNo ?? `#${a.id}`).join("・")}</span>
                )}
              </div>
              <div className="chips" role="radiogroup" aria-label={`${c.label} の用意の仕方`}>
                {modes.map((x) => (
                  <button key={x} type="button" className="chip" role="radio" aria-checked={m === x} aria-pressed={m === x}
                          title={MODE_HINT[x]} disabled={x === "existing" && c.existing.length === 0 && false}
                          onClick={() => setMode(c.id, x)}>{MODE_LABEL[x]}</button>
                ))}
              </div>
              {m === "create" && c.options.length > 1 && (
                <label className="field"><span>ひな形</span>
                  <select value={key} onChange={(ev) => patch({ templateKeys: { ...state.templateKeys, [c.id]: ev.target.value } })}>
                    {c.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </label>
              )}
              {m === "existing" && (
                <div className="stack" style={{ gap: 6 }}>
                  {c.existing.length > 0 ? (
                    <label className="field"><span>この相手先の文書</span>
                      <select value={String(state.existingPick[c.id] ?? c.existing[0].id)}
                              onChange={(ev) => patch({ existingPick: { ...state.existingPick, [c.id]: Number(ev.target.value) } })}>
                        {c.existing.map((d) => (
                          <option key={d.id} value={d.id}>{d.documentNo ?? `#${d.id}`}　{d.title ?? d.templateLabel ?? ""}（{d.phase === "sent" ? "送信済み" : "決定済み"}）</option>
                        ))}
                      </select>
                    </label>
                  ) : c.agreements.some((a) => a.live) ? (
                    <span>
                      契約の記録 <b>{c.agreements.filter((a) => a.live).map((a) => `${a.agreementNo ?? `#${a.id}`} ${a.title}`).join("・")}</b> を使います
                      （文書は V3 に無い。本体の文書はこの契約の下に置かれます）
                    </span>
                  ) : (
                    <span className="faint">この相手先の決定済みの同じ文書は見つかりません。下で全部の文書から探せます。</span>
                  )}
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="faint">見つからないとき：全部の文書から探す</span>
                    <div style={{ flex: "1 1 320px" }}>
                      <SearchSelect value="" search={searchAllDocuments} placeholder="文書番号・件名・相手先名（相手先・状態・種類を問わず）"
                                    onChange={(v) => { if (v) patch({ existingPick: { ...state.existingPick, [c.id]: Number(v) } }); }} />
                    </div>
                    {state.existingPick[c.id] && !c.existing.some((d) => d.id === state.existingPick[c.id]) && (
                      <span className="tag warn">候補に無い文書 #{state.existingPick[c.id]} を選んでいます（相手先が違わないか確かめてください）</span>
                    )}
                  </div>
                  <span className="faint">{MODE_HINT.existing}</span>
                </div>
              )}
              {m === "external" && <span className="faint">{MODE_HINT.external}。②でファイルを付けて登録します</span>}
              {m === "later" && <span className="faint">{MODE_HINT.later}</span>}
            </div>
          );
        })}

        {/* 候補に無い文書 */}
        <div className="stack" style={{ gap: 6, borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="faint">候補に無い文書を足す（NDA・覚書・通知書など）：</span>
            <select value={addKey} onChange={(ev) => setAddKey(ev.target.value)}>
              <option value="">ひな形を選ぶ</option>
              {templates.filter((t) => !state.extras.includes(t.templateKey)).map((t) => (
                <option key={t.templateKey} value={t.templateKey}>{t.category ? `${t.category}／${t.label}` : t.label}</option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={!addKey} onClick={() => { patch({ extras: [...state.extras, addKey] }); setAddKey(""); }}>足す</button>
          </div>
          {state.extras.map((t) => {
            const tpl = templates.find((x) => x.templateKey === t);
            const m = state.modes[`x:${t}`] ?? "create";
            return (
              <div key={t} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b>{tpl?.label ?? t}</b>
                <span className="chips">
                  {(["create", "external"] as PrepareMode[]).map((x) => (
                    <button key={x} type="button" className="chip" aria-pressed={m === x} onClick={() => setMode(`x:${t}`, x)}>{MODE_LABEL[x]}</button>
                  ))}
                </span>
                <button className="linky" onClick={() => patch({ extras: state.extras.filter((x) => x !== t) })}>外す</button>
              </div>
            );
          })}
        </div>

        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy || !anything} onClick={onStart}>
            {anything ? `進める（作る ${(counts.create ?? 0) + extrasN}・登録 ${counts.external ?? 0}・繋ぐ ${counts.existing ?? 0}）` : "文書を選んでください"}
          </button>
          <span className="faint">
            {bundle ? "基本契約書と本体は 1 つのフォームでまとめて作ります。" : ""}
            {MASTER_DOC[ctx.pattern] && plan.candidates.some((c) => c.id === "master" && mode(c) === "skip")
              ? "基本契約なしで本体を作ると、単体契約として扱われます。" : ""}
            {agreements.length === 0 && ctx.partyId ? "この相手先には契約の記録がありません。" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

function WorkStep(
  { plan, state, agreements, channels, isAdmin, onDone, onBackToPick, onComposeUnit, onOpenDocument }: {
    plan: WorkbenchPlan; state: WorkbenchState;
    agreements: Array<{ id: number; agreementNo: string | null; title: string; status: string; kind: string }>;
    channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>; isAdmin: boolean;
    onDone: (key: string, result: UnitResult) => void; onBackToPick: () => void;
    onComposeUnit: (u: WorkUnit) => void; onOpenDocument: (id: number) => void;
  }
) {
  const ctx = plan.ctx;
  const current = state.units.find((u) => !state.results[u.key]) ?? null;
  const idx = current ? state.units.indexOf(current) : state.units.length;
  const statusOf = (u: WorkUnit) => {
    const r = state.results[u.key];
    if (!r) return u === current ? "いま進めている" : "まだ";
    return r.status === "issued" ? "決定済み" : r.status === "draft" ? "下書き" : r.status === "registered" ? "登録済み（番号を振った）" : "繋いだ";
  };
  return (
    <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <nav className="panel" aria-label="進める文書" style={{ flex: "1 1 240px", maxWidth: 320 }}>
        <div className="panel-hd"><h2>② 作る・登録する</h2><span className="faint">{Math.min(idx + 1, state.units.length)} / {state.units.length}</span></div>
        <div className="panel-bd stack" style={{ gap: 6 }}>
          {state.linked.map((l) => (
            <div key={`l${l.documentId}`} style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--sunken)" }}>
              <div className="faint">既にある文書を使う</div>
              <b>{l.label}</b>
              <div className="faint" style={{ color: "var(--ok)" }}>繋いだ　<button className="linky" onClick={() => onOpenDocument(l.documentId)}>開く</button></div>
            </div>
          ))}
          {state.units.map((u) => (
            <div key={u.key} style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${u === current ? "var(--accent)" : "var(--line)"}`,
                                       background: u === current ? "var(--accent-soft)" : "var(--surface)" }}>
              <div className="faint">{u.kind === "set" ? "ひな形で作る（まとめて）" : u.kind === "single" ? "ひな形で作る" : "外の文書を登録"}</div>
              <b>{u.label}</b>
              <div className="faint" style={{ color: state.results[u.key] ? "var(--ok)" : undefined }}>
                {statusOf(u)}
                {state.results[u.key]?.documentIds.map((id) => (
                  <span key={id}>　<button className="linky" onClick={() => onOpenDocument(id)}>開く</button></span>
                ))}
              </div>
            </div>
          ))}
          <button className="btn btn-sm" onClick={onBackToPick}>用意の仕方を変える</button>
        </div>
      </nav>

      <div style={{ flex: "999 1 520px", minWidth: 0 }}>
        {current?.kind === "single" && (
          <div className="panel">
            <div className="panel-hd"><h2>{current.label}</h2><span className="tag accent">ひな形で作る</span>
              <span className="faint">ひな形はここで決まっている（文書の画面で選び直さない）</span></div>
            <div className="panel-bd stack" style={{ gap: 10 }}>
              <span>
                文書の画面がこの作業の帯つきで開きます。決定すると、この画面に戻って次の文書へ進みます。
                下書きのまま戻ってもよい（「下書き」として残り、あとで続きから作れます）。
              </span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => onComposeUnit(current)}>文書の画面で作る</button>
                <button className="btn" onClick={() => onDone(current.key, { status: "draft", documentIds: [] })}>この文書は飛ばして次へ</button>
              </div>
              {current.key !== "master" && (current.conditionIds?.length ?? 0) === 0 && (
                <div className="note warn">条件明細が繋がっていません。本体の文書は条件から作るので、先に条件明細を登録して繋いでください（基本契約書は条件なしで作れます）。</div>
              )}
            </div>
          </div>
        )}

        {current?.kind === "set" && ctx.partyId && ctx.setDomain && (
          <DocumentSet domain={ctx.setDomain} matterId={ctx.matterId} partyId={ctx.partyId} partyName={ctx.partyName}
            masterKey={current.masterKey ?? ""} masterLabel={current.masterLabel ?? "基本契約書"}
            termsOptions={current.mainOptions ?? []}
            conditions={plan.conditions.map((c) => ({ id: c.id, conditionNo: c.conditionNo, name: c.name, work: c.work ? { id: c.work.id, title: c.work.title } : null }))}
            agreements={agreements} channels={channels} isAdmin={isAdmin}
            onIssued={(r) => { if (r) onDone(current.key, { status: "issued", documentIds: r.documents.map((d) => d.id) }); }}
            onOpenDocument={onOpenDocument}
            onClose={() => onDone(current.key, { status: "draft", documentIds: [] })} />
        )}

        {current?.kind === "external" && (
          <div className="panel">
            <div className="panel-hd"><h2>{current.label}</h2><span className="tag warn">外の文書を登録</span>
              <span className="faint">ひな形は使わない。登録すると当社の文書番号を振る</span></div>
            <div className="panel-bd stack" style={{ gap: 10 }}>
              <DocumentImport key={current.key} initialMode="import" requestId={ctx.requestId ?? undefined} matterId={ctx.matterId ?? undefined}
                              conditionIds={plan.conditions.map((c) => c.id)}
                              onDone={() => undefined}
                              onRegistered={(id) => onDone(current.key, { status: "registered", documentIds: [id] })}
                              onOpenDocument={onOpenDocument} />
              <button className="linky" onClick={() => onDone(current.key, { status: "draft", documentIds: [] })}>この文書は飛ばして次へ</button>
            </div>
          </div>
        )}

        {!current && <div className="note">すべて済みました。</div>}
      </div>
    </div>
  );
}

function DoneStep(
  { state, ctxNo, onOpenDocument, onBack, backLabel, onRestart }: {
    state: WorkbenchState; ctxNo: string | null; onOpenDocument: (id: number) => void;
    onBack: () => void; backLabel: string; onRestart: () => void;
  }
) {
  const ids = [...state.linked.map((l) => l.documentId), ...Object.values(state.results).flatMap((r) => r.documentIds)];
  const [nos, setNos] = useState<Record<number, { documentNo: string | null; status: string }>>({});
  useEffect(() => {
    let alive = true;
    Promise.all(ids.map((id) => api.get<{ documentNo: string | null; status: string }>(`/documents/${id}`).then((d) => [id, d] as const).catch(() => null)))
      .then((rows) => { if (alive) setNos(Object.fromEntries(rows.filter(Boolean).map((r) => [r![0], { documentNo: r![1].documentNo, status: r![1].status }]))); });
    return () => { alive = false; };
  }, [ids.join(",")]);
  const rows = [
    ...state.linked.map((l) => ({ label: l.label, way: "既にある文書を使う", ids: [l.documentId], status: "繋いだ", next: "そのまま使う" })),
    ...state.units.map((u) => {
      const r = state.results[u.key];
      const way = u.kind === "set" ? "ひな形で作る（まとめて）" : u.kind === "single" ? "ひな形で作る" : "外の文書を登録";
      const status = !r || (r.status === "draft" && !r.documentIds.length) ? "作っていない（飛ばした）"
        : r.status === "issued" ? "決定済み" : r.status === "draft" ? "下書き" : "登録済み（番号を振った）";
      const next = r?.status === "issued" ? "送る" : r?.status === "registered" ? "署名・原本の回収／送る" : r?.status === "draft" && r.documentIds.length ? "続きを作る" : "—";
      return { label: u.label, way, ids: r?.documentIds ?? [], status, next };
    })
  ];
  return (
    <div className="panel">
      <div className="panel-hd"><h2>③ この{ctxNo ? `作業（${ctxNo}）` : "作業"}の文書</h2><span className="faint">文書一覧には移りません</span></div>
      <div className="panel-bd stack" style={{ gap: 12 }}>
        <table className="compact">
          <thead><tr><th>文書</th><th>用意の仕方</th><th>番号</th><th>状態</th><th>次にすること</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><b>{r.label}</b></td>
                <td className="faint">{r.way}</td>
                <td className="code">
                  {r.ids.length ? r.ids.map((id) => (
                    <button key={id} className="linky code" onClick={() => onOpenDocument(id)}>{nos[id]?.documentNo ?? `#${id}`}</button>
                  )) : "—"}
                </td>
                <td>{r.status}</td>
                <td className="faint">{r.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={onBack}>{backLabel}</button>
          <span className="faint">送るときは、文書を開いて「送る」から（メール・CloudSign）。</span>
          <button className="linky" style={{ marginLeft: "auto" }} onClick={onRestart}>もう一度 ① から</button>
        </div>
      </div>
    </div>
  );
}
