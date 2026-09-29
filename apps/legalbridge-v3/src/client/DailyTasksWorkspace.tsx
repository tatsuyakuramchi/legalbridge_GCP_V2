import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { DetailBack, isWideLayout } from "./DetailBack.js";
import { UploadsPanel } from "./UploadsPanel.js";
import { RoundPicker, roundTargets } from "./RoundPicker.js";
import { StatusTag } from "./labels.js";

/**
 * デイリータスク。docs/v3-request-inbox.md §10（A-064）
 *
 * 受付箱で「軽微」にした依頼の作業テーブル。案件を立てるほどではない検収書・
 * 利用許諾計算書・定型文書などを、担当・期日と 未着手／作業中／待ち／完了 の 4 つの
 * 状態で追う。進み具合（受付→作成→送付→支払予定→支払）は文書と支払から自動で出す。
 * 支払まで済めば自動で完了になる。思ったより大きくなったら「案件に移す」。
 */

type Tab = "open" | "wait" | "late" | "done" | "all";
type Status = "todo" | "doing" | "blocked" | "done";
const STATUSES: Status[] = ["todo", "doing", "blocked", "done"];
const STATUS_LABEL: Record<Status, string> = { todo: "未着手", doing: "作業中", blocked: "待ち", done: "完了" };
const today = () => new Date().toISOString().slice(0, 10);
const when = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ").replace("-", "/") : "—");

interface Stage { key: string; label: string; done: boolean; at: string | null; detail: string }
export interface Progress {
  stages: Stage[]; current: Stage | null; complete: boolean;
  documents: Array<{ id: number; documentNo: string | null; status: string; pinned: boolean }>;
  payments: Array<{ id: number; paymentNo: string | null; status: string; dueOn: string | null; paidOn: string | null }>;
}
interface Task {
  id: number; title: string; status: Status; purpose: string; purposeLabel: string;
  assigneeStaffId: number | null; assigneeName: string | null; dueOn: string | null; overdue: boolean;
  doneAt: string | null; createdAt: string;
  request: { id: number; requestNo: string | null; source: string; targetDocNo: string | null;
             counterpartyName: string | null; requesterName: string | null; hasUnseenUpdate: boolean };
  progress: Progress | null;
}
interface Counts { todo: number; doing: number; wait: number; late: number; done: number; open: number }
interface Detail {
  task: Task;
  request: { id: number; requestNo: string | null; title: string; detail: string | null; purpose: string | null;
             targetDocNo: string | null; requesterName: string | null; requesterSlackId: string | null; requesterEmail: string | null;
             counterpartyName: string | null; kind: string | null; handledAt: string | null };
  matterCandidates: Array<{ id: number; matterNo: string | null; title: string; status: string; why: string }>;
  conditions: Array<{ id: number; conditionNo: string | null; name: string;
                      workId: number | null; workTitle: string | null; partyId: number | null }>;
  replies: Array<{ at: string; user: string; text: string }>;
  rounds: Array<{ kind: "schedule" | "event"; targetId: number; label: string | null; closeOn: string | null;
                  payOn: string | null; conditionId: number; usageType: string | null;
                  workId: number | null; workTitle: string | null; partyId: number | null; partyName: string | null }>;
  ledgers: Array<{ partyId: number; partyName: string; workId: number; workTitle: string }>;
}
interface Staff { id: number; name: string; status?: string }
interface MatterHit { id: number; matterNo: string | null; title: string; status: string }
const KIND_LABEL: Record<string, string> = { outsourcing: "業務委託・発注", work: "作品の権利", single: "その他の相談" };

export function DailyTasksWorkspace(
  { initialId, onOpenMatter, onCompose, onOpenDocument, onOpenLedger, onOpenRequest, onCountsChange }: {
    /** この作業を選んだ状態で開く。 */
    initialId?: number;
    onOpenMatter?: (matterId: number) => void;
    /** 依頼の条件を載せた状態で文書の画面へ移る（案件なし。作った文書は依頼に繋がる）。 */
    onCompose?: (conditionIds: number[], templateKey: string | null, requestId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    /** 計算書の依頼を、作品の利用許諾計算（許諾料の台帳）で開く。 */
    onOpenLedger?: (workId: number, partyId: number) => void;
    /** 元の依頼を受付箱で開く。 */
    onOpenRequest?: (requestId: number) => void;
    /** 左の桁の件数を合わせる。 */
    onCountsChange?: (counts: Counts) => void;
  }
) {
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<Tab>(initialId ? "all" : "open");
  const [mine, setMine] = useState<number | "">("");
  const [items, setItems] = useState<Task[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [version, setVersion] = useState(0);
  const [lastMatter, setLastMatter] = useState<number | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
    api.get<{ staff: Staff[] }>("/staff").then((r) => setStaff(r.staff.filter((s) => s.status !== "inactive")))
      .catch(() => setStaff([]));
  }, []);

  const q = mine ? `&assignee=${mine}` : "";
  useEffect(() => {
    setError(null);
    api.get<{ items: Task[] }>(`/tasks?tab=${tab}${q}`).then((r) => setItems(r.items))
      .catch((e: ApiError) => setError(e.message));
    api.get<Counts>(`/tasks/counts?x=1${q}`).then((c) => { setCounts(c); onCountsChange?.(c); }).catch(() => undefined);
  }, [tab, mine, version]);

  useEffect(() => {
    setDetail(null);
    if (selected === undefined) return;
    api.get<Detail>(`/tasks/${selected}`).then(setDetail).catch((e: ApiError) => setError(e.message));
  }, [selected, version]);

  useEffect(() => {
    if (selected === undefined && items?.length && isWideLayout()) setSelected(items[0].id);
  }, [items]);

  const reload = (message?: string, keepSelection = true) => {
    if (message) setNotice(message);
    if (!keepSelection) setSelected(undefined);
    setVersion((v) => v + 1);
  };

  const tabs: Array<[Tab, string, number | undefined]> = [
    ["open", "やること", counts ? counts.todo + counts.doing : undefined], ["wait", "待ち", counts?.wait],
    ["late", "期限切れ", counts?.late], ["done", "完了", counts?.done], ["all", "すべて", undefined]
  ];

  return (
    <div className={`workspace${selected !== undefined ? " picked" : ""}`}>
      <header className="workspace-head">
        <h1>デイリータスク</h1>
        <p>
          受付箱で「軽微」にした依頼の作業テーブルです。状態は 未着手・作業中・待ち・完了 の 4 つだけ。
          進み具合（作成・送付・支払）は文書と支払から自動で出し、支払まで済めば自動で完了になります。
          思ったより大きくなったら「案件に移す」。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && (
        <div className="note ok">
          {notice}
          {lastMatter && onOpenMatter && (
            <> <button className="linky" onClick={() => onOpenMatter(lastMatter)}>案件を開く</button></>
          )}
        </div>
      )}

      {counts && (
        <div className="tiles">
          <button className="tile" onClick={() => setTab("open")}>
            <span className="lab">未着手</span><span className="val">{counts.todo}</span></button>
          <button className="tile" onClick={() => setTab("open")}>
            <span className="lab">作業中</span><span className="val">{counts.doing}</span></button>
          <button className="tile" onClick={() => setTab("wait")}>
            <span className="lab">待ち</span><span className="val">{counts.wait}</span>
            <span className="sub">先方の返事・支払を待っている</span></button>
          <button className={`tile${counts.late ? " alert" : ""}`} onClick={() => setTab("late")}>
            <span className="lab">期限切れ</span><span className="val">{counts.late}</span></button>
          <button className="tile" onClick={() => setTab("done")}>
            <span className="lab">この 7 日の完了</span><span className="val">{counts.done}</span></button>
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <span className="faint">担当</span>
        <select className="inline-input" value={mine} onChange={(e) => { setMine(e.target.value ? Number(e.target.value) : ""); setSelected(undefined); }}>
          <option value="">全員</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div className="tabs">
        {tabs.map(([t, label, n]) => (
          <button key={t} aria-selected={tab === t} onClick={() => { setTab(t); setSelected(undefined); }}>
            {label}{n ? ` ${n}` : ""}
          </button>
        ))}
      </div>

      <div className="split">
        <div className="panel md-list">
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>期日</th><th>種別</th><th>件名</th><th className="md-list-extra">取引先</th><th>担当</th><th>状態</th><th>進み具合</th></tr>
              </thead>
              <tbody>
                {(items ?? []).map((t) => (
                  <tr key={t.id} aria-selected={selected === t.id} style={{ cursor: "pointer" }}
                      onClick={() => setSelected(t.id)}>
                    <td className={t.overdue ? "danger" : "faint"}>
                      {t.dueOn === today() ? "今日" : t.dueOn ?? "—"}
                    </td>
                    <td><span className="tag in">{t.purposeLabel}</span></td>
                    <td>
                      <div>{t.title}</div>
                      <div className="faint code">{t.request.requestNo ?? `#${t.request.id}`}{t.request.targetDocNo ? `　対象 ${t.request.targetDocNo}` : ""}</div>
                      {t.request.hasUnseenUpdate && <span className="tag warn">依頼者から返信あり</span>}
                    </td>
                    <td className="faint md-list-extra">{t.request.counterpartyName ?? "—"}</td>
                    <td className="faint">{t.assigneeName ?? "未定"}</td>
                    <td><StatusTag kind="task" value={t.status} /></td>
                    <td><StageBar progress={t.progress} compact /></td>
                  </tr>
                ))}
                {items && !items.length && (
                  <tr><td colSpan={7} className="faint">
                    {tab === "open" ? "やることはありません。受付箱で「軽微」にした依頼がここに入ります。"
                      : tab === "wait" ? "待ちの作業はありません。" : tab === "late" ? "期限切れの作業はありません。"
                      : tab === "done" ? "完了した作業はありません。" : "作業はありません。"}
                  </td></tr>
                )}
                {!items && <tr><td colSpan={7} className="faint">読み込んでいます…</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {selected !== undefined && (
          <div className="stack md-detail">
            <DetailBack label="デイリータスク" count={items?.length} onBack={() => setSelected(undefined)} />
            {!detail ? <div className="faint">読み込んでいます…</div> : (
              <>
                <TaskPanel detail={detail} canWrite={canWrite} staff={staff}
                           onChanged={(msg) => reload(msg)} onError={setError}
                           onCompose={onCompose} onOpenDocument={onOpenDocument} onOpenLedger={onOpenLedger}
                           onOpenRequest={onOpenRequest} />
                <MovePanel detail={detail} canWrite={canWrite} staff={staff}
                           onMoved={(msg, matterId) => { setLastMatter(matterId); reload(msg, false); }}
                           onError={setError} onOpenMatter={onOpenMatter} />
                <UploadsPanel target="intake" id={detail.request.id} canWrite={canWrite} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 工程の帯。済んだ段・いまの段・まだの段を並べる。 */
export function StageBar({ progress, compact = false }: { progress: Progress | null; compact?: boolean }) {
  if (!progress) return <span className="faint">—</span>;
  if (compact) {
    return progress.complete
      ? <span className="tag ok">すべて済み</span>
      : <span title={progress.current?.detail ?? ""}>
          <span className="tag accent">{progress.current?.label ?? "—"}</span>
          <span className="faint" style={{ marginLeft: 6 }}>
            {progress.stages.filter((s) => s.done).length}/{progress.stages.length}
          </span>
        </span>;
  }
  return (
    <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
      {progress.stages.map((s, i) => (
        <span key={s.key} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="faint">→</span>}
          <span className={`tag ${s.done ? "ok" : progress.current?.key === s.key ? "accent" : "ghost"}`}
                title={s.detail}>
            {s.done ? "✓ " : ""}{s.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/** 状態の切替。案件の作業タブでも同じものを使う。 */
export function StatusPicker(
  { value, disabled, onPick }: { value: string; disabled?: boolean; onPick: (status: Status) => void }
) {
  return (
    <div className="chips">
      {STATUSES.map((s) => (
        <button key={s} className="chip" aria-pressed={value === s} disabled={disabled}
                onClick={() => value !== s && onPick(s)}>{STATUS_LABEL[s]}</button>
      ))}
    </div>
  );
}

/** 作業の詳細。状態・担当・期日、進み具合、条件・回・文書、依頼者からの返信。 */
function TaskPanel(
  { detail, canWrite, staff, onChanged, onError, onCompose, onOpenDocument, onOpenLedger, onOpenRequest }: {
    detail: Detail; canWrite: boolean; staff: Staff[];
    onChanged: (message: string) => void;
    onError: (message: string) => void;
    onCompose?: (conditionIds: number[], templateKey: string | null, requestId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    onOpenLedger?: (workId: number, partyId: number) => void;
    onOpenRequest?: (requestId: number) => void;
  }
) {
  const t = detail.task;
  const r = detail.request;
  const p = t.progress;
  const payment = t.purpose === "inspection" || t.purpose === "royalty";
  const label = t.purposeLabel;
  const [assignee, setAssignee] = useState<number | "">(t.assigneeStaffId ?? "");
  const [dueOn, setDueOn] = useState(t.dueOn ?? "");
  const [title, setTitle] = useState(t.title);
  const [requesterEmail, setRequesterEmail] = useState(r.requesterEmail ?? "");
  const [docNo, setDocNo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAssignee(t.assigneeStaffId ?? ""); setDueOn(t.dueOn ?? ""); setTitle(t.title); setRequesterEmail(r.requesterEmail ?? "");
  }, [t.id, t.assigneeStaffId, t.dueOn, t.title, r.requesterEmail]);
  const dirty = assignee !== (t.assigneeStaffId ?? "") || dueOn !== (t.dueOn ?? "")
    || title.trim() !== t.title || requesterEmail.trim() !== (r.requesterEmail ?? "");

  const call = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await fn(); onChanged(message); }
    catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  };
  const patch = (body: unknown) => api.patch(`/tasks/${t.id}`, body);
  const post = (path: string, body: unknown) => api.post(`/intake/${r.id}/${path}`, body);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{t.title}</h2>
        <span className="tag in">{label}</span>
        <StatusTag kind="task" value={t.status} />
        {t.overdue && <span className="tag warn">期日超過</span>}
        {onOpenRequest && (
          <button className="linky code" style={{ marginLeft: "auto" }} onClick={() => onOpenRequest(r.id)}>
            依頼 {r.requestNo ?? `#${r.id}`}
          </button>
        )}
      </div>
      <div className="panel-bd stack">
        <div className="faint">
          依頼者 {r.requesterName ?? "—"}　相手先 {t.request.counterpartyName ?? "—"}
          {t.request.targetDocNo ? <>　対象 <span className="code">{t.request.targetDocNo}</span></> : null}
        </div>
        {r.detail && <pre className="locked" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.detail}</pre>}

        <div className="stack" style={{ gap: 4 }}>
          <b>状態</b>
          <StatusPicker value={t.status} disabled={!canWrite || busy}
                        onPick={(s) => call(() => patch({ status: s }), `${STATUS_LABEL[s]}にしました`)} />
          <span className="faint">
            {payment ? "支払が記録されると自動で「完了」になります。支払の記録が V3 に無いときは手で完了にしてください。"
              : "文書を送って終わったら「完了」にしてください（自動では完了になりません）。"}
          </span>
        </div>

        <div className="form-grid">
          <label className="field"><span>件名</span>
            <input value={title} disabled={!canWrite || busy} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field"><span>依頼者のメール</span>
            <input type="email" value={requesterEmail} disabled={!canWrite || busy} placeholder="例：tanaka@example.co.jp"
                   onChange={(e) => setRequesterEmail(e.target.value)} />
          </label>
          <label className="field"><span>担当</span>
            <select value={assignee} disabled={!canWrite || busy}
                    onChange={(e) => setAssignee(e.target.value ? Number(e.target.value) : "")}>
              <option value="">未定</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span>期日</span>
            <input type="date" value={dueOn} disabled={!canWrite || busy} onChange={(e) => setDueOn(e.target.value)} />
          </label>
        </div>
        <span className="faint">
          文書を送るメールの下書きは、ここから埋まります：宛先＝依頼者のメール（無ければ Slack の ID から社員を引く）、cc＝担当、
          本文の案件番号・案件名＝依頼番号・件名。
        </span>
        {canWrite && dirty && (
          <div>
            <button className="btn btn-sm" disabled={busy || !title.trim()}
                    onClick={() => call(() => patch({ title: title.trim(), requesterEmail: requesterEmail.trim() || null,
                                                      assigneeStaffId: assignee || null, dueOn: dueOn || null }),
                                        "件名・依頼者・担当・期日を保存しました")}>保存</button>
          </div>
        )}

        <div className="stack" style={{ gap: 4 }}>
          <b>進み具合<span className="faint" style={{ marginLeft: 8 }}>文書・支払から自動で判定</span></b>
          <StageBar progress={p} />
          {p && (
            <div className="stack" style={{ gap: 2 }}>
              {p.stages.map((s) => (
                <div key={s.key} className="faint">
                  {s.done ? "✓" : "・"} {s.label}：{s.detail || "—"}{s.at ? `（${when(s.at)}）` : ""}
                </div>
              ))}
            </div>
          )}
        </div>

        {(detail.conditions.length > 0 || t.purpose === "royalty") && (
          <div className="stack" style={{ gap: 4 }}>
            <b>対象の条件</b>
            {detail.conditions.map((c) => (
              <div key={c.id}><span className="code">{c.conditionNo ?? `#${c.id}`}</span> {c.name}</div>
            ))}
            {t.purpose === "royalty" && (
              <div className="stack" style={{ gap: 6 }}>
                <b>作家・作品と回</b>
                {detail.ledgers.map((l) => (
                  <div key={`${l.partyId}:${l.workId}`} className="stack" style={{ gap: 2 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span>{l.partyName} × {l.workTitle}</span>
                      {onOpenLedger && (
                        <button className="btn btn-sm" onClick={() => onOpenLedger(l.workId, l.partyId)}>台帳で開く</button>
                      )}
                    </span>
                    {(() => {
                      // 1つの回は条件の数だけ予定明細の行を持つ。支払日（製造は実績）ごとに1行にまとめる。
                      const groups = new Map<string, Detail["rounds"]>();
                      for (const x of detail.rounds.filter((y) => y.partyId === l.partyId && y.workId === l.workId)) {
                        const k = x.kind === "event" ? `e${x.targetId}` : `s${x.payOn ?? x.closeOn}`;
                        groups.set(k, [...(groups.get(k) ?? []), x]);
                      }
                      return [...groups.entries()].map(([k, xs]) => (
                        <span key={k} className="row" style={{ gap: 6, marginLeft: 12 }}>
                          <span className={`tag ${xs[0].kind === "event" ? "warn" : ""}`}>{xs[0].kind === "event" ? "製造" : "期"}</span>
                          <span>{[...new Set(xs.map((x) => x.label ?? x.closeOn))].join("・")}</span>
                          <span className="faint">締め {xs[0].closeOn ?? "—"}{xs[0].payOn ? ` · 支払 ${xs[0].payOn}` : ""}</span>
                          {canWrite && (
                            <button className="btn btn-sm" disabled={busy}
                                    onClick={() => call(() => post("rounds/unlink", {
                                      scheduleIds: xs.filter((x) => x.kind === "schedule").map((x) => x.targetId),
                                      eventIds: xs.filter((x) => x.kind === "event").map((x) => x.targetId)
                                    }), "回を外しました")}>外す</button>
                          )}
                        </span>
                      ));
                    })()}
                  </div>
                ))}
                {!detail.rounds.length && (
                  <div className="faint">まだ回を選んでいません。どの回（締め・製造）の計算書の依頼かを選んでください。</div>
                )}
                {canWrite && t.status !== "done" && (
                  <RoundPicker ledgers={detail.ledgers} busy={busy}
                               onPick={(round) => void call(() => post("rounds", roundTargets(round)), "回に紐づけました")} />
                )}
              </div>
            )}
            {canWrite && onCompose && detail.conditions.length > 0 && t.status !== "done" && t.purpose !== "royalty" && (
              <div>
                <button className="btn btn-sm primary"
                        onClick={() => onCompose(detail.conditions.map((c) => c.id), null, r.id)}>
                  この条件で{label}を作る
                </button>
                <span className="faint" style={{ marginLeft: 8 }}>作った{label}は、この作業の進み具合に自動で入ります</span>
              </div>
            )}
          </div>
        )}

        <div className="stack" style={{ gap: 4 }}>
          <b>文書</b>
          {p?.documents.length ? p.documents.map((d) => (
            <div key={d.id} className="row" style={{ gap: 8 }}>
              {onOpenDocument
                ? <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                : <span className="code">{d.documentNo ?? `#${d.id}`}</span>}
              <span className="faint">{d.status === "issued" ? "決定" : "下書き"}{d.pinned ? "・手で繋いだ" : ""}</span>
              {canWrite && d.pinned && (
                <button className="btn btn-sm" disabled={busy}
                        onClick={() => call(() => api.del(`/intake/${r.id}/documents/${d.id}`), "文書を外しました")}>外す</button>
              )}
            </div>
          )) : (
            <div className="faint">
              {payment ? `まだありません。この依頼の条件で作った${label}は、ここに自動で入ります`
                : "まだありません。作った文書の番号を入れて繋いでください（進み具合に入ります）"}
            </div>
          )}
          {canWrite && (
            <div className="row" style={{ gap: 6 }}>
              <input className="inline-input code" placeholder="文書番号（自動で入らないときに手で繋ぐ）"
                     value={docNo} onChange={(e) => setDocNo(e.target.value)} />
              <button className="btn btn-sm" disabled={busy || !docNo.trim()}
                      onClick={() => call(() => post("documents", { documentNo: docNo.trim() }).then(() => setDocNo("")),
                                          "文書を繋ぎました")}>繋ぐ</button>
            </div>
          )}
        </div>

        {p && p.payments.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>支払</b>
            {p.payments.map((x) => (
              <div key={x.id} className="faint">
                <span className="code">{x.paymentNo ?? `#${x.id}`}</span>
                {x.status === "paid" ? `支払済み ${x.paidOn ?? ""}` : x.status === "canceled" ? "取消"
                  : `支払予定日 ${x.dueOn ?? "—"}`}
              </div>
            ))}
          </div>
        )}

        {detail.replies.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>依頼者からの返信（Slack のスレッド）</b>
            {detail.replies.map((x, i) => (
              <div key={i} className="note">
                <div className="faint">{when(x.at)}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{x.text}</div>
              </div>
            ))}
            {canWrite && t.request.hasUnseenUpdate && (
              <div><button className="btn btn-sm" disabled={busy}
                           onClick={() => call(() => post("seen", {}), "返信を確認済みにしました")}>確認した</button></div>
            )}
          </div>
        )}
        {payment && (
          <span className="faint">進み具合（作成・送付・支払予定・支払）は、依頼者の Slack の DM のスレッドに自動で知らせます</span>
        )}
      </div>
    </div>
  );
}

/** 思ったより大きかった → 案件に移す。案件を新しく立てるか、既存の案件を選ぶ。 */
function MovePanel(
  { detail, canWrite, staff, onMoved, onError, onOpenMatter }: {
    detail: Detail; canWrite: boolean; staff: Staff[];
    onMoved: (message: string, matterId: number) => void;
    onError: (message: string) => void;
    onOpenMatter?: (matterId: number) => void;
  }
) {
  const t = detail.task;
  const r = detail.request;
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState<string>("new");
  const [kind, setKind] = useState<string>(r.kind ?? "single");
  const [title, setTitle] = useState(t.title);
  const [owner, setOwner] = useState<number | "">(t.assigneeStaffId ?? "");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<MatterHit[]>([]);
  const [picked, setPicked] = useState<MatterHit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dest !== "pick" || search.trim().length < 2) { setHits([]); return; }
    const h = setTimeout(() => {
      api.get<{ matters: MatterHit[] }>(`/matters?open=1&q=${encodeURIComponent(search.trim())}`)
        .then((x) => setHits(x.matters.slice(0, 8))).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(h);
  }, [dest, search]);

  if (!canWrite || t.status === "done") return null;
  const matterId = dest === "new" ? null : dest === "pick" ? picked?.id ?? null : Number(dest);
  const ok = dest === "new" ? Boolean(kind) : Boolean(matterId);

  const move = async () => {
    setBusy(true);
    try {
      const x = await api.post<{ matterId: number; matterNo: string | null; createdMatter: boolean; notified: boolean }>(
        `/tasks/${t.id}/move`, dest === "new"
          ? { mode: "new", kind, title, ownerStaffId: owner || null }
          : { mode: "existing", matterId, title });
      onMoved(`${x.matterNo ?? `#${x.matterId}`} ${x.createdMatter ? "を立てて" : ""}案件に移しました。続きは案件の「作業」で`
        + (x.notified ? "。依頼者に Slack で知らせました" : ""), x.matterId);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <div className="panel-bd stack">
        {!open ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="faint">思ったより大きくなったら（交渉がある、文書が複数、関係者が多い）</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(true)}>案件に移す…</button>
          </div>
        ) : (
          <>
            <b>案件に移す</b>
            <div className="faint">
              この作業は案件の「作業」に移り、デイリータスクからは消えます。繋いだ条件・文書・依頼の原票（Backlog・メール・資料）もそのまま案件に付きます。
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" name={`mv${t.id}`} checked={dest === "new"} onChange={() => setDest("new")} />新しい案件をつくる
              </label>
              {detail.matterCandidates.map((c) => (
                <label key={c.id} className="row" style={{ gap: 6 }}>
                  <input type="radio" name={`mv${t.id}`} checked={dest === String(c.id)} onChange={() => setDest(String(c.id))} />
                  <span>{c.matterNo ?? `#${c.id}`} {c.title} <span className="faint">（{c.why}）</span></span>
                </label>
              ))}
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" name={`mv${t.id}`} checked={dest === "pick"} onChange={() => setDest("pick")} />他の案件を選ぶ
              </label>
              {dest === "pick" && (
                <div className="stack" style={{ gap: 4, marginLeft: 22 }}>
                  <input className="inline-input" placeholder="案件番号・件名で探す" value={search}
                         onChange={(e) => { setSearch(e.target.value); setPicked(null); }} />
                  {hits.map((h) => (
                    <button key={h.id} className="linky" style={{ textAlign: "left" }}
                            aria-pressed={picked?.id === h.id} onClick={() => setPicked(h)}>
                      {picked?.id === h.id ? "● " : ""}{h.matterNo ?? `#${h.id}`} {h.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="form-grid">
              {dest === "new" && (
                <label className="field"><span>案件の種類</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>
                    {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                </label>
              )}
              <label className="field"><span>件名</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              {dest === "new" && (
                <label className="field"><span>法務担当</span>
                  <select value={owner} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : "")}>
                    <option value="">あとで決める</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>やめる</button>
              <button className="btn btn-sm primary" disabled={busy || !ok} onClick={move}>移す</button>
              {onOpenMatter && matterId && (
                <button className="linky" onClick={() => onOpenMatter(matterId)}>移す先の案件を見る</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
