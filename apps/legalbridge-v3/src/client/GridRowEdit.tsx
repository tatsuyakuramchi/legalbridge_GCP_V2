import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { SECTION_LABEL, type BundlePreview, type BundleSection, type ReissuedDraft }
  from "../server/conditions/bundle-service.js";
import { DRIFT_LABEL, FIELD_LABEL, driftOf, driftSummary }
  from "../server/matters/drift.js";
import type { GridRow } from "../server/matters/grid.js";
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
 */

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

export function GridRowEdit(
  { row, onDone, onCancel, onOpenDocument }: {
    row: GridRow;
    onDone: (message: string) => void;
    onCancel: () => void;
    onOpenDocument?: (documentId: number) => void;
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<ConditionHead>(`/conditions/${row.conditionId}`).catch(() => null),
      api.get<{ lines: ScheduleLine[] }>(`/conditions/${row.conditionId}/schedules`).catch(() => null),
      api.get<{ events: EventLine[] }>(`/conditions/${row.conditionId}/events`).catch(() => null)
    ]).then(([c, s, e]) => {
      const evs = (e?.events ?? []).filter((x) => x.status !== "void");
      setHead(c ?? null);
      setLines(s?.lines ?? []);
      setEvents(evs);
      setV({
        unitAmount: text(c?.unitAmount), quantity: text(c?.quantity), flatAmount: text(c?.flatAmount),
        termStart: text(c?.termStart), termEnd: text(c?.termEnd),
        paymentDueOn: text(row.payment?.dueOn), paymentNote: text(row.payment?.note),
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
  const paid = row.payment?.status === "paid";
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
      if (!paid && eventMoneyChanged(e)) {
        if (num(v[`evq${e.id}`]) !== e.quantity) x.quantity = num(v[`evq${e.id}`]);
        if (eventAmount(e) !== e.amount) x.amount = eventAmount(e);
        moneyOnEvents = true;
      }
      if (Object.keys(x).length > 1) evs.push(x);
    }
    if (evs.length) out.events = evs;
    // 実績の金額を直すなら、先に支払を取り消す（支払がまだのとき）。
    if (moneyOnEvents && row.payment && row.payment.status !== "canceled") out.cancelPayment = { id: row.payment.id };
    else if (row.payment && !paid) {
      const p: Record<string, unknown> = { id: row.payment.id };
      if (v.paymentDueOn !== text(row.payment.dueOn)) p.dueOn = orNull(v.paymentDueOn ?? "");
      if (v.paymentNote !== text(row.payment.note)) p.note = orNull(v.paymentNote ?? "");
      if (Object.keys(p).length > 1) out.payment = p;
    }

    // 訂正版：金額・数量・期日を直したら、決定済みの発注書・検収書（外したものを除く）。
    const reissue: number[] = [];
    const orderTouched = Boolean(out.condition || out.schedules);
    const settleTouched = moneyOnEvents || evs.length > 0;
    if (orderTouched && row.order && row.order.phase !== "draft" && !reissueOff.has(row.order.id)) reissue.push(row.order.id);
    if (settleTouched && row.settlementDoc && row.settlementDoc.phase !== "draft" && !reissueOff.has(row.settlementDoc.id)) reissue.push(row.settlementDoc.id);
    if (reissue.length) out.reissue = reissue;
    return out;
  }, [head, lines, events, v, typedAmount, reissueOff, row]);

  /** 支払済みで実績の金額を直そうとしている：差額（税抜）を「人が直す」に出す。 */
  const paidBlocked = useMemo(() => {
    if (!paid || !row.payment) return null;
    const diff = events.reduce((s, e) => s + ((eventAmount(e) ?? e.amount) - e.amount), 0);
    return diff !== 0 ? { paymentNo: row.payment.paymentNo, diff } : null;
  }, [paid, events, v, typedAmount, row]);

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
      if (r.stoppedAt) {
        setError(`${SECTION_LABEL[r.stoppedAt.section]}で止まりました：${r.stoppedAt.message}` + (done ? `（${done} は直しました）` : ""));
        return;
      }
      const drafts = r.reissued ?? [];
      const manual = drafts.filter((d) => d.pending.length);
      onDone(`${row.conditionNo ?? `#${row.conditionId}`} を直しました（${done}）`
        + (r.revisedTo ? "。実績があるので条件は改訂になり、新しい版に切り替わりました" : "")
        + (drafts.length ? `。${drafts.map((d) => `${d.documentNo ?? `#${d.documentId}`}（下書き #${d.draftId}）`).join("・")} の訂正版を作りました。文書の画面で中身を確かめてから決定してください` : "")
        + (body.cancelPayment ? "。支払を取り消しました。検収書の訂正版を決定したら、文書の画面で支払を作り直してください" : "")
        + (manual.length ? `。${manual.map((d) => `${d.documentNo ?? `#${d.documentId}`}（${d.pending.join("・")}）`).join("／")} は引き直せませんでした。下書きを開いて直してください` : ""));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const drift = driftOf(row);
  const edited = (k: string, was: unknown) => (text(was) !== (v[k] ?? "") ? "edited" : undefined);
  const docBox = (doc: GridRow["order"], label: string) => doc && doc.phase !== "draft" && (
    <label className="revise" style={{ marginTop: 0 }}>
      <input type="checkbox" checked={!reissueOff.has(doc.id)}
             onChange={(e) => setReissueOff((cur) => { const n = new Set(cur); if (e.target.checked) n.delete(doc.id); else n.add(doc.id); return n; })} />
      <span>{doc.documentNo ?? `#${doc.id}`}（{label}）の訂正版を作る<div className="faint">直したときだけ。下書きまでで、決定・送信はしない</div></span>
      {onOpenDocument && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={(ev) => { ev.preventDefault(); onOpenDocument(doc.id); }}>開く</button>}
    </label>
  );

  return (
    <td colSpan={8}>
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <b>{row.conditionNo ?? `#${row.conditionId}`} をまとめて直す</b>
        <span className="faint">左を直すと、右に 発注書・条件明細・実績・支払・検収書 の変わり方が出ます（保存前の試算。まだ何も書きません）</span>
      </div>
      {error && <div className="alert">{error}</div>}
      {drift && drift.flagged.length > 0 && (
        <div className="note" style={{ marginBottom: 10 }}>
          <b>{driftSummary(drift.flagged)}が食い違っています：</b>
          {drift.flagged.map((e) => `${DRIFT_LABEL[e.part]}の${FIELD_LABEL[e.field]}`).join("・")}
        </div>
      )}

      {!lines || !head ? <div className="faint">読み込んでいます…</div> : (
        <div className="fix">
          <div className="fix-in">
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

            {events.length > 0 && <h4>実績（検収）{paid ? "　支払済みのため金額は直せません" : ""}</h4>}
            {events.map((e) => (
              <div key={e.id} className="stack" style={{ gap: 4 }}>
                <span className="faint">{e.occurredOn ?? "日付なし"} の実績</span>
                <label className="field"><span>検収数量</span>
                  <input className={edited(`evq${e.id}`, e.quantity)} inputMode="decimal" disabled={paid} value={v[`evq${e.id}`] ?? ""}
                         onChange={(ev) => set(`evq${e.id}`, ev.target.value)} /></label>
                <label className="field"><span>金額（税抜）</span>
                  <input className={eventAmount(e) !== e.amount ? "edited" : undefined} inputMode="numeric" disabled={paid}
                         value={typedAmount.has(e.id) || !unitRate ? v[`eva${e.id}`] ?? "" : text(eventAmount(e))}
                         onChange={(ev) => { setTypedAmount((cur) => new Set(cur).add(e.id)); set(`eva${e.id}`, ev.target.value); }} /></label>
                {unitRate && !typedAmount.has(e.id) && <div className="fix-calc">単価 × 検収数量で引き直す（打てば打った額）</div>}
              </div>
            ))}

            {row.payment && !paid && !body?.cancelPayment && (<>
              <h4>支払</h4>
              <label className="field"><span>支払日</span>
                <input type="date" className={edited("paymentDueOn", row.payment.dueOn)} value={v.paymentDueOn ?? ""} onChange={(e) => set("paymentDueOn", e.target.value)} /></label>
            </>)}

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

            {(row.order || row.settlementDoc) && <h4>訂正版</h4>}
            {docBox(row.order, "発注書")}
            {docBox(row.settlementDoc, "検収書")}

            <label className="field"><span>直す理由<em className="req"> 必須</em></span>
              <input value={reason} placeholder="先方と納品数を再調整したため" onChange={(e) => setReason(e.target.value)} /></label>
          </div>

          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            {/* 別の支払が立っていて止まるとき：その場で取り消して試算をやり直す。 */}
            {blockingPaymentsOf(preview?.refusedDetail) && (
              <PaymentBlock payments={blockingPaymentsOf(preview?.refusedDetail)!} message={preview?.refused}
                            defaultReason={reason.trim() || undefined} onCanceled={() => setNonce((n) => n + 1)} />
            )}
            <BundleImpact preview={preview} busy={previewing} paidBlocked={paidBlocked} />
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
