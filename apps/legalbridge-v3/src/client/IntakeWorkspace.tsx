import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { DetailBack, isWideLayout } from "./DetailBack.js";

/**
 * 依頼の受付箱。docs/v3-request-inbox.md
 *
 * Slack の依頼は送信と同時に、Backlog の課題（V1 の Slack 受付・GAS・直接起票）は
 * 取得でここに入る。届いただけでは案件にしない。法務がここで判断する：
 *   新規案件で受付 ／ 既存の案件へ接続 ／ 重複 ／ 保留 ／ 対象外
 * 受け付けた依頼は案件の工程の先頭「受付」に繋がる。
 *
 * Backlog の中身は原票として読むだけ。こちらからは書き換えない。
 */

type Tab = "new" | "on_hold" | "updated" | "all";
type Kind = "work" | "outsourcing" | "single";
const KIND_LABEL: Record<Kind, string> = { outsourcing: "業務委託・発注", work: "作品の権利", single: "その他の相談" };
const STATE_LABEL: Record<string, string> = {
  new: "未処理", on_hold: "保留", accepted: "受付済", duplicate: "重複", dismissed: "対象外"
};
const SOURCE_LABEL: Record<string, string> = { slack: "Slack", backlog: "Backlog", manual: "手動" };
const DISMISS_REASONS = ["誤起票", "テスト投稿", "法務の対象外", "その他"];

interface Request {
  id: number; requestNo: string | null; source: string; state: string; kind: Kind | null;
  title: string; detail: string | null; counterpartyName: string | null; dueOn: string | null;
  requesterSlackId: string | null; requesterName: string | null;
  backlogIssueKey: string | null; backlogStatus: string | null; backlogUpdatedAt: string | null;
  backlogSnapshot: Record<string, any>; hasUnseenUpdate: boolean;
  matterId: number | null; matterNo: string | null; matterTitle: string | null;
  duplicateOfId: number | null; duplicateOfNo: string | null;
  reason: string | null; holdUntil: string | null; handledAt: string | null; handledBy: string | null;
  createdAt: string;
}
interface Detail {
  request: Request;
  matterCandidates: Array<{ id: number; matterNo: string | null; title: string; status: string; why: string }>;
  duplicateCandidates: Array<{ id: number; requestNo: string | null; title: string; state: string; why: string }>;
}
interface Counts { new: number; onHold: number; updated: number; holdDue: number }
interface Staff { id: number; name: string; status?: string }
interface MatterHit { id: number; matterNo: string | null; title: string; status: string }

const when = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ").replace("-", "/") : "—");

export function IntakeWorkspace(
  { onOpenMatter, onCountsChange }: {
    onOpenMatter?: (matterId: number) => void;
    /** 左の桁の件数を合わせる。 */
    onCountsChange?: (counts: Counts) => void;
  }
) {
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<Tab>("new");
  const [items, setItems] = useState<Request[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selected, setSelected] = useState<number | undefined>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [version, setVersion] = useState(0);
  const [pulling, setPulling] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  /** 直前に受け付けた先。知らせの横から案件を開けるようにする。 */
  const [lastMatter, setLastMatter] = useState<number | null>(null);

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
    setLastMatter(null);
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
    ["updated", "更新あり", counts?.updated], ["all", "すべて", undefined]
  ];

  return (
    <div className={`workspace${selected !== undefined ? " picked" : ""}`}>
      <header className="workspace-head">
        <h1>受付箱</h1>
        <p>
          Slack の依頼は送信と同時に、Backlog の課題は取得でここに入ります。届いただけでは案件にしません。
          受け付けると案件の工程の先頭「受付」に繋がり、依頼者に Slack で知らせます。Backlog は読むだけです。
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
                <tr><th>依頼</th><th>件名</th><th>経路</th><th>種類</th><th>{tab === "all" ? "状態" : "届いた日"}</th></tr>
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
                      {r.hasUnseenUpdate && <span className="tag warn">Backlog 更新あり</span>}
                    </td>
                    <td className="faint">{SOURCE_LABEL[r.source] ?? r.source}</td>
                    <td className="faint">{r.kind ? KIND_LABEL[r.kind] : "推定なし"}</td>
                    <td className="faint">
                      {tab === "all" ? STATE_LABEL[r.state] ?? r.state
                        : tab === "on_hold" ? `再確認 ${r.holdUntil ?? "—"}` : when(r.createdAt)}
                    </td>
                  </tr>
                ))}
                {items && !items.length && (
                  <tr><td colSpan={5} className="faint">
                    {tab === "new" ? "未処理の依頼はありません。" : tab === "on_hold" ? "保留中の依頼はありません。"
                      : tab === "updated" ? "受付後に Backlog で更新された依頼はありません。" : "依頼はありません。"}
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
                <Decision detail={detail} canWrite={canWrite} staff={staff}
                          onDone={(msg, matterId) => { reload(msg); if (matterId) setLastMatter(matterId); }}
                          onOpenMatter={onOpenMatter} onError={setError} />
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
        <span className="tag">{STATE_LABEL[r.state] ?? r.state}</span>
        <span className="faint">{SOURCE_LABEL[r.source] ?? r.source}</span>
        {r.backlogIssueKey && <span className="faint code">{r.backlogIssueKey}</span>}
        {r.backlogStatus && <span className="tag ghost" title="Backlog のステータスは起案時のまま置き、更新しません">
          Backlog：{r.backlogStatus}</span>}
        <span className="faint" style={{ marginLeft: "auto" }}>原票（読み取り専用）</span>
      </div>
      <div className="panel-bd stack">
        <div><b>{r.title}</b></div>
        <div className="form-grid">
          <div className="field"><span>依頼者</span><div>{r.requesterName ?? "—"}{r.requesterSlackId ? `（Slack ${r.requesterSlackId}）` : ""}</div></div>
          <div className="field"><span>相手先の記載</span><div>{r.counterpartyName ?? "—"}</div></div>
          <div className="field"><span>希望の期日</span><div>{r.dueOn ?? "—"}</div></div>
          <div className="field"><span>届いた日時</span><div>{when(r.createdAt)}</div></div>
          {fields.filter((f) => f.value && !["取引先名称", "希望納期"].includes(f.name)).map((f) => (
            <div key={f.name} className="field"><span>{f.name}</span><div>{f.value}</div></div>
          ))}
        </div>
        {r.detail && <pre className="locked" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.detail}</pre>}
        {r.state === "on_hold" && r.reason && (
          <div className="note warn">保留：{r.reason}{r.holdUntil ? `（再確認 ${r.holdUntil}）` : ""}</div>
        )}
        {r.state === "dismissed" && <div className="note">対象外：{r.reason}</div>}
        {r.state === "duplicate" && <div className="note">{r.duplicateOfNo ?? `#${r.duplicateOfId}`} の重複</div>}
      </div>
    </div>
  );
}

/** 判断。未処理・保留なら受付のフォーム、処理済みならその結果と戻し方。 */
function Decision(
  { detail, canWrite, staff, onDone, onOpenMatter, onError }: {
    detail: Detail; canWrite: boolean; staff: Staff[];
    onDone: (message: string, matterId?: number) => void;
    onOpenMatter?: (matterId: number) => void;
    onError: (message: string) => void;
  }
) {
  const r = detail.request;
  const open = r.state === "new" || r.state === "on_hold";
  const [kind, setKind] = useState<Kind | "">(r.kind ?? "");
  const [title, setTitle] = useState(r.title);
  const [owner, setOwner] = useState<number | "">("");
  const [dueOn, setDueOn] = useState(r.dueOn ?? "");
  const firstCandidate = detail.matterCandidates[0]?.id;
  const [dest, setDest] = useState<string>(firstCandidate && r.kind !== null ? String(firstCandidate) : "new");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<MatterHit[]>([]);
  const [picked, setPicked] = useState<MatterHit | null>(null);
  const [side, setSide] = useState<"" | "hold" | "dismiss" | "duplicate">("");
  const [holdReason, setHoldReason] = useState(r.reason ?? "");
  const [holdUntil, setHoldUntil] = useState(r.holdUntil ?? "");
  const [dismissReason, setDismissReason] = useState(/テスト/.test(r.title) ? "テスト投稿" : "誤起票");
  const [dupOf, setDupOf] = useState<number | "">(detail.duplicateCandidates[0]?.id ?? "");
  const [dupNo, setDupNo] = useState("");
  /** 依頼番号（REQ-…）から重複元を引く。候補に無い依頼を指すとき用。 */
  const findByNo = async () => {
    try {
      const all = await api.get<{ items: Request[] }>("/intake?state=all");
      const hit = all.items.find((x) => x.requestNo === dupNo.trim().toUpperCase() && x.id !== r.id);
      if (hit) setDupOf(hit.id); else onError(`${dupNo} という依頼は見つかりません`);
    } catch (e) { onError((e as ApiError).message); }
  };
  const [busy, setBusy] = useState(false);

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
      onDone(message(x), x?.matterId);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  };

  const matterId = dest === "new" ? null : dest === "pick" ? picked?.id ?? null : Number(dest);
  const acceptable = Boolean(kind) && (dest === "new" || matterId);
  const notified = (x: any) => (x?.notified ? "。依頼者に Slack で知らせました" : "");

  if (!open) {
    return (
      <div className="panel">
        <div className="panel-bd stack">
          {r.matterId && (
            <div className="row" style={{ gap: 8 }}>
              <span>接続先：</span>
              {onOpenMatter
                ? <button className="linky" onClick={() => onOpenMatter(r.matterId!)}>{r.matterNo ?? `#${r.matterId}`} {r.matterTitle}</button>
                : <span>{r.matterNo ?? `#${r.matterId}`} {r.matterTitle}</span>}
            </div>
          )}
          {r.hasUnseenUpdate && (
            <div className="note warn">
              受け付けたあとに Backlog が更新されました（{r.backlogStatus ?? "—"}・{when(r.backlogUpdatedAt)}）。
              案件は自動では動きません。内容を確かめて、必要なら案件側で対応してください。
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
      <div className="panel-hd"><h2>受付</h2></div>
      <div className="panel-bd stack">
        {detail.duplicateCandidates.length > 0 && (
          <div className="note warn">
            重複の可能性：{detail.duplicateCandidates.map((d) =>
              `${d.requestNo ?? `#${d.id}`} ${d.title}（${d.why}）`).join(" ／ ")}
          </div>
        )}
        {!canWrite && <div className="faint">受け付けられるのは管理者・法務だけです。</div>}
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
        </div>
        <div className="faint">相手先は取引先マスタで1件に決まれば紐づけます。決まらなければ記載を案件の備考に残し、要確認に積みます。</div>

        <div className="stack" style={{ gap: 6 }}>
          <b>接続先</b>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name={`dest${r.id}`} checked={dest === "new"} disabled={!canWrite} onChange={() => setDest("new")} />
            新規案件で受付
          </label>
          {detail.matterCandidates.map((c) => (
            <label key={c.id} className="row" style={{ gap: 6 }}>
              <input type="radio" name={`dest${r.id}`} checked={dest === String(c.id)} disabled={!canWrite}
                     onChange={() => setDest(String(c.id))} />
              <span>{c.matterNo ?? `#${c.id}`} {c.title} <span className="faint">（{c.why}）</span></span>
            </label>
          ))}
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name={`dest${r.id}`} checked={dest === "pick"} disabled={!canWrite} onChange={() => setDest("pick")} />
            他の案件を選ぶ
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

        {canWrite && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "dismiss" ? "" : "dismiss")}>対象外…</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "hold" ? "" : "hold")}>保留…</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setSide(side === "duplicate" ? "" : "duplicate")}>重複…</button>
            <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} disabled={busy || !acceptable}
                    onClick={() => run("accept", {
                      mode: dest === "new" ? "new" : "existing", matterId, kind,
                      title, ownerStaffId: owner || null, dueOn: dueOn || null
                    }, (x) => `${r.requestNo ?? ""} を受け付け、${x.matterNo ?? `#${x.matterId}`} の「受付」に繋ぎました${notified(x)}`)}>
              受け付けて案件に繋ぐ
            </button>
          </div>
        )}

        {side === "hold" && (
          <div className="note stack">
            <label className="field"><span>確認したいこと</span>
              <textarea rows={2} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} /></label>
            <label className="field"><span>再確認日</span>
              <input type="date" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} /></label>
            <div className="faint">依頼者に Slack で確認を送ります。返信はその DM で受けます。</div>
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
