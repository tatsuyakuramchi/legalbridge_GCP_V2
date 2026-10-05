import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import type { ConditionSummary } from "../server/core/model.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { ConditionEvents } from "./ConditionEvents.js";
import { CONDITION_KIND_LABEL, SettlementTag } from "./labels.js";
import { useReadOnly } from "./read-only.js";

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
 * ②③ は条件の画面と同じ部品（ConditionEvents）を使う。欄も動きも同じ。
 * 予定（回）が並んでいるものを月でまとめて締めるのは、支払文書処理の画面。
 */

type Kind = "service" | "license";

interface EventLite {
  id: number; status: string;
  documentId: number | null; documentStatus: string | null;
  paymentId?: number | null;
}

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
  const [chosen, setChosen] = useState<ConditionSummary | null>(null);
  const [events, setEvents] = useState<EventLite[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 相手が決まったら、その相手との取得側（当社が払う）の条件を並べる。
  useEffect(() => {
    setChosen(null); setConditions(null);
    if (!partyId) return;
    const q = new URLSearchParams({ counterpartyId: partyId, direction: "in" });
    if (workId) q.set("workId", workId);
    api.get<{ conditions: ConditionSummary[] }>(`/conditions?${q}`)
      .then((r) => setConditions(r.conditions.filter((c) => c.status === "active" || c.status === "draft" || c.status === "scheduled")))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [partyId, workId]);

  // 選んだ条件の実績。段の進み具合を出すのに使う（表そのものは ConditionEvents が出す）。
  useEffect(() => {
    if (!chosen) { setEvents([]); return; }
    api.get<{ events: EventLite[] }>(`/conditions/${chosen.id}/events`)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [chosen?.id, reloadKey]);

  const ofKind = (c: ConditionSummary) => kind === "license" ? c.kind === "license" : c.kind !== "license";
  const shown = (conditions ?? []).filter(ofKind);
  const stage = paymentStageOf(Boolean(chosen), events);
  const live = events.filter(liveEvent);
  const waitingDoc = live.filter((e) => !liveDoc(e)).length;
  const drafts = live.filter((e) => e.documentStatus === "draft");

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
          <span className="faint">誰の、どの取り決めの支払か</span></div>
        <div className="panel-bd stack" style={{ gap: 10 }}>
          <div className="row" role="group" aria-label="支払の種類" style={{ gap: 6 }}>
            {([["service", "業務委託の納品 → 検収書"], ["license", "ライセンスの利用報告 → 利用許諾計算書"]] as const).map(([v, label]) => (
              <button key={v} type="button" className="chip" aria-pressed={kind === v}
                      onClick={() => { setKind(v); setChosen(null); }}>{label}</button>
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
                  {shown.map((c) => (
                    <tr key={c.id} tabIndex={0} className={chosen?.id === c.id ? "sel" : undefined}
                        onClick={() => setChosen(c)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setChosen(c)}>
                      <td><input type="radio" name="pay-condition" checked={chosen?.id === c.id} onChange={() => setChosen(c)}
                                 aria-label={`${c.name} を選ぶ`} /></td>
                      <td><div>{c.name}</div><div className="faint code">{c.conditionNo ?? `#${c.id}`}</div></td>
                      <td>{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</td>
                      <td>{c.work?.title ?? "—"}</td>
                      <td className="num">{c.ratePpm != null ? `${c.ratePpm / 10000}%`
                        : c.flatAmount != null ? money(c.flatAmount, c.currency)
                        : c.unitAmount != null ? `単価 ${money(c.unitAmount, c.currency)}` : "—"}</td>
                      <td><SettlementTag settlement={c.settlement} compact /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {chosen && (
        <div className="panel">
          <div className="panel-hd">
            <h2>② 実績 → ③ {kind === "service" ? "検収書" : "利用許諾計算書"}</h2>
            <span className="faint">{chosen.conditionNo ?? `#${chosen.id}`} {chosen.name}</span>
          </div>
          <div className="panel-bd stack" style={{ gap: 10 }}>
            <div className={stage === 2 ? "note" : "note ok"}>
              {stage === 2
                ? (kind === "service"
                    ? "まず納品の実績を立てます。下の「実績を足す」から、納品日・成果物・数量・金額・検収日を入れてください。"
                    : "まず利用の報告を実績にします。下の「実績を足す」から、報告の期間・製造数や売上・控除を入れてください。")
                : stage === 3
                ? `文書になっていない実績が ${waitingDoc} 件あります。下の実績の行の「…を作る」（料率の実績はまとめて選んで「計算書を作る」）で文書の画面へ進んでください。`
                : stage === 4
                ? `下書きの文書が ${drafts.length} 件あります。文書を開いて決定し、送ってください。`
                : stage === 5
                ? "文書は決まっています。支払は決めた文書から立ちます（支払タブ・支払文書処理の画面で確かめられます）。"
                : "この条件の実績は、文書・支払まで済んでいます。次の納品・報告が来たら、また実績から立ててください。"}
              {drafts.length > 0 && (
                <span className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {[...new Set(drafts.map((e) => e.documentId!))].map((id) => (
                    <button key={id} className="btn btn-sm" onClick={() => onOpenDocument(id)}>文書 #{id} を開く</button>
                  ))}
                </span>
              )}
            </div>
            <ConditionEvents key={chosen.id}
              conditionId={chosen.id} currency={chosen.currency}
              editable={!readOnly && (chosen.status === "active" || chosen.status === "draft")}
              reloadKey={reloadKey}
              pricingModel={chosen.pricingModel} ratePpm={chosen.ratePpm}
              conditionUnitAmount={chosen.unitAmount} conditionQuantity={chosen.quantity}
              direction={chosen.direction} kind={chosen.kind}
              workTitle={chosen.work?.title ?? null} workId={chosen.work?.id ?? null}
              onCompose={onCompose} onOpenDocument={onOpenDocument}
              onChanged={() => setReloadKey((v) => v + 1)} />
          </div>
        </div>
      )}
    </section>
  );
}
