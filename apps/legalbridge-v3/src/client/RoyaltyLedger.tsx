import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { ReportAdd, RoundReport, type ReportTarget } from "./RoundReport.js";
import { BulkReport } from "./BulkReport.js";
import { RoyaltyCloses } from "./RoyaltyCloses.js";
import { StatementBreakdown, type StatementLine, type StatementTotals } from "./StatementLines.js";
import { roundTargets, roundTitle } from "./RoundPicker.js";
import type {
  LedgerCondition, LedgerEvent, LedgerView, Round, WorkRoyaltyParty
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

/** 右の欄で「新しい製造の回」を開いているときの選択キー。 */
const NEW_EVENT = "new-event";

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
    onCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null, back: DocBack,
                 revise?: { supersedesIds: number[]; reason: string } | null) => void;
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
  /**
   * ① 取引モデル（利用形態）。選ぶと、その取引モデルの回だけを並べ、新しい回も
   * その取引モデルで立てる（イベント式なら製造の回、時限式なら締めの回）。null はすべて。
   */
  const [model, setModel] = useState<string | null>(null);
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
        // 新しい製造の回を記録した直後は、その製造日の回を開く。
        const madeOn = pendingDate.current; pendingDate.current = null;
        const made = madeOn ? v.rounds.find((r) => r.kind === "event" && r.closeOn === madeOn) : null;
        setSelected((cur) => made ? made.key
          : cur === NEW_EVENT || (cur && [...v.rounds, ...v.history].some((r) => r.key === cur)) ? cur
          : v.rounds.find((r) => r.state !== "before")?.key ?? v.rounds[0]?.key ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [partyId, allWorks, workId, version]);
  /** 記録した製造日。読み直したらその回を選ぶ。 */
  const pendingDate = useRef<string | null>(null);

  const reload = (message?: string) => { if (message) setNotice(message); setError(null); setVersion((n) => n + 1); };
  const openRequests = useOpenRequests(version);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  /** 「締めを作る」の案内から開いたとき、その条件の締めのフォームを最初から開く。 */
  const [scheduleFor, setScheduleFor] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ mode: "report" | "plan"; conditionId?: number } | null>(null);

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
  /** 取引モデルの札。条件の利用形態ごとに1枚。イベント式の条件が1本でもあればイベント式。 */
  const models = view ? [...new Map(view.conditions.map((c) => [c.usageType ?? "-", c])).values()].map((c) => {
    const same = view.conditions.filter((x) => (x.usageType ?? "-") === (c.usageType ?? "-"));
    return { usageType: c.usageType ?? "-", label: c.usageLabel || "利用形態なし",
             rates: [...new Set(same.map((x) => x.pricingModel === "unit_rate" ? yen(x.unitAmount, x.currency) : pct(x.ratePpm)))].join("・"),
             timing: same.some((x) => x.timing === "event") ? "event" as const : "periodic" as const };
  }) : [];
  const chosenModel = models.find((m) => m.usageType === model) ?? null;
  /** 選んだ取引モデルの回か。混ぜる設定の作家は、その取引モデルの行を含む回。 */
  const usageOf = (conditionId: number) => view?.conditions.find((c) => c.id === conditionId)?.usageType ?? "-";
  const inModel = (r: Round) => !model ? true
    : view?.party.mixModels ? r.parts.some((p) => usageOf(p.conditionId) === model) : (r.usageType ?? "-") === model;
  const shownView = view && model
    ? { ...view, rounds: view.rounds.filter(inModel), history: view.history.filter(inModel) } : view;
  /** 新しい製造の回で使える条件（選んだ取引モデルのイベント式の条件）。 */
  const eventConditions = view ? view.conditions.filter((c) => c.timing === "event" && (!model || (c.usageType ?? "-") === model)) : [];
  /** 文書の画面から戻る先。この作家 × この作品。 */
  const back: DocBack | null = view ? { label: `${view.party.name} × ${view.scope?.workTitle ?? "全作品"}`, workId, partyId: view.party.id } : null;
  const openDoc = onOpenDocument ? (id: number) => onOpenDocument(id, back) : undefined;
  const composeWith = onCompose && back
    ? (ids: number[], events: number[], key: string | null, revise?: { supersedesIds: number[]; reason: string } | null) =>
        onCompose(ids, events, key, back, revise)
    : undefined;

  async function setMixModels(mix: boolean) {
    if (!view) return;
    try {
      await api.put("/royalty-ledger/mix-models", { partyId: view.party.id, mix });
      reload(mix ? "計算書に取引モデルを混ぜるようにしました" : "計算書を取引モデルごとに分けるようにしました");
    } catch (e) { setError((e as ApiError).message); }
  }

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
                  onClick={() => { setPartyId(p.id); setModel(null); setSelected(p.next?.roundKey ?? null); }}>
            <b>{p.name}</b>
            <span className="faint">{p.conditions.map((c) => `${c.usageLabel} ${pct(c.ratePpm)}${c.targetPartyName ? `（${c.targetPartyName} 専用）` : ""}`).join("・")}</span>
            {p.next
              ? <span className="ledger-next">▶ 次：{p.next.label}の回に報告待ちが {p.next.waiting} 行</span>
              : p.noClose.length
                ? <span className="ledger-next" style={{ color: "var(--warn)" }}>▶ 次：{p.noClose.map((c) => c.usageLabel).join("・")} の締めを作る（回が立ちません）</span>
                : <span className="faint">▶ 次：{p.nextPayOn ? `締め前（次の支払 ${md(p.nextPayOn)}）。いま入れるものはありません`
                    : p.conditions.some((c) => c.timing === "event") ? "製造の報告を足すと、その報告の回が立ちます"
                    : "締めがありません（条件と締めの設定…）"}</span>}
            <span className="row" style={{ gap: 4 }}>
              <span className="tag">開いている回 {p.openRounds}</span>
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
              {view.conditions.length > 3 && <span className="ledger-term-chip"><span className="faint">{view.works.length} 作品 · {view.conditions.length} 条件</span></span>}
              {view.conditions.length <= 3 && view.conditions.map((c) => (
                <span key={c.id} className="ledger-term-chip">
                  <span className="faint">{c.usageLabel}</span> <b>{c.pricingModel === "unit_rate" ? yen(c.unitAmount, c.currency) : pct(c.ratePpm)}</b>
                  {c.targetPartyName && <span className="tag pin" style={{ marginLeft: 4 }}>{c.targetPartyName} 専用</span>}
                  {c.shares && c.shares.length > 0 && (
                    <span className="tag accent" style={{ marginLeft: 4 }} title="共著の取り分。計算書は受取人ごとに 1 枚">
                      取り分 {c.shares.map((x) => `${x.name} ${x.sharePpm / 10000}%`).join("・")}
                    </span>
                  )}
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
                  {/* 1枚に取引モデルを混ぜると、計算書の日付見出し・取引モデル概要が1つに決まらない。 */}
                  <span className="chips" role="group" aria-label="取引モデル">
                    <button className="chip" disabled={!canWrite} aria-pressed={!view.party.mixModels} onClick={() => void setMixModels(false)}>取引モデルごと</button>
                    <button className="chip" disabled={!canWrite} aria-pressed={view.party.mixModels} onClick={() => void setMixModels(true)}>取引モデルを混ぜる</button>
                  </span>
                </span>
              </div>
              <div className="panel-bd">
                <Terms conditions={view.conditions} view={view} allWorks={allWorks} canWrite={canWrite} onChanged={reload} onError={setError}
                       initialScheduling={scheduleFor} />
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

          {/* ① 取引モデル。選ぶとその取引モデルの回だけになり、新しい回もその取引モデルで立てる。 */}
          {models.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <b>① 取引モデル</b>
              <span className="chips" role="group" aria-label="取引モデル">
                <button className="chip" aria-pressed={!model} onClick={() => { setModel(null); setSelected(null); }}>すべて</button>
                {models.map((m) => (
                  <button key={m.usageType} className="chip" aria-pressed={model === m.usageType}
                          onClick={() => { setModel(m.usageType); setSelected(null); }}>
                    {m.label} {m.rates}・{m.timing === "event" ? "イベント式（製造の回）" : "時限式（締めの回）"}
                  </button>
                ))}
              </span>
              <span className="faint">
                {view.party.mixModels
                  ? "この作家は計算書に取引モデルを混ぜる設定です（条件と締めの設定…）"
                  : "計算書は取引モデルごとに1枚。日付の見出し・取引モデル概要がその取引モデルで決まります"}
              </span>
            </div>
          )}

          {/* 手順の帯：いまどこにいて、次に何をするか。 */}
          {(() => {
            const waiting = round ? waitingLinesOf(round) : 0;
            const noClose = view.conditions.filter((c) => c.timing === "periodic" && !c.schedules);
            const periods = round ? [...new Set(round.parts.map((p) => p.label).filter(Boolean))] : [];
            const entriesLeft = round ? round.parts.some((p) => p.events.some((e) => !e.documentId)) : false;
            const stage = !round ? 1 : waiting > 0 ? 3 : entriesLeft ? 4 : round.documents.length ? 5 : 3;
            const cls = (n: number) => `g${stage === n ? " on" : stage > n ? " done" : ""}`;
            return (
              <div className="ledger-guide">
                <div className={cls(1)}><span className="k">1 作家</span><b>{view.party.name}</b>
                  <span className="faint">{view.works.length} 作品 · {view.conditions.length} 条件</span></div>
                <div className={cls(2)}><span className="k">2 回</span><b>{round ? (periods.join("・") || roundTitle(round)) : "左で回を選ぶ"}</b>
                  <span className="faint">{round ? `締め ${md(round.closeOn)} · 支払 ${round.payOn ? md(round.payOn) : "—"}` : "報告待ちのある回から"}</span>
                  {noClose.length > 0 && (
                    <span className="stack" style={{ gap: 2, marginTop: 2 }}>
                      <span style={{ color: "var(--warn)", fontSize: 12 }}>
                        {noClose.map((c) => c.usageLabel).join("・")} は時限式なのに締めがなく、回が立ちません。
                      </span>
                      {canWrite && (
                        <button className="btn btn-sm primary" style={{ alignSelf: "flex-start" }}
                                onClick={() => { setScheduleFor(noClose[0].id); setSettings(true); }}>締めを作る</button>
                      )}
                    </span>
                  )}
                </div>
                <div className={cls(3)}><span className="k">3 報告を入れる</span>
                  <b>{!round ? "—" : waiting > 0 ? `報告待ち ${waiting} 行` : "入力済"}</b>
                  <span className="faint">来た数字を行に打つ。来ないものは「報告なし」</span>
                  {round && waiting > 0 && (
                    <button className="btn btn-sm primary" style={{ alignSelf: "flex-start", marginTop: 2 }}
                            onClick={() => document.querySelector("table.report tr.wait, table.report tr.plan")?.scrollIntoView({ block: "center", behavior: "smooth" })}>
                      最初の報告待ちへ ↓
                    </button>
                  )}
                  {round && waiting === 0 && canWrite && !entriesLeft && !round.documents.length && (
                    <button className="btn btn-sm" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={() => setAdding({ mode: "report" })}>＋ 報告を追加</button>
                  )}
                </div>
                <div className={cls(4)}><span className="k">4 計算書</span>
                  <b>{!round ? "—" : round.documents.length && !entriesLeft ? "決定済" : entriesLeft && waiting === 0 ? "作れる" : "まだ"}</b>
                  <span className="faint">全行が入力済か報告なしになると作れる</span></div>
              </div>
            );
          })()}

          {/* 左に回の一覧、右にその回の中身。 */}
          <div className="ledger-split">
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>回</h2>
                <span className="faint">支払日でまとめる</span>
              </div>
              {/* ② 回を立てる。イベント式は製造の回をここで立てる。時限式は締め（予定明細）から立つ。 */}
              {eventConditions.length > 0 && canWrite && (
                <button className={`ledger-round${selected === NEW_EVENT ? " on" : ""}`} aria-pressed={selected === NEW_EVENT}
                        style={{ display: "block", textAlign: "left", borderStyle: "dashed" }} onClick={() => setSelected(NEW_EVENT)}>
                  <b>＋ 新しい製造の回{chosenModel ? `（${chosenModel.label}）` : ""}</b>
                  <span className="faint" style={{ display: "block" }}>製造日ごとに 1 回。依頼文を貼ってまとめて入れる</span>
                </button>
              )}
              {chosenModel?.timing === "periodic" && (
                <div className="note" style={{ fontSize: 12 }}>
                  {chosenModel.label} は時限式です。締めの回は、条件の締め（予定明細）から自動で立ちます。
                  締めが無ければ「条件と締めの設定…」で作ってください。
                </div>
              )}
              {shownView!.rounds.map((r) => <RoundCard key={r.key} round={r} view={view} selected={r.key === selected}
                                                 onSelect={() => setSelected(r.key)} />)}
              {!shownView!.rounds.length && (
                <span className="faint">
                  {(chosenModel ? chosenModel.timing === "event" : view.conditions.every((c) => c.timing === "event"))
                    ? "開いている回はありません。製造の報告を足すと、その報告の回が立ちます。"
                    : "開いている回はありません。締めを作ると回が出ます。"}
                </span>
              )}
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
              <History view={shownView!} onSelect={(key) => setSelected(key)} selected={selected} />
            </div>
            {selected === NEW_EVENT && eventConditions.length > 0
              ? <NewEventRound conditions={eventConditions} onError={setError} onCancel={() => setSelected(view.rounds[0]?.key ?? null)}
                               onAdded={(m, on) => { pendingDate.current = on; reload(m); }} />
              : round
              ? <RoundDetail key={`${round.key}-${version}`} round={round} view={view} canWrite={canWrite}
                             onChanged={reload} onError={setError} onOpenDocument={openDoc}
                             openRequests={openRequests} onLink={linkRequest} onOpenRequest={onOpenRequest}
                             onCompose={composeWith} adding={adding} setAdding={setAdding} isAdmin={role === "admin"} />
              : <div className="panel"><div className="panel-bd faint">左で回を選ぶと、ここに報告の表と計算書が出ます。</div></div>}
          </div>
        </>
      )}
    </div>
  );
}

/** この組の条件。料率と出し方（時限式／イベント式）。予定明細が無ければその場で作る。 */
function Terms(
  { conditions, view, allWorks, canWrite, onChanged, onError, initialScheduling = null }: {
    conditions: LedgerCondition[]; view: LedgerView; allWorks: boolean; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
    initialScheduling?: number | null;
  }
) {
  const [scheduling, setScheduling] = useState<number | null>(initialScheduling);
  /** 回の整理を開いている条件。 */
  const [fixing, setFixing] = useState<number | null>(null);
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
            {(c.usageType === "sublicense" || c.usageType === "oem") && (
              c.targetPartyName
                ? <span className="tag pin">許諾先専用：{c.targetPartyName}</span>
                : <span className="faint">一律（この作品の許諾先すべて）</span>
            )}
            {(c.agAmount || c.mgAmount) ? <span className="faint">{c.agAmount ? `AG ${yen(c.agAmount, c.currency)}` : ""} {c.mgAmount ? `MG ${yen(c.mgAmount, c.currency)}` : ""}</span> : null}
            {c.shares && c.shares.length > 0 && (
              <span className="tag accent" title="共著の取り分。全体率をこの比で受取人に割り、計算書は受取人ごとに 1 枚">
                取り分：{c.shares.map((x) => `${x.name} ${x.sharePpm / 10000}%`).join("・")}
              </span>
            )}
            <label className="row" style={{ gap: 4 }}>
              <span className="faint">出し方</span>
              <select value={c.timingExplicit ? c.timing : ""} disabled={!canWrite}
                      onChange={(e) => void setTiming(c, e.target.value)}>
                <option value="">{c.timing === "event" ? "イベント式（既定）" : "時限式（既定）"}</option>
                <option value="periodic">時限式（締めで回る）</option>
                <option value="event">イベント式（製造・刷のたび）</option>
              </select>
            </label>
            {c.timing === "periodic" ? (
              <span className="row" style={{ gap: 4 }}>
                {c.schedules ? <span className="faint">締め {c.schedules} 回</span> : <span className="tag warn">締めなし</span>}
                {canWrite && (
                  <button className="btn btn-sm" onClick={() => setScheduling(scheduling === c.id ? null : c.id)}>
                    {c.schedules ? "締めを足す" : "締めを作る"}
                  </button>
                )}
              </span>
            ) : (
              <span className="faint">締めなし（報告 1 件＝回 1 つ）</span>
            )}
            {canWrite && (
              <button className="btn btn-sm" aria-pressed={fixing === c.id} onClick={() => setFixing(fixing === c.id ? null : c.id)}>回の整理…</button>
            )}
          </div>
        ))}
      </div>
      {fixing && conditions.some((c) => c.id === fixing) && (
        <RoundFix key={fixing} condition={conditions.find((c) => c.id === fixing)!} view={view}
                  onChanged={onChanged} onError={onError} onClose={() => setFixing(null)} />
      )}
      {scheduling && conditions.some((c) => c.id === scheduling) && (
        <RoyaltyCloses key={scheduling} condition={conditions.find((c) => c.id === scheduling)!}
                       onCancel={() => setScheduling(null)}
                       onSaved={(m) => { setScheduling(null); onChanged(m); }} />
      )}
    </div>
  );
}

/**
 * 新しい製造の回（イベント式）。右の欄で開く。依頼文からまとめて入れるのが基本、
 * 1 件ずつも入れられる。記録するとその製造日の回が立ち、そちらに切り替わる。
 */
function NewEventRound({ conditions, onAdded, onCancel, onError }: {
  /** 回を立てる条件（① で選んだ取引モデルのイベント式の条件）。 */
  conditions: LedgerCondition[];
  onAdded: (message: string, on: string) => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const canBulk = conditions.some((c) => c.usageType === "sublicense" || c.usageType === "oem");
  const [mode, setMode] = useState<"bulk" | "one">(canBulk ? "bulk" : "one");
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>新しい製造の回</h2>
        <span className="faint">{conditions.map((c) => c.usageLabel).join("・")}</span>
        <span className="chips" role="group" aria-label="入れ方" style={{ marginLeft: "auto" }}>
          {canBulk && <button className="chip" aria-pressed={mode === "bulk"} onClick={() => setMode("bulk")}>依頼文からまとめて</button>}
          <button className="chip" aria-pressed={mode === "one"} onClick={() => setMode("one")}>1 件ずつ</button>
        </span>
      </div>
      <div className="panel-bd stack">
        <span className="faint">
          製造 1 回が 1 回。締めは要らない。同じ製造日の報告（許諾先・言語・前金後金）は 1 つの回にまとまり、計算書 1 枚（多明細）で出す。
          支払日は条件の支払条件から決まる。すでにある製造日の回に足すときは、左でその回を選んで「報告を追加」。
        </span>
        {mode === "bulk"
          ? <BulkReport eventStyle defaultDate={new Date().toISOString().slice(0, 10)}
                        targets={conditions.map((c) => ({ condition: c, scheduleId: null }))}
                        onCancel={onCancel} onDone={onAdded} onError={onError} />
          : <ReportAdd mode="report" initialConditionId={null}
                       targets={conditions.map((c): ReportTarget => ({
                         key: `e:${c.id}`, condition: c, scheduleId: null, closeOn: null, periodFrom: null, label: null }))}
                       onCancel={onCancel} onAdded={(m, on) => onAdded(m, on ?? "")} onError={onError} />}
      </div>
    </div>
  );
}

/**
 * 回の整理（過去分）。この条件の報告がどの回に入っているかを一覧し、紐づけを変えるだけで直す。
 *   時限式 … 締めを選ぶ（null＝発生日で振り分け）。
 *   イベント式 … 報告 1 件＝回 1 つ。締めは持たないので、締めを指している古い報告は「外す」で単独の回にする。
 * 決定した計算書に載った報告は動かせない。出し方（時限式／イベント式）は上の欄で切り替える。
 */
function RoundFix({ condition: c, view, onChanged, onError, onClose }: {
  condition: LedgerCondition; view: LedgerView;
  onChanged: (message?: string) => void; onError: (m: string) => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const schedules = view.schedules.filter((s) => s.conditionId === c.id)
    .sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)));
  const events: Array<{ e: LedgerEvent; roundTitle: string; roundKind: "period" | "event"; roundLabel: string | null }> = [];
  for (const r of [...view.rounds, ...view.history]) {
    for (const p of r.parts) {
      if (p.conditionId !== c.id) continue;
      for (const e of p.events) events.push({ e, roundTitle: roundTitle(r), roundKind: r.kind, roundLabel: p.label });
    }
  }
  events.sort((a, b) => String(a.e.occurredOn).localeCompare(String(b.e.occurredOn)) || a.e.id - b.e.id);
  async function move(e: LedgerEvent, scheduleId: number | null) {
    setBusy(e.id);
    try {
      await api.put(`/royalty-ledger/events/${e.id}/round`, { conditionId: c.id, scheduleId });
      onChanged(scheduleId === null ? "締めから外しました" : "締めに付け替えました");
    } catch (x) { onError((x as ApiError).message); }
    finally { setBusy(null); }
  }
  const scheduleLabel = (id: number | null) => {
    if (id === null) return null;
    const s = schedules.find((x) => x.id === id);
    return s ? `${s.label ?? ""}（締め ${s.dueOn ?? "—"}）` : `締め #${id}`;
  };
  return (
    <div className="note stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <b>回の整理：{c.workTitle ?? ""} · {c.usageLabel}</b>
        <span className="faint">{c.timing === "event" ? "イベント式（報告 1 件＝回 1 つ）" : `時限式（締め ${schedules.length} 回）`}</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>
      <span className="faint">
        {c.timing === "event"
          ? "報告は締めを持ちません。古い報告が締めを指していれば「外す」で単独の回になります。締めで回したいなら、上の出し方を時限式にしてから締めに付けてください。"
          : "各報告をどの締めに付けるかを変えられます。「発生日で振り分け」にすると、前の締めの翌日〜その締めの日に入る回へ入ります。決定した計算書に載った報告は動かせません。"}
      </span>
      {!events.length && <span className="faint">この条件の報告はまだありません。</span>}
      {events.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>発生日</th><th>行</th><th className="num">数量</th><th className="num">額</th><th>いまの回</th><th>付け先</th></tr></thead>
            <tbody>
              {events.map(({ e, roundTitle: rt, roundKind, roundLabel }) => {
                const locked = Boolean(e.documentId);
                return (
                  <tr key={e.id}>
                    <td>{e.occurredOn ?? "—"}</td>
                    <td>{e.outName ?? e.workTitle ?? "—"}{(e.languages ?? []).length ? `（${[...(e.languages ?? []), ...(e.regions ?? [])].join("・")}）` : ""}</td>
                    <td className="num">{e.quantity ?? ""}</td>
                    <td className="num">{yen(e.grossAmount ?? e.amount, c.currency)}</td>
                    <td>
                      {roundKind === "event" ? `単独（${rt}）` : roundLabel ?? rt}
                      {e.scheduleId ? <span className="faint">　締め指定</span> : <span className="faint">　発生日で振り分け</span>}
                      {locked && <span className="tag" style={{ marginLeft: 4 }}>計算書 {e.documentNo ?? ""}</span>}
                    </td>
                    <td>
                      {locked ? <span className="faint">決定済（動かせない）</span>
                        : c.timing === "event" ? (
                          e.scheduleId
                            ? <button className="btn btn-sm" disabled={busy === e.id} onClick={() => void move(e, null)}>締めから外す</button>
                            : <span className="faint">—</span>
                        ) : (
                          <select value={e.scheduleId ?? ""} disabled={busy === e.id}
                                  onChange={(ev) => void move(e, ev.target.value ? Number(ev.target.value) : null)}>
                            <option value="">発生日で振り分け</option>
                            {schedules.map((s) => <option key={s.id} value={s.id}>{scheduleLabel(s.id)}</option>)}
                          </select>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
  { round: r, view, canWrite, onChanged, onError, onOpenDocument, openRequests, onLink, onOpenRequest, onCompose, adding, setAdding, isAdmin }: {
    round: Round; view: LedgerView; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
    onOpenDocument?: (documentId: number) => void;
    openRequests: OpenRequest[];
    onLink: (requestId: number, round: Round, unlink?: boolean) => void;
    onOpenRequest?: (requestId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null,
                 revise?: { supersedesIds: number[]; reason: string } | null) => void;
    adding: { mode: "report" | "plan"; conditionId?: number } | null;
    isAdmin: boolean;
    setAdding: (a: { mode: "report" | "plan"; conditionId?: number } | null) => void;
  }
) {
  const [pickRequest, setPickRequest] = useState("");
  const [preview, setPreview] = useState<{ lines: StatementLine[]; totals: StatementTotals } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Array<{ templateKey: string; label: string }>>([]);
  const [templateKey, setTemplateKey] = useState("");

  /** 「合わせて出す」にした決定済みの計算書。その報告も試算・計算書に入り、決定の瞬間に退く。 */
  const [merging, setMerging] = useState<Set<number>>(new Set());
  const toggleMerge = (documentId: number) => setMerging((s) => { const n = new Set(s); if (n.has(documentId)) n.delete(documentId); else n.add(documentId); return n; });
  // 計算書に入れるのは、まだ文書に結ばれていない実績と、「合わせて出す」にした計算書の実績。
  const entries = useMemo(() => r.parts
    .map((p) => ({ conditionId: p.conditionId,
                   eventIds: p.events.filter((e) => !e.documentId || merging.has(e.documentId)).map((e) => e.id),
                   period: p.label ?? null }))
    .filter((e) => e.eventIds.length), [r, merging]);
  const waitingLines = r.open && r.state !== "issued" ? waitingLinesOf(r) : 0;

  useEffect(() => {
    if (!entries.length) { setPreview(null); setPreviewError(null); return; }
    let live = true;
    api.post<{ lines: StatementLine[]; totals: StatementTotals }>("/statement-documents/preview",
      { entries, supersedesId: [...merging][0] ?? null, supersedesExtraIds: [...merging].slice(1) })
      .then((x) => { if (live) { setPreview(x); setPreviewError(null); } })
      .catch((e: ApiError) => { if (live) { setPreview(null); setPreviewError(e.message); } });
    return () => { live = false; };
  }, [r.key, entries.map((e) => `${e.conditionId}:${e.eventIds.join("-")}`).join(","), [...merging].join("-")]);
  useEffect(() => {
    api.get<{ templates: Array<{ templateKey: string; label: string }> }>("/document-templates")
      .then((x) => {
        const list = x.templates.filter((t) => /statement|計算書/.test(`${t.templateKey}${t.label}`));
        setTemplates(list.length ? list : x.templates);
        setTemplateKey((list.find((t) => t.templateKey === "royalty_statement") ?? list[0] ?? x.templates[0])?.templateKey ?? "");
      })
      .catch(() => undefined);
  }, []);

  /** 決定した計算書から支払を立てる。経理提出用の帳票は支払から作られる。 */
  async function createPayment(d: { id: number; documentNo: string | null }) {
    try {
      const x = await api.post<{ paymentId: number; amount: number; dueOn: string | null }>(`/documents/${d.id}/payment`, {});
      onChanged(`${d.documentNo ?? `#${d.id}`} の支払 #${x.paymentId}（${yen(x.amount)}${x.dueOn ? ` · 支払期日 ${x.dueOn}` : ""}）を立てました。経理提出用は「運用」の出力タブから`);
    } catch (e) { onError((e as ApiError).message); }
  }
  /**
   * 訂正版を出し直す。その計算書に結ばれた実績（直したものを含む）と条件を選んだ状態で
   * 文書の画面を開く。決定すると元の計算書が退き、実績が新しい版に移る。
   */
  function reissue(documentId: number, reason: string) {
    if (!onCompose) return;
    const evs = r.parts.flatMap((p) => p.events.filter((e) => e.documentId === documentId));
    onCompose([...new Set(evs.map((e) => e.conditionId))], evs.map((e) => e.id), templateKey || null,
              { supersedesIds: [documentId], reason });
  }
  const mergeable = r.documents.filter((d) => d.status === "issued" && !d.paymentIds.length);
  /** 文書の画面へ。この回のまだ文書に結ばれていない実績と、その条件を選んだ状態で開く。 */
  function compose() {
    if (!onCompose) return;
    const ids = [...merging];
    const nos = r.documents.filter((d) => merging.has(d.id)).map((d) => d.documentNo ?? `#${d.id}`);
    onCompose(entries.map((e) => e.conditionId), entries.flatMap((e) => e.eventIds), templateKey || null,
              ids.length ? { supersedesIds: ids, reason: `${nos.join("・")} を退かせ、この回の報告と合わせて 1 枚で出し直し` } : null);
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
            <RoundReport round={r} view={view} canWrite={canWrite} onChanged={onChanged} onError={onError} onOpenDocument={onOpenDocument}
                         adding={adding} setAdding={setAdding} isAdmin={isAdmin} onReissue={onCompose ? reissue : undefined}
                         onCreatePayment={canWrite ? (id) => void createPayment(r.documents.find((d) => d.id === id) ?? { id, documentNo: null }) : undefined}
                         merging={merging} onMerge={canWrite && onCompose ? toggleMerge : undefined} />
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
            {(entries.length > 0 || mergeable.length > 0) && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  {canWrite && (
                    <button className="btn primary" disabled={!canCompose} onClick={compose}
                            title={waitingLines ? `報告待ちが ${waitingLines} 行あります（待たずに出すと入力済の分だけの計算書になります）` : ""}>
                      {merging.size ? `計算書を作る（${merging.size} 枚を退かせて 1 枚に・文書の画面へ）` : "計算書を作る（文書の画面へ）"}
                    </button>
                  )}
                  {canWrite && templates.length > 1 && (
                    <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} aria-label="ひな形">
                      {templates.map((t) => <option key={t.templateKey} value={t.templateKey}>{t.label}</option>)}
                    </select>
                  )}
                  <span className="faint">文書の画面で本文を確かめ、見出しを直して決定します。決定するまで番号は振られません。</span>
                </div>
                {canWrite && mergeable.length > 0 && (
                  <div className="note stack" style={{ gap: 4 }}>
                    <span>この回にはもう決定した計算書があります。<b>合わせて出す</b>にした計算書の報告は上の試算に加わり、「計算書を作る」で退かせて 1 枚にまとめます（支払が立っていない計算書だけ）。</span>
                    <span className="chips" role="group" aria-label="合わせて出す計算書">
                      {mergeable.map((d) => (
                        <button key={d.id} className="chip" aria-pressed={merging.has(d.id)} onClick={() => toggleMerge(d.id)}>
                          {merging.has(d.id) ? "✓ " : ""}{d.documentNo ?? `#${d.id}`}{merging.has(d.id) ? "（合わせて出す）" : " を合わせる"}
                        </button>
                      ))}
                    </span>
                  </div>
                )}
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
                {d.status === "issued" && !d.paymentIds.length && d.net > 0 && (
                  <>
                    <span className="tag warn">支払なし</span>
                    {canWrite && <button className="btn btn-sm primary" onClick={() => void createPayment(d)}>支払を立てる</button>}
                  </>
                )}
                {d.status === "issued" && !d.paymentIds.length && d.net <= 0 && <span className="tag">支払なし（差引 0）</span>}
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
