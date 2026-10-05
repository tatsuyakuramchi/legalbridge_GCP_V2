import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import type { ConditionSummary } from "../server/core/model.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { ConditionEvents } from "./ConditionEvents.js";
import { CONDITION_KIND_LABEL, SettlementTag } from "./labels.js";
import { useReadOnly } from "./read-only.js";
import { settlementDocFor } from "../server/documents/settlement-docs.js";

/**
 * 取引を進める：支払（検収書・利用許諾計算書）。
 *
 * 支払文書は納品や利用の報告が来てから走る。実績が無いのに検収書・計算書は作れないので、
 * 順番を固定して 1 枚で進める。
 *   ① 相手と条件 … 誰のどの取り決めの支払か
 *   ② 実績 … 業務委託は納品・検収、ライセンスは利用（製造・販売など）の報告
 *   ③ 検収書・計算書 … 立てた実績を選んで作る（実績の無い文書は作れない）
 *   ④ 送る … 決めた文書を開いて送る（メール／CloudSign）
 *   ⑤ 支払 … 決めた文書から立つ
 * ② は条件の画面と同じ部品（ConditionEvents）で実績を足す。
 * ③ は選んだ条件（複数可）の実績を 1 つの表に並べ、チェックした実績で文書を 1 枚作る。
 *    検収書は条件をまたいでまとめられる（1 回の納品で複数の発注行を検収する）。
 *    計算書は料率が条件ごとなので 1 枚に 1 条件。
 * 予定（回）が並んでいるものを月でまとめて締めるのは、支払文書処理の画面。
 */

type Kind = "service" | "license";

interface EventLite {
  id: number; status: string; eventType: string; occurredOn: string | null;
  quantity: number | null; amount: number; deliverable?: string | null; period?: string | null;
  documentId: number | null; documentNo?: string | null; documentStatus: string | null;
  paymentId?: number | null;
}
/** 実績に、どの条件のものかを添えたもの（複数の条件の実績を 1 つの表に並べる）。 */
type PayEvent = EventLite & { condition: ConditionSummary };

const STEPS = ["相手と条件", "実績（納品・利用の報告）", "検収書・計算書", "送る", "支払"] as const;

const liveEvent = (e: EventLite) => e.status !== "void";
const liveDoc = (e: EventLite) => e.documentId !== null && e.documentStatus !== "void" && e.documentStatus !== "superseded";

/** 実績の進み具合から、いまどの段か（1 始まり）。 */
export function paymentStageOf(conditionChosen: boolean, events: EventLite[]): number {
  if (!conditionChosen) return 1;
  const live = events.filter(liveEvent);
  if (!live.length) return 2;
  if (live.some((e) => !liveDoc(e))) return 3;
  if (live.some((e) => e.documentStatus === "draft")) return 4;
  if (live.some((e) => !e.paymentId)) return 5;
  return 6;
}

export function TradePayment(
  { onBack, onCompose, onOpenDocument, onOpenPayments }: {
    onBack: () => void;
    onCompose: (conditionIds: number[], eventIds?: number[], matterId?: number | null, templateKey?: string | null) => void;
    onOpenDocument: (id: number) => void;
    /** 予定の回を月でまとめて締める（支払文書処理の画面）。 */
    onOpenPayments: () => void;
  }
) {
  const readOnly = useReadOnly();
  const [kind, setKind] = useState<Kind>("service");
  const [partyId, setPartyId] = useState("");
  const [partyLabel, setPartyLabel] = useState<string | null>(null);
  const [workId, setWorkId] = useState("");
  const [workLabel, setWorkLabel] = useState<string | null>(null);
  const [conditions, setConditions] = useState<ConditionSummary[] | null>(null);
  /** 選んだ条件（複数可）。1 枚の検収書に複数の条件の実績をまとめられる。 */
  const [chosenIds, setChosenIds] = useState<number[]>([]);
  /** 実績を足す条件（選んだ条件のうち 1 つ）。 */
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const [events, setEvents] = useState<PayEvent[]>([]);
  /** 文書にする実績。既定は文書になっていない実績ぜんぶ。 */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 相手が決まったら、その相手との取得側（当社が払う）の条件を並べる。
  /** 条件の一覧を引き直す（実費・手数料を足したあと）。選んだ条件は保つ。 */
  const [listVersion, setListVersion] = useState(0);
  useEffect(() => { setChosenIds([]); setConditions(null); }, [partyId, workId]);
  useEffect(() => {
    if (!partyId) return;
    const q = new URLSearchParams({ counterpartyId: partyId, direction: "in" });
    if (workId) q.set("workId", workId);
    api.get<{ conditions: ConditionSummary[] }>(`/conditions?${q}`)
      .then((r) => setConditions(r.conditions.filter((c) => c.status === "active" || c.status === "draft" || c.status === "scheduled")))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [partyId, workId, listVersion]);

  const ofKind = (c: ConditionSummary) => kind === "license" ? c.kind === "license" : c.kind !== "license";
  const shown = (conditions ?? []).filter(ofKind);
  const chosen = shown.filter((c) => chosenIds.includes(c.id));
  const recording = chosen.find((c) => c.id === recordingId) ?? chosen[0] ?? null;
  const docLabel = kind === "service" ? "検収書" : "利用許諾計算書";

  // 選んだ条件の実績をまとめて引く。表（③）と段の進み具合に使う。
  useEffect(() => {
    if (!chosen.length) { setEvents([]); return; }
    let alive = true;
    Promise.all(chosen.map((c) => api.get<{ events: EventLite[] }>(`/conditions/${c.id}/events`)
      .then((r) => r.events.map((e) => ({ ...e, condition: c })))
      .catch(() => [] as PayEvent[])))
      .then((lists) => {
        if (!alive) return;
        const all = lists.flat();
        setEvents(all);
        // 文書になっていない実績は既定で選んでおく（まとめて 1 枚が普通）。
        setPicked(new Set(all.filter((e) => liveEvent(e) && !liveDoc(e)).map((e) => e.id)));
      });
    return () => { alive = false; };
  }, [chosen.map((c) => c.id).join(","), kind, reloadKey]);

  const toggleCondition = (id: number) =>
    setChosenIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const togglePick = (id: number) =>
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const stage = paymentStageOf(chosen.length > 0, events);
  const live = events.filter(liveEvent);
  const waiting = live.filter((e) => !liveDoc(e));
  const drafts = live.filter((e) => e.documentStatus === "draft");
  const pickedEvents = waiting.filter((e) => picked.has(e.id));
  const pickedConditionIds = [...new Set(pickedEvents.map((e) => e.condition.id))];
  // 計算書は条件ごとに料率で計算するので、1 枚に 1 条件。検収書は条件をまたいでまとめられる。
  const tooManyForStatement = kind === "license" && pickedConditionIds.length > 1;
  const pickedTotal = pickedEvents.reduce((a, e) => a + (e.amount ?? 0), 0);
  const currency = pickedEvents[0]?.condition.currency ?? "JPY";

  return (
    <section className="stack">
      <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0 }}>取引を進める：支払（検収書・利用許諾計算書）</h1>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onBack}>取引の種類に戻る</button>
      </div>
      <p className="faint" style={{ margin: 0 }}>
        支払文書は、納品や利用の報告が来てから作ります。先に実績を立て、その実績を選んで検収書・計算書を作ります（実績の無い文書は作れません）。
        予定（回）が並んでいるものを月でまとめて締めるなら
        <button className="linky" onClick={onOpenPayments}>支払文書処理の画面</button>へ。
      </p>
      {error && <div className="alert">{error}</div>}

      <div className="pipe" aria-label="進み具合">
        {STEPS.map((name, i) => {
          const no = i + 1; const done = stage > no;
          return (
            <span key={name} className={`pipe-step${stage === no ? " open" : ""}`}
                  style={done ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}>
              <span className="st">{done ? "済" : no}</span><span className="nm">{name}</span>
            </span>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-hd"><h2>① 相手と条件</h2>
          <span className="faint">誰の、どの取り決めの支払か。{kind === "service" ? "1 枚の検収書にまとめる条件は複数選べます" : ""}</span></div>
        <div className="panel-bd stack" style={{ gap: 10 }}>
          <div className="row" role="group" aria-label="支払の種類" style={{ gap: 6 }}>
            {([["service", "業務委託の納品 → 検収書"], ["license", "ライセンスの利用報告 → 利用許諾計算書"]] as const).map(([v, label]) => (
              <button key={v} type="button" className="chip" aria-pressed={kind === v}
                      onClick={() => { setKind(v); setChosenIds([]); }}>{label}</button>
            ))}
          </div>
          <div className="form-grid">
            <label className="field"><span>{kind === "service" ? "受託者（相手先）" : "権利元（相手先）"}</span>
              <SearchSelect value={partyId} search={searchParties} valueLabel={partyLabel} placeholder="取引先名・コードで探す"
                            onChange={(v, o) => { setPartyId(v); setPartyLabel(o?.label ?? null); }} /></label>
            <label className="field"><span>作品（任意。絞り込み）</span>
              <SearchSelect value={workId} search={searchWorks} valueLabel={workLabel} emptyLabel="（絞らない）" placeholder="作品名・コードで探す"
                            onChange={(v, o) => { setWorkId(v); setWorkLabel(o?.label ?? null); }} /></label>
          </div>
          {!partyId && <span className="faint">相手先を選ぶと、その相手との条件明細が並びます。</span>}
          {partyId && conditions && !shown.length && (
            <div className="note">
              この相手との{kind === "service" ? "業務委託" : "利用許諾（取得）"}の条件明細がありません。
              先に「{kind === "service" ? "業務委託 発注" : "IN：権利を取得"}」で条件を立ててください。
            </div>
          )}
          {shown.length > 0 && (
            <div className="tablewrap">
              <table>
                <thead><tr><th></th><th>条件</th><th>種類</th><th>作品</th><th className="num">金額・料率</th><th>進み具合</th></tr></thead>
                <tbody>
                  {shown.map((c) => {
                    const on = chosenIds.includes(c.id);
                    return (
                      <tr key={c.id} tabIndex={0} className={on ? "sel" : undefined}
                          onClick={() => toggleCondition(c.id)}
                          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleCondition(c.id))}>
                        <td><input type="checkbox" checked={on} onClick={(e) => e.stopPropagation()} onChange={() => toggleCondition(c.id)}
                                   aria-label={`${c.name} を選ぶ`} /></td>
                        <td><div>{c.name}</div><div className="faint code">{c.conditionNo ?? `#${c.id}`}</div></td>
                        <td>{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</td>
                        <td>{c.work?.title ?? "—"}</td>
                        <td className="num">{c.ratePpm != null ? `${c.ratePpm / 10000}%`
                          : c.flatAmount != null ? money(c.flatAmount, c.currency)
                          : c.unitAmount != null ? `単価 ${money(c.unitAmount, c.currency)}` : "—"}</td>
                        <td><SettlementTag settlement={c.settlement} compact /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {recording && (
        <div className="panel">
          <div className="panel-hd">
            <h2>② 実績を立てる</h2>
            <span className="faint">{kind === "service" ? "納品が来たら、条件ごとに納品の実績を足す" : "利用の報告が来たら、報告の期間・製造数や売上を実績にする"}</span>
          </div>
          <div className="panel-bd stack" style={{ gap: 10 }}>
            {chosen.length > 1 && (
              <div className="row" role="group" aria-label="実績を足す条件" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className="faint">実績を足す条件：</span>
                {chosen.map((c) => (
                  <button key={c.id} type="button" className="chip" aria-pressed={c.id === recording.id}
                          onClick={() => setRecordingId(c.id)}>
                    {c.work?.title ? `${c.work.title}｜` : ""}{c.name}
                  </button>
                ))}
              </div>
            )}
            {!live.length && (
              <div className="note">
                {kind === "service"
                  ? "まず納品の実績を立てます。下の「実績を足す」から、納品日・成果物・数量・金額・検収日を入れてください。"
                  : "まず利用の報告を実績にします。下の「実績を足す」から、報告の期間・製造数や売上・控除を入れてください。"}
              </div>
            )}
            {kind === "service" && !readOnly && (
              <ExtraCharge base={recording}
                onMade={(conditionId) => {
                  // 足した実費の条件を選んだ条件に加え、③ に実績が並ぶようにする。
                  setChosenIds((prev) => prev.includes(conditionId) ? prev : [...prev, conditionId]);
                  setListVersion((v) => v + 1);
                }}
                onError={setError} />
            )}
            <ConditionEvents key={recording.id}
              conditionId={recording.id} currency={recording.currency}
              editable={!readOnly && (recording.status === "active" || recording.status === "draft")}
              reloadKey={reloadKey}
              pricingModel={recording.pricingModel} ratePpm={recording.ratePpm}
              conditionUnitAmount={recording.unitAmount} conditionQuantity={recording.quantity}
              direction={recording.direction} kind={recording.kind}
              workTitle={recording.work?.title ?? null} workId={recording.work?.id ?? null}
              onCompose={onCompose} onOpenDocument={onOpenDocument}
              onChanged={() => setReloadKey((v) => v + 1)} />
          </div>
        </div>
      )}

      {chosen.length > 0 && (
        <div className="panel">
          <div className="panel-hd">
            <h2>③ {docLabel}にする実績を選ぶ</h2>
            <span className="faint">
              {kind === "service"
                ? "チェックした実績を 1 枚の検収書にまとめます（条件をまたいでも可）。分けたいときは、チェックを外して 2 回に分けて作ります"
                : "計算書は条件ごとに 1 枚。同じ条件の報告はまとめて 1 枚にできます"}
            </span>
          </div>
          <div className="panel-bd stack" style={{ gap: 10 }}>
            {!waiting.length
              ? <span className="faint">{live.length ? "文書になっていない実績はありません。" : "まだ実績がありません。② で実績を足すと、ここに並びます。"}</span>
              : (
                <div className="tablewrap">
                  <table>
                    <thead><tr>
                      <th><input type="checkbox" aria-label="すべて選ぶ"
                                 checked={waiting.every((e) => picked.has(e.id))}
                                 onChange={(e) => setPicked(e.target.checked ? new Set(waiting.map((x) => x.id)) : new Set())} /></th>
                      <th>条件</th><th>作品</th><th>{kind === "service" ? "納品日" : "発生日・期間"}</th><th>成果物・摘要</th>
                      <th className="num">数量</th><th className="num">金額（税抜）</th>
                    </tr></thead>
                    <tbody>
                      {waiting.map((e) => (
                        <tr key={e.id} className={picked.has(e.id) ? "sel" : undefined} onClick={() => togglePick(e.id)}>
                          <td><input type="checkbox" checked={picked.has(e.id)} onClick={(x) => x.stopPropagation()} onChange={() => togglePick(e.id)}
                                     aria-label={`実績 ${e.occurredOn ?? ""} を選ぶ`} /></td>
                          <td><div>{e.condition.name}</div><div className="faint code">{e.condition.conditionNo ?? `#${e.condition.id}`}</div></td>
                          <td>{e.condition.work?.title ?? "—"}</td>
                          <td className="code">{e.occurredOn ?? "—"}{e.period ? `（${e.period}）` : ""}</td>
                          <td>{e.deliverable ?? "—"}</td>
                          <td className="num">{e.quantity ?? "—"}</td>
                          <td className="num">{money(e.amount ?? 0, e.condition.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            {waiting.length > 0 && (
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <button className="btn primary" disabled={readOnly || !pickedEvents.length || tooManyForStatement}
                        onClick={() => onCompose(pickedConditionIds, pickedEvents.map((e) => e.id), null, settlementDocFor(pickedEvents[0]?.condition.kind).templateKey)}>
                  選んだ実績 {pickedEvents.length} 件で{docLabel}を 1 枚作る
                </button>
                {pickedEvents.length > 0 && <span>合計（税抜） <b>{money(pickedTotal, currency)}</b>　条件 {pickedConditionIds.length} 本</span>}
                {tooManyForStatement && <span className="alert">計算書は条件ごとに作ります。1 つの条件の実績だけを選んでください。</span>}
                <span className="faint">文書の画面に移り、選んだ実績が入った状態で開きます。決定すると実績に結びつきます。</span>
              </div>
            )}
          </div>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>④ 送る</h2><span className="faint">下書きの文書を開いて決定し、送ります。支払（⑤）は決めた文書から立ちます</span></div>
          <div className="panel-bd row" style={{ gap: 6, flexWrap: "wrap" }}>
            {[...new Map(drafts.map((e) => [e.documentId!, e])).values()].map((e) => (
              <button key={e.documentId} className="btn btn-sm" onClick={() => onOpenDocument(e.documentId!)}>
                {e.documentNo ?? `文書 #${e.documentId}`} を開く
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 実費・手数料を後から足す（交通費の漏れなど）。選んでいる委託料の条件から相手先・契約・
 * 案件を写して実費（または手数料）の条件を作り、実績まで一度に立てる。
 * 足した実績は ③ に並び、委託料の実績と一緒に 1 枚の検収書にできる。
 */
function ExtraCharge(
  { base, onMade, onError }: {
    base: ConditionSummary; onMade: (conditionId: number) => void; onError: (m: string) => void;
  }
) {
  const [open, setOpen] = useState(false);
  const [extraKind, setExtraKind] = useState<"expense" | "fee">("expense");
  const [name, setName] = useState("交通費");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const value = Math.round(Number(amount.replace(/[,，¥￥\s]/g, "")) || 0);

  async function save() {
    setBusy(true); setDone(null);
    try {
      const r = await api.post<{ conditionId: number; conditionNo: string | null }>(`/conditions/${base.id}/extras`, {
        kind: extraKind, name: name.trim(), amount: value, occurredOn, note: note.trim() || null
      });
      setDone(`${r.conditionNo ?? "条件"}（${name.trim()} ${money(value, base.currency)}${extraKind === "expense" ? "・税込" : ""}）を足し、実績を立てました。③ に並びます`);
      setAmount(""); setNote(""); setOpen(false);
      onMade(r.conditionId);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>実費・手数料を足す（交通費の漏れなど）</button>
        {done && <span className="faint">{done}</span>}
      </div>
    );
  }
  return (
    <div className="note stack" style={{ gap: 8 }}>
      <b>実費・手数料を足す</b>
      <span className="faint">
        {base.conditionNo ?? `#${base.id}`} {base.name} と同じ相手先・契約・案件で条件を作り、実績まで立てます。
      </span>
      <div className="row" role="group" aria-label="種類" style={{ gap: 6 }}>
        {([["expense", "実費（交通費・宿泊費など。税込）"], ["fee", "手数料（税抜）"]] as const).map(([v, label]) => (
          <button key={v} type="button" className="chip" aria-pressed={extraKind === v}
                  onClick={() => { setExtraKind(v); if (v === "fee" && name === "交通費") setName("振込手数料"); if (v === "expense" && name === "振込手数料") setName("交通費"); }}>{label}</button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field"><span>名前（検収書の経費の行に出る）</span>
          <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>金額（{extraKind === "expense" ? "税込" : "税抜"}）</span>
          <input value={amount} placeholder="3200" inputMode="numeric" onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>{extraKind === "expense" ? "利用日" : "発生日"}</span>
          <input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} /></label>
        <label className="field"><span>備考</span>
          <input value={note} placeholder="東京⇔大阪 往復 など" onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary btn-sm" disabled={busy || !name.trim() || value <= 0 || !occurredOn} onClick={() => void save()}>
          {busy ? "足しています…" : "足して実績を立てる"}
        </button>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>やめる</button>
      </div>
    </div>
  );
}
