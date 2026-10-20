import { useEffect, useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { ConditionEvents } from "./ConditionEvents.js";
import { hoursText, settleHours, timeSettlementLabel } from "../server/conditions/time-settlement.js";

/**
 * 実績入力の 1 つの入口。
 *
 * 以前は 取引管理の「実績を入れる」（簡易フォーム）・条件明細の「実績を足す」（業務委託は
 * ServiceEventForm、許諾は汎用フォーム）・支払文書処理の「通しで進める」の行入力 が
 * 別々の欄と別々の送り方を持っていた。ここで条件の種類から 1 つに決める：
 *
 *   業務委託（委託料・実費・手数料） … ServiceEntry（納品日・検収日・数量・金額・成果物・契約形式。
 *                                     予定との差分と次のアクションまで）
 *   許諾（ライセンス・製品）         … 条件明細の実績の表（ConditionEvents）を、その回で開いた状態
 *                                     （利用形態・許諾先・算定の形・入金区分まで、紙に出る項目を全部持つ）
 *
 * 支払文書処理の行入力は、同じ送り方（saveRoundEvent）だけを共有する（表の形は残す）。
 * 許諾料の台帳（RoundReport）は「来るはず」の行に数字を打つ表で、送り先は同じ実績 API。
 */
export const SERVICE_KINDS = new Set(["service", "expense", "fee"]);

interface ConditionForEntry {
  id: number; kind: string; currency: string; status: string; pricingModel: string; direction: string;
  deliverableOwnership: string | null; ratePpm: number | null; unitAmount: number | null; quantity: number | null;
  work: { id: number; title: string } | null;
  matters: Array<{ id: number }>;
}

export function EventEntryForm(
  { conditionId, scheduleId, matterId, title, onDone, onCancel }: {
    conditionId: number;
    /** どの回の分か（取引管理の行から）。無ければ回と結び付けずに入れる。 */
    scheduleId?: number | null;
    matterId?: number | null;
    /** 見出し（条件名と回）。 */
    title?: string | null;
    onDone: () => void;
    onCancel: () => void;
  }
) {
  const [cond, setCond] = useState<ConditionForEntry | null>(null);
  const [schedules, setSchedules] = useState<ScheduleLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<ConditionForEntry>(`/conditions/${conditionId}`),
      api.get<{ lines?: ScheduleLite[] }>(`/conditions/${conditionId}/schedules`).catch(() => ({ lines: [] as ScheduleLite[] }))
    ]).then(([c, s]) => { if (!live) return; setCond(c); setSchedules((s.lines ?? []).filter((l) => !l.eventId)); })
      .catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [conditionId]);

  const service = cond ? SERVICE_KINDS.has(cond.kind) : false;
  return (
    <div className="panel">
      <div className="panel-hd"><h2>実績を入れる</h2>
        {title && <span>{title}</span>}
        {cond && <span className="tag">{service ? "納品・検収" : "売上・製造"}</span>}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>やめる</button></div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {!cond && !error && <span className="faint">条件を読み込んでいます…</span>}
        {cond && service && (
          <ServiceEntry conditionId={cond.id} kind={cond.kind} currency={cond.currency} schedules={schedules}
                        initialScheduleId={scheduleId ?? null} matterId={matterId ?? cond.matters[0]?.id ?? null}
                        onDone={onDone} onCancel={onCancel} />
        )}
        {cond && !service && (
          <ConditionEvents conditionId={cond.id} currency={cond.currency} kind={cond.kind}
                           pricingModel={cond.pricingModel} deliverableOwnership={cond.deliverableOwnership}
                           ratePpm={cond.ratePpm} direction={cond.direction}
                           conditionUnitAmount={cond.unitAmount} conditionQuantity={cond.quantity}
                           workTitle={cond.work?.title ?? null} workId={cond.work?.id ?? null}
                           matterId={matterId ?? cond.matters[0]?.id ?? null}
                           editable={cond.status === "active" || cond.status === "draft"}
                           openForSchedule={scheduleId ?? null} openOnMount
                           onChanged={onDone} />
        )}
      </div>
    </div>
  );
}

/** 回に入れる実績（支払文書処理の行入力と同じ形）。 */
export interface RoundDraft {
  occurredOn: string;        // 納品日／売上の締め日
  quantity: string;
  amount: string;            // 税抜。料率の回は売上（税抜）
  deductions: string;        // 料率の回の控除
  deliverable: string;
  inspectedOn: string;
  inspectorName: string;
  note: string;
}
export const newRoundDraft = (row: { closingOn: string | null; plannedAmount: number | null }, todayIso = today()): RoundDraft => ({
  occurredOn: row.closingOn ?? todayIso, quantity: "1",
  amount: row.plannedAmount != null ? String(row.plannedAmount) : "", deductions: "0",
  deliverable: "", inspectedOn: row.closingOn ?? todayIso, inspectorName: "", note: ""
});
const asNum = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
/**
 * 回の実績を 1 件保存する。料率の回は売上の報告（events）、それ以外は回の記録（schedules/record）。
 * 送り方はここ 1 か所（取引管理・支払文書処理・条件明細で同じ）。実績の id を返す。
 */
export async function saveRoundEvent(
  row: { conditionId: number; scheduleId: number | null; pricingModel: string }, d: RoundDraft
): Promise<number> {
  if (row.pricingModel === "revenue_rate" || row.scheduleId === null) {
    const made = await api.post<{ id: number }>(`/conditions/${row.conditionId}/events`, {
      eventType: row.pricingModel === "revenue_rate" ? "sales" : "delivery", occurredOn: d.occurredOn, scheduleId: row.scheduleId,
      grossAmount: row.pricingModel === "revenue_rate" ? Math.round(asNum(d.amount)) : null,
      deductions: row.pricingModel === "revenue_rate" ? Math.round(asNum(d.deductions)) : 0,
      quantity: d.quantity.trim() ? asNum(d.quantity) : null,
      amount: row.pricingModel === "revenue_rate" ? 0 : Math.round(asNum(d.amount)), note: d.note.trim() || null
    });
    return made.id;
  }
  const made = await api.post<{ eventId: number }>(`/conditions/${row.conditionId}/schedules/${row.scheduleId}/record`, {
    occurredOn: d.occurredOn, amount: d.amount.trim() ? Math.round(asNum(d.amount)) : null,
    quantity: d.quantity.trim() ? asNum(d.quantity) : null,
    deliverable: d.deliverable.trim() || null, inspectedOn: d.inspectedOn || null,
    inspectorName: d.inspectorName.trim() || null, note: d.note.trim() || null
  });
  return made.eventId;
}

/**
 * 業務委託の実績を記録する（委託料・実費・手数料）。
 *
 * 流れ：条件の内容を見る → 実績を入れる → 予定との差分を確かめる → 差分があれば
 * 理由と次のアクションを決める → 確定。
 *
 * 以前は許諾料と同じ欄（種類・期間・総額・控除・利用形態…）が並んでいて、
 * 交通費 1 件の精算にも 20 の欄が出ていた。ここは条件の種類で欄を変える。
 *   委託料 … 納品日・検収日・数量・金額・成果物・契約形式
 *   実費／手数料 … 精算日・金額・内容
 * 予定の値は条件（回があれば回）から写して初期値にし、差分だけ人が見る。
 *
 * 次のアクション
 *   不足分を待つ … 期日つきのタスクを案件に立てる（いつまで待つかを持つ）
 *   不足のまま終了（減額） … この金額で終わり。条件を完了扱いにできる
 *   意図どおり … 差分はあるが問題ない（理由だけ残す）
 */

interface ReportImport {
  report: { targetMonth: string | null; submittedOn: string | null; actualHours: number | null; overtimeHours: number | null;
            matters: Array<{ code: string | null; name: string; hours: number | null; outcome: string | null }>;
            expenses: Array<{ date: string | null; category: string | null; description: string; amount: number }> };
  warnings: string[];
  matterLines: string;
}

interface Detail {
  id: number; conditionNo: string | null; name: string; kind: string; currency: string;
  pricingModel: string; flatAmount: number | null; unitAmount: number | null; quantity: number | null;
  termStart: string | null; termEnd: string | null; spec: string | null; contractForm: string | null;
  paymentTerms: string | null; deliverableOwnership: string | null; taxCategory: string;
  /** 準委任の時間精算（A-073）。 */
  timeSettlement?: boolean; hoursIncluded?: number | null; overageUnitAmount?: number | null; shortfallUnitAmount?: number | null;
  matters: Array<{ id: number; matterNo: string | null; title: string }>;
}
export interface ScheduleLite {
  id: number; seq: number; label: string | null; plannedAmount: number; dueOn: string | null;
  payOn?: string | null; contractForm?: string | null; serviceFrom?: string | null; serviceTo?: string | null;
  eventId?: number | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const numOf = (s: string): number | null => {
  const t = s.replace(/[,¥￥\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const firstLine = (s: string | null | undefined) =>
  String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? "";
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

export function ServiceEntry(
  { conditionId, kind, currency, schedules, initialScheduleId, matterId, onDone, onCancel }: {
    conditionId: number;
    kind: string;
    currency: string;
    /** まだ実績の付いていない予定の回。 */
    schedules: ScheduleLite[];
    initialScheduleId?: number | null;
    matterId?: number | null;
    onDone: () => void;
    onCancel: () => void;
  }
) {
  const settlement = kind === "expense" || kind === "fee";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleId, setScheduleId] = useState<string>(initialScheduleId ? String(initialScheduleId) : "");
  /** 月次業務報告書（Excel）の読み取り結果（A-073）。欄を埋めるだけで、何も保存しない。 */
  const [report, setReport] = useState<ReportImport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [extrasDone, setExtrasDone] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, string>>({
    occurredOn: today(), inspectedOn: today(), quantity: "", amount: "", deliverable: "", contractForm: "",
    hours: "", reportReceivedOn: "",
    note: "", varianceNote: "", followUp: "", followUpDueOn: "", closeCondition: ""
  });
  const set = (k: string, value: string) => setV((s) => ({ ...s, [k]: value }));
  const f = (k: string) => v[k] ?? "";

  useEffect(() => {
    api.get<Detail>(`/conditions/${conditionId}`).then((d) => {
      setDetail(d);
      // 予定の値を初期値に。ほとんどの実績は予定どおりに済む。
      const line = schedules.find((s) => String(s.id) === scheduleId);
      const qty = d.quantity ?? (settlement ? null : 1);
      const amount = line ? line.plannedAmount
        : d.pricingModel === "unit_rate" && d.unitAmount !== null && qty !== null ? d.unitAmount * qty
        : d.flatAmount ?? null;
      setV((s) => ({
        ...s,
        occurredOn: line?.dueOn ?? d.termEnd ?? s.occurredOn,
        inspectedOn: line?.dueOn ?? d.termEnd ?? s.inspectedOn,
        quantity: qty === null ? "" : String(qty),
        amount: amount === null ? "" : String(amount),
        deliverable: settlement ? d.name : (firstLine(d.spec) || d.name),
        contractForm: line?.contractForm ?? d.contractForm ?? ""
      }));
    }).catch((e: ApiError) => setError(e.message));
  }, [conditionId]);

  /** 回を変えたら、予定額と期日を回のものにする。 */
  function pickSchedule(id: string) {
    setScheduleId(id);
    const line = schedules.find((s) => String(s.id) === id);
    if (!line) return;
    setV((s) => ({ ...s, amount: String(line.plannedAmount),
                   occurredOn: line.dueOn ?? s.occurredOn, inspectedOn: line.dueOn ?? s.inspectedOn,
                   contractForm: line.contractForm ?? s.contractForm }));
  }

  // ---- 予定と実績の差分 ----------------------------------------------------
  const line = schedules.find((s) => String(s.id) === scheduleId) ?? null;
  const expectedQty = detail ? (detail.quantity ?? (settlement ? null : 1)) : null;
  /**
   * 準委任の時間精算（A-073）。枠までは基本委託料（回の予定額）、超過は単価 × 時間、未消化は控除単価があれば減額。
   * 実績時間を入れると金額はこの式で出す。式どおりの額は「予定との差分」にしない（超過は合意された精算）。
   */
  const timeSettled = Boolean(detail?.timeSettlement) && !settlement;
  const baseAmount = detail ? (line ? line.plannedAmount : detail.flatAmount ?? 0) : 0;
  const hoursActual = numOf(f("hours"));
  const hoursCalc = timeSettled && detail && hoursActual !== null
    ? settleHours({ timeSettlement: true, hoursIncluded: detail.hoursIncluded ?? 0,
                    overageUnitAmount: detail.overageUnitAmount ?? 0, shortfallUnitAmount: detail.shortfallUnitAmount ?? null },
                  baseAmount, hoursActual)
    : null;
  const expectedAmount = detail
    ? (hoursCalc ? hoursCalc.total
       : line ? line.plannedAmount
       : detail.pricingModel === "unit_rate" && detail.unitAmount !== null && expectedQty !== null
         ? detail.unitAmount * expectedQty
         : detail.flatAmount)
    : null;
  const dueOn = line?.dueOn ?? detail?.termEnd ?? null;
  const actualQty = numOf(f("quantity"));
  const actualAmount = numOf(f("amount"));
  const diffs = useMemo(() => {
    const out: Array<{ key: string; label: string; expected: string; actual: string; short: boolean }> = [];
    if (!settlement && expectedQty !== null && actualQty !== null && actualQty !== expectedQty) {
      out.push({ key: "quantity", label: "数量", expected: String(expectedQty), actual: String(actualQty),
                 short: actualQty < expectedQty });
    }
    if (expectedAmount !== null && actualAmount !== null && actualAmount !== expectedAmount) {
      out.push({ key: "amount", label: settlement ? "金額" : "金額（税抜）",
                 expected: money(expectedAmount, currency), actual: money(actualAmount, currency),
                 short: actualAmount < expectedAmount });
    }
    if (dueOn && f("occurredOn") && f("occurredOn") > dueOn) {
      out.push({ key: "date", label: settlement ? "精算日" : "納品日",
                 expected: dueOn, actual: `${f("occurredOn")}（${daysBetween(dueOn, f("occurredOn"))} 日遅れ）`, short: false });
    }
    return out;
  }, [detail, line, actualQty, actualAmount, f("occurredOn")]);
  const hasShort = diffs.some((d) => d.short);
  const hasDiff = diffs.length > 0;

  // ---- 確定できるか ---------------------------------------------------------
  const whyNot = !detail ? "条件を読み込んでいます"
    : !f("occurredOn") ? (settlement ? "精算日を入れてください" : "納品日を入れてください")
    : timeSettled && hoursActual === null ? "実績時間を入れてください"
    : actualAmount === null ? "金額を入れてください"
    : hasDiff && !f("varianceNote").trim() ? "予定と違います。理由を書いてください"
    : hasDiff && !f("followUp") ? "次のアクションを選んでください"
    : f("followUp") === "wait" && !f("followUpDueOn") ? "いつまで待つかを入れてください"
    : null;

  async function confirm() {
    if (!detail || whyNot) return;
    setBusy(true); setError(null);
    try {
      const followUp = hasDiff ? (f("followUp") as "wait" | "settle_short" | "as_is") : null;
      await api.post(`/conditions/${conditionId}/events`, {
        eventType: "inspection",
        occurredOn: f("occurredOn"),
        quantity: settlement ? null : actualQty,
        amount: Math.round(actualAmount ?? 0),
        note: f("note").trim() || null,
        deliverable: f("deliverable").trim() || null,
        inspectedOn: settlement ? null : (f("inspectedOn") || null),
        contractForm: settlement ? null : (f("contractForm").trim() || null),
        // 時間精算の回（A-073）。実績時間と月次業務報告書の受領日。役務提供完了通知書に出る。
        hours: timeSettled ? hoursActual : null,
        reportReceivedOn: timeSettled ? (f("reportReceivedOn") || null) : null,
        scheduleId: scheduleId ? Number(scheduleId) : null,
        expectedQuantity: expectedQty,
        expectedAmount,
        varianceNote: hasDiff ? f("varianceNote").trim() : null,
        followUp,
        followUpDueOn: followUp === "wait" ? f("followUpDueOn") : null
      });
      // 不足分を待つ → 期日つきのタスクを案件に立てる（いつまで待つかを持たせる）。
      const matter = matterId ?? detail.matters[0]?.id ?? null;
      if (followUp === "wait" && matter) {
        const shortText = diffs.filter((d) => d.short).map((d) => `${d.label} ${d.expected} → ${d.actual}`).join("、");
        await api.post(`/matters/${matter}/tasks`, {
          title: `不足分の納品待ち：${detail.name}`,
          taskType: "follow_up",
          description: `${shortText}\n理由：${f("varianceNote").trim()}\n条件 ${detail.conditionNo ?? `#${detail.id}`}`,
          dueAt: `${f("followUpDueOn")}T09:00:00+09:00`
        });
      }
      // 不足のまま終了 → 条件を完了扱いに（この金額で終わり）。
      if (followUp === "settle_short" && f("closeCondition") === "yes") {
        await api.post(`/conditions/${conditionId}/close`, {
          reason: `不足のまま終了（減額）：${f("varianceNote").trim()}`
        });
      }
      onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const kindLabel = CONDITION_KIND_LABEL[kind] ?? kind;
  const open = schedules.filter((s) => !s.eventId);

  /** 月次業務報告書（Excel）を読んで、実績時間・受領日・案件別の実績（メモ）を埋める。 */
  async function readReport(file: File) {
    if (!detail) return;
    setReportBusy(true); setError(null); setExtrasDone(null);
    try {
      const q = scheduleId ? `?scheduleId=${scheduleId}` : "";
      const r = await api.postRaw<ReportImport>(`/conditions/${conditionId}/report-import${q}`, file,
        file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setReport(r);
      setV((s) => {
        const next = { ...s };
        if (r.report.actualHours !== null) {
          next.hours = String(r.report.actualHours);
          const calc = settleHours({ timeSettlement: true, hoursIncluded: detail.hoursIncluded ?? 0,
                                     overageUnitAmount: detail.overageUnitAmount ?? 0, shortfallUnitAmount: detail.shortfallUnitAmount ?? null },
                                   baseAmount, r.report.actualHours);
          next.amount = String(calc.total);
        }
        if (r.report.submittedOn && !s.reportReceivedOn) next.reportReceivedOn = r.report.submittedOn;
        if (r.matterLines && !s.note.trim()) next.note = r.matterLines;
        return next;
      });
    } catch (e) { setError((e as ApiError).message); }
    finally { setReportBusy(false); }
  }

  /** Excel の経費明細を、この業務の実費の条件（と実績）として登録する。 */
  async function addExpenses() {
    if (!report || !report.report.expenses.length) return;
    setReportBusy(true); setError(null);
    try {
      let n = 0;
      for (const e of report.report.expenses) {
        await api.post(`/conditions/${conditionId}/extras`, {
          kind: "expense", name: [e.category, e.description].filter(Boolean).join(" "), amount: e.amount,
          occurredOn: e.date ?? f("occurredOn") ?? today(), note: report.report.targetMonth ? `${report.report.targetMonth} 月次業務報告書より` : null
        });
        n += 1;
      }
      setExtrasDone(`実費 ${n} 件を登録しました（役務提供完了通知書の実費の行に出ます）`);
    } catch (e) { setError((e as ApiError).message); }
    finally { setReportBusy(false); }
  }

  return (
    <div className="stack">
      {/* 1. 条件の内容 */}
      <div className="note">
        <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
          <b>1. 条件の内容</b>
          <span className="faint">この実績が付く条件。予定の値はここから写します</span>
        </div>
        {detail ? (
          <dl className="dl" style={{ marginTop: 6 }}>
            <dt>条件</dt><dd><span className="code">{detail.conditionNo ?? `#${detail.id}`}</span>　<span className="tag">{kindLabel}</span>　{detail.name}</dd>
            {!settlement && detail.spec && (<><dt>仕様・成果物</dt><dd style={{ whiteSpace: "pre-line" }}>{detail.spec}</dd></>)}
            <dt>予定</dt>
            <dd>
              {settlement
                ? `${money(detail.flatAmount, currency)}${kind === "expense" ? "（税込）" : "（税抜）"}`
                : detail.pricingModel === "unit_rate"
                  ? `${money(detail.unitAmount, currency)} × ${detail.quantity ?? "—"} = ${money(expectedAmount, currency)}`
                  : `${money(detail.flatAmount, currency)}${detail.quantity ? `（数量 ${detail.quantity}）` : ""}`}
              {detail.termEnd && `　／　納期 ${detail.termEnd}`}
              {detail.contractForm && `　／　${detail.contractForm}`}
              {detail.paymentTerms && `　／　${detail.paymentTerms}`}
            </dd>
            {timeSettled && (<><dt>時間精算</dt>
              <dd>{timeSettlementLabel({ timeSettlement: true, hoursIncluded: detail.hoursIncluded ?? null,
                                         overageUnitAmount: detail.overageUnitAmount ?? null, shortfallUnitAmount: detail.shortfallUnitAmount ?? null }, baseAmount)}
                　<span className="faint">決済文書は役務提供完了通知書</span></dd></>)}
          </dl>
        ) : <div className="faint">読み込み中…</div>}
        {open.length > 0 && (
          <label className="field wide" style={{ marginTop: 6 }}>
            <span>どの回の分か</span>
            <select value={scheduleId} onChange={(e) => pickSchedule(e.target.value)}>
              <option value="">（回と結び付けない）</option>
              {open.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  第{s.seq}回　{s.label ?? "（名前なし）"}　予定 {money(s.plannedAmount, currency)}{s.dueOn ? `　期日 ${s.dueOn}` : ""}
                </option>
              ))}
            </select>
            <small className={scheduleId ? "faint" : "danger"}>
              {scheduleId ? "予定額と期日は回から入れました" : "結び付けないと、検収書の支払日が空欄になります"}
            </small>
          </label>
        )}
      </div>

      {/* 2. 実績 */}
      <div className="note">
        <b>2. 実績</b>
        <div className="form-grid" style={{ marginTop: 6 }}>
          <label className="field">
            <span>{settlement ? "精算日（利用日）" : timeSettled ? "役務提供期間の末日（完了日）" : "納品日（役務完了日）"}</span>
            <input type="date" value={f("occurredOn")} onChange={(e) => set("occurredOn", e.target.value)} />
          </label>
          {!settlement && (
            <label className="field">
              <span>検収日</span>
              <input type="date" value={f("inspectedOn")} onChange={(e) => set("inspectedOn", e.target.value)} />
              <small className="faint">検収書の検収日。空なら納品日と同じ</small>
            </label>
          )}
          {!settlement && (
            <label className="field">
              <span>納品数量</span>
              <input inputMode="decimal" value={f("quantity")} onChange={(e) => {
                const q = e.target.value; set("quantity", q);
                // 単価×数量の条件は、数量を直したら金額も計算し直す。
                const n = numOf(q);
                if (detail?.pricingModel === "unit_rate" && detail.unitAmount !== null && n !== null) {
                  set("amount", String(detail.unitAmount * n));
                }
              }} />
              {expectedQty !== null && <small className="faint">予定 {expectedQty}</small>}
            </label>
          )}
          {timeSettled && (
            <div className="field wide">
              <span>月次業務報告書（Excel）から読む</span>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input type="file" accept=".xlsx" disabled={reportBusy}
                       onChange={(e) => { const file = e.target.files?.[0]; if (file) void readReport(file); e.target.value = ""; }} />
                {reportBusy && <span className="faint">読んでいます…</span>}
                {report && (
                  <span className="faint">
                    対象月 {report.report.targetMonth ?? "—"}　提出日 {report.report.submittedOn ?? "—"}　実績 {hoursText(report.report.actualHours)}
                    　案件 {report.report.matters.length} 件　経費 {report.report.expenses.length} 件
                  </span>
                )}
              </div>
              <small className="faint">実績時間・受領日・案件別の実績（メモ）を埋めます。Excel の基本枠・基本報酬・基準単価は使わず、条件明細と違えば下に出します</small>
              {report && report.warnings.length > 0 && (
                <div className="note warn" style={{ marginTop: 6 }}>
                  {report.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
              {report && report.report.expenses.length > 0 && (
                <div className="note" style={{ marginTop: 6 }}>
                  <b>経費明細</b>　{report.report.expenses.map((e) => `${e.date ?? ""} ${[e.category, e.description].filter(Boolean).join(" ")} ${money(e.amount, currency)}`).join("、")}
                  {!extrasDone
                    ? <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} disabled={reportBusy} onClick={() => void addExpenses()}>実費の行として登録する</button>
                    : <span className="faint" style={{ marginLeft: 8 }}>{extrasDone}</span>}
                </div>
              )}
            </div>
          )}
          {timeSettled && (<>
            <label className="field">
              <span>実績時間（h）</span>
              <input inputMode="decimal" value={f("hours")} placeholder={detail?.hoursIncluded != null ? String(detail.hoursIncluded) : ""}
                     onChange={(e) => {
                       const h = e.target.value; set("hours", h);
                       // 実績時間を入れたら金額は式で出す（基本＋超過−控除）。人が直せば手の値が勝つ。
                       const n = numOf(h);
                       if (detail && n !== null) {
                         const calc = settleHours({ timeSettlement: true, hoursIncluded: detail.hoursIncluded ?? 0,
                                                    overageUnitAmount: detail.overageUnitAmount ?? 0, shortfallUnitAmount: detail.shortfallUnitAmount ?? null },
                                                  baseAmount, n);
                         set("amount", String(calc.total));
                       }
                     }} />
              <small className="faint">
                月次業務報告書の実績時間。包括枠 {hoursText(detail?.hoursIncluded)}
                {hoursCalc && hoursCalc.overageHours > 0 && `　→ 超過 ${hoursText(hoursCalc.overageHours)} × ${money(detail?.overageUnitAmount ?? 0, currency)} = ${money(hoursCalc.overageAmount, currency)}`}
                {hoursCalc && hoursCalc.shortfallHours > 0 && (hoursCalc.shortfallAmount > 0
                  ? `　→ 未消化 ${hoursText(hoursCalc.shortfallHours)} × ${money(detail?.shortfallUnitAmount ?? 0, currency)} = −${money(hoursCalc.shortfallAmount, currency)}`
                  : `　→ 未消化 ${hoursText(hoursCalc.shortfallHours)}（減額なし）`)}
              </small>
            </label>
            <label className="field">
              <span>月次業務報告書の受領日</span>
              <input type="date" value={f("reportReceivedOn")} onChange={(e) => set("reportReceivedOn", e.target.value)} />
              <small className="faint">役務提供完了通知書の「月次業務報告書」欄に出る。報告書の Excel は文書として実績に繋ぐ</small>
            </label>
          </>)}
          <label className="field">
            <span>{settlement ? (kind === "expense" ? "金額（税込）" : "金額（税抜）") : "金額（税抜）"}</span>
            <input inputMode="numeric" value={f("amount")} onChange={(e) => set("amount", e.target.value)} />
            {expectedAmount !== null && <small className="faint">{hoursCalc ? "式どおり" : "予定"} {money(expectedAmount, currency)}</small>}
          </label>
          <label className="field wide">
            <span>{settlement ? "内容" : "成果物"}</span>
            <input value={f("deliverable")} onChange={(e) => set("deliverable", e.target.value)} />
            <small className="faint">{settlement ? "検収書の経費・手数料の行に出る名前" : "検収書の成果物・業務内容の 1 行目"}</small>
          </label>
          {!settlement && (
            <label className="field">
              <span>契約形式</span>
              <input value={f("contractForm")} onChange={(e) => set("contractForm", e.target.value)} placeholder="請負／準委任" />
            </label>
          )}
          <label className="field wide">
            <span>{timeSettled ? "案件別の実績（メモ）" : "メモ"}</span>
            {timeSettled
              ? <textarea rows={3} value={f("note")} onChange={(e) => set("note", e.target.value)} placeholder={"LGL-003 契約スキーム相談 18 h\nLGL-004 契約書レビュー 31.5 h"} />
              : <input value={f("note")} onChange={(e) => set("note", e.target.value)} />}
            {timeSettled && <small className="faint">役務提供完了通知書の「業務内容」の行の下にそのまま出る（1 行 1 案件）</small>}
          </label>
        </div>
      </div>

      {/* 3. 差分 */}
      <div className="note">
        <b>3. 予定との差分</b>
        {!hasDiff ? (
          <div className="faint" style={{ marginTop: 4 }}>予定どおりです。差分はありません</div>
        ) : (
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>項目</th><th>予定</th><th>実績</th><th></th></tr></thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.key}>
                  <td>{d.label}</td><td className="num">{d.expected}</td><td className="num">{d.actual}</td>
                  <td>{d.short ? <span className="tag warn">不足</span> : <span className="tag">変更</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 4. 変更の記録と次のアクション */}
      {hasDiff && (
        <div className="note warn">
          <b>4. 変更の記録と次のアクション</b>
          <div className="form-grid" style={{ marginTop: 6 }}>
            <label className="field wide">
              <span>理由（必須）</span>
              <textarea rows={2} value={f("varianceNote")} onChange={(e) => set("varianceNote", e.target.value)}
                        placeholder="納品数が 2 点足りない／単価の見直し／納期の再調整 など" />
            </label>
            <div className="field wide">
              <span>次のアクション（必須）</span>
              <div className="stack" style={{ gap: 4 }}>
                {hasShort && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="radio" name="followUp" checked={f("followUp") === "wait"} onChange={() => set("followUp", "wait")} />
                    不足分を待つ（期日つきのタスクを案件に立てる）
                  </label>
                )}
                {/* 日付は幅いっぱいに伸ばさない。全幅の欄の中にあるので、
                    放っておくと 1200px の日付欄になる。 */}
                {f("followUp") === "wait" && (
                  <label className="field" style={{ marginLeft: 22, maxWidth: 240 }}>
                    <span>いつまで待つか</span>
                    <input type="date" value={f("followUpDueOn")} onChange={(e) => set("followUpDueOn", e.target.value)} />
                  </label>
                )}
                {hasShort && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="radio" name="followUp" checked={f("followUp") === "settle_short"} onChange={() => set("followUp", "settle_short")} />
                    不足のまま終了する（この金額で減額して確定）
                  </label>
                )}
                {f("followUp") === "settle_short" && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 22 }}>
                    <input type="checkbox" checked={f("closeCondition") === "yes"}
                           onChange={(e) => set("closeCondition", e.target.checked ? "yes" : "")} />
                    この条件を完了扱いにする（残りは請求しない）
                  </label>
                )}
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="followUp" checked={f("followUp") === "as_is"} onChange={() => set("followUp", "as_is")} />
                  差分は意図どおり（理由だけ残す）
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || Boolean(whyNot)} onClick={() => void confirm()}>
          {busy ? "保存中…" : hasDiff ? "5. 変更を記録して実績を確定する" : "実績を確定する"}
        </button>
        {whyNot && !busy && <span className="faint">{whyNot}</span>}
        <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}
