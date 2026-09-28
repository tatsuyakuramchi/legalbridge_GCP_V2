import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { RoundReport } from "./RoundReport.js";
import { RoyaltyCloses } from "./RoyaltyCloses.js";
import { StatementBreakdown, type StatementLine, type StatementTotals } from "./StatementLines.js";
import { roundTargets, roundTitle } from "./RoundPicker.js";
import type {
  LedgerCondition, LedgerView, Round, WorkRoyaltyParty
} from "../server/royalty/ledger-service.js";
import type { DocBack } from "./WorksWorkspace.js";

/**
 * 作品 › 利用許諾計算（許諾料の台帳）。docs/royalty-ledger.md
 *
 * 作家 × この作品（切り替えれば作家 × 全作品）で、条件を毎期くり返し使って
 * 計算書を出す。主役は「開いている回」。作品が何本あっても、いま手を動かす回は
 * 数件に収まる。過去の回は年ごとに畳む。
 *
 * 計算（料率・MG・AG・税）は束ねた計算書（/statement-documents）がする。
 * ここは回ごとに実績を揃え、その回の実績で計算書を出すだけ。
 * 受付箱で「案件にせず処理」した計算書の依頼は、回に付けて見せる。
 * ここで出した計算書で、依頼の工程（作成→送付→支払予定→支払）が進む。
 */

const yen = (n: number | null | undefined, currency = "JPY") =>
  n === null || n === undefined ? "—" : currency === "JPY"
    ? `¥${Number(n).toLocaleString("ja-JP")}` : `${currency} ${(Number(n) / 100).toLocaleString("en-US")}`;
const pct = (ppm: number | null) => (ppm === null ? "—" : `${ppm / 10000}%`);
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "—");

/** まだ数字の無い行の数。来るはずの行と、行の無い報告待ちの条件。 */
const waitingLinesOf = (r: Round) => r.parts
  .reduce((n, p) => n + (p.state === "waiting" || p.state === "before" ? Math.max(p.expected.length, 1) : p.expected.length), 0);

const ROUND_STATE: Record<string, { label: string; tag: string }> = {
  before: { label: "締め前", tag: "" },
  input: { label: "実績を入力中", tag: "accent" },
  ready: { label: "計算書を作れる", tag: "warn" },
  issued: { label: "計算書を決定", tag: "ok" },
  sent: { label: "送付済", tag: "ok" },
  scheduled: { label: "支払予定", tag: "accent" },
  paid: { label: "支払済", tag: "ok" },
  nopay: { label: "支払なし（AG 充当など）", tag: "ok" },
  skipped: { label: "報告なし", tag: "" }
};
const PART_STATE: Record<string, { label: string; tag: string }> = {
  before: { label: "締め前", tag: "" },
  waiting: { label: "報告待ち", tag: "warn" },
  reported: { label: "入力済", tag: "accent" },
  skipped: { label: "報告なし", tag: "" },
  issued: { label: "計算書済", tag: "ok" }
};

/** 開いている依頼（受付箱で案件にせず処理した計算書の依頼）。回に繋ぐ候補。 */
interface OpenRequest { id: number; requestNo: string | null; title: string; purpose: string | null;
                        requesterName: string | null; assigneeName: string | null }
const useOpenRequests = (version: number) => {
  const [list, setList] = useState<OpenRequest[]>([]);
  useEffect(() => {
    api.get<{ items: OpenRequest[] }>("/intake?state=direct").then((r) => setList(r.items)).catch(() => setList([]));
  }, [version]);
  return list;
};

export function RoyaltyLedger(
  { workId, initialPartyId, onOpenDocument, onOpenRequest, onCompose }: {
    workId: number;
    /**
     * 計算書を作る。その回の条件と実績を選んだ状態で文書の画面へ移る。
     * 中身の確認・手入力・下書き保存・決定は文書の画面でする（台帳からいきなり決定しない）。
     */
    onCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null, back: DocBack) => void;
    initialPartyId?: number | null;
    onOpenDocument?: (documentId: number, back?: DocBack | null) => void;
    /** 作家・作品 → 依頼。受付箱のその依頼を開く。 */
    onOpenRequest?: (requestId: number) => void;
  }
) {
  const readOnly = useReadOnly();
  const [parties, setParties] = useState<WorkRoyaltyParty[] | null>(null);
  const [partyId, setPartyId] = useState<number | null>(initialPartyId ?? null);
  const [allWorks, setAllWorks] = useState(false);
  const [view, setView] = useState<LedgerView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, []);
  useEffect(() => {
    setParties(null);
    api.get<{ parties: WorkRoyaltyParty[] }>(`/works/${workId}/royalty`)
      .then((r) => {
        setParties(r.parties);
        setPartyId((cur) => cur && r.parties.some((p) => p.id === cur) ? cur : r.parties[0]?.id ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [workId, version]);
  useEffect(() => {
    if (!partyId) { setView(null); return; }
    api.get<LedgerView>(`/royalty-ledger?partyId=${partyId}${allWorks ? "" : `&workId=${workId}`}`)
      .then((v) => {
        setView(v);
        setSelected((cur) => cur && [...v.rounds, ...v.history].some((r) => r.key === cur) ? cur : v.rounds.find((r) => r.state !== "before")?.key ?? v.rounds[0]?.key ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [partyId, allWorks, workId, version]);

  const reload = (message?: string) => { if (message) setNotice(message); setError(null); setVersion((n) => n + 1); };
  const openRequests = useOpenRequests(version);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [bulkBefore, setBulkBefore] = useState(new Date().toISOString().slice(0, 10));
  async function linkRequest(requestId: number, round: Round, unlink = false) {
    try {
      await api.post(`/intake/${requestId}/rounds${unlink ? "/unlink" : ""}`, roundTargets(round));
      reload(unlink ? "依頼を外しました" : "依頼をこの回に紐づけました");
    } catch (e) { setError((e as ApiError).message); }
  }
  async function skipBefore() {
    if (!view) return;
    try {
      const r = await api.post<{ count: number }>("/royalty-ledger/skips/before",
        { partyId: view.party.id, workId: allWorks ? null : workId, before: bulkBefore });
      setBulkOpen(false);
      reload(`${bulkBefore} より前の空の回 ${r.count} 件を報告なしにしました`);
    } catch (e) { setError((e as ApiError).message); }
  }
  const oldWaiting = view ? view.rounds.flatMap((r) => r.parts).filter((p) => p.state === "waiting").length : 0;
  const party = parties?.find((p) => p.id === partyId) ?? null;
  const round = [...(view?.rounds ?? []), ...(view?.history ?? [])].find((r) => r.key === selected) ?? null;
  /** 文書の画面から戻る先。この作家 × この作品。 */
  const back: DocBack | null = view ? { label: `${view.party.name} × ${view.scope?.workTitle ?? "全作品"}`, workId, partyId: view.party.id } : null;
  const openDoc = onOpenDocument ? (id: number) => onOpenDocument(id, back) : undefined;
  const composeWith = onCompose && back ? (ids: number[], events: number[], key: string | null) => onCompose(ids, events, key, back) : undefined;

  async function setBundle(bundle: "per_work" | "per_party") {
    if (!view) return;
    try { await api.put("/royalty-ledger/bundle", { partyId: view.party.id, bundle }); reload("計算書のまとめ方を変えました"); }
    catch (e) { setError((e as ApiError).message); }
  }

  if (parties && !parties.length) {
    return (
      <div className="panel"><div className="panel-bd faint">
        この作品には、料率・単価で計算する許諾（IN）の条件がありません。条件の「利用形態」と「計算方式（料率）」を入れると、作家ごとの台帳がここに出ます。
      </div></div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      {/* 作家。作品を許諾している人ごとに台帳がある。 */}
      <div className="ledger-parties">
        {(parties ?? []).map((p) => (
          <button key={p.id} className="ledger-party" aria-pressed={p.id === partyId}
                  onClick={() => { setPartyId(p.id); setSelected(null); }}>
            <b>{p.name}</b>
            <span className="faint">{p.conditions.map((c) => `${c.usageLabel} ${pct(c.ratePpm)}`).join("・")}</span>
            <span className="row" style={{ gap: 4 }}>
              <span className="tag">開いている回 {p.openRounds}</span>
              {p.waiting > 0 && <span className="tag warn">報告待ち {p.waiting}</span>}
              {p.nextPayOn && <span className="tag">次の支払 {md(p.nextPayOn)}</span>}
              {p.requests.map((r) => <span key={r.id} className="tag pin">{r.requestNo ?? `#${r.id}`}</span>)}
            </span>
          </button>
        ))}
        {!parties && <span className="faint">読み込んでいます…</span>}
      </div>

      {view && (
        <>
          {/* 見出し：作家 × 作品。条件と締めの設定は押したときだけ開く。 */}
          <div className="ledger-head">
            <div className="stack" style={{ gap: 0 }}>
              <h2 style={{ margin: 0 }}>{view.party.name}{allWorks ? " × 全作品" : ` × ${view.scope?.workTitle ?? ""}`}</h2>
              <span className="faint">
                {view.party.kind === "individual" ? "個人" : "法人"}・{view.party.residency === "non_resident" ? "非居住者" : "居住者"}
                　· 計算書は{view.party.bundle === "per_party" ? "作家でまとめる" : "作品ごと"}
              </span>
            </div>
            <div className="row" style={{ gap: 6, marginLeft: "auto" }}>
              <span className="chips" role="group" aria-label="見る範囲">
                <button className="chip" aria-pressed={!allWorks} onClick={() => { setAllWorks(false); setSelected(null); }}>この作品</button>
                <button className="chip" aria-pressed={allWorks} onClick={() => { setAllWorks(true); setSelected(null); }}>
                  この作家の全作品{party ? `（${party.otherWorks + 1}）` : ""}
                </button>
              </span>
              {view.conditions.map((c) => (
                <span key={c.id} className="ledger-term-chip">
                  <span className="faint">{c.usageLabel}</span> <b>{c.pricingModel === "unit_rate" ? yen(c.unitAmount, c.currency) : pct(c.ratePpm)}</b>
                  <span className="faint"> · {c.timing === "event" ? "イベント式" : `締め ${c.schedules} 回`}</span>
                </span>
              ))}
              <button className="btn btn-sm" aria-pressed={settings} onClick={() => setSettings(!settings)}>条件と締めの設定…</button>
            </div>
          </div>
          {settings && (
            <div className="panel">
              <div className="panel-hd"><h2>条件と締め</h2><span className="faint">出し方と締めの時期だけ。料率・MG・AG は条件明細で</span>
                <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                  <span className="faint">計算書のまとめ方</span>
                  <span className="chips" role="group" aria-label="計算書のまとめ方">
                    <button className="chip" disabled={!canWrite} aria-pressed={view.party.bundle === "per_work"} onClick={() => void setBundle("per_work")}>作品ごと</button>
                    <button className="chip" disabled={!canWrite} aria-pressed={view.party.bundle === "per_party"} onClick={() => void setBundle("per_party")}>作家でまとめる</button>
                  </span>
                </span>
              </div>
              <div className="panel-bd">
                <Terms conditions={view.conditions} allWorks={allWorks} canWrite={canWrite} onChanged={reload} onError={setError} />
                {canWrite && oldWaiting > 0 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    {!bulkOpen && <button className="btn btn-sm" onClick={() => setBulkOpen(true)}>空の回をまとめて報告なしに…</button>}
                    {bulkOpen && (
                      <div className="note row" style={{ gap: 8 }}>
                        <span>締めが</span>
                        <input type="date" value={bulkBefore} onChange={(e) => setBulkBefore(e.target.value)} aria-label="この日より前" />
                        <span>より前で、実績の無い回（報告待ち）をすべて「報告なし」にします。実績のある回・締め前の回はそのままです。あとで1本ずつ取り消せます。</span>
                        <button className="btn btn-sm primary" onClick={() => void skipBefore()}>報告なしにする</button>
                        <button className="btn btn-sm" onClick={() => setBulkOpen(false)}>やめる</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 左に回の一覧、右にその回の中身。 */}
          <div className="ledger-split">
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>回</h2>
                <span className="faint">支払日でまとめる</span>
              </div>
              {view.rounds.map((r) => <RoundCard key={r.key} round={r} view={view} selected={r.key === selected}
                                                 onSelect={() => setSelected(r.key)} />)}
              {!view.rounds.length && <span className="faint">開いている回はありません。締めを作ると回が出ます。</span>}
              {view.requests.length > 0 && (
                <div className="note stack" style={{ gap: 4 }}>
                  <b>回を選んでいない依頼</b>
                  {view.requests.map((q) => (
                    <div key={q.id} className="row" style={{ gap: 6 }}>
                      {onOpenRequest
                        ? <button className="tag pin" onClick={() => onOpenRequest(q.id)}>{q.requestNo ?? `#${q.id}`}</button>
                        : <span className="tag pin">{q.requestNo ?? `#${q.id}`}</span>}
                      <span>{q.title}</span>
                      {canWrite && round && (
                        <button className="linky" onClick={() => void linkRequest(q.id, round)}>{roundTitle(round)}に付ける</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <History view={view} onSelect={(key) => setSelected(key)} selected={selected} />
            </div>
            {round
              ? <RoundDetail key={`${round.key}-${version}`} round={round} view={view} canWrite={canWrite}
                             onChanged={reload} onError={setError} onOpenDocument={openDoc}
                             openRequests={openRequests} onLink={linkRequest} onOpenRequest={onOpenRequest}
                             onCompose={composeWith} />
              : <div className="panel"><div className="panel-bd faint">左で回を選ぶと、ここに報告の表と計算書が出ます。</div></div>}
          </div>
        </>
      )}
    </div>
  );
}

/** この組の条件。料率と出し方（時限式／イベント式）。予定明細が無ければその場で作る。 */
function Terms(
  { conditions, allWorks, canWrite, onChanged, onError }: {
    conditions: LedgerCondition[]; allWorks: boolean; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
  }
) {
  const [scheduling, setScheduling] = useState<number | null>(null);
  async function setTiming(c: LedgerCondition, timing: string) {
    try {
      await api.put("/royalty-ledger/timing", { conditionId: c.id, timing: timing || null });
      onChanged(`${c.usageLabel} の出し方を変えました`);
    } catch (e) { onError((e as ApiError).message); }
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="ledger-terms">
        {conditions.map((c) => (
          <div key={c.id} className="ledger-term">
            <span className="faint">{allWorks && c.workTitle ? `${c.workTitle} · ` : ""}{c.usageLabel}</span>
            <b className="num" style={{ textAlign: "left" }}>{c.pricingModel === "unit_rate" ? yen(c.unitAmount, c.currency) : pct(c.ratePpm)}</b>
            <span className="faint code">{c.conditionNo ?? `#${c.id}`}{c.agreementNo ? ` · ${c.agreementNo}` : ""}</span>
            {(c.agAmount || c.mgAmount) ? <span className="faint">{c.agAmount ? `AG ${yen(c.agAmount, c.currency)}` : ""} {c.mgAmount ? `MG ${yen(c.mgAmount, c.currency)}` : ""}</span> : null}
            <label className="row" style={{ gap: 4 }}>
              <span className="faint">出し方</span>
              <select value={c.timingExplicit ? c.timing : ""} disabled={!canWrite}
                      onChange={(e) => void setTiming(c, e.target.value)}>
                <option value="">{c.timing === "event" ? "イベント式（既定）" : "時限式（既定）"}</option>
                <option value="periodic">時限式（締めで回る）</option>
                <option value="event">イベント式（製造・刷のたび）</option>
              </select>
            </label>
            {c.timing === "periodic" && (
              <span className="row" style={{ gap: 4 }}>
                {c.schedules ? <span className="faint">締め {c.schedules} 回</span> : <span className="tag warn">締めなし</span>}
                {canWrite && (
                  <button className="btn btn-sm" onClick={() => setScheduling(scheduling === c.id ? null : c.id)}>
                    {c.schedules ? "締めを足す" : "締めを作る"}
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      {scheduling && conditions.some((c) => c.id === scheduling) && (
        <RoyaltyCloses key={scheduling} condition={conditions.find((c) => c.id === scheduling)!}
                       onCancel={() => setScheduling(null)}
                       onSaved={(m) => { setScheduling(null); onChanged(m); }} />
      )}
    </div>
  );
}

function RoundCard({ round: r, view, selected, onSelect }: { round: Round; view: LedgerView; selected: boolean; onSelect: () => void }) {
  const n = r.parts.length;
  const done = r.parts.filter((p) => p.state !== "waiting" && p.state !== "before").length;
  const waiting = r.open && (r.state === "input" || r.state === "ready") ? waitingLinesOf(r) : 0;
  const periods = [...new Set(r.parts.map((p) => p.label).filter(Boolean))];
  const works = r.workIds.map((id) => view.works.find((w) => w.id === id)?.title).filter(Boolean);
  const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };
  return (
    <button className="ledger-round" aria-pressed={selected} onClick={onSelect}>
      <span className="row" style={{ gap: 6, justifyContent: "space-between" }}>
        <b>{periods.length ? periods.slice(0, 2).join("・") : roundTitle(r)}{periods.length > 2 ? " ほか" : ""}</b>
        <span className={`tag ${waiting ? "warn" : st.tag}`}>{waiting ? `報告待ち ${waiting}` : st.label}</span>
      </span>
      <span className="faint">
        {r.kind === "event" ? `製造 ${r.closeOn ?? ""}` : `締め ${md(r.closeOn)}`} · 支払 {r.payOn ? md(r.payOn) : "—"}
        {works.length > 1 ? ` · ${works.length} 作品` : works.length === 1 && view.works.length > 1 ? ` · ${works[0]}` : ""}
        {r.requests.map((q) => <span key={q.id} className="tag pin" style={{ marginLeft: 4 }}>{q.requestNo ?? `#${q.id}`}</span>)}
      </span>
      {r.open && <span className="bar"><i style={{ width: `${n ? (done / n) * 100 : 0}%` }} /></span>}
    </button>
  );
}

/** 選んだ回：1 報告を入れる → 2 計算書を作る → 3 送付・支払。上から下へ進むだけ。 */
function RoundDetail(
  { round: r, view, canWrite, onChanged, onError, onOpenDocument, openRequests, onLink, onOpenRequest, onCompose }: {
    round: Round; view: LedgerView; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
    onOpenDocument?: (documentId: number) => void;
    openRequests: OpenRequest[];
    onLink: (requestId: number, round: Round, unlink?: boolean) => void;
    onOpenRequest?: (requestId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null) => void;
  }
) {
  const [pickRequest, setPickRequest] = useState("");
  const [preview, setPreview] = useState<{ lines: StatementLine[]; totals: StatementTotals } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Array<{ templateKey: string; label: string }>>([]);
  const [templateKey, setTemplateKey] = useState("");

  // 計算書に入れるのは、まだ文書に結ばれていない実績。
  const entries = useMemo(() => r.parts
    .map((p) => ({ conditionId: p.conditionId, eventIds: p.events.filter((e) => !e.documentId).map((e) => e.id),
                   period: p.label ?? null }))
    .filter((e) => e.eventIds.length), [r]);
  const waitingLines = r.open && r.state !== "issued" ? waitingLinesOf(r) : 0;

  useEffect(() => {
    if (!entries.length) { setPreview(null); setPreviewError(null); return; }
    let live = true;
    api.post<{ lines: StatementLine[]; totals: StatementTotals }>("/statement-documents/preview", { entries })
      .then((x) => { if (live) { setPreview(x); setPreviewError(null); } })
      .catch((e: ApiError) => { if (live) { setPreview(null); setPreviewError(e.message); } });
    return () => { live = false; };
  }, [r.key, entries.map((e) => `${e.conditionId}:${e.eventIds.join("-")}`).join(",")]);
  useEffect(() => {
    api.get<{ templates: Array<{ templateKey: string; label: string }> }>("/document-templates")
      .then((x) => {
        const list = x.templates.filter((t) => /statement|計算書/.test(`${t.templateKey}${t.label}`));
        setTemplates(list.length ? list : x.templates);
        setTemplateKey((list.find((t) => t.templateKey === "royalty_statement") ?? list[0] ?? x.templates[0])?.templateKey ?? "");
      })
      .catch(() => undefined);
  }, []);

  /** 文書の画面へ。この回のまだ文書に結ばれていない実績と、その条件を選んだ状態で開く。 */
  function compose() {
    if (!onCompose) return;
    onCompose(entries.map((e) => e.conditionId), entries.flatMap((e) => e.eventIds), templateKey || null);
  }

  const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };
  const periods = [...new Set(r.parts.map((p) => p.label).filter(Boolean))];
  const step1Done = !waitingLines && r.parts.every((p) => p.state === "issued" || p.state === "skipped" || p.state === "reported");
  const step2Done = r.documents.length > 0 && !entries.length;
  const canCompose = canWrite && Boolean(templateKey) && Boolean(preview) && Boolean(onCompose) && entries.length > 0;
  const pending = new Set(view.requests.map((x) => x.id));
  const candidates = openRequests
    .filter((x) => !r.requests.some((y) => y.id === x.id))
    .sort((a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)));

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{periods.length ? periods.join("・") : roundTitle(r)}の回</h2>
        <span className="faint">{r.kind === "event" ? `製造 ${r.closeOn ?? ""}` : `締め ${r.closeOn ?? "—"}`} · 支払 {r.payOn ?? "—"}</span>
        <span className={`tag ${st.tag}`} style={{ marginLeft: "auto" }}>{st.label}</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 14 }}>
        {/* 1 報告を入れる */}
        <div className="ledger-step">
          <span className={`step-no ${step1Done ? "done" : ""}`}>1</span>
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>報告を入れる</b>
              <span className="faint">相手から来た数字を行に打つ。発生日は締め日で入る。</span>
            </div>
            <RoundReport round={r} view={view} canWrite={canWrite} onChanged={onChanged} onError={onError} onOpenDocument={onOpenDocument} />
          </div>
        </div>

        {/* 2 計算書を作る */}
        <div className="ledger-step">
          <span className={`step-no ${step2Done ? "done" : entries.length ? "" : "todo"}`}>2</span>
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>計算書を作る</b>
              <span className="faint">{entries.length ? "入力済の報告で試算しています" : r.documents.length ? "この回の報告はすべて計算書に入っています" : "報告を入れると試算が出ます"}</span>
            </div>
            {entries.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  {canWrite && (
                    <button className="btn primary" disabled={!canCompose} onClick={compose}
                            title={waitingLines ? `報告待ちが ${waitingLines} 行あります（待たずに出すと入力済の分だけの計算書になります）` : ""}>
                      計算書を作る（文書の画面へ）
                    </button>
                  )}
                  {canWrite && templates.length > 1 && (
                    <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} aria-label="ひな形">
                      {templates.map((t) => <option key={t.templateKey} value={t.templateKey}>{t.label}</option>)}
                    </select>
                  )}
                  <span className="faint">文書の画面で本文を確かめ、見出しを直して決定します。決定するまで番号は振られません。</span>
                </div>
                {waitingLines > 0 && (
                  <div className="note warn">
                    報告待ちが {waitingLines} 行あります。待たずに出すと入力済の分だけの計算書になります（残りは「報告なし」にするか、あとで別の計算書に）。
                  </div>
                )}
                {preview && <StatementBreakdown lines={preview.lines} totals={preview.totals} />}
                {previewError && <div className="alert">試算できません：{previewError}</div>}
              </div>
            )}
          </div>
        </div>

        {/* 3 送付・支払 */}
        <div className="ledger-step">
          <span className={`step-no ${r.state === "paid" || r.state === "nopay" ? "done" : r.documents.length ? "" : "todo"}`}>3</span>
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>送付・支払</b>
              <span className="faint">決定した文書のページで進める</span>
            </div>
            {r.documents.map((d) => (
              <div key={d.id} className="row" style={{ gap: 6 }}>
                {onOpenDocument
                  ? <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                  : <span className="code">{d.documentNo ?? `#${d.id}`}</span>}
                <span className="tag ok">決定</span>{d.sent && <span className="tag ok">送付済</span>}
                <span className="faint">差引 {yen(d.net)}</span>
              </div>
            ))}
            {r.payments.map((x) => (
              <div key={x.id} className="faint">
                支払 <span className="code">{x.paymentNo ?? `#${x.id}`}</span> {yen(x.amount)} ·
                {x.status === "paid" ? ` 支払済 ${x.paidOn ?? ""}` : ` 支払予定 ${x.dueOn ?? "—"}`}
              </div>
            ))}
            {!r.documents.length && <span className="faint">この回の計算書はまだありません。</span>}
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <span className="faint">受付箱の依頼：</span>
              {r.requests.map((x) => (
                <span key={x.id} className="row" style={{ gap: 4 }}>
                  {onOpenRequest
                    ? <button className="tag pin" onClick={() => onOpenRequest(x.id)} title="受付箱で開く">{x.requestNo ?? `#${x.id}`}</button>
                    : <span className="tag pin">{x.requestNo ?? `#${x.id}`}</span>}
                  <span className="faint">{x.title}{x.done ? "（対応完了）" : ""}</span>
                  {canWrite && <button className="linky" onClick={() => onLink(x.id, r, true)}>外す</button>}
                </span>
              ))}
              {!r.requests.length && <span className="faint">なし</span>}
              {canWrite && candidates.length > 0 && (
                <>
                  <select value={pickRequest} onChange={(e) => setPickRequest(e.target.value)} aria-label="紐づける依頼">
                    <option value="">依頼を選ぶ…</option>
                    {candidates.map((x) => (
                      <option key={x.id} value={x.id}>{pending.has(x.id) ? "★ " : ""}{x.requestNo ?? `#${x.id}`} {x.title}{x.requesterName ? `（${x.requesterName}）` : ""}</option>
                    ))}
                  </select>
                  <button className="btn btn-sm" disabled={!pickRequest} onClick={() => { onLink(Number(pickRequest), r); setPickRequest(""); }}>この回に付ける</button>
                </>
              )}
            </div>
            <span className="faint">付けた依頼は、この回の計算書で工程（作成→送付→支払予定→支払）が進み、依頼者に Slack で知らせます。★ はこの作家・作品の依頼。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** これまでの回。年ごとに畳む。押すと右にその回が出る。 */
function History({ view, onSelect, selected }: {
  view: LedgerView;
  onSelect: (key: string) => void; selected: string | null;
}) {
  const years = [...new Set(view.history.map((r) => (r.payOn ?? r.closeOn ?? "").slice(0, 4)).filter(Boolean))];
  const [year, setYear] = useState<string>(years[0] ?? "");
  useEffect(() => { if (!years.includes(year)) setYear(years[0] ?? ""); }, [years.join(",")]);
  if (!view.history.length) return null;
  const rows = view.history.filter((r) => (r.payOn ?? r.closeOn ?? "").startsWith(year));
  return (
    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="faint" style={{ letterSpacing: ".1em" }}>終わった回</span>
        <span className="chips">
          {years.map((y) => (
            <button key={y} className="chip" aria-pressed={y === year} onClick={() => setYear(y)}>{y}年</button>
          ))}
        </span>
      </div>
      {rows.map((r) => <RoundCard key={r.key} round={r} view={view} selected={r.key === selected} onSelect={() => onSelect(r.key)} />)}
    </div>
  );
}
