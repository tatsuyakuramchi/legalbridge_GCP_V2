import type { BundlePreview, BundleSnapshot } from "../server/conditions/bundle-service.js";
import { SECTION_LABEL } from "../server/conditions/bundle-service.js";

/**
 * まとめて直すの右の欄：発注書 → 条件明細 → 実績 → 支払 → 検収書 の前後（試算）。
 * 試算はサーバが本物の保存処理を 1 トランザクションで流して取り消したもの（bundle-service.ts preview）。
 * 段ごとに 直す・改訂／新しく作る（下書き）／止まる／人が直す／変わらない の印を付ける。
 */

const ORDER_KEYS = new Set(["purchase_order", "intl_purchase_order"]);
const SETTLE_KEYS = new Set(["inspection_certificate", "intl_inspection_certificate", "service_completion_notice"]);
const yen = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `¥${Math.round(n).toLocaleString("ja-JP")}`);
const qty = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("ja-JP"));

/** 条件の総額（単価 × 数量、または定額）。 */
export const conditionTotal = (c: BundleSnapshot["condition"]): number | null => {
  if (!c) return null;
  if (c.pricingModel === "unit_rate" && c.unitAmount !== null && c.quantity !== null) return Math.round(c.unitAmount * c.quantity);
  return c.flatAmount;
};

function BeforeAfter({ was, now, fmt, diff }: { was: number | null; now: number | null; fmt: (n: number | null) => string; diff?: boolean }) {
  if (was === now) return <span className="ba">{fmt(now)}</span>;
  const d = was !== null && now !== null ? now - was : null;
  return (
    <span className="ba">
      <span className="was">{fmt(was)}</span><span className="arrow">→</span><span className="now">{fmt(now)}</span>
      {diff && d !== null && d !== 0 && <span className={`d ${d < 0 ? "minus" : "plus"}`}>{d < 0 ? "−" : "＋"}{yen(Math.abs(d))}</span>}
    </span>
  );
}

export function BundleImpact({ preview, busy, paidBlocked }: {
  preview: BundlePreview | null; busy: boolean;
  /** 支払済みで実績の金額を直せない（画面の側で分かっている）。差額を出して「人が直す」にする。 */
  paidBlocked?: { paymentNo: string | null; diff: number } | null;
}) {
  if (!preview) {
    return <div className="fix-out"><div className="fix-tbody faint">{busy ? "試算しています…" : "左の欄を直すと、ここに段ごとの変わり方が出ます（保存前の試算）"}</div></div>;
  }
  const { before: b, after: a, result: r } = preview;
  const drafts = r?.reissued ?? [];
  const draftOf = (id: number) => drafts.find((d) => d.documentId === id) ?? null;
  const docs = (keys: Set<string>) => b.documents.filter((d) => d.status === "issued" && keys.has(d.templateKey ?? ""));
  const totalWas = conditionTotal(b.condition), totalNow = conditionTotal(a.condition);
  const revised = Boolean(a.condition && b.condition && a.condition.id !== b.condition.id);
  const condChanged = revised || totalWas !== totalNow
    || (a.condition?.unitAmount ?? null) !== (b.condition?.unitAmount ?? null) || (a.condition?.quantity ?? null) !== (b.condition?.quantity ?? null);

  const docTier = (label: string, keys: Set<string>, what: string) => {
    const list = docs(keys);
    return (
      <div className="fix-tier">
        <div className="fix-tname">{label}{list[0] && <small>{list[0].documentNo ?? `#${list[0].id}`}</small>}</div>
        <div className="fix-tbody">
          {!list.length && <span className="faint">決定済みの{label}はありません</span>}
          {list.map((d) => {
            const draft = draftOf(d.id);
            return (
              <div key={d.id} className="stack" style={{ gap: 4 }}>
                <div className="fix-row">
                  {draft ? <span className="chip new">訂正版を作る（下書き）</span> : <span className="chip same">そのまま</span>}
                  <span className="faint">{draft ? `決定すると元の${label}は「訂正済み」。${what}` : `出したときの値のまま（訂正版を作らない）`}</span>
                </div>
                {draft?.repriced.map((t) => <div key={t} className="ba">{t}</div>)}
                {draft && draft.pending.length > 0 && (
                  <div className="fix-row"><span className="chip man">人が直す</span><span className="faint">{draft.pending.join("・")}（下書きを開いて直す）</span></div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const evBefore = new Map(b.events.map((e) => [e.id, e]));
  const changedEvents = a.events.filter((e) => {
    const x = evBefore.get(e.id);
    return x && (x.quantity !== e.quantity || x.amount !== e.amount);
  });

  const steps: string[] = [];
  for (const s of r?.applied ?? []) {
    if (s.section === "condition") steps.push(revised ? `条件明細を改訂（${a.condition?.conditionNo ?? "新しい版"}）` : "条件明細を直す");
    else if (s.section === "cancelPayment") steps.push(`支払を取り消す（${b.payments.filter((p) => a.payments.find((q) => q.id === p.id)?.status === "canceled" && p.status !== "canceled").map((p) => p.paymentNo ?? `#${p.id}`).join("・")}）`);
    else if (s.section === "event") steps.push(`実績を直す（${changedEvents.length} 件）`);
    else if (s.section === "reissue") steps.push(`訂正版を下書きで作る（${drafts.map((d) => d.documentNo ?? `#${d.documentId}`).join("・")}。決定は文書の画面で 1 枚ずつ）`);
    else steps.push(`${SECTION_LABEL[s.section]}を直す`);
  }
  const recreated = a.payments.some((p) => p.status === "canceled") && b.payments.some((p) => p.status !== "canceled" && a.payments.find((q) => q.id === p.id)?.status === "canceled");
  if (recreated) steps.push("検収書の訂正版を決定したら、文書の画面で支払を作り直す");

  return (
    <div className="stack" style={{ gap: 8 }}>
      {preview.refused && <div className="alert">保存できません：{preview.refused}</div>}
      {r?.stoppedAt && <div className="alert">{SECTION_LABEL[r.stoppedAt.section]}で止まります：{r.stoppedAt.message}</div>}
      <div className="fix-out" aria-busy={busy}>
        {docTier("発注書", ORDER_KEYS, "明細は新しい条件で引き直す")}
        <div className="fix-tier">
          <div className="fix-tname">条件明細<small>{b.condition?.conditionNo ?? ""}</small></div>
          <div className="fix-tbody">
            <div className="fix-row">
              {revised ? <span className="chip chg">改訂（新しい版）</span> : condChanged ? <span className="chip chg">直す</span> : <span className="chip same">変わらない</span>}
              {revised && <span className="faint">{a.condition?.conditionNo} を作る。実績は元の版に残る</span>}
            </div>
            {b.condition?.pricingModel === "unit_rate" ? (
              <div className="fix-row">
                <span>単価 <BeforeAfter was={b.condition.unitAmount} now={a.condition?.unitAmount ?? null} fmt={yen} /></span>
                <span>数量 <BeforeAfter was={b.condition.quantity} now={a.condition?.quantity ?? null} fmt={qty} /></span>
                <span>金額 <BeforeAfter was={totalWas} now={totalNow} fmt={yen} diff /></span>
              </div>
            ) : (
              <div className="fix-row"><span>金額 <BeforeAfter was={totalWas} now={totalNow} fmt={yen} diff /></span></div>
            )}
          </div>
        </div>
        <div className="fix-tier">
          <div className="fix-tname">実績</div>
          <div className="fix-tbody">
            {!b.events.length && <span className="faint">実績はまだありません</span>}
            {b.events.map((e) => {
              const n = a.events.find((x) => x.id === e.id) ?? e;
              const changed = n.quantity !== e.quantity || n.amount !== e.amount;
              return (
                <div key={e.id} className="fix-row">
                  {changed ? <span className="chip chg">直す</span> : <span className="chip same">変わらない</span>}
                  <span className="faint">{e.occurredOn ?? "—"}</span>
                  <span>数量 <BeforeAfter was={e.quantity} now={n.quantity} fmt={qty} /></span>
                  <span>金額 <BeforeAfter was={e.amount} now={n.amount} fmt={yen} diff /></span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="fix-tier">
          <div className="fix-tname">支払</div>
          <div className="fix-tbody">
            {!b.payments.length && <span className="faint">支払はまだありません</span>}
            {b.payments.filter((p) => p.status !== "canceled").map((p) => {
              const n = a.payments.find((x) => x.id === p.id) ?? p;
              const canceled = n.status === "canceled";
              const exNow = a.events.filter((e) => p.eventIds.includes(e.id)).reduce((s, e) => s + e.amount, 0);
              const exWas = b.events.filter((e) => p.eventIds.includes(e.id)).reduce((s, e) => s + e.amount, 0);
              return (
                <div key={p.id} className="stack" style={{ gap: 3 }}>
                  <div className="fix-row">
                    {canceled ? <span className="chip chg">取り消して作り直す</span>
                      : paidBlocked && p.status === "paid" ? <span className="chip stop">止まる</span>
                      : <span className="chip same">そのまま</span>}
                    <span className="code">{p.paymentNo ?? `#${p.id}`}</span>
                    <span className="faint">{p.status === "paid" ? `支払済み ${p.paidOn ?? ""}` : `支払日 ${n.dueOn ?? p.dueOn ?? "—"}`}</span>
                  </div>
                  {canceled && (
                    <div className="fix-row ba">税抜 <span className="was">{yen(exWas)}</span><span className="arrow">→</span><span className="now">{yen(exNow)}</span>
                      <span className="faint" style={{ fontFamily: "inherit" }}>　作り直すと新しい支払番号になります</span></div>
                  )}
                  {paidBlocked && p.status === "paid" && (
                    <div className="fix-row"><span className="chip man">人が直す</span>
                      <span className="faint">差額 {paidBlocked.diff < 0 ? "−" : "＋"}{yen(Math.abs(paidBlocked.diff))}（税抜）は、返金・次回相殺などの調整として別に立てる</span></div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {docTier("検収書", SETTLE_KEYS, "明細は直した実績から引き直す")}
      </div>
      {steps.length > 0 && (
        <div>
          <b style={{ fontSize: 12.5 }}>保存すると、この順に行います</b>
          <ol className="fix-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}
    </div>
  );
}
