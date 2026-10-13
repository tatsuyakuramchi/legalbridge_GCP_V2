import { useCallback, useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { ClosingRun } from "./ClosingRun.js";
import type { DealAction, DealRow, DealsList, DealsView } from "../server/deals/service.js";

/**
 * 取引管理。条件明細 × 回 を 1 本の表にして、予定 → 実績 → 決済文書 → 支払 を進める。
 *
 *   - 「決まり」は条件の決済の型（一回きり／回数固定／期間で決まる／回数無制限）。
 *     残りが無い条件は行が出ず、期限切れは「条件を改訂する」だけ。
 *   - 「進み具合」は 4 段。業務委託もライセンスも同じ。
 *   - 「次にすること」は段に応じて 1 つ。決済文書を作る段だけ作業テーブルへ移り、決定すると戻る。
 *   - 選んだ回を「まとめて進める」は、支払文書処理の締め（実績=予定どおり → 決済文書 → 支払）をそのまま使う。
 */

const VIEW_LABEL: Record<DealsView, string> = { due: "到来した未済の回", late: "遅れ・期限切れ", pay: "支払を立てた回", all: "すべての回" };
const STAGES = ["予定", "実績", "決済文書", "支払"] as const;
const stageIndex = (r: DealRow) => r.step === "event" ? 1 : r.step === "document" ? 2 : r.step === "payment" ? 3 : 4;
const MODE_TONE: Record<string, string> = { once: "var(--sunken)", fixed_count: "var(--accent-soft)", term_bound: "var(--in-soft)", open: "var(--warn-soft)" };

export interface DealHandoff {
  conditionId: number; conditionNo: string | null; conditionName: string;
  scheduleId: number | null; eventId: number | null; roundLabel: string; templateKey: string;
}

export function DealsWorkspace(
  { scope, onOpenCondition, onOpenDocument, onIssueDocument, onOpenMatter }: {
    /** 案件・相手先・作品に絞って埋め込むとき。 */
    scope?: { partyId?: number; matterId?: number; workId?: number };
    onOpenCondition: (id: number) => void;
    onOpenDocument: (id: number) => void;
    /** 決済文書を作る：作業テーブルへ（この回を渡す）。 */
    onIssueDocument: (h: DealHandoff) => void;
    onOpenMatter?: (id: number) => void;
  }
) {
  const readOnly = useReadOnly();
  const [view, setView] = useState<DealsView>("due");
  const [partyId, setPartyId] = useState<number | null>(scope?.partyId ?? null);
  const [partyLabel, setPartyLabel] = useState<string | null>(null);
  const [kind, setKind] = useState<"" | "service" | "license">("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<DealsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState<DealRow | null>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view });
    if (partyId) p.set("partyId", String(partyId));
    if (scope?.matterId) p.set("matterId", String(scope.matterId));
    if (scope?.workId) p.set("workId", String(scope.workId));
    if (kind) p.set("kind", kind);
    if (q.trim()) p.set("q", q.trim());
    try { setData(await api.get<DealsList>(`/deals?${p}`)); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }, [view, partyId, scope?.matterId, scope?.workId, kind, q]);
  useEffect(() => { void load(); }, [load]);

  const rowKey = (r: DealRow) => r.scheduleId ? `s${r.scheduleId}` : r.eventId ? `e${r.eventId}` : `c${r.conditionId}`;

  async function act(r: DealRow, action: DealAction) {
    if (readOnly) return;
    setBusy(rowKey(r)); setError(null); setNotice(null);
    try {
      if (action === "record_planned" && r.scheduleId) {
        await api.post(`/conditions/${r.conditionId}/schedules/${r.scheduleId}/record`,
          { occurredOn: r.closingOn ?? data?.today ?? null, amount: r.plannedAmount });
        setNotice(`${r.conditionName} ${r.roundLabel}：予定どおりに実績を立てました`);
      } else if (action === "record") {
        setRecording(r); setBusy(null); return;
      } else if (action === "issue") {
        onIssueDocument({ conditionId: r.conditionId, conditionNo: r.conditionNo, conditionName: r.conditionName,
                          scheduleId: r.scheduleId, eventId: r.eventId, roundLabel: r.roundLabel, templateKey: r.templateKey });
        setBusy(null); return;
      } else if (action === "pay" && r.documentId) {
        const made = await api.post<{ paymentNo?: string | null; id?: number }>(`/documents/${r.documentId}/payment`, {});
        setNotice(`${r.conditionName}：支払 ${made.paymentNo ?? ""} を立てました`);
      } else if (action === "paid" && r.paymentId) {
        await api.post(`/payments/${r.paymentId}/paid`, { paidOn: data?.today ?? new Date().toISOString().slice(0, 10) });
        setNotice(`${r.conditionName}：${r.direction === "out" ? "入金を確認しました" : "支払済みにしました"}`);
      } else if (action === "revise") {
        onOpenCondition(r.conditionId); setBusy(null); return;
      }
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function skip(r: DealRow) {
    if (!r.scheduleId) return;
    const reason = prompt(`${r.conditionName} ${r.roundLabel} は今回無し（報告なし・発生なし）として記録します。理由があれば書いてください。`);
    if (reason === null) return;
    setBusy(rowKey(r)); setError(null);
    try {
      await api.post("/royalty-ledger/skips", { conditionId: r.conditionId, scheduleId: r.scheduleId, reason: reason.trim() || null });
      setNotice(`${r.conditionName} ${r.roundLabel}：今回は無しにしました`);
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const rows = data?.rows ?? [];
  const selectable = rows.filter((r) => r.scheduleId !== null && r.rowKind === "round" && r.step !== "done" && r.action !== "wait" && !r.skipped);
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.scheduleId!));
  const s = data?.summary;

  return (
    <section className="stack">
      {!scope && (
        <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
          <h1 style={{ margin: 0 }}>取引管理</h1>
          <span className="faint">条件明細の決まり（決済の型）に沿って、予定 → 実績 → 決済文書 → 支払 を進める</span>
        </div>
      )}

      {s && (
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {([
            ["due", "到来して未済", `${s.due.count} 回`, `合計 ${money(s.due.amount, "JPY")}（見込を含む）`],
            ["late", "遅れ・期限切れ", `${s.late.count} 件`, "締め日を過ぎた回・猶予切れ"],
            ["pay", "支払を立てた", `${s.pay.count} 回`, `合計 ${money(s.pay.amount, "JPY")}`],
            ["all", "受取（OUT 許諾）", `${s.receive.count} 回`, "入金待ち・入金確認"]
          ] as Array<[DealsView, string, string, string]>).map(([v, label, value, sub]) => (
            <button key={v} type="button" className="panel" aria-pressed={view === v}
                    style={{ flex: "1 1 180px", textAlign: "left", padding: "10px 14px", cursor: "pointer",
                             borderColor: view === v ? "var(--accent)" : undefined }}
                    onClick={() => { setView(v); setSelected(new Set()); }}>
              <div className="faint">{label}</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, textAlign: "left" }}>{value}</div>
              <div className="faint">{sub}</div>
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="panel-bd row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="faint">見るもの</span>
          <span className="chips">
            {(Object.keys(VIEW_LABEL) as DealsView[]).map((v) => (
              <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => { setView(v); setSelected(new Set()); }}>{VIEW_LABEL[v]}</button>
            ))}
          </span>
          {!scope?.partyId && (
            <div style={{ minWidth: 220 }}>
              <SearchSelect value={partyId ? String(partyId) : ""} valueLabel={partyLabel} search={searchParties} placeholder="相手先で絞る"
                            onChange={(v, o) => { setPartyId(v ? Number(v) : null); setPartyLabel(o?.label ?? null); }} />
            </div>
          )}
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">種類：すべて</option><option value="service">業務委託</option><option value="license">ライセンス</option>
          </select>
          <input type="search" value={q} placeholder="条件名・相手先・番号・作品で探す" style={{ marginLeft: "auto", minWidth: 220 }}
                 onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      {running && (
        <ClosingRun scheduleIds={[...selected]} onOpenDocument={onOpenDocument}
                    onRan={() => void load()} onDone={() => { setRunning(false); setSelected(new Set()); }}
                    onCancel={() => setRunning(false)} />
      )}
      {recording && (
        <RecordForm row={recording} today={data?.today ?? ""} onClose={() => setRecording(null)}
                    onDone={(msg) => { setRecording(null); setNotice(msg); void load(); }} />
      )}

      <div className="panel">
        <div className="panel-hd" style={{ flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={allOn} disabled={!selectable.length}
                   onChange={() => setSelected(allOn ? new Set() : new Set(selectable.map((r) => r.scheduleId!)))} />
            <span>到来した未済の回をすべて選ぶ</span>
          </label>
          <span className="faint">{selected.size ? `${selected.size} 回を選んでいる` : "選んでいない"}</span>
          <button className="btn btn-sm primary" disabled={readOnly || !selected.size || running} onClick={() => setRunning(true)}>
            選んだ回をまとめて進める（実績 → 決済文書 → 支払を立てる）
          </button>
          <span className="faint">まとめて進めるは予定どおりの額で実績を立てます。納品・売上の入力が要る回は、行ごとに「実績を入れる」から</span>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>条件明細（相手先）</th>
                <th>決まり</th>
                <th>回</th>
                <th className="num">予定／実績</th>
                <th>進み具合</th>
                <th>次にすること</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="faint" style={{ padding: 16 }}>{data ? "この見方に当たる回はありません。" : "読み込み中…"}</td></tr>
              )}
              {rows.map((r) => {
                const key = rowKey(r);
                const sel = r.scheduleId !== null && selected.has(r.scheduleId);
                const canSel = selectable.includes(r);
                const idx = stageIndex(r);
                const paid = r.paymentStatus === "paid";
                return (
                  <tr key={key} className={r.rowKind === "expired" ? "overdue" : ""}
                      style={sel ? { background: "var(--accent-soft)" } : r.skipped ? { opacity: 0.6 } : undefined}>
                    <td>{canSel && <input type="checkbox" checked={sel} aria-label={`${r.conditionName} を選ぶ`}
                                          onChange={() => setSelected((x) => { const n = new Set(x); if (sel) n.delete(r.scheduleId!); else n.add(r.scheduleId!); return n; })} />}</td>
                    <td>
                      <div><button className="linky" style={{ fontWeight: 700 }} onClick={() => onOpenCondition(r.conditionId)}>{r.conditionName}</button></div>
                      <div className="faint">
                        {r.party?.name ?? "—"} ・ <span className={`tag ${r.direction === "in" ? "in" : "out"}`}>{r.direction === "in" ? "IN 払う（取得）" : "OUT 受け取る（許諾）"}</span>
                        ・ {r.kind === "service" || r.kind === "expense" || r.kind === "fee" ? "業務委託" : "ライセンス"}
                        {r.work && <> ・ {r.work.title}</>}
                        {r.matter && onOpenMatter && <> ・ <button className="linky" onClick={() => onOpenMatter(r.matter!.id)}>{r.matter.title}</button></>}
                      </div>
                    </td>
                    <td>
                      <span className="tag" style={{ background: MODE_TONE[r.rule.mode ?? ""] ?? "var(--sunken)", borderColor: "transparent", fontWeight: 700 }}>
                        {r.rule.label.replace(/（.*）/, "")}
                      </span>
                      <div className="faint">
                        {r.rule.mode === "term_bound" && r.termStart && <>{r.termStart}〜{r.termEnd ?? ""}</>}
                        {r.rule.mode === "open" && r.rule.graceUntil && <>猶予 {r.rule.graceUntil} まで</>}
                        {r.rule.mode === "fixed_count" && <>{r.rule.count} 回</>}
                        {r.rule.remaining !== null && <>　残 {r.rule.remaining}</>}
                      </div>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div className="code">{r.roundLabel}</div>
                      <div className="faint" style={{ color: r.rowKind === "expired" || r.lateDays > 0 ? "var(--out)" : r.action === "wait" ? "var(--faint)" : "var(--warn)" }}>
                        {r.rowKind === "expired" ? "期限切れ" : r.rowKind === "next" ? "いつでも" : r.closingOn
                          ? `${r.closingOn} ${r.action === "wait" ? "まだ" : r.lateDays > 0 ? `${r.lateDays} 日遅れ` : "到来"}` : "—"}
                        {r.skipped && "（今回は無し）"}
                      </div>
                    </td>
                    <td className="num">
                      {r.plannedAmount !== null ? money(r.plannedAmount, r.currency) : r.pricingModel === "revenue_rate" ? "報告待ち" : "—"}
                      {r.eventAmount !== null && r.eventAmount !== r.plannedAmount && <div className="faint">実績 {money(r.eventAmount, r.currency)}</div>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {STAGES.map((name, i) => {
                          const done = i < idx || (i === 3 && paid);
                          const now = i === idx && !(i === 3 && paid);
                          return (
                            <span key={name} className="tag" title={name}
                                  style={done ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "transparent", fontWeight: 700 }
                                    : now ? { background: "var(--accent-soft)", color: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 }
                                    : { color: "var(--faint)" }}>
                              {i === 2 ? r.documentLabel : name}
                            </span>
                          );
                        })}
                      </div>
                      <div className="faint">
                        {r.eventOn && <>実績 {r.eventOn}</>}
                        {r.documentNo && <>　<button className="linky code" onClick={() => onOpenDocument(r.documentId!)}>{r.documentNo}</button>{r.documentSentAt ? "（送付済）" : "（未送付）"}</>}
                        {r.paymentNo && <>　支払 {r.paymentNo}{paid ? `（${r.direction === "out" ? "入金" : "支払"}済 ${r.paidOn ?? ""}）` : r.due.on ? `（期日 ${r.due.on}）` : ""}</>}
                      </div>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <ActionButton row={r} busy={busy === key} readOnly={readOnly} onAct={(a) => void act(r, a)} />
                      {(r.pricingModel === "revenue_rate" || r.rule.mode === "term_bound") && r.step === "event" && r.scheduleId && !r.skipped && r.action !== "wait" && (
                        <button className="linky" style={{ marginLeft: 8 }} disabled={readOnly || busy === key} onClick={() => void skip(r)}>今回は無し</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <b>「決まり」は条件明細で決めた支払の回数の型</b>
          <div className="faint">一回きり／回数固定（N 回）／期間で決まる（周期 × 契約期間）／回数無制限（製造・増刷のたび。終了後の猶予まで）。残りが無い条件はここに出ず、「条件を改訂する」からだけ回を増やせます。</div>
        </div>
        <div style={{ flex: "1 1 320px" }}>
          <b>「進み具合」は 4 つの段</b>
          <div className="faint">予定 → 実績 → 決済文書（検収書・計算書）→ 支払。業務委託もライセンスも同じ 4 段で、「次にすること」は段に応じて 1 つだけ出ます。決済文書を作る段だけ作業テーブルに移り、決定すると戻ります。</div>
        </div>
      </div>
    </section>
  );
}

function ActionButton({ row: r, busy, readOnly, onAct }: { row: DealRow; busy: boolean; readOnly: boolean; onAct: (a: DealAction) => void }) {
  const a = r.action;
  const lic = r.kind === "license" || r.kind === "product";
  if (a === "done") return <span className="faint">済み</span>;
  if (a === "wait") return <span className="faint">まだ到来していない</span>;
  if (a === "revise") return <button className="linky" onClick={() => onAct(a)}>条件を改訂する（期間を延ばす・回数を増やす）</button>;
  const label = a === "record_planned" ? "予定どおりに実績を立てる"
    : a === "record" ? (lic ? "実績を入れる（売上・製造）" : "実績を入れる（納品・検収）")
    : a === "issue" ? `${r.documentLabel}を作る（作業テーブルへ）`
    : a === "pay" ? (r.direction === "out" ? "受取の予定を立てる" : "支払を立てる")
    : (r.direction === "out" ? "入金を確認した" : "支払済みにする");
  const primary = a === "issue";
  return (
    <span className="stack" style={{ gap: 2, display: "inline-flex" }}>
      <button className={`btn btn-sm${primary ? " primary" : ""}`} disabled={readOnly || busy} onClick={() => onAct(a)}>{busy ? "…" : label}</button>
      {a === "issue" && <span className="faint">作業テーブルで確認して決定。終わるとこの行に戻る</span>}
      {a === "pay" && <span className="faint">{r.due.on ? `期日 ${r.due.on}（${r.due.label}）` : "期日は条件の支払条件から"}</span>}
      {a === "paid" && <span className="faint">銀行の明細を見てから</span>}
    </span>
  );
}

/** 実績を入れる（1 行ぶん）。業務委託は納品・検収、ライセンスは売上・製造。 */
function RecordForm({ row: r, today, onClose, onDone }: { row: DealRow; today: string; onClose: () => void; onDone: (msg: string) => void }) {
  const lic = r.kind === "license" || r.kind === "product";
  const royalty = r.pricingModel === "revenue_rate";
  const [v, setV] = useState({
    occurredOn: r.closingOn ?? today, quantity: "", amount: r.plannedAmount != null ? String(r.plannedAmount) : "",
    deductions: "0", deliverable: "", inspectedOn: r.closingOn ?? today, inspectorName: "", note: "",
    eventType: lic ? (r.usageType === "oem" || r.usageType === "pub_print" ? "manufacturing" : "sales") : "delivery"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v, value: string) => setV({ ...v, [k]: value });
  const num = (x: string) => { const n = Number(String(x ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
  async function save() {
    setBusy(true); setError(null);
    try {
      if (lic || !r.scheduleId) {
        await api.post(`/conditions/${r.conditionId}/events`, {
          eventType: v.eventType, occurredOn: v.occurredOn, scheduleId: r.scheduleId,
          quantity: v.quantity.trim() ? num(v.quantity) : null,
          grossAmount: royalty ? Math.round(num(v.amount)) : null, deductions: royalty ? Math.round(num(v.deductions)) : 0,
          amount: royalty ? 0 : Math.round(num(v.amount)), note: v.note.trim() || null
        });
      } else {
        await api.post(`/conditions/${r.conditionId}/schedules/${r.scheduleId}/record`, {
          occurredOn: v.occurredOn, amount: v.amount.trim() ? Math.round(num(v.amount)) : null,
          quantity: v.quantity.trim() ? num(v.quantity) : null,
          deliverable: v.deliverable.trim() || null, inspectedOn: v.inspectedOn || null,
          inspectorName: v.inspectorName.trim() || null, note: v.note.trim() || null
        });
      }
      onDone(`${r.conditionName} ${r.roundLabel}：実績を入れました`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel">
      <div className="panel-hd"><h2>実績を入れる</h2><span>{r.conditionName} <span className="code faint">{r.roundLabel}</span></span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>やめる</button></div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        <div className="form-grid">
          {lic && (
            <label className="field"><span>何の実績か</span>
              <select value={v.eventType} onChange={(e) => set("eventType", e.target.value)}>
                <option value="sales">売上（報告）</option><option value="manufacturing">製造</option><option value="sublicense_receipt">再許諾の受領</option>
              </select>
            </label>
          )}
          <label className="field"><span>{lic ? "売上の締め日／製造日" : "納品日"}</span><input type="date" value={v.occurredOn} onChange={(e) => set("occurredOn", e.target.value)} /></label>
          <label className="field"><span>数量</span><input value={v.quantity} placeholder={lic ? "個数・部数" : "1"} onChange={(e) => set("quantity", e.target.value)} /></label>
          <label className="field"><span>{royalty ? "売上（税抜）" : "金額（税抜）"}</span><input value={v.amount} onChange={(e) => set("amount", e.target.value)} /></label>
          {royalty && <label className="field"><span>控除</span><input value={v.deductions} onChange={(e) => set("deductions", e.target.value)} /></label>}
          {!lic && (<>
            <label className="field"><span>成果物・摘要</span><input value={v.deliverable} onChange={(e) => set("deliverable", e.target.value)} /></label>
            <label className="field"><span>検収日</span><input type="date" value={v.inspectedOn} onChange={(e) => set("inspectedOn", e.target.value)} /></label>
            <label className="field"><span>検収者</span><input value={v.inspectorName} onChange={(e) => set("inspectorName", e.target.value)} /></label>
          </>)}
          <label className="field wide"><span>備考</span><input value={v.note} onChange={(e) => set("note", e.target.value)} /></label>
        </div>
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "実績を保存する"}</button></div>
      </div>
    </div>
  );
}
