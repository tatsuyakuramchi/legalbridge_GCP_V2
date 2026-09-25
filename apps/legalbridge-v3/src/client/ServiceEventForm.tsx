import { useEffect, useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { CONDITION_KIND_LABEL } from "./labels.js";

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

interface Detail {
  id: number; conditionNo: string | null; name: string; kind: string; currency: string;
  pricingModel: string; flatAmount: number | null; unitAmount: number | null; quantity: number | null;
  termStart: string | null; termEnd: string | null; spec: string | null; contractForm: string | null;
  paymentTerms: string | null; deliverableOwnership: string | null; taxCategory: string;
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

export function ServiceEventForm(
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
  const [v, setV] = useState<Record<string, string>>({
    occurredOn: today(), inspectedOn: today(), quantity: "", amount: "", deliverable: "", contractForm: "",
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
  const expectedAmount = detail
    ? (line ? line.plannedAmount
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
            <span>{settlement ? "精算日（利用日）" : "納品日（役務完了日）"}</span>
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
          <label className="field">
            <span>{settlement ? (kind === "expense" ? "金額（税込）" : "金額（税抜）") : "金額（税抜）"}</span>
            <input inputMode="numeric" value={f("amount")} onChange={(e) => set("amount", e.target.value)} />
            {expectedAmount !== null && <small className="faint">予定 {money(expectedAmount, currency)}</small>}
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
            <span>メモ</span>
            <input value={f("note")} onChange={(e) => set("note", e.target.value)} />
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
