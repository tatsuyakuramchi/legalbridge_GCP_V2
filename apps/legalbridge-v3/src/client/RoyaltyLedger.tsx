import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { ConditionEvents } from "./ConditionEvents.js";
import { ConditionSchedules } from "./ConditionSchedules.js";
import { StatementBreakdown, type StatementLine, type StatementTotals } from "./StatementLines.js";
import type {
  LedgerCondition, LedgerView, Round, RoundPart, WorkRoyaltyParty
} from "../server/royalty/ledger-service.js";

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
  skipped: { label: "今期は無し", tag: "" },
  issued: { label: "計算書済", tag: "ok" }
};

const roundTitle = (r: Round) => r.kind === "event"
  ? `${r.closeOn ?? ""} 製造`
  : r.key.startsWith("x:") ? `${r.closeOn ?? ""} 予定の外` : `${md(r.payOn ?? r.closeOn)} 支払の回`;

export function RoyaltyLedger(
  { workId, initialPartyId, onOpenDocument }: {
    workId: number;
    initialPartyId?: number | null;
    onOpenDocument?: (documentId: number) => void;
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
        setSelected((cur) => cur && v.rounds.some((r) => r.key === cur) ? cur : v.rounds.find((r) => r.state !== "before")?.key ?? v.rounds[0]?.key ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [partyId, allWorks, workId, version]);

  const reload = (message?: string) => { if (message) setNotice(message); setError(null); setVersion((n) => n + 1); };
  const party = parties?.find((p) => p.id === partyId) ?? null;
  const round = view?.rounds.find((r) => r.key === selected) ?? null;

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
          <div className="panel">
            <div className="panel-hd">
              <h2>{view.party.name}{allWorks ? " × 全作品" : ` × ${view.scope?.workTitle ?? ""}`}</h2>
              <span className="faint">{view.party.kind === "individual" ? "個人" : "法人"}・{view.party.residency === "non_resident" ? "非居住者" : "居住者"}</span>
              <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                <span className="chips" role="group" aria-label="見る範囲">
                  <button className="chip" aria-pressed={!allWorks} onClick={() => { setAllWorks(false); setSelected(null); }}>この作品</button>
                  <button className="chip" aria-pressed={allWorks} onClick={() => { setAllWorks(true); setSelected(null); }}>
                    この作家の全作品{party ? `（${party.otherWorks + 1}）` : ""}
                  </button>
                </span>
                <span className="faint">計算書のまとめ方</span>
                <span className="chips" role="group" aria-label="計算書のまとめ方">
                  <button className="chip" disabled={!canWrite} aria-pressed={view.party.bundle === "per_work"}
                          onClick={() => void setBundle("per_work")}>作品ごと</button>
                  <button className="chip" disabled={!canWrite} aria-pressed={view.party.bundle === "per_party"}
                          onClick={() => void setBundle("per_party")}>作家でまとめる</button>
                </span>
              </span>
            </div>
            <div className="panel-bd">
              <Terms conditions={view.conditions} allWorks={allWorks} canWrite={canWrite}
                     onChanged={reload} onError={setError} />
              {!allWorks && view.party.bundle === "per_party" && (
                <div className="faint" style={{ marginTop: 6 }}>
                  この作家は「作家でまとめる」です。同じ支払日の他の作品とは、「この作家の全作品」から1枚で出します。
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd">
              <h2>開いている回</h2>
              <span className="faint">支払まで終わっていない回。締めがずれた契約も、支払日が同じなら1つの回</span>
            </div>
            <div className="panel-bd">
              <div className="ledger-rounds">
                {view.rounds.map((r) => <RoundCard key={r.key} round={r} view={view} selected={r.key === selected}
                                                   onSelect={() => setSelected(r.key)} />)}
                {!view.rounds.length && <span className="faint">開いている回はありません。</span>}
              </div>
            </div>
          </div>

          {round && (
            <RoundDetail key={`${round.key}-${version}`} round={round} view={view} canWrite={canWrite}
                         onChanged={reload} onError={setError} onOpenDocument={onOpenDocument} />
          )}

          <History view={view} onOpenDocument={onOpenDocument} />
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
            {c.timing === "periodic" && !c.schedules && (
              <span className="row" style={{ gap: 4 }}>
                <span className="tag warn">予定明細なし</span>
                {canWrite && <button className="btn btn-sm" onClick={() => setScheduling(scheduling === c.id ? null : c.id)}>締めを作る</button>}
              </span>
            )}
          </div>
        ))}
      </div>
      {scheduling && (
        <div className="note stack">
          <span>締め日（予定明細）を作ると、その回ごとに実績を集めて計算書を出せます。四半期なら間隔を 3 にします。</span>
          <ConditionSchedules conditionId={scheduling} editable={canWrite}
                              onChanged={() => { setScheduling(null); onChanged("予定明細を作りました"); }} />
        </div>
      )}
    </div>
  );
}

function RoundCard({ round: r, view, selected, onSelect }: { round: Round; view: LedgerView; selected: boolean; onSelect: () => void }) {
  const n = r.parts.length;
  const done = r.parts.filter((p) => p.state !== "waiting" && p.state !== "before").length;
  const periods = [...new Set(r.parts.map((p) => p.label).filter(Boolean))];
  const works = r.workIds.map((id) => view.works.find((w) => w.id === id)?.title).filter(Boolean);
  const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };
  return (
    <button className="ledger-round" aria-pressed={selected} onClick={onSelect}>
      <span className="stack" style={{ gap: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className={`tag ${r.kind === "event" ? "warn" : ""}`}>{r.kind === "event" ? "製造" : "期"}</span>
          <b>{roundTitle(r)}</b>
          {works.length === 1 && view.works.length > 1 && <span className="faint">{works[0]}</span>}
        </span>
        <span className="faint">
          {r.kind === "event" ? `支払 ${r.payOn ?? "（支払条件から出せない）"}` : `締め ${periods.slice(0, 3).join("・")}${periods.length > 3 ? " ほか" : ""}`}
        </span>
      </span>
      <span className="stack" style={{ gap: 2 }}>
        <span className="faint">{works.length > 1 ? `${works.length} 作品 · ` : ""}実績 {done}/{n}</span>
        <span className="bar"><i style={{ width: `${n ? (done / n) * 100 : 0}%` }} /></span>
      </span>
      <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
        <span className={`tag ${st.tag}`}>{st.label}</span>
        {r.requests.map((q) => <span key={q.id} className="tag pin">{q.requestNo ?? `#${q.id}`}</span>)}
      </span>
    </button>
  );
}

/** 選んだ回：作品・条件ごとの実績、今期は無し、来るはずの行、計算書。 */
function RoundDetail(
  { round: r, view, canWrite, onChanged, onError, onOpenDocument }: {
    round: Round; view: LedgerView; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
    onOpenDocument?: (documentId: number) => void;
  }
) {
  const [filter, setFilter] = useState<"all" | "waiting" | "reported" | "done">("all");
  const [q, setQ] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ lines: StatementLine[]; totals: StatementTotals } | null>(null);
  /** 試算で弾かれた理由。回の中の話なので、画面の上ではなく計算書の欄に出す。 */
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Array<{ templateKey: string; label: string }>>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ id: number; documentNo: string | null } | null>(null);
  const cond = (id: number) => view.conditions.find((c) => c.id === id)!;
  const partKey = (p: RoundPart) => `${p.conditionId}:${p.scheduleId ?? ""}:${p.eventId ?? ""}`;

  // 計算書に入れるのは、まだ文書に結ばれていない実績。
  const entries = useMemo(() => r.parts
    .map((p) => ({ conditionId: p.conditionId, eventIds: p.events.filter((e) => !e.documentId).map((e) => e.id),
                   period: p.label ?? null }))
    .filter((e) => e.eventIds.length), [r]);
  const waiting = r.parts.filter((p) => p.state === "waiting" || p.state === "before");

  useEffect(() => {
    if (!entries.length) { setPreview(null); setPreviewError(null); return; }
    let live = true;
    api.post<{ lines: StatementLine[]; totals: StatementTotals }>("/statement-documents/preview", { entries })
      .then((x) => { if (live) { setPreview(x); setPreviewError(null); } })
      .catch((e: ApiError) => { if (live) { setPreview(null); setPreviewError(e.message); } });
    return () => { live = false; };
  }, [r.key, entries.length]);
  useEffect(() => {
    api.get<{ templates: Array<{ templateKey: string; label: string }> }>("/document-templates")
      .then((x) => {
        const list = x.templates.filter((t) => /statement|計算書/.test(`${t.templateKey}${t.label}`));
        setTemplates(list.length ? list : x.templates);
        setTemplateKey((list.find((t) => t.templateKey === "royalty_statement") ?? list[0] ?? x.templates[0])?.templateKey ?? "");
      })
      .catch(() => undefined);
  }, []);

  async function skip(p: RoundPart, undo = false) {
    if (!p.scheduleId) return;
    try {
      if (undo) await api.del(`/royalty-ledger/skips?conditionId=${p.conditionId}&scheduleId=${p.scheduleId}`);
      else await api.post("/royalty-ledger/skips", { conditionId: p.conditionId, scheduleId: p.scheduleId });
      onChanged(undo ? "「今期は無し」を取り消しました" : "今期は無しにしました");
    } catch (e) { onError((e as ApiError).message); }
  }
  async function issue() {
    setBusy(true);
    try {
      const x = await api.post<{ document: { id: number; documentNo: string | null } }>("/statement-documents", {
        templateKey, entries
      });
      setIssued(x.document);
      onChanged(`計算書 ${x.document.documentNo ?? `#${x.document.id}`} を作りました`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const bucket = (p: RoundPart) => p.state === "waiting" || p.state === "before" ? "waiting"
    : p.state === "reported" ? "reported" : "done";
  const counts = { all: r.parts.length, waiting: 0, reported: 0, done: 0 };
  r.parts.forEach((p) => counts[bucket(p)]++);
  const order = { waiting: 0, reported: 1, done: 2 };
  const list = r.parts
    .filter((p) => filter === "all" || bucket(p) === filter)
    .filter((p) => !q || `${cond(p.conditionId).workTitle ?? ""}${cond(p.conditionId).usageLabel}`.includes(q))
    .sort((a, b) => order[bucket(a)] - order[bucket(b)]);
  const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };

  return (
    <div className="ledger-detail">
      <div className="panel">
        <div className="panel-hd">
          <h2>{roundTitle(r)}</h2>
          <span className={`tag ${st.tag}`}>{st.label}</span>
          <span className="chips" style={{ marginLeft: "auto" }} role="group" aria-label="絞り込み">
            {(["all", "waiting", "reported", "done"] as const).map((f) => (
              <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {{ all: "すべて", waiting: "報告待ち", reported: "入力済", done: "済・無し" }[f]} {counts[f]}
              </button>
            ))}
          </span>
          {r.parts.length > 6 && (
            <input className="inline-input" placeholder="作品名で探す" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
        </div>
        <div className="panel-bd stack" style={{ gap: 0 }}>
          {list.map((p) => {
            const c = cond(p.conditionId);
            const ps = PART_STATE[p.state] ?? { label: p.state, tag: "" };
            const key = partKey(p);
            return (
              <div key={key} className={`ledger-part${p.state === "waiting" ? " waiting" : ""}`}>
                <div className="ledger-part-row">
                  <span className="stack" style={{ gap: 0 }}>
                    <span>{c.workTitle ?? "—"} · {c.usageLabel}</span>
                    <span className="faint code">{c.conditionNo ?? `#${c.id}`}</span>
                  </span>
                  <span className="stack" style={{ gap: 0 }}>
                    <span>{p.label ?? p.closeOn ?? ""}</span>
                    <span className="faint">{p.eventId !== null ? "" : `締め ${p.closeOn ?? "—"}${p.payOn ? ` · 支払 ${p.payOn}` : ""}`}</span>
                  </span>
                  <span className="stack" style={{ gap: 0 }}>
                    {p.events.map((e) => (
                      <span key={e.id} className="faint">
                        {e.occurredOn} {e.outName ? `${e.outName} ` : e.workTitle ? `${e.workTitle} ` : ""}
                        {e.quantity !== null ? `${e.quantity.toLocaleString()} 個 ` : ""}
                        {e.grossAmount !== null ? `報告 ${yen(e.grossAmount, c.currency)}` : ""}
                        {e.documentId ? " · 計算書済" : ""}
                      </span>
                    ))}
                    {p.expected.map((x, i) => (
                      <span key={i} style={{ color: "var(--warn)" }}>
                        来るはず：{x.outName ?? x.workTitle ?? x.usageType ?? "前の回の行"}（{x.why}）
                      </span>
                    ))}
                    {!p.events.length && !p.expected.length && <span className="faint">実績なし</span>}
                  </span>
                  <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                    <span className={`tag ${ps.tag}`}>{p.implied ? "報告なし" : ps.label}</span>
                    {canWrite && p.state !== "issued" && !p.skipped && (
                      <button className="btn btn-sm" onClick={() => setRecording(recording === key ? null : key)}>実績を入れる</button>
                    )}
                    {canWrite && p.scheduleId && !p.events.length && !p.skipped && (
                      <button className="btn btn-sm" title="この回は報告が来なかった" onClick={() => void skip(p)}>今期は無し</button>
                    )}
                    {canWrite && p.skipped && !p.implied && p.scheduleId && (
                      <button className="btn btn-sm" onClick={() => void skip(p, true)}>取り消す</button>
                    )}
                  </span>
                </div>
                {recording === key && (
                  <div style={{ padding: "6px 0 10px" }}>
                    <ConditionEvents conditionId={c.id} currency={c.currency} pricingModel={c.pricingModel}
                      ratePpm={c.ratePpm} direction="in" kind="license"
                      conditionUnitAmount={c.unitAmount} workTitle={c.workTitle} workId={c.workId}
                      editable={canWrite} openForSchedule={p.scheduleId}
                      onOpenDocument={onOpenDocument}
                      onChanged={() => { setRecording(null); onChanged("実績を入れました"); }} />
                  </div>
                )}
              </div>
            );
          })}
          {!list.length && <div className="faint">当たる行はありません。</div>}
        </div>
      </div>

      <aside className="stack">
        <div className="panel">
          <div className="panel-hd"><h2>この回の計算書</h2>
            <span className="faint">{view.party.bundle === "per_party" ? "作家でまとめる" : "作品ごと"}</span></div>
          <div className="panel-bd stack">
            {r.documents.map((d) => (
              <div key={d.id} className="row" style={{ gap: 6 }}>
                {onOpenDocument
                  ? <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                  : <span className="code">{d.documentNo ?? `#${d.id}`}</span>}
                <span className="tag ok">決定</span>{d.sent && <span className="tag ok">送付済</span>}
              </div>
            ))}
            {r.payments.map((x) => (
              <div key={x.id} className="faint">
                支払 <span className="code">{x.paymentNo ?? `#${x.id}`}</span> {yen(x.amount)} ·
                {x.status === "paid" ? ` 支払済 ${x.paidOn ?? ""}` : ` 支払予定 ${x.dueOn ?? "—"}`}
              </div>
            ))}
            {entries.length > 0 && (
              <>
                {preview && <StatementBreakdown lines={preview.lines} totals={preview.totals} />}
                {previewError && (
                  <div className="alert">試算できません：{previewError}。「実績を入れる」から該当の実績を直してください。</div>
                )}
                {waiting.length > 0 && (
                  <div className="note warn">
                    報告待ち・締め前が {waiting.length} 本あります。待たずに出すと、入力済の分だけの計算書になります
                    （残りは「今期は無し」にするか、あとで別の計算書にします）。
                  </div>
                )}
                {canWrite && (
                  <div className="row">
                    <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} aria-label="ひな形">
                      {templates.map((t) => <option key={t.templateKey} value={t.templateKey}>{t.label}</option>)}
                    </select>
                    <button className="btn primary" disabled={busy || !templateKey || !preview} onClick={() => void issue()}>
                      {busy ? "作成中…" : "この回の計算書を作る"}
                    </button>
                  </div>
                )}
              </>
            )}
            {!entries.length && !r.documents.length && <div className="faint">まだ計算書に入れる実績がありません。</div>}
            {issued && onOpenDocument && (
              <button className="btn btn-sm" onClick={() => onOpenDocument(issued.id)}>作った計算書を開く（送付へ）</button>
            )}
          </div>
        </div>
        {r.requests.length > 0 && (
          <div className="panel">
            <div className="panel-hd"><h2>受付箱の依頼</h2></div>
            <div className="panel-bd stack" style={{ gap: 4 }}>
              {r.requests.map((x) => (
                <div key={x.id}>
                  <span className="tag pin">{x.requestNo ?? `#${x.id}`}</span> {x.title}
                  <div className="faint">担当 {x.assigneeName ?? "未定"} · 期日 {x.dueOn ?? "—"}</div>
                </div>
              ))}
              <div className="faint">この回で作った計算書で、依頼の工程（作成→送付→支払予定→支払）が進み、依頼者に Slack で知らせます。</div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/** これまでの回。年ごとに畳む。 */
function History({ view, onOpenDocument }: { view: LedgerView; onOpenDocument?: (documentId: number) => void }) {
  const years = [...new Set(view.history.map((r) => (r.payOn ?? r.closeOn ?? "").slice(0, 4)).filter(Boolean))];
  const [year, setYear] = useState<string>(years[0] ?? "");
  useEffect(() => { if (!years.includes(year)) setYear(years[0] ?? ""); }, [years.join(",")]);
  if (!view.history.length) return null;
  const rows = view.history.filter((r) => (r.payOn ?? r.closeOn ?? "").startsWith(year));
  const titles = (r: Round) => {
    const t = r.workIds.map((id) => view.works.find((w) => w.id === id)?.title).filter(Boolean) as string[];
    return t.length > 1 ? `${t[0]} ほか${t.length - 1}作品` : t[0] ?? "";
  };
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>これまでの回</h2>
        <span className="chips">
          {years.map((y) => (
            <button key={y} className="chip" aria-pressed={y === year} onClick={() => setYear(y)}>
              {y}年 {view.history.filter((r) => (r.payOn ?? r.closeOn ?? "").startsWith(y)).length}
            </button>
          ))}
        </span>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>回</th><th>作品</th><th>計算書</th><th className="num">お支払い</th><th>状態</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };
              return (
                <tr key={r.key}>
                  <td><span className={`tag ${r.kind === "event" ? "warn" : ""}`}>{r.kind === "event" ? "製造" : "期"}</span> {roundTitle(r)}
                    <div className="faint">{[...new Set(r.parts.map((p) => p.label).filter(Boolean))].slice(0, 3).join("・")}</div></td>
                  <td>{titles(r)}</td>
                  <td>{r.documents.map((d) => onOpenDocument
                    ? <button key={d.id} className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                    : <span key={d.id} className="code">{d.documentNo}</span>)}{!r.documents.length && <span className="faint">—</span>}</td>
                  <td className="num">{r.payments.length ? yen(r.payments.reduce((a, x) => a + x.amount, 0)) : "—"}</td>
                  <td><span className={`tag ${st.tag}`}>{st.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
