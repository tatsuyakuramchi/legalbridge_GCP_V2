import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { DetailBack, isWideLayout } from "./DetailBack.js";
import { UploadsPanel } from "./UploadsPanel.js";
import { StatusTag } from "./labels.js";

/**
 * 依頼の受付箱。docs/v3-request-inbox.md
 *
 * Slack の依頼は送信と同時に、Backlog の課題（V1 の Slack 受付・GAS・直接起票）は
 * 取得で、既存の案件に当たらない新しいメールは受信の取り込みでここに入る。届いただけでは案件にしない。
 *
 * 受付箱は振り分けるだけ（A-064）。法務がここで決めるのは 2 択＋例外：
 *   軽微 → デイリータスク（検収書・利用許諾計算書・定型文書など。作業テーブルで追う）
 *   大きい → 案件にする（新規、または既存の案件へ接続）
 *   保留 ／ 重複 ／ 対象外
 * 振り分けた依頼はここから消え、続きはデイリータスクか案件で進める。
 * 迷ったら軽微で受けてよい（デイリータスクから「案件に移す」ことができる）。
 *
 * 発注書が案件に入っている検収書は、その案件へ繋ぐ（案件の中で作る）。
 * Backlog の中身は原票として読むだけ。こちらからは書き換えない。
 */

type Tab = "new" | "on_hold" | "updated" | "all";
type Kind = "work" | "outsourcing" | "single";
const KIND_LABEL: Record<Kind, string> = { outsourcing: "業務委託・発注", work: "作品の権利", single: "その他の相談" };
const STATE_LABEL: Record<string, string> = {
  new: "未処理", on_hold: "保留", accepted: "受付済", duplicate: "重複", dismissed: "対象外"
};
const SOURCE_LABEL: Record<string, string> = { slack: "Slack", backlog: "Backlog", email: "メール", manual: "手動" };
const DISMISS_REASONS = ["誤起票", "テスト投稿", "法務の対象外", "その他"];
/** デイリータスクの種別。支払の書類（検収書・計算書）は対象の番号から条件を引き当てる。 */
const DAILY_PURPOSE_LABEL: Record<string, string> = {
  inspection: "検収書", royalty: "利用許諾計算書", template: "定型文書（当社ひな形の NDA など）", other: "その他の軽微な作業"
};
const isPayment = (p: string | null | undefined) => p === "inspection" || p === "royalty";

interface TaskRef {
  id: number; status: string; matterId: number | null;
  assigneeStaffId: number | null; assigneeName: string | null; dueOn: string | null; doneAt: string | null;
}
interface Request {
  id: number; requestNo: string | null; source: string; state: string; kind: Kind | null;
  purpose: string | null; purposeLabel: string | null; targetDocNo: string | null;
  title: string; detail: string | null; counterpartyName: string | null; dueOn: string | null;
  requesterSlackId: string | null; requesterName: string | null; requesterEmail: string | null;
  mail: { from: string | null; to: string[]; attachments: string[];
          followUps: Array<{ subject: string | null; from: string | null; receivedAt: string | null }> } | null;
  backlogIssueKey: string | null; backlogStatus: string | null; backlogUpdatedAt: string | null;
  backlogSnapshot: Record<string, any>; hasUnseenUpdate: boolean;
  matterId: number | null; matterNo: string | null; matterTitle: string | null;
  duplicateOfId: number | null; duplicateOfNo: string | null;
  reason: string | null; holdUntil: string | null; handledAt: string | null; handledBy: string | null;
  createdAt: string;
  handling: "matter" | "direct" | null;
  task: TaskRef | null;
}
interface Target {
  docNo: string; documentId: number | null; documentNo: string | null;
  agreementId: number | null; agreementNo: string | null;
  counterpartyId: number | null; counterpartyName: string | null;
  conditions: Array<{ id: number; conditionNo: string | null; name: string }>;
  matter: { id: number; matterNo: string | null; title: string; status: string } | null;
}
interface Detail {
  request: Request;
  matterCandidates: Array<{ id: number; matterNo: string | null; title: string; status: string; why: string }>;
  duplicateCandidates: Array<{ id: number; requestNo: string | null; title: string; state: string; why: string }>;
  target: Target | null;
  replies: Array<{ at: string; user: string; text: string }>;
  /** 依頼者のメールの見込み（依頼のメール → Slack の ID → 名前 から）。受付の欄の初期値。 */
  requesterEmailGuess?: string | null;
}
interface Counts { new: number; onHold: number; updated: number; holdDue: number }
interface Staff { id: number; name: string; status?: string }
interface MatterHit { id: number; matterNo: string | null; title: string; status: string }

const when = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ").replace("-", "/") : "—");

/** 振り分けたあとの行き先。受付済は「デイリーへ」「案件へ」で見分ける。 */
function destinationOf(r: Request): string {
  if (r.state !== "accepted") return STATE_LABEL[r.state] ?? r.state;
  return r.handling === "direct" ? "デイリーへ" : "案件へ";
}

export function IntakeWorkspace(
  { onOpenMatter, onOpenTask, onCountsChange, initialId }: {
    /** この依頼を選んだ状態で開く（検索・作家の台帳から来たとき）。 */
    initialId?: number;
    onOpenMatter?: (matterId: number) => void;
    /** デイリータスクにした依頼の作業を開く。 */
    onOpenTask?: (taskId: number) => void;
    /** 左の桁の件数を合わせる。 */
    onCountsChange?: (counts: Counts) => void;
  }
) {
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<Tab>(initialId ? "all" : "new");
  const [items, setItems] = useState<Request[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [version, setVersion] = useState(0);
  const [pulling, setPulling] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  /** 直前に振り分けた先。知らせの横から開けるようにする。 */
  const [last, setLast] = useState<{ matterId?: number | null; taskId?: number | null } | null>(null);

  const canWrite = !readOnly && (role === "admin" || role === "legal");

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
    api.get<{ staff: Staff[] }>("/staff").then((r) => setStaff(r.staff.filter((s) => s.status !== "inactive")))
      .catch(() => setStaff([]));
  }, []);

  useEffect(() => {
    setError(null);
    api.get<{ items: Request[] }>(`/intake?state=${tab}`).then((r) => setItems(r.items))
      .catch((e: ApiError) => setError(e.message));
    api.get<Counts>("/intake/counts").then((c) => { setCounts(c); onCountsChange?.(c); }).catch(() => undefined);
  }, [tab, version]);

  useEffect(() => {
    setDetail(null);
    if (selected === undefined) return;
    api.get<Detail>(`/intake/${selected}`).then(setDetail).catch((e: ApiError) => setError(e.message));
  }, [selected, version]);

  // 並べて出せる幅なら、最初の1件を選んでおく（空の右半分を見せない）。
  useEffect(() => {
    if (selected === undefined && items?.length && isWideLayout()) setSelected(items[0].id);
  }, [items]);

  const reload = (message?: string, keepSelection = false) => {
    if (message) setNotice(message);
    setLast(null);
    if (!keepSelection) setSelected(undefined);
    setVersion((v) => v + 1);
  };

  const pull = async () => {
    setPulling(true); setError(null);
    try {
      const r = await api.post<{ ran: boolean; reason?: string; fetched: number;
                                 counts: Record<string, number>; failures: unknown[] }>("/jobs/backlog-pull", {});
      reload(r.ran
        ? `Backlog から ${r.fetched} 件読みました（新しく入った依頼 ${r.counts.created ?? 0} 件`
          + `${r.counts.failed ? `・失敗 ${r.counts.failed} 件` : ""}）`
        : `読みに行けませんでした：${r.reason}`, true);
    } catch (e) { setError((e as ApiError).message); }
    finally { setPulling(false); }
  };

  const tabs: Array<[Tab, string, number | undefined]> = [
    ["new", "未処理", counts?.new], ["on_hold", "保留", counts?.onHold],
    ["updated", "返信・更新あり", counts?.updated], ["all", "すべて", undefined]
  ];

  return (
    <div className={`workspace${selected !== undefined ? " picked" : ""}`}>
      <header className="workspace-head">
        <h1>受付箱</h1>
        <p>
          届いた依頼を振り分けるだけの場所です。軽微ならデイリータスク、大きければ案件にします。
          振り分けた依頼はここから消え、続きはデイリータスクか案件で進めます。依頼者には Slack で知らせます。Backlog は読むだけです。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && (
        <div className="note ok">
          {notice}
          {last?.matterId && onOpenMatter && (
            <> <button className="linky" onClick={() => onOpenMatter(last.matterId!)}>案件を開く</button></>
          )}
          {last?.taskId && onOpenTask && (
            <> <button className="linky" onClick={() => onOpenTask(last.taskId!)}>デイリータスクで開く</button></>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        {canWrite && (
          <button className="btn btn-sm" onClick={() => setManualOpen((v) => !v)}>＋ 手で登録（口頭・メール）</button>
        )}
        {role === "admin" && !readOnly && (
          <button className="btn btn-sm" disabled={pulling} onClick={pull}>
            {pulling ? "Backlog を読んでいます…" : "Backlog を今すぐ読む"}
          </button>
        )}
        {counts?.holdDue ? <span className="tag warn">再確認日の来た保留 {counts.holdDue} 件</span> : null}
      </div>

      {manualOpen && canWrite && (
        <ManualForm onDone={(msg) => { setManualOpen(false); setTab("new"); reload(msg); }}
                    onError={setError} />
      )}

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
                <tr><th>依頼</th><th>件名</th><th>経路</th><th>種類</th><th>{tab === "all" ? "行き先" : "届いた日"}</th></tr>
              </thead>
              <tbody>
                {(items ?? []).map((r) => (
                  <tr key={r.id} aria-selected={selected === r.id} style={{ cursor: "pointer" }}
                      onClick={() => setSelected(r.id)}>
                    <td>
                      <div className="code">{r.requestNo ?? `#${r.id}`}</div>
                      <div className="faint code">{r.backlogIssueKey ?? "Backlog なし"}</div>
                    </td>
                    <td>
                      <div>{r.title}</div>
                      <div className="faint">
                        {r.counterpartyName ?? "相手先の記載なし"}
                        {r.requesterName ? `　依頼者 ${r.requesterName}` : ""}
                      </div>
                      {r.hasUnseenUpdate && <span className="tag warn">返信・更新あり</span>}
                    </td>
                    <td className="faint">{SOURCE_LABEL[r.source] ?? r.source}</td>
                    <td className="faint">
                      {r.kind ? KIND_LABEL[r.kind] : "推定なし"}
                      {r.purposeLabel && <div title="依頼者が選んだ内容">{r.purposeLabel}</div>}
                    </td>
                    <td className="faint">
                      {tab === "all" ? (
                        <>
                          {destinationOf(r)}
                          {r.task && <div><StatusTag kind="task" value={r.task.status} /></div>}
                        </>
                      ) : tab === "on_hold" ? `再確認 ${r.holdUntil ?? "—"}` : when(r.createdAt)}
                    </td>
                  </tr>
                ))}
                {items && !items.length && (
                  <tr><td colSpan={5} className="faint">
                    {tab === "new" ? "未処理の依頼はありません。" : tab === "on_hold" ? "保留中の依頼はありません。"
                      : tab === "updated" ? "振り分けたあとに返信・Backlog の更新があった依頼はありません。"
                      : "依頼はありません。"}
                  </td></tr>
                )}
                {!items && <tr><td colSpan={5} className="faint">読み込んでいます…</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {selected !== undefined && (
          <div className="stack md-detail">
            <DetailBack label="受付箱" count={items?.length} onBack={() => setSelected(undefined)} />
            {!detail ? <div className="faint">読み込んでいます…</div> : (
              <>
                <Original request={detail.request} />
                <UploadsPanel target="intake" id={detail.request.id} canWrite={canWrite} />
                <Decision detail={detail} canWrite={canWrite} staff={staff}
                          onDone={(msg, dest) => { reload(msg); if (dest) setLast(dest); }}
                          onOpenMatter={onOpenMatter} onOpenTask={onOpenTask} onError={setError} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 原票。Backlog の写しと依頼の中身。読むだけ。 */
function Original({ request: r }: { request: Request }) {
  const snap = r.backlogSnapshot ?? {};
  const fields = (snap.customFields as Array<{ name: string; value: string | null }> | undefined) ?? [];
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{r.requestNo ?? `#${r.id}`}</h2>
        <span className="tag">{destinationOf(r)}</span>
        <span className="faint">{SOURCE_LABEL[r.source] ?? r.source}</span>
        {r.backlogIssueKey && <span className="faint code">{r.backlogIssueKey}</span>}
        {r.backlogStatus && <span className="tag ghost" title="Backlog のステータスは起案時のまま置き、更新しません">
          Backlog：{r.backlogStatus}</span>}
        <span className="faint" style={{ marginLeft: "auto" }}>原票（読み取り専用）</span>
      </div>
      <div className="panel-bd stack">
        <div><b>{r.title}</b></div>
        <div className="form-grid">
          <div className="field"><span>依頼者</span><div>{r.requesterName ?? "—"}{r.requesterSlackId ? `（Slack ${r.requesterSlackId}）` : ""}{r.requesterEmail && !r.requesterSlackId ? `（${r.requesterEmail}）` : ""}</div></div>
          {r.mail && <div className="field"><span>差出人</span><div>{r.mail.from ?? "—"}</div></div>}
          {r.mail && r.mail.attachments.length > 0 && (
            <div className="field"><span>添付</span><div>{r.mail.attachments.join("、")}</div></div>
          )}
          {r.purposeLabel && <div className="field"><span>依頼の内容</span><div>{r.purposeLabel}</div></div>}
          {r.targetDocNo && <div className="field"><span>対象の番号</span><div className="code">{r.targetDocNo}</div></div>}
          <div className="field"><span>相手先の記載</span><div>{r.counterpartyName ?? "—"}</div></div>
          <div className="field"><span>希望の期日</span><div>{r.dueOn ?? "—"}</div></div>
          <div className="field"><span>届いた日時</span><div>{when(r.createdAt)}</div></div>
          {fields.filter((f) => f.value && !["取引先名称", "希望納期"].includes(f.name)).map((f) => (
            <div key={f.name} className="field"><span>{f.name}</span><div>{f.value}</div></div>
          ))}
        </div>
        {r.detail && <pre className="locked" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.detail}</pre>}
        {r.mail && r.mail.followUps.length > 0 && (
          <div className="note">
            同じスレッドの続きのメール {r.mail.followUps.length} 通：
            {r.mail.followUps.map((m, i) => (
              <div key={i} className="faint">{when(m.receivedAt)}　{m.from ?? ""}　{m.subject ?? ""}</div>
            ))}
            <div className="faint">案件にすると、メールのスレッドごと案件のやり取りに入ります。</div>
          </div>
        )}
        {r.state === "on_hold" && r.reason && (
          <div className="note warn">保留：{r.reason}{r.holdUntil ? `（再確認 ${r.holdUntil}）` : ""}</div>
        )}
        {r.state === "dismissed" && <div className="note">対象外：{r.reason}</div>}
        {r.state === "duplicate" && <div className="note">{r.duplicateOfNo ?? `#${r.duplicateOfId}`} の重複</div>}
      </div>
    </div>
  );
}

/** 振り分け。未処理・保留なら 軽微／大きい の 2 択のフォーム、振り分け済みならその行き先と戻し方。 */
function Decision(
  { detail, canWrite, staff, onDone, onOpenMatter, onOpenTask, onError }: {
    detail: Detail; canWrite: boolean; staff: Staff[];
    onDone: (message: string, dest?: { matterId?: number | null; taskId?: number | null }) => void;
    onOpenMatter?: (matterId: number) => void;
    onOpenTask?: (taskId: number) => void;
    onError: (message: string) => void;
  }
) {
  const r = detail.request;
  const open = r.state === "new" || r.state === "on_hold";
  const target = detail.target;
  // 発注書が案件に入っている検収書は、その案件へ繋ぐほかは受けない（サーバも止める）。
  const lockedMatter = r.purpose === "inspection" && target?.documentId && target.matter ? target.matter : null;
  const firstCandidate = detail.matterCandidates[0]?.id;
  /** 軽微の既定：支払の書類と NDA。交渉のある依頼（レビュー・許諾・取引）は案件が既定。 */
  const dailyByDefault = isPayment(r.purpose) || r.purpose === "nda";
  const [route, setRoute] = useState<"daily" | "matter">(lockedMatter ? "matter" : dailyByDefault ? "daily" : "matter");
  const [purpose, setPurpose] = useState<string>(
    isPayment(r.purpose) ? r.purpose! : r.purpose === "nda" ? "template" : "other");
  const [kind, setKind] = useState<Kind | "">(r.kind ?? "");
  const [title, setTitle] = useState(r.title);
  const [owner, setOwner] = useState<number | "">("");
  const [dueOn, setDueOn] = useState(r.dueOn ?? "");
  /** 依頼者（事業部の担当者）のメール。見込みを入れておき、違えば直す。文書のメールの宛先になる。 */
  const [requesterEmail, setRequesterEmail] = useState(detail.requesterEmailGuess ?? r.requesterEmail ?? "");
  const [dest, setDest] = useState<string>(
    lockedMatter ? String(lockedMatter.id) : firstCandidate && r.kind !== null ? String(firstCandidate) : "new");
  const [docNo, setDocNo] = useState(r.targetDocNo ?? "");
  const [conditionIds, setConditionIds] = useState<number[]>(target?.conditions.map((c) => c.id) ?? []);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<MatterHit[]>([]);
  const [picked, setPicked] = useState<MatterHit | null>(null);
  const [side, setSide] = useState<"" | "hold" | "dismiss" | "duplicate">("");
  const [holdReason, setHoldReason] = useState(r.reason ?? "");
  const [holdUntil, setHoldUntil] = useState(r.holdUntil ?? "");
  const [dismissReason, setDismissReason] = useState(/テスト/.test(r.title) ? "テスト投稿" : "誤起票");
  const [dupOf, setDupOf] = useState<number | "">(detail.duplicateCandidates[0]?.id ?? "");
  const [dupNo, setDupNo] = useState("");
  const [busy, setBusy] = useState(false);
  /** 依頼番号（REQ-…）から重複元を引く。候補に無い依頼を指すとき用。 */
  const findByNo = async () => {
    try {
      const all = await api.get<{ items: Request[] }>("/intake?state=all");
      const hit = all.items.find((x) => x.requestNo === dupNo.trim().toUpperCase() && x.id !== r.id);
      if (hit) setDupOf(hit.id); else onError(`${dupNo} という依頼は見つかりません`);
    } catch (e) { onError((e as ApiError).message); }
  };

  useEffect(() => {
    if (dest !== "pick" || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      api.get<{ matters: MatterHit[] }>(`/matters?open=1&q=${encodeURIComponent(search.trim())}`)
        .then((x) => setHits(x.matters.slice(0, 8))).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [dest, search]);

  const run = async (path: string, body: unknown, message: (x: any) => string) => {
    setBusy(true);
    try {
      const x = await api.post<any>(`/intake/${r.id}/${path}`, body);
      onDone(message(x), { matterId: x?.matterId ?? null, taskId: x?.taskId ?? null });
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  };

  const daily = route === "daily";
  const payment = isPayment(purpose);
  const matterId = dest === "new" ? null : dest === "pick" ? picked?.id ?? null : Number(dest);
  const acceptable = daily
    ? Boolean(purpose) && (!payment || conditionIds.length > 0 || docNo.trim() !== "")
    : Boolean(kind) && (dest === "new" || matterId);
  const notified = (x: any) => (x?.notified ? "。依頼者に Slack で知らせました" : "");

  if (!open) {
    return (
      <div className="panel">
        <div className="panel-bd stack">
          {r.handling === "direct" && r.task && (
            <div className="row" style={{ gap: 8 }}>
              <span>行き先：デイリータスク</span>
              <StatusTag kind="task" value={r.task.status} />
              <span className="faint">担当 {r.task.assigneeName ?? "未定"}　期日 {r.task.dueOn ?? "—"}</span>
              {onOpenTask && <button className="linky" onClick={() => onOpenTask(r.task!.id)}>デイリータスクで開く</button>}
            </div>
          )}
          {r.matterId && (
            <div className="row" style={{ gap: 8 }}>
              <span>行き先：案件</span>
              {onOpenMatter
                ? <button className="linky" onClick={() => onOpenMatter(r.matterId!)}>{r.matterNo ?? `#${r.matterId}`} {r.matterTitle}</button>
                : <span>{r.matterNo ?? `#${r.matterId}`} {r.matterTitle}</span>}
            </div>
          )}
          {r.hasUnseenUpdate && r.handling === "direct" && (
            <div className="note warn">依頼者から Slack のスレッドに返信がありました（デイリータスクの詳細で読めます）。</div>
          )}
          {r.hasUnseenUpdate && r.handling !== "direct" && (
            <div className="note warn">
              振り分けたあとに Backlog が更新されました（{r.backlogStatus ?? "—"}・{when(r.backlogUpdatedAt)}）。
              案件は自動では動きません。内容を確かめて、必要なら案件側で対応してください。
            </div>
          )}
          {detail.replies.length > 0 && r.handling !== "direct" && (
            <div className="stack" style={{ gap: 4 }}>
              <b>依頼者からの返信（Slack のスレッド）</b>
              {detail.replies.map((x, i) => (
                <div key={i} className="note"><div className="faint">{when(x.at)}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{x.text}</div></div>
              ))}
            </div>
          )}
          <div className="faint">{STATE_LABEL[r.state]}：{r.handledBy ?? "—"}（{when(r.handledAt)}）</div>
          <div className="row" style={{ gap: 8 }}>
            {canWrite && r.hasUnseenUpdate && (
              <button className="btn btn-sm primary" disabled={busy}
                      onClick={() => run("seen", {}, () => "更新を確認済みにしました")}>確認した</button>
            )}
            {canWrite && (r.state === "duplicate" || r.state === "dismissed") && (
              <button className="btn btn-sm" disabled={busy}
                      onClick={() => run("reopen", {}, () => "受付箱に戻しました")}>受付箱に戻す</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-hd"><h2>振り分け</h2></div>
      <div className="panel-bd stack">
        {detail.duplicateCandidates.length > 0 && (
          <div className="note warn">
            重複の可能性：{detail.duplicateCandidates.map((d) =>
              `${d.requestNo ?? `#${d.id}`} ${d.title}（${d.why}）`).join(" ／ ")}
          </div>
        )}
        {detail.replies.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>依頼者からの返信（Slack のスレッド）</b>
            {detail.replies.map((x, i) => (
              <div key={i} className="note"><div className="faint">{when(x.at)}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{x.text}</div></div>
            ))}
          </div>
        )}
        {!canWrite && <div className="faint">振り分けられるのは管理者・法務だけです。</div>}

        {lockedMatter ? (
          <div className="note">
            発注書 {target?.documentNo ?? target?.docNo} は案件 {lockedMatter.matterNo ?? `#${lockedMatter.id}`}（{lockedMatter.title}）に入っています。
            検収書はその案件で作るので、この案件へ繋いで受け付けます。
          </div>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            <b>どこで進めるか</b>
            <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
              <button className="tile" style={{ flex: 1 }} aria-pressed={daily} disabled={!canWrite}
                      onClick={() => setRoute("daily")}>
                <span className="lab" style={{ color: daily ? "var(--in)" : undefined, fontWeight: 700, fontSize: 13 }}>
                  {daily ? "● " : "○ "}軽微 → デイリータスク
                </span>
                <span className="sub">文書 1 通・交渉なし・数日で終わる。検収書、利用許諾計算書、定型の NDA など</span>
              </button>
              <button className="tile" style={{ flex: 1 }} aria-pressed={!daily} disabled={!canWrite}
                      onClick={() => setRoute("matter")}>
                <span className="lab" style={{ color: !daily ? "var(--accent)" : undefined, fontWeight: 700, fontSize: 13 }}>
                  {!daily ? "● " : "○ "}大きい → 案件にする
                </span>
                <span className="sub">交渉がある、文書が複数、関係者が多い、数週間以上かかる</span>
              </button>
            </div>
            <div className="note warn">迷ったら軽微で受けてください。デイリータスクから、あとで「案件に移す」ことができます。</div>
          </div>
        )}

        {daily && !lockedMatter && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="form-grid">
              <label className="field"><span>種別<em className="req"> 必須</em></span>
                <select value={purpose} disabled={!canWrite || isPayment(r.purpose)}
                        onChange={(e) => setPurpose(e.target.value)}>
                  {Object.keys(DAILY_PURPOSE_LABEL).map((k) => <option key={k} value={k}>{DAILY_PURPOSE_LABEL[k]}</option>)}
                </select>
              </label>
              {payment && (
                <label className="field">
                  <span>{purpose === "inspection" ? "発注書番号" : "契約書番号"}</span>
                  <input value={docNo} disabled={!canWrite} className="code" onChange={(e) => setDocNo(e.target.value)} />
                </label>
              )}
              <label className="field"><span>件名</span>
                <input value={title} disabled={!canWrite} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field"><span>担当</span>
                <select value={owner} disabled={!canWrite} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">あとで決める</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field"><span>期日</span>
                <input type="date" value={dueOn} disabled={!canWrite} onChange={(e) => setDueOn(e.target.value)} />
              </label>
              <label className="field"><span>依頼者のメール</span>
                <input type="email" value={requesterEmail} disabled={!canWrite} placeholder="依頼から当たらなければ入れる"
                       onChange={(e) => setRequesterEmail(e.target.value)} />
              </label>
            </div>
            <div className="faint">
              依頼者のメールは文書を送るメール（担当者への確認）の宛先になります。
              {detail.requesterEmailGuess ? `依頼から「${detail.requesterEmailGuess}」と当てました。違えば直してください。` : "依頼からは当たりませんでした。分かれば入れてください（あとからも直せます）。"}
            </div>
            {payment && (
              target && docNo.trim() === (r.targetDocNo ?? "").trim() ? (
                target.conditions.length ? (
                  <div className="stack" style={{ gap: 2 }}>
                    <span className="faint">
                      {target.documentNo ?? target.agreementNo ?? target.docNo} から引き当てた条件
                      {target.counterpartyName ? `（${target.counterpartyName}）` : ""}。作った文書と支払はここから辿ります
                    </span>
                    {target.conditions.map((c) => (
                      <label key={c.id} className="row" style={{ gap: 6 }}>
                        <input type="checkbox" checked={conditionIds.includes(c.id)} disabled={!canWrite}
                               onChange={(e) => setConditionIds(e.target.checked
                                 ? [...conditionIds, c.id] : conditionIds.filter((x) => x !== c.id))} />
                        <span className="code">{c.conditionNo ?? `#${c.id}`}</span> {c.name}
                      </label>
                    ))}
                  </div>
                ) : <div className="note warn">{target.docNo} に条件が付いていません。番号を確かめてください</div>
              ) : (
                <div className="faint">
                  {docNo.trim()
                    ? "登録するときに、この番号から条件を引き当てます"
                    : r.targetDocNo ? `${r.targetDocNo} に当たる発注書・契約書が見つかりません。番号を直してください`
                    : "番号を入れると、登録するときに条件を引き当てます"}
                </div>
              )
            )}
            {!payment && <div className="faint">条件は持ちません。作った文書はデイリータスクの詳細で番号を入れて繋ぎます。</div>}
          </div>
        )}

        {!daily && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="stack" style={{ gap: 6 }}>
              <b>繋ぎ先</b>
              {!lockedMatter && (
                <label className="row" style={{ gap: 6 }}>
                  <input type="radio" name={`dest${r.id}`} checked={dest === "new"} disabled={!canWrite} onChange={() => setDest("new")} />
                  新しい案件をつくる
                </label>
              )}
              {detail.matterCandidates.filter((c) => !lockedMatter || c.id === lockedMatter.id).map((c) => (
                <label key={c.id} className="row" style={{ gap: 6 }}>
                  <input type="radio" name={`dest${r.id}`} checked={dest === String(c.id)} disabled={!canWrite}
                         onChange={() => setDest(String(c.id))} />
                  <span>{c.matterNo ?? `#${c.id}`} {c.title} <span className="faint">（{c.why}）</span></span>
                </label>
              ))}
              {!lockedMatter && (
                <label className="row" style={{ gap: 6 }}>
                  <input type="radio" name={`dest${r.id}`} checked={dest === "pick"} disabled={!canWrite} onChange={() => setDest("pick")} />
                  他の案件を選ぶ
                </label>
              )}
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
              <label className="field"><span>依頼の種類<em className="req"> 必須</em></span>
                <select value={kind} disabled={!canWrite} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="">選んでください</option>
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="field"><span>件名</span>
                <input value={title} disabled={!canWrite} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field"><span>法務担当</span>
                <select value={owner} disabled={!canWrite || dest !== "new"}
                        onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">あとで決める</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field"><span>期日</span>
                <input type="date" value={dueOn} disabled={!canWrite} onChange={(e) => setDueOn(e.target.value)} />
              </label>
              <label className="field"><span>依頼者のメール</span>
                <input type="email" value={requesterEmail} disabled={!canWrite} placeholder="依頼から当たらなければ入れる"
                       onChange={(e) => setRequesterEmail(e.target.value)} />
              </label>
            </div>
            <div className="faint">
              相手先は取引先マスタで1件に決まれば紐づけます。決まらなければ記載を案件の備考に残し、要確認に積みます。
              依頼者のメールは案件の依頼者になり、文書を送るメール（担当者への確認）の宛先になります。
              {detail.requesterEmailGuess ? `依頼から「${detail.requesterEmailGuess}」と当てました。` : ""}
            </div>
          </div>
        )}

        {canWrite && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "dismiss" ? "" : "dismiss")}>対象外…</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "hold" ? "" : "hold")}>保留…</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "duplicate" ? "" : "duplicate")}>重複…</button>
            <span className="faint" style={{ marginLeft: "auto" }}>依頼者に Slack で受付を知らせます</span>
            <button className="btn btn-sm primary" disabled={busy || !acceptable}
                    onClick={() => run("accept", daily && !lockedMatter ? {
                      mode: "direct", purpose, targetDocNo: payment ? docNo.trim() || null : null,
                      conditionIds: payment && docNo.trim() === (r.targetDocNo ?? "").trim() ? conditionIds : null,
                      title, ownerStaffId: owner || null, dueOn: dueOn || null, requesterEmail: requesterEmail.trim() || null
                    } : {
                      mode: dest === "new" ? "new" : "existing", matterId, kind,
                      title, ownerStaffId: owner || null, dueOn: dueOn || null, requesterEmail: requesterEmail.trim() || null
                    }, (x) => x.handling === "direct"
                      ? `${r.requestNo ?? ""} をデイリータスクに登録しました${notified(x)}`
                      : `${r.requestNo ?? ""} を案件 ${x.matterNo ?? `#${x.matterId}`} にしました${notified(x)}`)}>
              {daily && !lockedMatter ? "デイリータスクに登録" : "案件にして受け付ける"}
            </button>
          </div>
        )}

        {side === "hold" && (
          <div className="note stack">
            <label className="field"><span>確認したいこと</span>
              <textarea rows={2} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} /></label>
            <label className="field"><span>再確認日</span>
              <input type="date" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} /></label>
            <div className="faint">依頼者に Slack で確認を送ります。返信は「返信・更新あり」に出ます。</div>
            <button className="btn btn-sm" disabled={busy || !holdReason.trim()}
                    onClick={() => run("hold", { reason: holdReason, until: holdUntil || null },
                      (x) => `保留にしました${notified(x)}`)}>保留にする</button>
          </div>
        )}
        {side === "dismiss" && (
          <div className="note stack">
            <div className="chips">
              {DISMISS_REASONS.map((d) => (
                <button key={d} className="chip" aria-pressed={dismissReason === d} onClick={() => setDismissReason(d)}>{d}</button>
              ))}
            </div>
            <div className="faint">受付箱から消えます（あとで戻せます）。テスト投稿・誤起票は依頼者に知らせません。Backlog は変更しません。</div>
            <button className="btn btn-sm danger" disabled={busy}
                    onClick={() => run("dismiss", { reason: dismissReason }, (x) => `対象外にしました${notified(x)}`)}>対象外にする</button>
          </div>
        )}
        {side === "duplicate" && (
          <div className="note stack">
            <div className="row" style={{ gap: 6 }}>
              <input className="inline-input" value={dupNo} placeholder="重複元の依頼番号（REQ-…）"
                     onChange={(e) => setDupNo(e.target.value)} />
              <button className="btn btn-sm" disabled={!dupNo.trim()} onClick={findByNo}>探す</button>
              {dupOf !== "" && <span className="faint">選択中：#{dupOf}</span>}
            </div>
            {detail.duplicateCandidates.map((d) => (
              <button key={d.id} className="linky" style={{ textAlign: "left" }} onClick={() => setDupOf(d.id)}>
                {dupOf === d.id ? "● " : ""}{d.requestNo ?? `#${d.id}`} {d.title}
              </button>
            ))}
            <button className="btn btn-sm" disabled={busy || !dupOf}
                    onClick={() => run("duplicate", { duplicateOfId: dupOf }, (x) => `重複にしました${notified(x)}`)}>重複にする</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 口頭・メールで受けた依頼を手で入れる。Backlog には起案しない。 */
function ManualForm({ onDone, onError }: { onDone: (message: string) => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [counterpartyName, setCounterparty] = useState("");
  const [requesterName, setRequester] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = useMemo(() => title.trim().length > 0, [title]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ requestNo: string | null }>("/intake", {
        title, kind: kind || null, counterpartyName: counterpartyName || null,
        requesterName: requesterName || null, detail: detail || null
      });
      onDone(`${r.requestNo ?? "依頼"} を受付箱に入れました`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <div className="panel-hd"><h2>手で登録</h2><span className="faint">Backlog には起案しません</span></div>
      <div className="panel-bd stack">
        <div className="form-grid">
          <label className="field"><span>件名<em className="req"> 必須</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>依頼の種類</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="">あとで決める</option>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select></label>
          <label className="field"><span>相手先</span>
            <input value={counterpartyName} onChange={(e) => setCounterparty(e.target.value)} /></label>
          <label className="field"><span>依頼者</span>
            <input value={requesterName} onChange={(e) => setRequester(e.target.value)} /></label>
        </div>
        <label className="field"><span>内容</span>
          <textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        <div><button className="btn btn-sm primary" disabled={busy || !ok} onClick={save}>受付箱に入れる</button></div>
      </div>
    </div>
  );
}
