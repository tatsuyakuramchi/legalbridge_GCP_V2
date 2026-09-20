import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { StatusTag } from "./labels.js";
import { SECTION_LABEL, type BundleSection, type ReissuedDraft }
  from "../server/conditions/bundle-service.js";
import { DRIFT_LABEL, driftOf } from "../server/matters/drift.js";
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
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
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
  /** 訂正版を作る決定済みの文書。下書きを作るところまでで、決定も送信もしない。 */
  const [reissue, setReissue] = useState<Set<number>>(new Set());
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

  /** 条件と、焼き付いた文書・実績・支払の金額のずれ。 */
  const drift = driftOf(row);
  const toggleReissue = (id: number, on: boolean) => setReissue((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  /**
   * いまの条件の金額に、直せる段を全部そろえる。
   *
   * 直すのは実績と予定（条件はそれ自体が基準）。決定済みの文書は書き換えられ
   * ないので、訂正版を作るほうに印を付ける。押しただけでは保存しない。
   */
  function alignAll() {
    if (!drift) return;
    const amount = String(drift.conditionAmount);
    const next = { ...v };
    if (event && !moneyLocked) next.eventAmount = amount;
    // 回が1つだけなら、その回＝条件の総額。分納は回ごとの配分が要るので触らない。
    if (lines?.length === 1) next[`sch${lines[0].id}`] = amount;
    setV(next);
    const docs = drift.flagged
      .filter((e) => e.part === "order" || e.part === "settlementDoc")
      .map((e) => (e.part === "order" ? row.order?.id : row.settlementDoc?.id))
      .filter((id): id is number => Boolean(id));
    setReissue(new Set([...reissue, ...docs]));
  }

  /** 決定済みの文書に「訂正版を作る」を出す。下書きは直接直せるので出さない。 */
  const reissuable = (doc: GridRow["order"]) =>
    Boolean(doc && doc.phase !== "draft");

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

      if (reissue.size) body.reissue = [...reissue];

      if (Object.keys(body).length <= 1) { setError("直した欄がありません"); setBusy(false); return; }

      const r = await api.patch<{
        applied: Array<{ section: BundleSection; changed: string[] }>;
        stoppedAt: { section: BundleSection; message: string } | null;
        revisedTo: number | null;
        reissued: ReissuedDraft[];
      }>(`/conditions/${row.conditionId}/bundle`, body);

      const done = r.applied.map((a) => SECTION_LABEL[a.section]).join("・");
      if (r.stoppedAt) {
        // 半端に書けたことを黙らない。どこまで書けて、どこで止まったかを出す。
        setError(`${SECTION_LABEL[r.stoppedAt.section]}で止まりました：${r.stoppedAt.message}`
          + (done ? `（${done} は直しました）` : ""));
        setBusy(false);
        return;
      }
      // 訂正版は下書きなので、作っただけでは相手に何も出ていない。
      // 「作った」で終わらせず、次に何をするかまで言う。
      const drafts = (r.reissued ?? []);
      const manual = drafts.filter((d) => d.keepsManualAmounts);
      onDone(`${row.conditionNo ?? `#${row.conditionId}`} を直しました（${done}）`
        // 版が増えたことを黙らない。工程表の行も新しい版に入れ替わる。
        + (r.revisedTo ? "。実績があるので条件は改訂になり、新しい版に切り替わりました" : "")
        + (drafts.length
            ? `。${drafts.map((d) => `${d.documentNo ?? `#${d.documentId}`}（下書き #${d.draftId}）`).join("・")}`
              + " の訂正版を作りました。文書の画面で中身を確かめてから決定してください"
            : "")
        + (manual.length
            ? `。${manual.map((d) => d.documentNo ?? `#${d.documentId}`).join("・")} は`
              + "手入力の明細に金額が入っています。そのままだと古い金額で出るので、明細を直してください"
            : ""));
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

      {drift && drift.flagged.length > 0 && (
        <div className="drift">
          <div className="row">
            <b>金額が食い違っています</b>
            <span className="faint">
              条件を直しても、決定済みの文書は出したときの金額のまま残ります
            </span>
          </div>
          <table>
            <tbody>
              <tr className="now">
                <td>いまの条件</td>
                <td className="right"><b>{yen(drift.conditionAmount)}</b></td>
                <td className="faint">発注書はこれと比べます</td>
              </tr>
              {drift.deliveredAmount !== null && (
                <tr className="now">
                  <td>実績の合計</td>
                  <td className="right"><b>{yen(drift.deliveredAmount)}</b></td>
                  <td className="faint">検収書と支払はこれと比べます</td>
                </tr>
              )}
              {drift.entries.map((e) => (
                <tr key={`${e.part}${e.ref ?? ""}`} className={e.flagged ? "out" : undefined}>
                  <td>{DRIFT_LABEL[e.part]}{e.ref ? <span className="faint code">　{e.ref}</span> : null}</td>
                  <td className="right">{yen(e.amount)}</td>
                  <td className={e.flagged ? "diff" : "faint"}>
                    {e.note ?? (e.diff === 0 ? `${e.basisLabel}と一致`
                      : `${e.basisLabel}より ${e.diff > 0 ? "＋" : "−"}${yen(Math.abs(e.diff))}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={alignAll}>
              いまの条件の金額（{yen(drift.conditionAmount)}）に全部そろえる
            </button>
            <span className="faint">
              欄に入れるだけです。保存は下のボタンで、文書は訂正版の下書きになります
            </span>
          </div>
        </div>
      )}

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
                  <div className="row" style={{ marginTop: 6 }}>
                    {onOpenDocument && (
                      <button className="btn btn-sm" onClick={() => onOpenDocument(row.order!.id)}>開く</button>
                    )}
                  </div>
                  {reissuable(row.order) && (
                    <label className="revise">
                      <input type="checkbox" checked={reissue.has(row.order.id)}
                             onChange={(e) => toggleReissue(row.order!.id, e.target.checked)} />
                      <span>
                        {row.order.documentNo ?? `#${row.order.id}`} の<b>訂正版</b>を作る
                        <div className="faint">
                          下書きで作ります。決定も送信もここではしません
                        </div>
                      </span>
                    </label>
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
                  <div className="row" style={{ marginTop: 6 }}>
                    {onOpenDocument && (
                      <button className="btn btn-sm"
                              onClick={() => onOpenDocument(row.settlementDoc!.id)}>開く</button>
                    )}
                  </div>
                  {reissuable(row.settlementDoc) && (
                    <label className="revise">
                      <input type="checkbox" checked={reissue.has(row.settlementDoc.id)}
                             onChange={(e) => toggleReissue(row.settlementDoc!.id, e.target.checked)} />
                      <span>
                        {row.settlementDoc.documentNo ?? `#${row.settlementDoc.id}`} の<b>訂正版</b>を作る
                        <div className="faint">
                          下書きで作ります。決定も送信もここではしません
                        </div>
                      </span>
                    </label>
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
              この行をまとめて保存する{reissue.size ? `（訂正版 ${reissue.size} 枚も作る）` : ""}
            </button>
            <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
            <span className="faint">前後の値と理由は監査に残ります</span>
          </div>
        </>
      )}
    </td>
  );
}
