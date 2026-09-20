import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { StatusTag } from "./labels.js";
import { SECTION_LABEL, type BundleSection } from "../server/conditions/bundle-service.js";
import type { GridRow } from "../server/matters/grid.js";

/**
 * 工程表の1行を、段をまたいでまとめて直す。
 *
 * 条件・予定・実績・支払はそれぞれ別の画面で保存していた。「納品数を減らした
 * ので金額も予定も実績も支払も直す」が4画面4回の保存になり、どれかを直し
 * 忘れると数字が食い違ったまま残る。ここは1回の保存で揃える。
 *
 * 直せない欄は隠さずに、理由ごと出す。押せないだけだと「なぜ押せないのか」が
 * 分からず、結局どこかで詰まる。
 */

interface ScheduleLine {
  id: number; seq: number; label: string | null; triggerKind: string;
  plannedAmount: number; dueOn: string | null; payOn: string | null;
  contractForm: string | null; serviceFrom: string | null; serviceTo: string | null;
  eventId: number | null;
}
interface EventLine {
  id: number; status: string; occurredOn: string | null;
  quantity: number | null; amount: number;
}
interface ConditionHead {
  flatAmount: number | null; termStart: string | null; termEnd: string | null;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** 空欄は「変えない」ではなく「空にする」。日付と備考はそれでよい。 */
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

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
  const [event, setEvent] = useState<EventLine | null>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    Promise.all([
      // 条件の詳細は入れ子にせず、そのまま返ってくる。
      api.get<ConditionHead>(`/conditions/${row.conditionId}`).catch(() => null),
      api.get<{ lines: ScheduleLine[] }>(`/conditions/${row.conditionId}/schedules`).catch(() => null),
      row.events.latestId
        ? api.get<{ events: EventLine[] }>(`/conditions/${row.conditionId}/events`).catch(() => null)
        : Promise.resolve(null)
    ]).then(([c, s, e]) => {
      const condition = c ?? null;
      const ev = e?.events.find((x) => x.id === row.events.latestId) ?? null;
      setHead(condition);
      setLines(s?.lines ?? []);
      setEvent(ev);
      setV({
        flatAmount: text(condition?.flatAmount),
        termStart: text(condition?.termStart),
        termEnd: text(condition?.termEnd),
        eventOccurredOn: text(ev?.occurredOn),
        eventQuantity: text(ev?.quantity),
        eventAmount: text(ev?.amount),
        paymentDueOn: text(row.payment?.dueOn),
        paymentNote: text(row.payment?.note),
        ...Object.fromEntries((s?.lines ?? []).map((l) => [`sch${l.id}`, String(l.plannedAmount)]))
      });
    });
  }, [row.conditionId, row.events.latestId]);

  // 金額に関わる欄は、支払が立っていると直せない（サーバが断る）。
  const moneyLocked = Boolean(row.payment);

  async function save() {
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { reason: reason.trim() };

      const condition: Record<string, unknown> = {};
      if (head) {
        if (v.flatAmount !== text(head.flatAmount)) condition.flatAmount = orNull(v.flatAmount);
        if (v.termStart !== text(head.termStart)) condition.termStart = orNull(v.termStart);
        if (v.termEnd !== text(head.termEnd)) condition.termEnd = orNull(v.termEnd);
      }
      if (Object.keys(condition).length) body.condition = condition;

      // 予定は入れ替えなので、1行でも直したら全部の行を送る。
      if (lines?.length && lines.some((l) => v[`sch${l.id}`] !== String(l.plannedAmount))) {
        body.schedules = lines.map((l) => ({
          seq: l.seq, label: l.label, triggerKind: l.triggerKind,
          plannedAmount: Number(v[`sch${l.id}`] || 0),
          dueOn: l.dueOn, payOn: l.payOn, contractForm: l.contractForm,
          serviceFrom: l.serviceFrom, serviceTo: l.serviceTo
        }));
      }

      if (event) {
        const e: Record<string, unknown> = { id: event.id };
        if (v.eventOccurredOn !== text(event.occurredOn)) e.occurredOn = orNull(v.eventOccurredOn);
        if (!moneyLocked) {
          if (v.eventQuantity !== text(event.quantity)) e.quantity = orNull(v.eventQuantity);
          if (v.eventAmount !== text(event.amount)) e.amount = orNull(v.eventAmount);
        }
        if (Object.keys(e).length > 1) body.event = e;
      }

      if (row.payment) {
        const p: Record<string, unknown> = { id: row.payment.id };
        if (v.paymentDueOn !== text(row.payment.dueOn)) p.dueOn = orNull(v.paymentDueOn);
        if (v.paymentNote !== text(row.payment.note)) p.note = orNull(v.paymentNote);
        if (Object.keys(p).length > 1) body.payment = p;
      }

      if (Object.keys(body).length <= 1) { setError("直した欄がありません"); setBusy(false); return; }

      const r = await api.patch<{
        applied: Array<{ section: BundleSection; changed: string[] }>;
        stoppedAt: { section: BundleSection; message: string } | null;
        revisedTo: number | null;
      }>(`/conditions/${row.conditionId}/bundle`, body);

      const done = r.applied.map((a) => SECTION_LABEL[a.section]).join("・");
      if (r.stoppedAt) {
        // 半端に書けたことを黙らない。どこまで書けて、どこで止まったかを出す。
        setError(`${SECTION_LABEL[r.stoppedAt.section]}で止まりました：${r.stoppedAt.message}`
          + (done ? `（${done} は直しました）` : ""));
        setBusy(false);
        return;
      }
      onDone(`${row.conditionNo ?? `#${row.conditionId}`} を直しました（${done}）`
        // 版が増えたことを黙らない。工程表の行も新しい版に入れ替わる。
        + (r.revisedTo ? "。実績があるので条件は改訂になり、新しい版に切り替わりました" : ""));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <td colSpan={8}>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>{row.conditionNo ?? `#${row.conditionId}`} をまとめて直す</b>
        <span className="faint">直した欄だけを送ります。1回の保存で段ぶんが揃います</span>
      </div>
      {error && <div className="alert">{error}</div>}
      {!lines ? <div className="faint">読み込んでいます…</div> : (
        <>
          <div className="editgrid">
            <div className="editsec">
              <h4>条件</h4>
              <label className="field"><span>金額</span>
                <input value={v.flatAmount ?? ""} disabled={moneyLocked}
                       onChange={(e) => setV({ ...v, flatAmount: e.target.value })} /></label>
              <label className="field"><span>開始</span>
                <input type="date" value={v.termStart ?? ""}
                       onChange={(e) => setV({ ...v, termStart: e.target.value })} /></label>
              <label className="field"><span>終了</span>
                <input type="date" value={v.termEnd ?? ""}
                       onChange={(e) => setV({ ...v, termEnd: e.target.value })} /></label>
              {moneyLocked && (
                <div className="locked">
                  支払 {row.payment?.paymentNo} が立っているので金額は直せません。
                  先にその支払を取り消してください。
                </div>
              )}
              {!moneyLocked && row.events.count > 0 && (
                <div className="locked">
                  実績があるので、金額を直すと<b>改訂</b>（新しい版）になります。
                  旧版は残り、実績と支払の割当もそのままです。
                </div>
              )}
            </div>

            <div className="editsec">
              <h4>予定（{lines.length} 回）</h4>
              {lines.length === 0 && <div className="locked">回がありません。条件の画面で作ります。</div>}
              {lines.map((l) => (
                <label className="field" key={l.id}>
                  <span>第{l.seq}回</span>
                  <input value={v[`sch${l.id}`] ?? ""}
                         onChange={(e) => setV({ ...v, [`sch${l.id}`]: e.target.value })} />
                </label>
              ))}
              {lines.some((l) => l.eventId) && (
                <div className="locked">実績の付いた回があります。金額を直すと実績との差分が出ます。</div>
              )}
            </div>

            <div className="editsec">
              <h4>発注書</h4>
              {row.order ? (
                <>
                  <div className="locked">
                    {row.order.documentNo ?? `#${row.order.id}`} は
                    <StatusTag kind="document" value={row.order.phase} />です。
                    {row.order.phase !== "draft" && <>中身は直せません。直すなら訂正版を作ります。</>}
                  </div>
                  {onOpenDocument && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="btn btn-sm" onClick={() => onOpenDocument(row.order!.id)}>開く</button>
                    </div>
                  )}
                </>
              ) : <div className="locked">まだありません。</div>}
            </div>

            <div className="editsec">
              <h4>実績{event ? `（直近 1 件／全 ${row.events.count} 件）` : ""}</h4>
              {event ? (
                <>
                  <label className="field"><span>発生日</span>
                    <input type="date" value={v.eventOccurredOn ?? ""}
                           onChange={(e) => setV({ ...v, eventOccurredOn: e.target.value })} /></label>
                  <label className="field"><span>数量</span>
                    <input value={v.eventQuantity ?? ""} disabled={moneyLocked}
                           onChange={(e) => setV({ ...v, eventQuantity: e.target.value })} /></label>
                  <label className="field"><span>実額</span>
                    <input value={v.eventAmount ?? ""} disabled={moneyLocked}
                           onChange={(e) => setV({ ...v, eventAmount: e.target.value })} /></label>
                  {moneyLocked && (
                    <div className="locked">
                      支払 {row.payment?.paymentNo} が立っているので金額・数量は直せません。
                    </div>
                  )}
                </>
              ) : <div className="locked">まだありません。実績タブで記録します。</div>}
            </div>

            <div className="editsec">
              <h4>検収書・計算書</h4>
              {row.settlementDoc ? (
                <>
                  <div className="locked">
                    {row.settlementDoc.documentNo ?? `#${row.settlementDoc.id}`} は
                    <StatusTag kind="document" value={row.settlementDoc.phase} />です。
                  </div>
                  {onOpenDocument && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="btn btn-sm"
                              onClick={() => onOpenDocument(row.settlementDoc!.id)}>開く</button>
                    </div>
                  )}
                </>
              ) : <div className="locked">まだありません。実績から作ります。</div>}
            </div>

            <div className="editsec">
              <h4>支払</h4>
              {row.payment ? (
                <>
                  <label className="field"><span>期日</span>
                    <input type="date" value={v.paymentDueOn ?? ""}
                           onChange={(e) => setV({ ...v, paymentDueOn: e.target.value })} /></label>
                  <label className="field"><span>備考</span>
                    <input value={v.paymentNote ?? ""}
                           onChange={(e) => setV({ ...v, paymentNote: e.target.value })} /></label>
                  <div className="locked">金額は割当の合計です。ここでは直せません。</div>
                </>
              ) : <div className="locked">まだありません。支払タブで起こします。</div>}
            </div>
          </div>

          <label className="field" style={{ marginTop: 10, gridTemplateColumns: "110px minmax(0,1fr)" }}>
            <span>直す理由<em className="req"> 必須</em></span>
            <input value={reason} placeholder="先方と納品数を再調整したため"
                   onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !reason.trim()} onClick={() => void save()}>
              この行をまとめて保存する
            </button>
            <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
            <span className="faint">前後の値と理由は監査に残ります</span>
          </div>
        </>
      )}
    </td>
  );
}
