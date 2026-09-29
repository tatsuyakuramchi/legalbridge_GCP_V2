import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import type { LedgerCondition, LedgerEvent, LedgerView, Round, RoundPart } from "../server/royalty/ledger-service.js";

/**
 * 回の「報告を入れる」表。docs/royalty-ledger.md §3
 *
 * 行は 許諾先（製品）× 言語 × 地域。来るはずの行が先に並んでいて、
 * 相手から来た数字（数量・受領額）をその行に打つだけ。利用形態・許諾先・
 * 言語・地域・回・発生日（締め日）は行が持っているので聞かない。
 * 汎用の実績フォーム（ConditionEvents）はここでは開かない。
 *
 * 予定にない報告（新しい許諾先・想定外の言語）は「予定にない報告を足す」で
 * 許諾先と言語・地域を選んで行を足す。
 */

const yen = (n: number | null | undefined, currency = "JPY") =>
  n === null || n === undefined ? "—" : currency === "JPY"
    ? `¥${Number(n).toLocaleString("ja-JP")}` : `${currency} ${(Number(n) / 100).toLocaleString("en-US")}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const numOf = (s: string) => { const n = Number(String(s).replace(/[,，]/g, "")); return Number.isFinite(n) ? n : 0; };

/** 表の1行。入力済（event）か、来るはず（expected）か、まだ何も無い条件（blank）。 */
interface Line {
  key: string;
  part: RoundPart;
  condition: LedgerCondition;
  event: LedgerEvent | null;
  /** 行の見出し（許諾先 or 作品）と範囲。 */
  outConditionId: number | null; outName: string | null;
  languages: string[]; regions: string[];
  why: string | null;
  planId: number | null;
}

/** 行に打つ数字。利用形態で使う欄が違う。 */
interface Draft { quantity: string; unit: string; gross: string; taxIncluded: boolean; on: string; note: string }

/** 利用形態ごとに、どの欄を使うか。 */
function fieldsFor(usage: string | null, pricingModel: string) {
  if (usage === "sublicense") return { quantity: false, unit: false, gross: true, tax: true, grossLabel: "受領額" };
  if (usage === "oem") return { quantity: true, unit: true, gross: true, tax: true, grossLabel: "受領額（数量×単価の代わり）" };
  if (usage === "in_house") return { quantity: true, unit: true, gross: false, tax: false, grossLabel: "" };
  // 利用形態なし（出版など）。料率なら報告額、単価なら数量。
  return pricingModel === "unit_rate"
    ? { quantity: true, unit: false, gross: false, tax: false, grossLabel: "" }
    : { quantity: true, unit: false, gross: true, tax: false, grossLabel: "報告額（売上）" };
}

export function eventTypeFor(usage: string | null, condition: LedgerCondition): string {
  if (usage === "sublicense") return "sublicense_receipt";
  if (usage === "in_house" || usage === "oem") return "sales";
  return condition.usageType === "pub_print" ? "manufacturing" : "sales";
}

export function RoundReport(
  { round, view, canWrite, onChanged, onError, onOpenDocument, adding, setAdding, isAdmin = false, onReissue }: {
    round: Round; view: LedgerView; canWrite: boolean;
    onChanged: (message?: string) => void; onError: (m: string) => void;
    onOpenDocument?: (documentId: number) => void;
    /** 表の上のフォーム。報告を追加／予定を作る。開く条件（作品）を指定できる。 */
    adding: { mode: "report" | "plan"; conditionId?: number } | null;
    setAdding: (a: { mode: "report" | "plan"; conditionId?: number } | null) => void;
    /** admin だけ、決定した計算書に載った報告を例外的に直せる。 */
    isAdmin?: boolean;
    /** 直したあと、その計算書の訂正版を出し直す（文書の画面へ）。 */
    onReissue?: (documentId: number, reason: string) => void;
  }
) {
  const cond = (id: number) => view.conditions.find((c) => c.id === id)!;
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const p of round.parts) {
      const c = cond(p.conditionId);
      for (const e of p.events) {
        out.push({ key: `e${e.id}`, part: p, condition: c, event: e, outConditionId: e.outConditionId, outName: e.outName,
                   languages: e.languages ?? [], regions: e.regions ?? [], why: null, planId: null });
      }
      p.expected.forEach((x, i) => {
        out.push({ key: `x${p.conditionId}:${p.scheduleId ?? ""}:${i}`, part: p, condition: c, event: null,
                   outConditionId: x.outConditionId, outName: x.outName,
                   languages: x.languages ?? [], regions: x.regions ?? [], why: x.why, planId: x.planId ?? null });
      });
      if (!p.events.length && !p.expected.length) {
        out.push({ key: `b${p.conditionId}:${p.scheduleId ?? p.eventId ?? ""}`, part: p, condition: c, event: null,
                   outConditionId: null, outName: null, languages: [], regions: [], why: null, planId: null });
      }
    }
    return out;
  }, [round]);

  /** 作品ごとの区切り。作家 × 全作品で見ているときだけ帯を出す。回に締めの無い作品も帯だけ出す。 */
  const groups = useMemo(() => {
    const many = view.works.length > 1;
    const byWork = new Map<number, Line[]>();
    for (const l of lines) {
      const w = l.condition.workId ?? 0;
      byWork.set(w, [...(byWork.get(w) ?? []), l]);
    }
    const order = many ? view.works.map((w) => w.id) : [...byWork.keys()];
    for (const k of byWork.keys()) if (!order.includes(k)) order.push(k);
    return order.map((workId) => {
      const conds = view.conditions.filter((c) => (c.workId ?? 0) === workId);
      return {
        workId, band: many,
        title: view.works.find((w) => w.id === workId)?.title ?? conds[0]?.workTitle ?? "—",
        terms: conds.map((c) => `${c.usageLabel} ${c.pricingModel === "unit_rate" ? yen(c.unitAmount, c.currency) : `${(c.ratePpm ?? 0) / 10000}%`}`).join(" · "),
        lines: byWork.get(workId) ?? []
      };
    });
  }, [lines, view]);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 決定した計算書に載った報告の例外修正（admin）。理由が要る。 */
  const [correcting, setCorrecting] = useState<{ key: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(l: Line) {
    const usage = l.condition.usageType && ["in_house", "sublicense", "oem"].includes(l.condition.usageType) ? l.condition.usageType : null;
    // 基準価格は条件が持っていればそれ、無ければ前に打った実績のもの。
    const lastUnit = view.rounds.concat(view.history).flatMap((r) => r.parts).flatMap((p) => p.events)
      .filter((e) => e.conditionId === l.condition.id && e.unitAmount).slice(-1)[0]?.unitAmount ?? null;
    setDraft({ quantity: "", unit: String(l.condition.unitAmount ?? lastUnit ?? ""), gross: "", taxIncluded: false,
               on: l.part.closeOn ?? new Date().toISOString().slice(0, 10), note: "" });
    setEditing(l.key); void usage;
  }

  function startCorrect(l: Line) {
    const e = l.event!;
    setDraft({ quantity: e.quantity === null ? "" : String(e.quantity), unit: e.unitAmount ? String(e.unitAmount) : "",
               gross: e.grossAmount === null ? "" : String(e.grossAmount), taxIncluded: false,
               on: e.occurredOn ?? "", note: "" });
    setCorrecting({ key: l.key, reason: "" }); setEditing(l.key);
  }
  async function correct(l: Line) {
    if (!draft || !correcting || !l.event) return;
    const c = l.condition;
    const usage = c.usageType && ["in_house", "sublicense", "oem"].includes(c.usageType) ? c.usageType : null;
    const f = fieldsFor(usage, c.pricingModel);
    if (!correcting.reason.trim()) { onError("修正の理由を書いてください（監査に残ります）"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ documentId: number | null; documentNo: string | null }>("/royalty-ledger/corrections", {
        conditionId: c.id, eventId: l.event.id, reason: correcting.reason.trim(),
        ...(f.quantity ? { quantity: numOf(draft.quantity) || null } : {}),
        ...(f.unit ? { unitAmount: numOf(draft.unit) || null } : {}),
        ...(f.gross ? { grossAmount: numOf(draft.gross) || null } : {}),
        occurredOn: draft.on || null
      });
      const reason = correcting.reason.trim();
      setEditing(null); setDraft(null); setCorrecting(null);
      if (r.documentId && onReissue) onReissue(r.documentId, reason);
      else onChanged("報告を直しました");
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  async function record(l: Line) {
    if (!draft) return;
    const c = l.condition;
    const usage = c.usageType && ["in_house", "sublicense", "oem"].includes(c.usageType) ? c.usageType : null;
    const f = fieldsFor(usage, c.pricingModel);
    const quantity = f.quantity ? numOf(draft.quantity) : null;
    const gross = f.gross ? numOf(draft.gross) : null;
    const unit = f.unit ? numOf(draft.unit) : null;
    setBusy(true);
    try {
      await api.post(`/conditions/${c.id}/events`, {
        eventType: eventTypeFor(usage, c),
        occurredOn: draft.on,
        scheduleId: l.part.scheduleId,
        quantity: quantity || null,
        unitAmount: usage ? (unit || null) : null,
        grossAmount: gross || null,
        // 利用形態なしの実績は 総額＝実額（料率は計算書で掛ける）。
        amount: usage ? 0 : (gross ?? 0),
        taxIncluded: f.tax ? draft.taxIncluded : null,
        usageType: usage,
        outConditionId: usage === "in_house" ? null : l.outConditionId,
        languages: l.languages, regions: l.regions,
        note: draft.note.trim() || null
      });
      setEditing(null); setDraft(null);
      onChanged("報告を入れました");
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function skip(p: RoundPart, undo = false) {
    if (!p.scheduleId) return;
    try {
      if (undo) await api.del(`/royalty-ledger/skips?conditionId=${p.conditionId}&scheduleId=${p.scheduleId}`);
      else await api.post("/royalty-ledger/skips", { conditionId: p.conditionId, scheduleId: p.scheduleId });
      onChanged(undo ? "「報告なし」を取り消しました" : "報告なしにしました");
    } catch (e) { onError((e as ApiError).message); }
  }
  async function unplan(id: number) {
    try { await api.del(`/royalty-ledger/plans/${id}`); onChanged("予定を外しました"); }
    catch (e) { onError((e as ApiError).message); }
  }
  async function voidEvent(e: LedgerEvent) {
    const reason = window.prompt("この報告を取り消します。理由（監査に残ります）：", "入力違い");
    if (reason === null) return;
    try {
      await api.post(`/conditions/${e.conditionId}/events/${e.id}/void`, { reason: reason.trim() || "入力違い" });
      onChanged("報告を取り消しました");
    } catch (x) { onError((x as ApiError).message); }
  }

  const scope = (l: Line) => [...l.languages, ...l.regions];
  const stateOf = (l: Line) => l.event
    ? (l.event.documentId ? { label: "計算書済", tag: "ok" } : { label: "入力済", tag: "accent" })
    : l.part.skipped ? { label: "報告なし", tag: "" }
    : l.planId && l.part.state === "before" ? { label: "予定", tag: "pin" }
    : l.part.state === "before" ? { label: "締め前", tag: "" }
    : l.planId ? { label: "予定（報告待ち）", tag: "pin" }
    : { label: "報告待ち", tag: "warn" };

  const firstWait = lines.find((l) => !l.event && !l.part.skipped && l.part.state !== "before");
  return (
    <div className="stack" style={{ gap: 6 }}>
      {canWrite && !adding && (
        <div className="report-actions">
          <button className="btn primary btn-big" onClick={() => setAdding({ mode: "report" })}>＋ 報告を追加</button>
          <button className="btn btn-big" onClick={() => setAdding({ mode: "plan" })}>＋ 予定を作る</button>
          <span className="faint">報告を追加＝数字が来た。予定を作る＝まだ数字は無いが、この許諾先から来るはず（以後の回でも待つ）。</span>
          {firstWait && <span className="faint" style={{ marginLeft: "auto" }}>来るはずの行はもう並んでいます。まずは黄色の行へ。</span>}
        </div>
      )}
      {adding && (
        <AddLine key={`${adding.mode}-${adding.conditionId ?? ""}`} mode={adding.mode} round={round} view={view}
                 conditionId={adding.conditionId ?? null} onCancel={() => setAdding(null)}
                 onAdded={(m) => { setAdding(null); onChanged(m); }} onError={onError} />
      )}
      <div className="tablewrap">
        <table className="report">
          <thead>
            <tr><th>行（許諾先・製品）</th><th>言語・地域</th><th className="num">数量</th><th className="num">単価・受領額</th><th>発生日</th><th>状態</th><th></th></tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              g.band && (
                <tr key={`w${g.workId}`} className="work">
                  <td colSpan={7}>
                    <span className="row" style={{ gap: 8 }}>
                      <span>{g.title}</span>
                      <span className="faint">{g.terms}</span>
                      {g.lines.length === 0 && <span className="faint">この回に締めなし（「条件と締めの設定…」で締めを作る）</span>}
                      {canWrite && g.lines.length > 0 && (
                        <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                                onClick={() => setAdding({ mode: "report", conditionId: g.lines[0].condition.id })}>＋ この作品の報告を追加</button>
                      )}
                    </span>
                  </td>
                </tr>
              ),
              ...g.lines.map((l) => {
              const c = l.condition;
              const usage = c.usageType && ["in_house", "sublicense", "oem"].includes(c.usageType) ? c.usageType : null;
              const f = fieldsFor(usage, c.pricingModel);
              const st = stateOf(l);
              const isEdit = editing === l.key && draft;
              const head = l.outName ?? l.event?.workTitle ?? c.workTitle ?? "—";
              return (
                <tr key={l.key} className={isEdit ? "edit" : l.planId && !l.event ? "plan" : st.tag === "warn" ? "wait" : ""}>
                  <td>
                    <div>{head}</div>
                    <div className="faint">{c.workTitle && l.outName ? `${c.workTitle} · ` : ""}{c.usageLabel}{l.why ? `（${l.why}）` : ""}</div>
                  </td>
                  <td>{scope(l).length ? scope(l).join("・") : <span className="faint">—</span>}</td>
                  {isEdit ? (
                    <>
                      <td className="num">
                        {f.quantity
                          ? <input className="inline-input num" style={{ width: 90 }} value={draft.quantity} placeholder="数量" aria-label="数量" autoFocus
                                   onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
                          : <span className="faint">—</span>}
                      </td>
                      <td className="num">
                        <span className="stack" style={{ gap: 3, alignItems: "flex-end" }}>
                          {f.unit && <input className="inline-input num" style={{ width: 110 }} value={draft.unit} placeholder={usage === "oem" ? "単価" : "基準価格"} aria-label="単価"
                                            onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />}
                          {f.gross && <input className="inline-input num" style={{ width: 130 }} value={draft.gross} placeholder={f.grossLabel} aria-label={f.grossLabel}
                                             onChange={(e) => setDraft({ ...draft, gross: e.target.value })} />}
                          {f.tax && <label className="ledger-check"><input type="checkbox" checked={draft.taxIncluded}
                                              onChange={(e) => setDraft({ ...draft, taxIncluded: e.target.checked })} /> 税込</label>}
                        </span>
                      </td>
                      <td><input className="inline-input" type="date" value={draft.on} aria-label="発生日" onChange={(e) => setDraft({ ...draft, on: e.target.value })} /></td>
                      <td><span className="tag accent">{correcting ? "例外修正" : "入力中"}</span></td>
                      <td>
                        {correcting?.key === l.key ? (
                          <span className="stack" style={{ gap: 4 }}>
                            <input className="inline-input" placeholder="修正の理由（必須・監査に残る）" aria-label="修正の理由"
                                   value={correcting.reason} onChange={(e) => setCorrecting({ key: l.key, reason: e.target.value })} />
                            <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                              <button className="btn btn-sm primary" disabled={busy || !correcting.reason.trim()} onClick={() => void correct(l)}>
                                直して訂正版を出す
                              </button>
                              <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing(null); setDraft(null); setCorrecting(null); }}>やめる</button>
                            </span>
                            <span className="faint">許諾料は料率で計算し直します。決定すると元の計算書 {l.event?.documentNo ?? ""} は「訂正版あり」に退きます。</span>
                          </span>
                        ) : (
                          <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                            <button className="btn btn-sm primary" disabled={busy} onClick={() => void record(l)}>記録</button>
                            <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing(null); setDraft(null); }}>やめる</button>
                          </span>
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="num">{l.event?.quantity !== null && l.event?.quantity !== undefined ? l.event.quantity.toLocaleString() : <span className="faint">—</span>}</td>
                      <td className="num">
                        {l.event
                          ? <>{l.event.unitAmount
                                ? <span className="faint">{yen(l.event.unitAmount, c.currency)} × {l.event.quantity?.toLocaleString() ?? "—"} = </span> : ""}
                              {l.event.grossAmount !== null ? yen(l.event.grossAmount, c.currency) : ""}
                              <div className="faint">許諾料 {yen(l.event.amount, c.currency)}</div></>
                          : <span className="faint">—</span>}
                      </td>
                      <td className="code">{l.event?.occurredOn ?? <span className="faint">—</span>}</td>
                      <td><span className={`tag ${st.tag}`}>{st.label}</span></td>
                      <td>
                        <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                          {l.event?.documentId && (onOpenDocument
                            ? <button className="linky code" onClick={() => onOpenDocument(l.event!.documentId!)}>{l.event.documentNo ?? `#${l.event.documentId}`}</button>
                            : <span className="code">{l.event.documentNo ?? `#${l.event.documentId}`}</span>)}
                          {canWrite && l.event && !l.event.documentId && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => void voidEvent(l.event!)}>取り消す</button>
                          )}
                          {isAdmin && l.event?.documentId && onReissue && (
                            <button className="btn btn-sm" disabled={busy || editing !== null}
                                    title="例外：決定した計算書に載った数字を直し、訂正版を出し直す（admin）"
                                    onClick={() => startCorrect(l)}>修正して出し直す</button>
                          )}
                          {canWrite && !l.event && !l.part.skipped && (
                            <button className="btn btn-sm primary" disabled={busy || editing !== null} onClick={() => startEdit(l)}>数字を入れる</button>
                          )}
                          {canWrite && !l.event && !l.part.skipped && l.part.scheduleId && !l.part.events.length && (
                            <button className="btn btn-sm" disabled={busy} title="この回は報告が来なかった" onClick={() => void skip(l.part)}>報告なし</button>
                          )}
                          {canWrite && !l.event && l.planId && (
                            <button className="btn btn-sm" disabled={busy} title="予定の行を消す（実績は消えない）" onClick={() => void unplan(l.planId!)}>予定を外す</button>
                          )}
                          {canWrite && l.part.skipped && l.part.scheduleId && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => void skip(l.part, true)}>取り消す</button>
                          )}
                        </span>
                      </td>
                    </>
                  )}
                </tr>
              );
            })])}
            {!lines.length && <tr><td colSpan={7} className="faint">この回に行はありません。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 予定にない報告の行を足す：条件（作品・利用形態）→ 許諾先 → 言語 → 地域。 */
function AddLine(
  { mode, round, view, conditionId, onCancel, onAdded, onError }: {
    mode: "report" | "plan"; round: Round; view: LedgerView; conditionId: number | null; onCancel: () => void;
    onAdded: (message: string) => void; onError: (m: string) => void;
  }
) {
  // 報告なしにした回には足さない。計算書済の回には足せる（遅れて来た報告は次の計算書に載る）。
  const parts = round.parts.filter((p) => !p.skipped);
  const first = parts.find((p) => p.conditionId === conditionId) ?? parts[0];
  const [partKey, setPartKey] = useState(first ? `${first.conditionId}:${first.scheduleId ?? ""}` : "");
  const [fromWhen, setFromWhen] = useState<"this" | "next">("this");
  const part = parts.find((p) => `${p.conditionId}:${p.scheduleId ?? ""}` === partKey) ?? null;
  const cond = part ? view.conditions.find((c) => c.id === part.conditionId)! : null;
  const usage = cond?.usageType && ["sublicense", "oem"].includes(cond.usageType) ? cond.usageType : null;
  const [outs, setOuts] = useState<Array<{ id: number; name: string; partyName: string | null; languages: string[]; regions: string[] }>>([]);
  const [outId, setOutId] = useState("");
  const [language, setLanguage] = useState("");
  const [region, setRegion] = useState("");
  const [draft, setDraft] = useState<Draft>({ quantity: "", unit: "", gross: "", taxIncluded: false,
                                              on: part?.closeOn ?? new Date().toISOString().slice(0, 10), note: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!cond || !usage) { setOuts([]); return; }
    api.get<{ conditions: typeof outs }>(`/conditions/${cond.id}/out-candidates?usage=${usage}`)
      .then((r) => { setOuts(r.conditions); setOutId(String(r.conditions[0]?.id ?? "")); })
      .catch((e: ApiError) => onError(e.message));
  }, [cond?.id, usage]);
  const out = outs.find((o) => String(o.id) === outId) ?? null;
  useEffect(() => { setLanguage(out?.languages[0] ?? ""); setRegion(out?.regions[0] ?? ""); }, [out?.id]);
  if (!cond || !part) {
    return (
      <div className="note stack" style={{ gap: 4 }}>
        <b>足せる行がありません</b>
        <span className="faint">この回の条件はすべて「報告なし」です。取り消してから足すか、別の回を選んでください。</span>
        <button className="btn btn-sm" onClick={onCancel}>閉じる</button>
      </div>
    );
  }
  const inHouse = cond.usageType === "in_house";
  const f = fieldsFor(usage ?? (inHouse ? "in_house" : null), cond.pricingModel);

  async function plan() {
    if (!cond || !part) return;
    setBusy(true);
    try {
      // この回から＝この回の期間の始まり（無ければ締め日）。次の回から＝この回の締めの翌日。
      const fromOn = fromWhen === "this"
        ? (part.periodFrom ?? part.closeOn ?? draft.on)
        : iso(new Date(new Date(`${part.closeOn ?? draft.on}T00:00:00Z`).getTime() + 86_400_000));
      await api.post("/royalty-ledger/plans", {
        conditionId: cond.id, outConditionId: usage ? Number(outId) || null : null,
        languages: language ? [language] : [], regions: region ? [region] : [], fromOn
      });
      onAdded("予定を置きました");
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  async function add() {
    if (!cond || !part) return;
    setBusy(true);
    try {
      const u = usage ?? (inHouse ? "in_house" : null);
      const gross = f.gross ? numOf(draft.gross) : null;
      await api.post(`/conditions/${cond.id}/events`, {
        eventType: eventTypeFor(u, cond), occurredOn: draft.on, scheduleId: part.scheduleId,
        quantity: f.quantity ? numOf(draft.quantity) || null : null,
        unitAmount: f.unit ? numOf(draft.unit) || null : null,
        grossAmount: gross || null, amount: u ? 0 : (gross ?? 0),
        taxIncluded: f.tax ? draft.taxIncluded : null,
        usageType: u, outConditionId: usage ? Number(outId) || null : null,
        languages: language ? [language] : [], regions: region ? [region] : [],
        note: draft.note.trim() || null
      });
      onAdded("報告を足しました");
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const isPlan = mode === "plan";
  return (
    <div className={`note stack${isPlan ? " pin" : ""}`} style={{ gap: 6 }}>
      <b>{isPlan ? "予定を作る" : "報告を追加"}</b>
      <span className="faint">{isPlan
        ? "数字はまだ無い。この許諾先・言語・地域から報告が来るはず、という行を置く。以後の回でも「来るはず」として待つ。"
        : "記録すると入力済の行になり、以後の回でも「来るはず」として待つ。"}</span>
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 4 }}><span className="faint">作品 · 利用形態</span>
          <select value={partKey} onChange={(e) => setPartKey(e.target.value)}>
            {parts.map((p) => { const c = view.conditions.find((x) => x.id === p.conditionId)!;
              return <option key={`${p.conditionId}:${p.scheduleId ?? ""}`} value={`${p.conditionId}:${p.scheduleId ?? ""}`}>{c.workTitle ?? ""} · {c.usageLabel}</option>; })}
          </select></label>
        {usage && (
          <label className="row" style={{ gap: 4 }}><span className="faint">許諾先</span>
            <select value={outId} onChange={(e) => setOutId(e.target.value)}>
              {outs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              {!outs.length && <option value="">（許諾先がありません）</option>}
            </select></label>
        )}
        {out && out.languages.length > 0 && (
          <label className="row" style={{ gap: 4 }}><span className="faint">言語</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {out.languages.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></label>
        )}
        {out && out.regions.length > 0 && (
          <label className="row" style={{ gap: 4 }}><span className="faint">地域</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {out.regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select></label>
        )}
      </div>
      {isPlan ? (
        <div className="row" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 4 }}><span className="faint">いつから</span>
            <select value={fromWhen} onChange={(e) => setFromWhen(e.target.value as "this" | "next")}>
              <option value="this">この回（{part.label ?? part.closeOn ?? ""}）から</option>
              <option value="next">次の回から</option>
            </select></label>
          <button className="btn btn-sm primary" disabled={busy || (Boolean(usage) && !outId)} onClick={() => void plan()}>予定を置く</button>
          <button className="btn btn-sm" disabled={busy} onClick={onCancel}>やめる</button>
          <span className="faint">置いた行は「予定」の色で並び、数字が来たら「数字を入れる」。来なければ「報告なし」か「予定を外す」。</span>
        </div>
      ) : (
      <div className="row" style={{ gap: 8 }}>
        {f.quantity && <input className="inline-input num" style={{ width: 90 }} placeholder="数量" aria-label="数量" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />}
        {f.unit && <input className="inline-input num" style={{ width: 110 }} placeholder={usage === "oem" ? "単価" : "基準価格"} aria-label="単価" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />}
        {f.gross && <input className="inline-input num" style={{ width: 130 }} placeholder={f.grossLabel} aria-label={f.grossLabel} value={draft.gross} onChange={(e) => setDraft({ ...draft, gross: e.target.value })} />}
        {f.tax && <label className="ledger-check"><input type="checkbox" checked={draft.taxIncluded} onChange={(e) => setDraft({ ...draft, taxIncluded: e.target.checked })} /> 税込</label>}
        <input className="inline-input" type="date" value={draft.on} aria-label="発生日" onChange={(e) => setDraft({ ...draft, on: e.target.value })} />
        <button className="btn btn-sm primary" disabled={busy || (Boolean(usage) && !outId)} onClick={() => void add()}>記録</button>
        <button className="btn btn-sm" disabled={busy} onClick={onCancel}>やめる</button>
      </div>
      )}
    </div>
  );
}
