import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { SECTION_LABEL, type BundlePreview, type BundleSection, type ReissuedDraft }
  from "../server/conditions/bundle-service.js";
import { DRIFT_LABEL, FIELD_LABEL, driftOf, driftSummary }
  from "../server/matters/drift.js";
import type { GridRound, GridRow } from "../server/matters/grid.js";
import { BundleImpact } from "./BundleImpact.js";
import { PaymentBlock, blockingPaymentsOf } from "./PaymentBlock.js";

/**
 * 工程表の1行を、段をまたいでまとめて直す（docs/document-write-back.md §まとめて直す）。
 *
 * 左に直す値（その条件で意味のある欄だけ）、右に 発注書 → 条件明細 → 実績 → 支払 → 検収書 の
 * 前後を出す。右は保存前の試算で、サーバが本物の保存処理を 1 トランザクションで流して取り消したもの
 * （POST /conditions/:id/bundle/preview）。数量を直すと実績・支払・訂正版がどう動くかが、保存する前に見える。
 *
 * 決まり：
 *   - 単価 × 数量の条件は単価と数量、定額は金額。実績の金額は 単価 × 検収数量 で引き直す（打てば打った額）。
 *   - 実績の金額を直すとき、支払がまだなら先に取り消す（作り直しは検収書の訂正版を決定したあと）。
 *     支払済みなら実績の金額は直さず、差額を「人が直す」に出す。
 *   - 金額・数量を直したら、決定済みの発注書・検収書の訂正版（下書き）を作る（外せる）。
 *   - 複数回の条件は、回ごとに 実績 → 検収書 → 支払 を持つ（row.rounds）。直した回の支払だけを取り消し、
 *     直した回の検収書だけ訂正版を作る。支払済みの回は、その回の金額だけ止める（ほかの回は直せる）。
 */

/** 作品別の一覧でセルを押したとき、どの段を開くか。 */
export type EditFocus = "condition" | "event" | "order" | "settlement" | "payment" | "schedule";

interface ScheduleLine {
  id: number; seq: number; label: string | null; triggerKind: string;
  plannedAmount: number; dueOn: string | null; payOn: string | null;
  contractForm: string | null; serviceFrom: string | null; serviceTo: string | null;
  eventId: number | null;
}
interface EventLine {
  id: number; status: string; occurredOn: string | null; inspectedOn: string | null;
  quantity: number | null; amount: number;
}
interface ConditionHead {
  pricingModel: string; unitAmount: number | null; quantity: number | null; unitLabel: string | null;
  flatAmount: number | null; termStart: string | null; termEnd: string | null; currency?: string;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
/** 空欄は「変えない」ではなく「空にする」。日付と備考はそれでよい。 */
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
const num = (v: string | undefined) => {
  const s = String(v ?? "").replace(/[,，¥￥\s]/g, "");
  return s === "" ? null : Number(s);
};

type Pay = NonNullable<GridRound["payment"]>;

export function GridRowEdit(
  { row, onDone, onCancel, onOpenDocument, inline, focus, onPreview, colSpan = 8 }: {
    row: GridRow;
    onDone: (message: string) => void;
    onCancel: () => void;
    onOpenDocument?: (documentId: number) => void;
    /** 作品別の一覧の行の下に開く。段ごとの前後は行のセルに出すので、右は保存の手順だけ。 */
    inline?: boolean;
    /** 開いたときに前へ出す段。 */
    focus?: EditFocus;
    /** 試算が変わるたびに渡す（行のセルに 前 → 後 を出す）。 */
    onPreview?: (preview: BundlePreview | null) => void;
    colSpan?: number;
  }
) {
  const [head, setHead] = useState<ConditionHead | null>(null);
  const [lines, setLines] = useState<ScheduleLine[] | null>(null);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [v, setV] = useState<Record<string, string>>({});
  /** 実績の金額を人が打ったか（打っていなければ 単価 × 検収数量 で引き直す）。 */
  const [typedAmount, setTypedAmount] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  /** 訂正版を作る文書。金額・数量を直すと既定で印が付く。外したものは覚えておく。 */
  const [reissueOff, setReissueOff] = useState<Set<number>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /** 支払を取り消したあと、試算をやり直す。 */
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** 実績を取り消す：押した実績（2度目で実行）。 */
  const [voiding, setVoiding] = useState<number | null>(null);
  const [voidBlock, setVoidBlock] = useState<{ eventId: number; payments: ReturnType<typeof blockingPaymentsOf>; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<ConditionHead>(`/conditions/${row.conditionId}`).catch(() => null),
      api.get<{ lines: ScheduleLine[] }>(`/conditions/${row.conditionId}/schedules`).catch(() => null),
      api.get<{ events: EventLine[] }>(`/conditions/${row.conditionId}/events`).catch(() => null)
    ]).then(([c, s, e]) => {
      // 回の順（納品日の古いもの → 新しいもの）。一覧は新しい順で返す。
      const evs = (e?.events ?? []).filter((x) => x.status !== "void")
        .sort((a, b) => (a.occurredOn ?? "").localeCompare(b.occurredOn ?? "") || a.id - b.id);
      setHead(c ?? null);
      setLines(s?.lines ?? []);
      setEvents(evs);
      setV({
        unitAmount: text(c?.unitAmount), quantity: text(c?.quantity), flatAmount: text(c?.flatAmount),
        termStart: text(c?.termStart), termEnd: text(c?.termEnd),
        ...Object.fromEntries(allPayments.flatMap((p) => [[`pdue${p.id}`, text(p.dueOn)], [`pnote${p.id}`, text(p.note)]])),
        ...Object.fromEntries(evs.flatMap((x) => [
          [`evq${x.id}`, text(x.quantity)], [`eva${x.id}`, text(x.amount)],
          [`evo${x.id}`, text(x.occurredOn)], [`evi${x.id}`, text(x.inspectedOn)]
        ])),
        ...Object.fromEntries((s?.lines ?? []).flatMap((l) => [
          [`sch${l.id}`, String(l.plannedAmount)], [`schDue${l.id}`, text(l.dueOn)], [`schPay${l.id}`, text(l.payOn)]
        ]))
      });
    });
  }, [row.conditionId]);

  const unitRate = head?.pricingModel === "unit_rate";
  // 回ごとの 検収書・支払（実績の id で引く）。回の情報が無い古い行は、行の支払・検収書で代える。
  const roundOf = useMemo(() => new Map((row.rounds ?? []).filter((r) => r.eventId !== null).map((r) => [r.eventId!, r])), [row.rounds]);
  const multi = (row.rounds ?? []).filter((r) => r.eventId !== null).length > 1;
  const paymentOf = (e: EventLine): Pay | null => {
    const r = roundOf.get(e.id);
    if (r) return r.payment;
    return row.payment ? { ...row.payment, amount: row.payment.amount ?? 0 } : null;
  };
  const docOf = (e: EventLine) => roundOf.get(e.id)?.doc ?? null;
  const paidOf = (e: EventLine) => paymentOf(e)?.status === "paid";
  /** この条件に立っている支払（回をまたいで1回ずつ）。 */
  const allPayments = useMemo(() => {
    const seen = new Map<number, Pay>();
    for (const r of row.rounds ?? []) if (r.payment) seen.set(r.payment.id, r.payment);
    if (!seen.size && row.payment) seen.set(row.payment.id, { ...row.payment, amount: row.payment.amount ?? 0 });
    return [...seen.values()];
  }, [row]);
  const paid = allPayments.length > 0 && allPayments.every((p) => p.status === "paid");
  const set = (k: string, value: string) => setV((cur) => ({ ...cur, [k]: value }));

  /** 実績の金額。打っていなければ、単価 × 検収数量。 */
  const eventAmount = (e: EventLine): number | null => {
    if (typedAmount.has(e.id) || !unitRate) return num(v[`eva${e.id}`]);
    const u = num(v.unitAmount), q = num(v[`evq${e.id}`]);
    return u !== null && q !== null ? Math.round(u * q) : num(v[`eva${e.id}`]);
  };
  const eventMoneyChanged = (e: EventLine) =>
    num(v[`evq${e.id}`]) !== e.quantity || eventAmount(e) !== e.amount;

  /** 保存・試算に送る中身。直した欄だけ。 */
  const body = useMemo(() => {
    if (!head || !lines) return null;
    const out: Record<string, unknown> = {};
    const condition: Record<string, unknown> = {};
    if (unitRate) {
      if (num(v.unitAmount) !== head.unitAmount) condition.unitAmount = num(v.unitAmount);
      if (num(v.quantity) !== head.quantity) condition.quantity = num(v.quantity);
    } else if (num(v.flatAmount) !== head.flatAmount) condition.flatAmount = num(v.flatAmount);
    if (v.termStart !== text(head.termStart)) condition.termStart = orNull(v.termStart ?? "");
    if (v.termEnd !== text(head.termEnd)) condition.termEnd = orNull(v.termEnd ?? "");
    if (Object.keys(condition).length) out.condition = condition;

    // 予定：回が 1 つで実績が付いていなければ、新しい総額に揃える。ほかは欄で直したときだけ。
    const total = unitRate ? (num(v.unitAmount) ?? 0) * (num(v.quantity) ?? 0) : num(v.flatAmount);
    const planned = (l: ScheduleLine) =>
      lines.length === 1 && !l.eventId && condition && (condition.unitAmount !== undefined || condition.quantity !== undefined || condition.flatAmount !== undefined)
      && v[`sch${l.id}`] === String(l.plannedAmount) && total !== null ? Math.round(total) : Number(v[`sch${l.id}`] || 0);
    const scheduleChanged = lines.some((l) => planned(l) !== l.plannedAmount
      || v[`schDue${l.id}`] !== text(l.dueOn) || v[`schPay${l.id}`] !== text(l.payOn));
    if (lines.length && scheduleChanged) {
      out.schedules = lines.map((l) => ({
        seq: l.seq, label: l.label, triggerKind: l.triggerKind, plannedAmount: planned(l),
        dueOn: orNull(v[`schDue${l.id}`] ?? ""), payOn: orNull(v[`schPay${l.id}`] ?? ""),
        contractForm: l.contractForm, serviceFrom: l.serviceFrom, serviceTo: l.serviceTo
      }));
    }

    // 実績。支払済みなら金額は直さない（差額は人が直す）。
    const evs: Array<Record<string, unknown>> = [];
    let moneyOnEvents = false;
    for (const e of events) {
      const x: Record<string, unknown> = { id: e.id };
      if (v[`evo${e.id}`] !== text(e.occurredOn)) x.occurredOn = orNull(v[`evo${e.id}`] ?? "");
      if (v[`evi${e.id}`] !== text(e.inspectedOn)) x.inspectedOn = orNull(v[`evi${e.id}`] ?? "");
      if (!paidOf(e) && eventMoneyChanged(e)) {
        if (num(v[`evq${e.id}`]) !== e.quantity) x.quantity = num(v[`evq${e.id}`]);
        if (eventAmount(e) !== e.amount) x.amount = eventAmount(e);
        moneyOnEvents = true;
      }
      if (Object.keys(x).length > 1) evs.push(x);
    }
    if (evs.length) out.events = evs;
    // 実績の金額を直すなら、その回の支払を先に取り消す（支払がまだのとき）。複数回なら回ごとに。
    const cancels = new Set<number>();
    for (const e of events) {
      const p = paymentOf(e);
      if (p && p.status !== "paid" && p.status !== "canceled" && !paidOf(e) && eventMoneyChanged(e)) cancels.add(p.id);
    }
    if (cancels.size === 1) out.cancelPayment = { id: [...cancels][0] };
    else if (cancels.size > 1) out.cancelPayments = [...cancels].map((id) => ({ id }));
    // 取り消さない支払は、支払日・備考を直せる。
    const edits: Array<Record<string, unknown>> = [];
    for (const p of allPayments) {
      if (p.status === "paid" || cancels.has(p.id)) continue;
      const x: Record<string, unknown> = { id: p.id };
      if ((v[`pdue${p.id}`] ?? "") !== text(p.dueOn)) x.dueOn = orNull(v[`pdue${p.id}`] ?? "");
      if ((v[`pnote${p.id}`] ?? "") !== text(p.note)) x.note = orNull(v[`pnote${p.id}`] ?? "");
      if (Object.keys(x).length > 1) edits.push(x);
    }
    if (edits.length === 1) out.payment = edits[0];
    else if (edits.length > 1) out.payments = edits;

    // 訂正版：金額・数量・期日を直したら、決定済みの発注書と、直した回の検収書（外したものを除く）。
    const reissue = new Set<number>();
    const orderTouched = Boolean(out.condition || out.schedules);
    if (orderTouched && row.order && row.order.phase !== "draft" && !reissueOff.has(row.order.id)) reissue.add(row.order.id);
    const touchedEvents = new Set(evs.map((x) => Number(x.id)));
    for (const e of events) {
      if (!touchedEvents.has(e.id)) continue;
      const d = roundOf.size ? docOf(e) : row.settlementDoc;
      if (d && d.phase !== "draft" && (!("status" in d) || d.status === "issued") && !reissueOff.has(d.id)) reissue.add(d.id);
    }
    if (reissue.size) out.reissue = [...reissue];
    return out;
  }, [head, lines, events, v, typedAmount, reissueOff, row, allPayments, roundOf]);

  /** 支払済みで実績の金額を直そうとしている：差額（税抜）を「人が直す」に出す。 */
  const paidBlocked = useMemo(() => {
    const hit = events.filter((e) => paidOf(e));
    if (!hit.length) return null;
    const diff = hit.reduce((s, e) => s + ((eventAmount(e) ?? e.amount) - e.amount), 0);
    return diff !== 0 ? { paymentNo: paymentOf(hit[0])?.paymentNo ?? null, diff } : null;
  }, [events, v, typedAmount, row, roundOf]);

  // 試算。入力が止まってから 400ms。直した欄が無ければ出さない。
  const seq = useRef(0);
  useEffect(() => {
    if (!body || !Object.keys(body).length) { setPreview(null); return; }
    const my = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      api.post<BundlePreview>(`/conditions/${row.conditionId}/bundle/preview`, { ...body, reason })
        .then((p) => { if (my === seq.current) setPreview(p); })
        .catch((e: ApiError) => { if (my === seq.current) { setPreview(null); setError(e.message); } })
        .finally(() => { if (my === seq.current) setPreviewing(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [JSON.stringify(body), nonce]);
  useEffect(() => { onPreview?.(preview); }, [preview]);
  useEffect(() => () => onPreview?.(null), []);

  // 押したセルの段を前に出す（その段の最初の欄へ）。
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focus || !head || !lines) return;
    if (focus === "schedule") setShowMore(true);
    const t = setTimeout(() => {
      const sec = box.current?.querySelector<HTMLElement>(`[data-sec="${focus}"]`);
      if (!sec) return;
      sec.scrollIntoView({ block: "nearest" });
      sec.querySelector<HTMLInputElement>("input:not([disabled])")?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [focus, Boolean(head && lines)]);

  /** 実績1件を取り消す（無効にする）。検収書に載っていれば断られる。支払が立っていれば PaymentBlock で先に取り消す。 */
  async function voidEvent(e: EventLine) {
    if (!reason.trim()) { setError("直す理由（取り消しの理由）を入れてください"); return; }
    setBusy(true); setError(null); setVoidBlock(null);
    try {
      await api.post(`/conditions/${row.conditionId}/events/${e.id}/void`, { reason: reason.trim() });
      onDone(`${row.conditionNo ?? `#${row.conditionId}`} の実績（${e.occurredOn ?? "日付なし"}・${yen(e.amount)}）を取り消しました`);
    } catch (err) {
      const blocked = blockingPaymentsOf(err);
      if (blocked) setVoidBlock({ eventId: e.id, payments: blocked, message: (err as ApiError).message });
      else setError((err as ApiError).message);
    } finally { setBusy(false); setVoiding(null); }
  }

  async function save() {
    if (!body || !Object.keys(body).length) { setError("直した欄がありません"); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.patch<{
        applied: Array<{ section: BundleSection; changed: string[] }>;
        stoppedAt: { section: BundleSection; message: string } | null;
        revisedTo: number | null;
        reissued: ReissuedDraft[];
      }>(`/conditions/${row.conditionId}/bundle`, { ...body, reason: reason.trim() });
      const done = r.applied.map((a) => SECTION_LABEL[a.section]).join("・");
      const canceled = Boolean(body.cancelPayment || body.cancelPayments);
      if (r.stoppedAt) {
        setError(`${SECTION_LABEL[r.stoppedAt.section]}で止まりました：${r.stoppedAt.message}` + (done ? `（${done} は直しました）` : ""));
        return;
      }
      const drafts = r.reissued ?? [];
      const manual = drafts.filter((d) => d.pending.length);
      onDone(`${row.conditionNo ?? `#${row.conditionId}`} を直しました（${done}）`
        + (r.revisedTo ? "。実績があるので条件は改訂になり、新しい版に切り替わりました" : "")
        + (drafts.length ? `。${drafts.map((d) => `${d.documentNo ?? `#${d.documentId}`}（下書き #${d.draftId}）`).join("・")} の訂正版を作りました。文書の画面で中身を確かめてから決定してください` : "")
        + (canceled ? "。支払を取り消しました。検収書の訂正版を決定したら、文書の画面で支払を作り直してください" : "")
        + (manual.length ? `。${manual.map((d) => `${d.documentNo ?? `#${d.documentId}`}（${d.pending.join("・")}）`).join("／")} は引き直せませんでした。下書きを開いて直してください` : ""));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /** 回ごとの検収書（決定済みのもの、重ねない）。 */
  const settleDocs = (() => {
    const seen = new Map<number, { id: number; documentNo: string | null; phase: string; label: string }>();
    for (const r of row.rounds ?? []) {
      if (r.doc && r.doc.status === "issued" && !seen.has(r.doc.id)) seen.set(r.doc.id, { ...r.doc, label: r.seq ? `第${r.seq}回の検収書` : "検収書" });
    }
    return [...seen.values()];
  })();
  const drift = driftOf(row);
  const edited = (k: string, was: unknown) => (text(was) !== (v[k] ?? "") ? "edited" : undefined);
  // 印が付くのは、直した段の文書だけ（発注書は条件・予定、検収書はその回の実績）。直していない文書は作らない。
  const reissuing = new Set(((body?.reissue as number[] | undefined) ?? []));
  const docBox = (doc: GridRow["order"], label: string) => doc && doc.phase !== "draft" && (
    <label className="revise" style={{ marginTop: 0 }}>
      <input type="checkbox" checked={reissuing.has(doc.id)} disabled={!reissuing.has(doc.id) && !reissueOff.has(doc.id)}
             onChange={(e) => setReissueOff((cur) => { const n = new Set(cur); if (e.target.checked) n.delete(doc.id); else n.add(doc.id); return n; })} />
      <span>{doc.documentNo ?? `#${doc.id}`}（{label}）の訂正版を作る<div className="faint">{reissuing.has(doc.id) || reissueOff.has(doc.id) ? "下書きまでで、決定・送信はしない" : "その文書に載る値を直したときだけ"}</div></span>
      {onOpenDocument && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={(ev) => { ev.preventDefault(); onOpenDocument(doc.id); }}>開く</button>}
    </label>
  );

  const cancelIds = new Set<number>([
    ...(body?.cancelPayment ? [(body.cancelPayment as { id: number }).id] : []),
    ...((body?.cancelPayments as Array<{ id: number }> | undefined) ?? []).map((x) => x.id)]);
  const sec = (k: EditFocus) => ({ "data-sec": k, className: `fix-sec${focus === k ? " fix-focus" : ""}` });
  const payLine = (p: Pay) => (
    <span className="faint">{p.paymentNo ?? `#${p.id}`} {p.status === "paid" ? `支払済み ${p.paidOn ?? ""}` : p.status === "approved" ? "承認済み" : "予定"}</span>
  );
  /** 実績に付いていない支払（回の情報が無い、または割当に実績が無い）。 */
  const loosePayments = allPayments.filter((p) => !events.some((e) => paymentOf(e)?.id === p.id));

  return (
    <td colSpan={colSpan}>
      {!inline && (
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <b>{row.conditionNo ?? `#${row.conditionId}`} をまとめて直す</b>
          <span className="faint">左を直すと、右に 発注書・条件明細・実績・支払・検収書 の変わり方が出ます（保存前の試算。まだ何も書きません）</span>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {drift && drift.flagged.length > 0 && (
        <div className="note" style={{ marginBottom: 10 }}>
          <b>{driftSummary(drift.flagged)}が食い違っています：</b>
          {drift.flagged.map((e) => `${DRIFT_LABEL[e.part]}の${FIELD_LABEL[e.field]}`).join("・")}
        </div>
      )}

      {!lines || !head ? <div className="faint">読み込んでいます…</div> : (
        <div className="fix" ref={box}>
          <div className="fix-in">
            <div {...sec("condition")}>
            <h4>条件明細</h4>
            {unitRate ? (<>
              <label className="field"><span>単価（税抜）</span>
                <input className={edited("unitAmount", head.unitAmount)} inputMode="numeric" value={v.unitAmount ?? ""} onChange={(e) => set("unitAmount", e.target.value)} /></label>
              <label className="field"><span>発注数量</span>
                <input className={edited("quantity", head.quantity)} inputMode="decimal" value={v.quantity ?? ""} onChange={(e) => set("quantity", e.target.value)} /></label>
              <div className="fix-calc">金額 {yen((num(v.unitAmount) ?? 0) * (num(v.quantity) ?? 0))}{head.unitLabel ? `（${head.unitLabel}）` : ""}　発注時 {yen((head.unitAmount ?? 0) * (head.quantity ?? 0))}</div>
            </>) : (
              <label className="field"><span>金額（税抜）</span>
                <input className={edited("flatAmount", head.flatAmount)} inputMode="numeric" value={v.flatAmount ?? ""} onChange={(e) => set("flatAmount", e.target.value)} /></label>
            )}
            </div>

            <div {...sec("event")}>
            {events.length > 0 && <h4>実績（検収）{multi ? `　${events.length} 回` : ""}{paid ? "　支払済みのため金額は直せません" : ""}</h4>}
            {events.map((e) => {
              const round = roundOf.get(e.id);
              const p = paymentOf(e), d = docOf(e), locked = paidOf(e);
              const cancelling = Boolean(p && cancelIds.has(p.id));
              return (
                <div key={e.id} className="fix-round">
                  <div className="fix-round-hd">
                    <b>{round?.seq ? `第${round.seq}回` : "実績"}{round?.label ? ` ${round.label}` : ""}</b>
                    <span className="faint">{e.occurredOn ?? "日付なし"}</span>
                    {d && <span className="faint code">{d.documentNo ?? `#${d.id}`}</span>}
                    {p && payLine(p)}
                    {cancelling && <span className="chip chg">支払を取り消して作り直す</span>}
                    {locked && <span className="chip stop">支払済み：金額は直せません</span>}
                    {!locked && (
                      <span style={{ marginLeft: "auto" }} className="row" title={d ? `${d.documentNo ?? `#${d.id}`} に載っているので取り消せません。先にその文書を無効にしてください` : "この実績を無効にします（理由は下の欄）"}>
                        {voiding === e.id
                          ? <>
                              <span className="faint">この実績を取り消しますか？</span>
                              <button className="btn btn-sm danger" disabled={busy || !reason.trim()} onClick={() => void voidEvent(e)}>取り消す</button>
                              <button className="btn btn-sm" onClick={() => setVoiding(null)}>やめる</button>
                            </>
                          : <button className="linky" disabled={Boolean(d) || busy} onClick={() => { setVoiding(e.id); setError(null); }}>この実績を取り消す</button>}
                      </span>
                    )}
                  </div>
                  {voidBlock?.eventId === e.id && voidBlock.payments && (
                    <PaymentBlock payments={voidBlock.payments} message={voidBlock.message} defaultReason={reason.trim() || undefined}
                                  onCanceled={() => voidEvent(e)} />
                  )}
                  <div className="fix-round-bd">
                    <label className="field"><span>検収数量</span>
                      <input className={edited(`evq${e.id}`, e.quantity)} inputMode="decimal" disabled={locked} value={v[`evq${e.id}`] ?? ""}
                             onChange={(ev) => set(`evq${e.id}`, ev.target.value)} /></label>
                    <label className="field"><span>金額（税抜）</span>
                      <input className={eventAmount(e) !== e.amount ? "edited" : undefined} inputMode="numeric" disabled={locked}
                             value={typedAmount.has(e.id) || !unitRate ? v[`eva${e.id}`] ?? "" : text(eventAmount(e))}
                             onChange={(ev) => { setTypedAmount((cur) => new Set(cur).add(e.id)); set(`eva${e.id}`, ev.target.value); }} /></label>
                  </div>
                  {unitRate && !typedAmount.has(e.id) && !locked && <div className="fix-calc">単価 × 検収数量で引き直す（打てば打った額）</div>}
                </div>
              );
            })}
            </div>

            <div {...sec("payment")}>
            {allPayments.some((p) => p.status !== "paid") && <h4>支払{allPayments.length > 1 ? `　${allPayments.length} 件` : ""}</h4>}
            {allPayments.filter((p) => p.status !== "paid").map((p) => {
              const cancelling = cancelIds.has(p.id);
              const ev = events.find((e) => paymentOf(e)?.id === p.id);
              const round = ev ? roundOf.get(ev.id) : null;
              return (
                <div key={p.id} className="fix-round">
                  <div className="fix-round-hd">
                    <b>{round?.seq ? `第${round.seq}回` : ""}</b>{payLine(p)}<span className="faint">{yen(p.amount)}</span>
                    {cancelling && <span className="chip chg">取り消して作り直す</span>}
                  </div>
                  {!cancelling && (
                    <label className="field"><span>支払日</span>
                      <input type="date" className={edited(`pdue${p.id}`, p.dueOn)} value={v[`pdue${p.id}`] ?? ""} onChange={(e) => set(`pdue${p.id}`, e.target.value)} /></label>
                  )}
                </div>
              );
            })}
            {loosePayments.length > 0 && multi && <div className="faint">実績に付いていない支払：{loosePayments.map((p) => p.paymentNo ?? `#${p.id}`).join("・")}</div>}
            </div>

            <div {...sec("schedule")}>
            <button className="linky" style={{ justifySelf: "start" }} onClick={() => setShowMore((x) => !x)}>
              {showMore ? "▲ 期日・期間・予定をしまう" : "▼ 期日・期間・予定も直す"}
            </button>
            {showMore && (<>
              <label className="field"><span>開始</span>
                <input type="date" className={edited("termStart", head.termStart)} value={v.termStart ?? ""} onChange={(e) => set("termStart", e.target.value)} /></label>
              <label className="field"><span>終了</span>
                <input type="date" className={edited("termEnd", head.termEnd)} value={v.termEnd ?? ""} onChange={(e) => set("termEnd", e.target.value)} /></label>
              {lines.map((l) => (
                <div key={l.id} className="stack" style={{ gap: 4 }}>
                  <span className="faint">予定 第{l.seq}回{l.eventId ? "（実績あり）" : ""}</span>
                  <label className="field"><span>金額</span>
                    <input className={edited(`sch${l.id}`, l.plannedAmount)} value={v[`sch${l.id}`] ?? ""} onChange={(e) => set(`sch${l.id}`, e.target.value)} /></label>
                  <label className="field"><span>納期</span>
                    <input type="date" className={edited(`schDue${l.id}`, l.dueOn)} value={v[`schDue${l.id}`] ?? ""} onChange={(e) => set(`schDue${l.id}`, e.target.value)} /></label>
                  <label className="field"><span>支払日</span>
                    <input type="date" className={edited(`schPay${l.id}`, l.payOn)} value={v[`schPay${l.id}`] ?? ""} onChange={(e) => set(`schPay${l.id}`, e.target.value)} /></label>
                </div>
              ))}
              {events.map((e) => (
                <div key={e.id} className="stack" style={{ gap: 4 }}>
                  <span className="faint">実績 {e.occurredOn ?? ""} の日付</span>
                  <label className="field"><span>納品日</span>
                    <input type="date" className={edited(`evo${e.id}`, e.occurredOn)} value={v[`evo${e.id}`] ?? ""} onChange={(ev) => set(`evo${e.id}`, ev.target.value)} /></label>
                  <label className="field"><span>検収日</span>
                    <input type="date" className={edited(`evi${e.id}`, e.inspectedOn)} value={v[`evi${e.id}`] ?? ""} onChange={(ev) => set(`evi${e.id}`, ev.target.value)} /></label>
                </div>
              ))}
            </>)}
            </div>

            <div {...sec(focus === "order" ? "order" : "settlement")}>
            {(row.order || row.settlementDoc || settleDocs.length > 0) && <h4>訂正版</h4>}
            {docBox(row.order, "発注書")}
            {settleDocs.length
              ? settleDocs.map((d) => <div key={d.id}>{docBox({ ...(row.settlementDoc ?? {} as NonNullable<GridRow["settlementDoc"]>), id: d.id, documentNo: d.documentNo, phase: d.phase }, d.label)}</div>)
              : docBox(row.settlementDoc, "検収書")}
            </div>

            <label className="field"><span>直す理由<em className="req"> 必須</em></span>
              <input value={reason} placeholder="先方と納品数を再調整したため" onChange={(e) => setReason(e.target.value)} /></label>
          </div>

          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            {/* 別の支払が立っていて止まるとき：その場で取り消して試算をやり直す。 */}
            {blockingPaymentsOf(preview?.refusedDetail) && (
              <PaymentBlock payments={blockingPaymentsOf(preview?.refusedDetail)!} message={preview?.refused}
                            defaultReason={reason.trim() || undefined} onCanceled={() => setNonce((n) => n + 1)} />
            )}
            <BundleImpact preview={preview} busy={previewing} paidBlocked={paidBlocked} stepsOnly={inline} />
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !reason.trim() || !body || !Object.keys(body).length || Boolean(preview?.refused)}
                onClick={() => void save()}>
          この内容で直す{body?.reissue ? "（訂正版は下書きまで）" : ""}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
        <span className="faint">前後の値と理由は監査に残ります</span>
      </div>
    </td>
  );
}
