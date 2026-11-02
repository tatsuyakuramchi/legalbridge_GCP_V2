import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { SettlementTag, StatusTag } from "./labels.js";
import { conditionAmountLabel } from "./ConditionLabel.js";
import { GridRowEdit, type EditFocus } from "./GridRowEdit.js";
import { EventEntryForm } from "./EventEntryForm.js";
import {
  applyFilter, groupByParty, groupByWork, isStuck, unpaidPayments,
  type GridRound, type GridRow
} from "../server/matters/grid.js";
import { driftOf, driftSummary } from "../server/matters/drift.js";
import type { DuplicateGroup, DuplicateView } from "../server/conditions/duplicates.js";

/**
 * 作品別の条件一覧（案件の「条件ごと」）。
 *
 * 1行＝条件1本に 条件・実績・発注書・検収書（利用許諾計算書）・支払 を並べる。
 * 左で作品を選ぶと、その作品の条件だけになる（作品が混じる案件で条件を選びやすく）。
 *
 * セルを押すと、その段を前に出した「まとめて直す」をポップアップで開く（GridRowEdit。
 * 左に直す値、右に段ごとの前→後の試算）。画面を移らずに、そこで直して閉じる。
 * 実績を入れる（EventEntryForm）・支払を立てる（決定済みの検収書・計算書から）もポップアップで。
 *
 * 複数回の条件は、実績・検収書・支払のセルに回ごとの行を出す（row.rounds）。
 *
 * 前の画面で分かれていたもの（工程表・条件明細・実績・支払のタブ）は、ここに1行で出す。
 * 取引先名・番号・金額は行に1回だけ。同じ内容で重複している条件明細は印を付け、
 * その場で無効にできる（どれを残すかは人が決める。最初から選んでおかない）。
 */

type Filter = "all" | "stuck" | "unpaid" | "drift" | "dup" | "settled";
const FILTER_LABEL: Record<Filter, string> = {
  all: "すべて", stuck: "止まっている", unpaid: "未払い", drift: "金額・日付が食い違い", dup: "重複", settled: "払い切り"
};
const SETTLE_KEYS = new Set(["inspection_certificate", "intl_inspection_certificate", "service_completion_notice"]);
const yen = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `¥${Math.round(n).toLocaleString("ja-JP")}`);
const qty = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("ja-JP"));
const PAY_LABEL: Record<string, string> = { planned: "予定", approved: "承認済み", paid: "支払済み" };

const total = (r: GridRow): number | null =>
  r.pricingModel === "unit_rate" && r.unitAmount !== null && r.quantity != null ? Math.round(r.unitAmount * r.quantity) : r.flatAmount;
const isLicense = (r: GridRow) => r.kind === "license" || r.pricingModel === "rate";
/** 実績のある回（回の情報が無ければ、行の実績を1回として）。 */
const doneRounds = (r: GridRow): GridRound[] => (r.rounds ?? []).filter((x) => x.eventId !== null);

/** ネイティブの dialog。Esc と外側の押下で閉じる。 */
function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className={`lb-modal${wide ? " wide" : ""}`} onCancel={(e) => { e.preventDefault(); onClose(); }}
            onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="lb-modal-hd">
        <b>{title}</b>
        <button className="btn btn-sm" onClick={onClose} aria-label="閉じる">閉じる</button>
      </div>
      <div className="lb-modal-bd">{children}</div>
    </dialog>
  );
}

function DocLine({ doc, onOpen }: { doc: { id: number; documentNo: string | null; phase: string }; onOpen?: (id: number) => void }) {
  return (
    <div className="ledger-line">
      {onOpen
        ? <button className="linky code" onClick={(e) => { e.stopPropagation(); onOpen(doc.id); }}>{doc.documentNo ?? `#${doc.id}`}</button>
        : <span className="code">{doc.documentNo ?? `#${doc.id}`}</span>}
      <StatusTag kind="document" value={doc.phase} />
    </div>
  );
}

export function WorkLedger(
  { matterId, partyId, reloadKey, onOpenCondition, onOpenDocument, onCompose, onOpenDeals, onFixDrift, onChanged }: {
    matterId: number;
    partyId?: number | null;
    reloadKey?: number;
    onOpenCondition?: (conditionId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null, templateKey?: string | null) => void;
    onOpenDeals?: (conditionId: number) => void;
    onFixDrift?: () => void;
    onChanged?: () => void;
  }
) {
  const [all, setAll] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [version, setVersion] = useState(0);
  const [work, setWork] = useState<string>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [byParty, setByParty] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ conditionId: number; focus: EditFocus } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dups, setDups] = useState<DuplicateView | null>(null);
  const [dupOpen, setDupOpen] = useState<DuplicateGroup | null>(null);
  const [bulk, setBulk] = useState<"docs" | "cancel" | "due" | null>(null);
  /** 実績を入れる（条件と、次の回）／支払を立てる（条件）。 */
  /**
   * 実績を入れる：queue は続けて入れる条件（押した行から、表示順で実績を入れられる行）。
   * 1件入れたら閉じずに次の条件へ進む（画面が毎回切り替わると、どこまで入れたか分からなくなる）。
   */
  const [adding, setAdding] = useState<{ kind: "event"; queue: number[]; index: number; done: string[] } | { kind: "payment"; conditionId: number } | null>(null);

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => setIsAdmin(false));
  }, []);
  useEffect(() => {
    setError(null);
    api.get<{ rows: GridRow[] }>(`/matters/${matterId}/grid`)
      .then((r) => setAll(r.rows)).catch((e: ApiError) => { setError(e.message); setAll([]); });
    // 重複は法務・管理者だけが引ける。引けなければ印を出さないだけ。
    api.get<DuplicateView>(`/matters/${matterId}/duplicate-conditions`).then(setDups).catch(() => setDups(null));
  }, [matterId, reloadKey, version]);

  const reload = (message?: string) => { if (message) setNotice(message); setVersion((x) => x + 1); onChanged?.(); };

  const dupOf = useMemo(() => {
    const m = new Map<number, DuplicateGroup>();
    for (const g of dups?.groups ?? []) for (const x of g.members) m.set(x.id, g);
    return m;
  }, [dups]);

  const mine = useMemo(() => (all ?? []).filter((r) => !partyId || r.counterparty?.id === partyId), [all, partyId]);
  const works = useMemo(() => groupByWork(mine), [mine]);
  const inWork = useMemo(() => mine.filter((r) => work === "all" || String(r.workId ?? "none") === work), [mine, work]);
  const rows = useMemo(() => {
    switch (filter) {
      case "all": return inWork;
      case "stuck": return inWork.filter(isStuck);
      case "unpaid": return inWork.filter((r) => unpaidPayments(r).length > 0);
      case "drift": return applyFilter(inWork, "drift");
      case "settled": return applyFilter(inWork, "settled");
      case "dup": return inWork.filter((r) => dupOf.has(r.conditionId));
    }
  }, [inWork, filter, dupOf]);
  const counts = useMemo(() => ({
    all: inWork.length, stuck: inWork.filter(isStuck).length,
    unpaid: inWork.filter((r) => unpaidPayments(r).length > 0).length,
    drift: applyFilter(inWork, "drift").length, settled: applyFilter(inWork, "settled").length,
    dup: inWork.filter((r) => dupOf.has(r.conditionId)).length
  }), [inWork, dupOf]);

  useEffect(() => {
    setPicked((prev) => new Set([...prev].filter((id) => rows.some((r) => r.conditionId === id))));
  }, [rows]);

  if (error) return <div className="alert">{error}</div>;
  if (!all) return <div className="faint">読み込んでいます…</div>;
  if (!all.length) return <div className="faint">この案件には条件明細がありません。一覧の「条件明細」で作るか、すでにある条件を繋いでください。</div>;

  const pickedRows = rows.filter((r) => picked.has(r.conditionId));
  const editRow = editing ? all.find((r) => r.conditionId === editing.conditionId) ?? null : null;

  /** セルを押したとき。管理者はその段を前に出した「まとめて直す」を開く。ほかの人は既存の画面へ。 */
  const press = (r: GridRow, focus: EditFocus) => {
    if (isAdmin) { setNotice(null); setEditing({ conditionId: r.conditionId, focus }); return; }
    if (focus === "condition") onOpenCondition?.(r.conditionId);
    else onOpenDeals?.(r.conditionId);
  };
  const cell = (r: GridRow, focus: EditFocus, body: ReactNode, title: string) => (
    <td className="ledger-cell" onClick={() => press(r, focus)} title={isAdmin ? `${title}を直す（ポップアップ）` : title}
        onKeyDown={(e) => { if (e.key === "Enter") press(r, focus); }} tabIndex={0}>
      {body}
    </td>
  );

  const condCell = (r: GridRow) => {
    const drift = driftOf(r);
    const dup = dupOf.get(r.conditionId);
    return (
      <>
        <div className="ledger-name">{r.name}</div>
        <div className="faint code">{r.conditionNo ?? `#${r.conditionId}`}</div>
        <div className="ledger-num">
          {r.pricingModel === "unit_rate" && r.unitAmount !== null && r.quantity != null
            ? <>{yen(total(r))}<span className="faint">（{yen(r.unitAmount)} × {qty(r.quantity)}{r.unitLabel ?? ""}）</span></>
            : conditionAmountLabel(r)}
        </div>
        <div className="ledger-tags">
          <StatusTag kind="condition" value={r.status} /> <SettlementTag settlement={r.settlement} compact />
          {r.schedules.total > 1 && <span className="tag">{r.schedules.done}/{r.schedules.total} 回</span>}
          {drift && drift.flagged.length > 0 && <span className="tag out" title="発注書・検収書・支払のどれかが、いまの条件・予定・実績と違う値です">{driftSummary(drift.flagged)}が食い違い</span>}
          {dup && (
            <button className="tag warn linky" onClick={(e) => { e.stopPropagation(); setDupOpen(dup); }}
                    title="相手先・作品・種別・金額・期間・名前が同じ条件明細があります">
              重複 {dup.members.length} 本{dup.keepId === r.conditionId ? "（残す案）" : ""}
            </button>
          )}
        </div>
      </>
    );
  };

  const eventCell = (r: GridRow) => {
    const rs = doneRounds(r);
    const unit = isLicense(r) ? "部" : r.unitLabel ?? "";
    if (rs.length > 1) {
      return rs.map((x) => (
        <div key={x.eventId} className="ledger-line">
          <span className="ledger-seq">{x.seq ? `第${x.seq}回` : "—"}</span>
          <span className="ledger-num">{x.quantity !== null ? `${qty(x.quantity)}${unit} ` : ""}{yen(x.amount)}</span>
          <span className="faint">{x.occurredOn ?? ""}</span>
        </div>
      )).concat(...pendingRounds(r)) as ReactNode;
    }
    if (!r.events.count) return <><span className="faint">まだ</span>{pendingRounds(r)}</>;
    return (
      <>
        <div className="ledger-num">{r.events.quantity != null ? `${qty(r.events.quantity)}${unit}　` : ""}{yen(r.events.amount ?? null)}</div>
        <div className="faint">{r.events.count > 1 ? `${r.events.count} 件・` : ""}{r.events.latestOn ?? ""}</div>
        {pendingRounds(r)}
      </>
    );
  };
  const canWrite = isAdmin || Boolean(onOpenDeals);
  /** 実績を入れられる行（払い切りでない）。 */
  const takesEvent = (r: GridRow) => !r.settlement.done;
  /** その行の次の回（予定があってまだ実績の無い回）。 */
  const nextSchedule = (r: GridRow) => (r.rounds ?? []).find((x) => x.eventId === null) ?? null;
  /** 押した行から順に、続けて入れる列を組む。 */
  const startEvents = (from: GridRow | null, only?: GridRow[]) => {
    const base = (only ?? rows).filter(takesEvent);
    const i = from ? base.findIndex((r) => r.conditionId === from.conditionId) : 0;
    const queue = (i >= 0 ? base.slice(i) : [from!, ...base]).map((r) => r.conditionId);
    setNotice(null);
    setAdding({ kind: "event", queue, index: 0, done: [] });
  };
  const pendingRounds = (r: GridRow) => {
    const left = (r.rounds ?? []).filter((x) => x.eventId === null);
    const out: ReactElement[] = [];
    if (left.length) out.push(<div key="left" className="faint">あと {left.length} 回（{left.map((x) => x.seq ? `第${x.seq}回` : "").filter(Boolean).join("・")}）</div>);
    // 払い切った条件には足さない。次の回（予定があればその回）に入れる。
    if (canWrite && !r.settlement.done) {
      out.push(<button key="add" className="btn btn-sm ledger-add" onClick={(e) => { e.stopPropagation(); startEvents(r); }}>
        ＋ 実績を入れる{left[0]?.seq ? `（第${left[0].seq}回）` : ""}</button>);
    }
    return out;
  };
  /** 支払を立てられる文書（決定済みの検収書・計算書で、まだ支払の無いもの）。 */
  const payableDocs = (r: GridRow) => {
    const rs = doneRounds(r);
    const seen = new Map<number, { id: number; documentNo: string | null; seq: number | null }>();
    for (const x of rs) if (x.doc && x.doc.status === "issued" && !x.payment && !seen.has(x.doc.id)) seen.set(x.doc.id, { id: x.doc.id, documentNo: x.doc.documentNo, seq: x.seq });
    if (!rs.length && r.settlementDoc && r.settlementDoc.phase !== "draft" && !r.payment) seen.set(r.settlementDoc.id, { id: r.settlementDoc.id, documentNo: r.settlementDoc.documentNo, seq: null });
    return [...seen.values()];
  };
  const addPayButton = (r: GridRow) => {
    const docs = payableDocs(r);
    if (!canWrite || !docs.length || r.settlement.done) return null;
    return <button className="btn btn-sm ledger-add" onClick={(e) => { e.stopPropagation(); setNotice(null); setAdding({ kind: "payment", conditionId: r.conditionId }); }}>＋ 支払を立てる{docs.length > 1 ? `（${docs.length} 枚）` : ""}</button>;
  };

  const settleCell = (r: GridRow) => {
    const rs = doneRounds(r);
    if (rs.length > 1) {
      return rs.map((x) => (
        <div key={x.eventId} className="ledger-line">
          <span className="ledger-seq">{x.seq ? `第${x.seq}回` : "—"}</span>
          {x.doc ? <DocLine doc={x.doc} onOpen={onOpenDocument} /> : <span className="faint">まだ</span>}
        </div>
      ));
    }
    if (r.settlementDoc) return <DocLine doc={r.settlementDoc} onOpen={onOpenDocument} />;
    return r.events.count
      ? <span className="faint">まだ{isLicense(r) ? "（計算書）" : ""}</span>
      : <span className="faint">—</span>;
  };

  const payCell = (r: GridRow) => {
    const rs = doneRounds(r);
    const line = (p: NonNullable<GridRound["payment"]>) => (
      <>
        <span className="code">{p.paymentNo ?? `#${p.id}`}</span>
        <span className={`tag ${p.status === "paid" ? "ok" : ""}`}>{PAY_LABEL[p.status] ?? p.status}</span>
        <span className="faint">{p.status === "paid" ? p.paidOn ?? "" : p.dueOn ? `期日 ${p.dueOn}` : ""}</span>
      </>
    );
    if (rs.length > 1) {
      return <>{rs.map((x) => (
        <div key={x.eventId} className="ledger-line">
          <span className="ledger-seq">{x.seq ? `第${x.seq}回` : "—"}</span>
          {x.payment ? line(x.payment) : <span className="faint">まだ</span>}
        </div>
      ))}{addPayButton(r)}</>;
    }
    if (r.payment) return <div className="ledger-line">{line({ ...r.payment, amount: r.payment.amount ?? 0 })}</div>;
    return <><span className="faint">{r.settlementDoc ? "まだ" : "—"}</span>{addPayButton(r)}</>;
  };

  const head = (
    <tr>
      <th style={{ width: 28 }}>
        <input type="checkbox" aria-label="表示している条件をすべて選ぶ"
               checked={rows.length > 0 && rows.every((r) => picked.has(r.conditionId))}
               onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.conditionId)) : new Set())} />
      </th>
      {!byParty && <th className="stage-hd">取引先</th>}
      <th className="stage-hd">条件<span className="stage-sub">番号・金額</span></th>
      <th className="stage-hd">実績<span className="stage-sub">納品・検収／報告部数</span></th>
      <th className="stage-hd">発注書<span className="stage-sub">条件の文書</span></th>
      <th className="stage-hd">検収書・計算書<span className="stage-sub">回ごと</span></th>
      <th className="stage-hd">支払<span className="stage-sub">回ごと</span></th>
    </tr>
  );
  const cols = byParty ? 6 : 7;
  const rowOf = (r: GridRow) => (
    <tr key={r.conditionId} className={`${picked.has(r.conditionId) ? "sel" : ""}${editing?.conditionId === r.conditionId ? " ledger-editing" : ""}`}>
      <td><input type="checkbox" checked={picked.has(r.conditionId)} aria-label={`${r.conditionNo ?? r.conditionId} を選ぶ`}
                 onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r.conditionId); else n.delete(r.conditionId); return n; })} /></td>
      {!byParty && (
        <td>{r.counterparty ? <b>{r.counterparty.name}</b> : <span className="faint">（相手先なし）</span>}
          <div className="faint" style={{ fontSize: 11.5 }}>{isLicense(r) ? "利用許諾" : "業務委託"}</div></td>
      )}
      {cell(r, "condition", condCell(r), "条件")}
      {cell(r, "event", eventCell(r), "実績")}
      {cell(r, "order", isLicense(r) ? <span className="faint">—</span>
        : r.order ? <DocLine doc={r.order} onOpen={onOpenDocument} />
        : r.orderRef ? <span className="faint code">{r.orderRef}（外部）</span>
        : <span className="faint">まだ</span>, "発注書")}
      {cell(r, "settlement", settleCell(r), "検収書・計算書")}
      {cell(r, "payment", payCell(r), "支払")}
    </tr>
  );

  const groupHead = (key: string, title: string, sub: string) => (
    <tr key={`g${key}`} className="grid-grp"><td colSpan={cols}><b>{title}</b><span className="faint">　{sub}</span></td></tr>
  );
  const body = byParty
    ? groupByParty(rows).flatMap((g) => [groupHead(`p${g.id}`, g.name, `条件 ${g.tally.conditions} 本`), ...g.rows.map(rowOf)])
    : groupByWork(rows).flatMap((g) => [groupHead(`w${g.id}`, g.title,
        `条件 ${g.tally.conditions} 本${g.tally.amount ? `・${yen(g.tally.amount)}` : ""}${g.tally.stuck ? `・止まり ${g.tally.stuck}` : ""}${g.tally.unpaid ? `・未払い ${g.tally.unpaid}` : ""}`),
        ...g.rows.map(rowOf)]);

  return (
    <div className="ledger">
      <nav className="ledger-works" aria-label="作品">
        <div className="faint ledger-works-hd">作品で選ぶ</div>
        {[{ key: "all", title: "すべての作品", tally: groupByWork(mine).reduce((t, g) => ({ conditions: t.conditions + g.tally.conditions, stuck: t.stuck + g.tally.stuck, unpaid: t.unpaid + g.tally.unpaid }), { conditions: 0, stuck: 0, unpaid: 0 }) },
          ...works.map((g) => ({ key: String(g.id ?? "none"), title: g.title, tally: g.tally }))].map((w) => (
          <button key={w.key} className="ledger-work" aria-pressed={work === w.key} onClick={() => setWork(w.key)}>
            <span className="t">{w.title}</span><span className="n">{w.tally.conditions}</span>
            <span className="s">
              {w.tally.stuck ? <span><i className="dot stop" />止まり {w.tally.stuck}</span> : <span><i className="dot ok" />流れている</span>}
              {w.tally.unpaid > 0 && <span><i className="dot chg" />未払い {w.tally.unpaid}</span>}
            </span>
          </button>
        ))}
      </nav>

      <div className="stack" style={{ gap: 10, minWidth: 0 }}>
        <div className="stagefilter">
          <span className="faint">絞る</span>
          {(Object.keys(FILTER_LABEL) as Filter[]).filter((f) => f !== "dup" || counts.dup > 0).map((f) => (
            <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{FILTER_LABEL[f]} {counts[f]}</button>
          ))}
          {onFixDrift && counts.drift > 0 && <button className="btn btn-sm" onClick={onFixDrift}>食い違いをまとめて直す画面へ</button>}
          <label className="row" style={{ gap: 5, marginLeft: "auto" }}>
            <input type="checkbox" checked={byParty} onChange={(e) => setByParty(e.target.checked)} />
            <span className="faint">取引先でまとめる</span>
          </label>
        </div>

        {dups && dups.summary.groups > 0 && filter !== "dup" && (
          <div className="note warn row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span>同じ内容の条件明細が <b>{dups.summary.groups} 組（{dups.summary.conditions} 本）</b>あります。行の「重複」を押すと、その場で畳めます。</span>
            <button className="btn btn-sm" onClick={() => setFilter("dup")}>重複だけ出す</button>
          </div>
        )}

        {pickedRows.length > 0 && (
          <div className="bulkbar">
            <b>{pickedRows.length} 本を選んでいます</b>
            {canWrite && <button className="btn btn-sm primary" disabled={!pickedRows.some(takesEvent)} onClick={() => startEvents(null, pickedRows)}>実績を続けて入れる（{pickedRows.filter(takesEvent).length}）</button>}
            {isAdmin || onCompose ? <button className="btn btn-sm" onClick={() => setBulk("docs")}>文書をまとめて作る</button> : null}
            {isAdmin && <button className="btn btn-sm" onClick={() => setBulk("due")}>支払日をそろえる</button>}
            {isAdmin && <button className="btn btn-sm danger" disabled={!pickedRows.some((r) => unpaidPayments(r).length)} onClick={() => setBulk("cancel")}>
              未払いの支払を取り消す（{pickedRows.reduce((n, r) => n + unpaidPayments(r).length, 0)}）</button>}
            <button className="btn btn-sm" onClick={() => setPicked(new Set())}>選び直す</button>
          </div>
        )}

        {notice && <div className="note ok">{notice}</div>}

        <div className="tablewrap grid-wrap">
          <table className="ledger-table">
            <thead>{head}</thead>
            <tbody>
              {body}
              {!rows.length && <tr><td colSpan={cols} className="faint">{FILTER_LABEL[filter]} に当てはまる条件はありません。</td></tr>}
            </tbody>
          </table>
        </div>
        {isAdmin && <p className="faint" style={{ margin: 0 }}>セルを押すと、その段を開いた「まとめて直す」がポップアップで出ます。右に 発注書・条件明細・実績・支払・検収書 の前後（保存前の試算）。</p>}
      </div>

      {editRow && editing && (
        <Modal wide title={<>{editRow.counterparty?.name ?? ""}　{editRow.name}　<span className="faint code">{editRow.conditionNo ?? `#${editRow.conditionId}`}</span></>}
               onClose={() => setEditing(null)}>
          <table className="lb-modal-table"><tbody><tr>
            <GridRowEdit row={editRow} focus={editing.focus} colSpan={1} onOpenDocument={onOpenDocument}
              onCancel={() => setEditing(null)}
              onDone={(message) => { setEditing(null); reload(message); }} />
          </tr></tbody></table>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {onOpenCondition && <button className="linky" onClick={() => onOpenCondition(editRow.conditionId)}>条件明細の画面で開く</button>}
            {onOpenDeals && <button className="linky" onClick={() => { setEditing(null); onOpenDeals(editRow.conditionId); }}>実績を入れる・支払を立てる（取引管理）</button>}
          </div>
        </Modal>
      )}

      {dupOpen && (
        <DuplicateDialog matterId={matterId} group={dupOpen} onOpenCondition={onOpenCondition}
          onClose={() => setDupOpen(null)} onDone={(m) => { setDupOpen(null); reload(m); }} />
      )}
      {adding?.kind === "event" && (() => {
        const id = adding.queue[adding.index];
        const r = all.find((x) => x.conditionId === id);
        const total = adding.queue.length, k = adding.index + 1;
        const finish = (extra?: string) => {
          const done = [...adding.done, ...(extra ? [extra] : [])];
          setAdding(null);
          if (done.length) reload(`実績を入れました：${done.join("・")}`);
        };
        const advance = (entered: boolean) => {
          const label = r?.conditionNo ?? `#${id}`;
          const done = entered ? [...adding.done, label] : adding.done;
          // 表は裏で読み直す（ポップアップは閉じない）。
          if (entered) { setVersion((x) => x + 1); onChanged?.(); }
          if (adding.index + 1 >= total) { setAdding(null); if (done.length) setNotice(`実績を入れました：${done.join("・")}`); return; }
          setAdding({ ...adding, index: adding.index + 1, done });
        };
        if (!r) return null;
        const next = adding.queue[adding.index + 1];
        const nextRow = next !== undefined ? all.find((x) => x.conditionId === next) : null;
        return (
          <Modal wide title={<>{r.counterparty?.name ?? ""}　{r.name}　<span className="faint">実績を入れる</span></>} onClose={() => finish()}>
            {total > 1 && (
              <div className="row ledger-queue" style={{ gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <b>{k} / {total} 件目</b>
                <span className="faint">入れると閉じずに次へ進みます{nextRow ? `。次：${nextRow.counterparty?.name ?? ""} ${nextRow.name}` : "（これが最後）"}</span>
                {adding.done.length > 0 && <span className="tag ok">入れた {adding.done.length}</span>}
                <span style={{ marginLeft: "auto" }} className="row">
                  {nextRow && <button className="btn btn-sm" onClick={() => advance(false)}>この条件は飛ばす</button>}
                  <button className="btn btn-sm" onClick={() => finish()}>ここで終わる</button>
                </span>
              </div>
            )}
            <EventEntryForm key={r.conditionId} conditionId={r.conditionId} scheduleId={nextSchedule(r)?.scheduleId ?? null} matterId={matterId}
              title={r.conditionNo ?? undefined}
              onDone={() => advance(true)}
              onCancel={() => (total > 1 && nextRow ? advance(false) : finish())} />
          </Modal>
        );
      })()}
      {adding?.kind === "payment" && (() => {
        const r = all.find((x) => x.conditionId === adding.conditionId);
        return r ? <PaymentDialog row={r} docs={payableDocs(r)} onClose={() => setAdding(null)} onDone={(m) => { setAdding(null); reload(m); }} /> : null;
      })()}
      {bulk === "docs" && (
        <BulkDocsDialog matterId={matterId} rows={pickedRows} onCompose={onCompose} onOpenDocument={onOpenDocument}
          onClose={() => setBulk(null)} onDone={(m) => reload(m)} />
      )}
      {bulk === "cancel" && (
        <BulkCancelDialog rows={pickedRows} onClose={() => setBulk(null)} onDone={(m) => { setBulk(null); reload(m); }} />
      )}
      {bulk === "due" && (
        <BulkDueDialog rows={pickedRows} onClose={() => setBulk(null)} onDone={(m) => { setBulk(null); reload(m); }} />
      )}
    </div>
  );
}

/** 決定済みの検収書・計算書から支払を立てる（文書1枚につき1件。POST /documents/:id/payment）。 */
function PaymentDialog({ row, docs, onClose, onDone }: {
  row: GridRow; docs: Array<{ id: number; documentNo: string | null; seq: number | null }>;
  onClose: () => void; onDone: (m: string) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set(docs.map((d) => d.id)));
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    const made: string[] = []; const bad: string[] = [];
    for (const d of docs.filter((x) => picked.has(x.id))) {
      try {
        const r = await api.post<{ paymentNo?: string | null; id?: number; paymentId?: number }>(`/documents/${d.id}/payment`, { dueOn: dueOn || null });
        made.push(r.paymentNo ?? `#${r.paymentId ?? r.id ?? ""}`);
      } catch (e) { bad.push(`${d.documentNo ?? `#${d.id}`}：${(e as ApiError).message}`); }
    }
    setBusy(false);
    if (bad.length) { setError(bad.join("／")); if (!made.length) return; }
    onDone(`支払 ${made.join("・")} を立てました${bad.length ? `（${bad.length} 枚は立てられませんでした）` : ""}`);
  }
  return (
    <Modal title={<>{row.counterparty?.name ?? ""}　{row.name}　<span className="faint">支払を立てる</span></>} onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        <p className="faint" style={{ margin: 0 }}>支払は決定済みの検収書・計算書から、文書1枚につき1件立ちます。金額は文書の額です。</p>
        {docs.map((d) => (
          <label key={d.id} className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={picked.has(d.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />
            <span>{d.seq ? `第${d.seq}回　` : ""}<span className="code">{d.documentNo ?? `#${d.id}`}</span></span>
          </label>
        ))}
        <label className="field"><span>支払日（空なら条件・予定の支払日）</span><input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy || !picked.size} onClick={() => void run()}>{busy ? "立てています…" : `${picked.size} 件を立てる`}</button>
          <button className="btn" onClick={onClose}>やめる</button>
        </div>
      </div>
    </Modal>
  );
}

/** 重複の1組。どれを無効にするかは人が選ぶ（最初から選んでおかない）。 */
function DuplicateDialog({ matterId, group, onClose, onDone, onOpenCondition }: {
  matterId: number; group: DuplicateGroup; onClose: () => void; onDone: (message: string) => void;
  onOpenCondition?: (id: number) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("同じ内容の重複登録のため");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ ok: number; failed: number; outcomes: Array<{ conditionNo: string | null; ok: boolean; error: string | null }> }>(
        `/matters/${matterId}/duplicate-conditions/void`, { conditionIds: [...picked], reason: reason.trim() });
      const bad = r.outcomes.filter((o) => !o.ok);
      if (bad.length) { setError(bad.map((o) => `${o.conditionNo ?? ""}：${o.error}`).join("／")); return; }
      onDone(`重複の条件明細を ${r.ok} 本無効にしました`);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`重複：${group.partyName ?? "—"}／${group.name}`} onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        <p className="faint" style={{ margin: 0 }}>相手先・作品・種別・計算方式・金額・期間・名前が全部同じものです。{group.note}</p>
        <table>
          <thead><tr><th></th><th>条件</th><th>抱えているもの</th></tr></thead>
          <tbody>
            {group.members.map((m) => (
              <tr key={m.id}>
                <td>{!m.blocked && <input type="checkbox" checked={picked.has(m.id)} aria-label={`${m.conditionNo ?? m.id} を無効にする`}
                       onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} />}</td>
                <td><button className="linky code" onClick={() => onOpenCondition?.(m.id)}>{m.conditionNo ?? `#${m.id}`}</button>
                  {m.id === group.keepId && <span className="tag ok" style={{ marginLeft: 6 }}>残す案</span>}
                  <div className="faint">{m.createdAt?.slice(0, 10) ?? ""}</div></td>
                <td>{m.blocked ? <span className="danger">{m.blocked}</span>
                  : <span className="faint">実績 {m.carries.events}・文書 {m.carries.documents}・支払 {m.carries.payments}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field"><span>無効にする理由（監査に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn danger" disabled={busy || !picked.size || !reason.trim()} onClick={() => void run()}>
            {busy ? "無効にしています…" : `選んだ ${picked.size} 本を無効にする`}</button>
          <button className="btn" onClick={onClose}>やめる</button>
        </div>
      </div>
    </Modal>
  );
}

type Split = "one" | "party" | "each";
interface Plan { key: string; partyName: string; rows: GridRow[]; eventIds: number[]; skipped: string[] }

/**
 * 選んだ条件から文書をまとめて作る（下書きまで）。
 *   1枚にまとめる …… 選んだ条件を1枚に（取引先が1社のときだけ。文書の宛先は1社）
 *   取引先ごとに1枚 …… 複数人に出す。社ごとに1枚ずつ
 *   条件ごとに1枚 …… 1本ずつ
 * 検収書のひな形なら、まだ検収書に載っていない実績を回ごとに拾って載せる。
 */
export function planDocs(rows: GridRow[], split: Split, settle: boolean): Plan[] {
  const unbilled = (r: GridRow) => {
    const rounds = (r.rounds ?? []).filter((x) => x.eventId !== null && !x.doc).map((x) => x.eventId!);
    if (rounds.length || (r.rounds ?? []).some((x) => x.eventId !== null)) return rounds;
    return !r.settlementDoc && r.events.latestId ? [r.events.latestId] : [];
  };
  const groups = new Map<string, Plan>();
  for (const r of rows) {
    const key = split === "one" ? "one" : split === "party" ? `p${r.counterparty?.id ?? "none"}` : `c${r.conditionId}`;
    const g = groups.get(key) ?? { key, partyName: r.counterparty?.name ?? "（相手先なし）", rows: [], eventIds: [], skipped: [] };
    if (settle) {
      const ev = unbilled(r);
      if (!ev.length) { g.skipped.push(`${r.conditionNo ?? `#${r.conditionId}`}（検収書に載せる実績がない）`); groups.set(key, g); continue; }
      g.eventIds.push(...ev);
    }
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function BulkDocsDialog({ matterId, rows, onClose, onDone, onCompose, onOpenDocument }: {
  matterId: number; rows: GridRow[]; onClose: () => void; onDone: (message: string) => void;
  onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null, templateKey?: string | null) => void;
  onOpenDocument?: (id: number) => void;
}) {
  const [templates, setTemplates] = useState<Array<{ templateKey: string; label: string }>>([]);
  const [templateKey, setTemplateKey] = useState("purchase_order");
  const parties = new Set(rows.map((r) => r.counterparty?.id ?? 0));
  const [split, setSplit] = useState<Split>(parties.size > 1 ? "party" : "one");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ key: string; partyName: string; id?: number; error?: string }>>([]);
  useEffect(() => {
    api.get<{ templates: Array<{ templateKey: string; label: string }> }>("/document-templates")
      .then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);
  const settle = SETTLE_KEYS.has(templateKey);
  const plans = planDocs(rows, split, settle);
  const oneBlocked = split === "one" && parties.size > 1;
  const makeable = plans.filter((p) => p.rows.length);

  async function run() {
    setBusy(true);
    const out: typeof results = [];
    for (const p of makeable) {
      try {
        const r = await api.post<{ id: number }>("/documents", {
          templateKey, conditionIds: p.rows.map((x) => x.conditionId), matterId,
          eventIds: p.eventIds, manualInputs: p.eventIds.length ? { _eventIds: p.eventIds } : {}
        });
        out.push({ key: p.key, partyName: p.partyName, id: r.id });
      } catch (e) { out.push({ key: p.key, partyName: p.partyName, error: (e as ApiError).message }); }
      setResults([...out]);
    }
    setBusy(false);
    const ok = out.filter((x) => x.id).length;
    onDone(`下書きを ${ok} 枚作りました${out.length - ok ? `（${out.length - ok} 枚は作れませんでした）` : ""}。文書の画面で中身を確かめて決定してください`);
  }

  return (
    <Modal wide title={`文書をまとめて作る（${rows.length} 本）`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label className="field" style={{ minWidth: 240 }}><span>ひな形</span>
            <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              {(templates.length ? templates : [{ templateKey: "purchase_order", label: "発注書" }, { templateKey: "inspection_certificate", label: "検収書" }])
                .map((t) => <option key={t.templateKey} value={t.templateKey}>{t.label}</option>)}
            </select></label>
          <div className="chips" role="radiogroup" aria-label="分け方">
            {([["one", "1枚にまとめる"], ["party", "取引先ごとに1枚"], ["each", "条件ごとに1枚"]] as const).map(([k, label]) => (
              <button key={k} className="chip" role="radio" aria-checked={split === k} aria-pressed={split === k} onClick={() => setSplit(k)}>{label}</button>
            ))}
          </div>
        </div>
        {oneBlocked && <div className="alert">取引先が {parties.size} 社あります。文書の宛先は1社なので、1枚にはまとめられません。「取引先ごとに1枚」にしてください。</div>}
        {!oneBlocked && (
          <table>
            <thead><tr><th>宛先</th><th>載せる条件</th>{settle && <th>載せる実績</th>}<th>結果</th></tr></thead>
            <tbody>
              {plans.map((p) => {
                const res = results.find((x) => x.key === p.key);
                return (
                  <tr key={p.key}>
                    <td><b>{p.partyName}</b></td>
                    <td>{p.rows.map((r) => <div key={r.conditionId}><span className="code">{r.conditionNo ?? `#${r.conditionId}`}</span> {r.name}</div>)}
                      {p.skipped.map((s) => <div key={s} className="faint">飛ばす：{s}</div>)}</td>
                    {settle && <td className="faint">{p.eventIds.length} 件</td>}
                    <td>{res?.id ? <button className="linky" onClick={() => onOpenDocument?.(res.id!)}>下書き #{res.id} を開く</button>
                      : res?.error ? <span className="danger">{res.error}</span>
                      : p.rows.length ? <span className="faint">下書きを作る</span> : <span className="faint">作らない</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy || oneBlocked || !makeable.length || results.length > 0} onClick={() => void run()}>
            {busy ? "作っています…" : `下書きを ${makeable.length} 枚作る`}</button>
          {onCompose && split !== "each" && !oneBlocked && makeable.length === 1 && (
            <button className="btn" onClick={() => { onClose(); onCompose(makeable[0].rows.map((r) => r.conditionId), makeable[0].eventIds, matterId, templateKey); }}>
              作業テーブルで1枚ずつ作る</button>
          )}
          <button className="btn" onClick={onClose}>{results.length ? "閉じる" : "やめる"}</button>
          <span className="faint">作るのは下書きまで。決定・送信は文書の画面で行います</span>
        </div>
      </div>
    </Modal>
  );
}

function BulkCancelDialog({ rows, onClose, onDone }: { rows: GridRow[]; onClose: () => void; onDone: (m: string) => void }) {
  const list = rows.flatMap((r) => unpaidPayments(r).map((p) => ({ r, p })));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    let ok = 0; const bad: string[] = [];
    for (const { p } of list) {
      try { await api.post(`/payments/${p.id}/cancel`, { reason: reason.trim() }); ok += 1; }
      catch (e) { bad.push(`${p.paymentNo ?? `#${p.id}`}：${(e as ApiError).message}`); }
    }
    setBusy(false);
    if (bad.length) { setError(bad.join("／")); return; }
    onDone(`支払を ${ok} 件取り消しました。直したあと、検収書（訂正版）を決定したら文書の画面で作り直してください`);
  }
  return (
    <Modal title={`未払いの支払を取り消す（${list.length} 件）`} onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        <table><tbody>
          {list.map(({ r, p }) => (
            <tr key={p.id}><td>{r.counterparty?.name ?? ""}</td><td className="code">{r.conditionNo}</td>
              <td className="code">{p.paymentNo ?? `#${p.id}`}</td><td>{PAY_LABEL[p.status] ?? p.status}</td><td>{yen(p.amount)}</td><td className="faint">期日 {p.dueOn ?? "—"}</td></tr>
          ))}
        </tbody></table>
        <p className="faint" style={{ margin: 0 }}>支払済みのものは入っていません（取り消せません）。</p>
        <label className="field"><span>取り消しの理由（必須）</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="数量の訂正のため" /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn danger" disabled={busy || !reason.trim() || !list.length} onClick={() => void run()}>{busy ? "取り消しています…" : `${list.length} 件を取り消す`}</button>
          <button className="btn" onClick={onClose}>やめる</button>
        </div>
      </div>
    </Modal>
  );
}

function BulkDueDialog({ rows, onClose, onDone }: { rows: GridRow[]; onClose: () => void; onDone: (m: string) => void }) {
  const targets = rows.map((r) => ({ r, pays: unpaidPayments(r) })).filter((x) => x.pays.length);
  const [dueOn, setDueOn] = useState("");
  const [reason, setReason] = useState("支払日をそろえるため");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    let ok = 0; const bad: string[] = [];
    for (const { r, pays } of targets) {
      try {
        await api.patch(`/conditions/${r.conditionId}/bundle`, { reason: reason.trim(), payments: pays.map((p) => ({ id: p.id, dueOn })) });
        ok += pays.length;
      } catch (e) { bad.push(`${r.conditionNo ?? `#${r.conditionId}`}：${(e as ApiError).message}`); }
    }
    setBusy(false);
    if (bad.length) { setError(bad.join("／")); return; }
    onDone(`支払 ${ok} 件の支払日を ${dueOn} にしました`);
  }
  return (
    <Modal title="支払日をそろえる" onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        <p className="faint" style={{ margin: 0 }}>選んだ条件の未払いの支払 {targets.reduce((n, x) => n + x.pays.length, 0)} 件（{targets.length} 本）。支払済みは変えません。</p>
        <label className="field"><span>支払日</span><input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
        <label className="field"><span>理由</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy || !dueOn || !reason.trim() || !targets.length} onClick={() => void run()}>{busy ? "直しています…" : "そろえる"}</button>
          <button className="btn" onClick={onClose}>やめる</button>
        </div>
      </div>
    </Modal>
  );
}

