import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import type { GridRow } from "../server/matters/grid.js";

/**
 * 食い違いの一括修正：行＝条件 × 列＝段 の表（docs/navigation.md §11）。
 *
 * 緑の列（条件・予定・実績・支払）が正で、ここを直す。灰色の列（発注書・検収書）は決定したときに
 * 焼き付いた値で、直した正と違えば赤で「前 → 後」を出す。上で共通の設定（決定日・担当者・訂正版か
 * 新規か・どこまで行うか・理由）を決め、「この内容で直して文書を作り直す」で一度に流す：
 *
 *   1. 行ごとに まとめて直す（PATCH /conditions/:id/bundle）：条件・予定・実績・支払の期日・訂正版（下書き）
 *   2. 新規なら 下敷きにして作る（derive）→ 元を無効
 *   3. 下書きに担当者を入れ、決定まで望めば決定（issuedOn）
 *
 * 日付の正は支払（作る順番は 実績 → 支払 → 検収書。検収書は支払の期日を印字する）。
 * 束ねた文書（条件を何本も載せたもの）は、何本の行に出ていても1枚として1回だけ直す。
 */

interface Head { pricingModel: string; unitAmount: number | null; quantity: number | null; flatAmount: number | null; unitLabel: string | null }
interface ScheduleLine {
  id: number; seq: number; label: string | null; triggerKind: string; plannedAmount: number;
  dueOn: string | null; payOn: string | null; contractForm: string | null; serviceFrom: string | null; serviceTo: string | null; eventId: number | null;
}
interface EventLine { id: number; status: string; occurredOn: string | null; inspectedOn: string | null; quantity: number | null; amount: number }
interface Loaded { head: Head; schedules: ScheduleLine[]; events: EventLine[] }
interface Staff { id: number; name: string; department?: string | null; status?: string }

const yen = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `¥${Math.round(n).toLocaleString("ja-JP")}`);
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: string | undefined) => { const s = String(v ?? "").replace(/[,，¥￥\s]/g, ""); return s === "" ? null : Number(s); };
const isDate = (v: string | null | undefined): v is string => Boolean(v) && /^\d{4}-\d{2}-\d{2}$/.test(v!);
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const latest = (xs: Array<string | null | undefined>) => xs.filter(isDate).sort().at(-1) ?? null;

/** 焼き付いた値と、直した正。違えば赤で 前 → 後。 */
function Frozen({ value, target, fmt = (v) => String(v), note }: { value: string | number | null; target: string | number | null; fmt?: (v: string | number) => string; note?: string }) {
  if (value === null) return <td className="dm-frozen"><span className="faint">—</span></td>;
  const bad = target !== null && target !== value;
  return (
    <td className={`dm-frozen${bad ? " bad" : ""}`} title={note ?? (bad ? `焼き付いた値 ${fmt(value)} → 作り直すと ${fmt(target!)}` : undefined)}>
      {bad ? <><span className="was">{fmt(value)}</span>{fmt(target!)}</> : fmt(value)}
    </td>
  );
}

export function DriftMatrixDialog({ matterId, rows, onClose, onDone, onOpenDocument }: {
  matterId: number | null; rows: GridRow[]; onClose: () => void; onDone: (m: string) => void; onOpenDocument?: (id: number) => void;
}) {
  const [data, setData] = useState<Map<number, Loaded> | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, string>>({});
  // 共通の設定。
  const [issuedOn, setIssuedOn] = useState(today());
  const [ownerStaffId, setOwnerStaffId] = useState("");
  const [mode, setMode] = useState<"revise" | "fresh">("revise");
  const [extent, setExtent] = useState<"draft" | "issue">("issue");
  const [reason, setReason] = useState("条件・予定・実績・支払に合わせて文書を作り直すため");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      ...rows.map(async (r) => {
        const [head, s, e] = await Promise.all([
          api.get<Head>(`/conditions/${r.conditionId}`),
          api.get<{ lines: ScheduleLine[] }>(`/conditions/${r.conditionId}/schedules`).catch(() => ({ lines: [] as ScheduleLine[] })),
          api.get<{ events: EventLine[] }>(`/conditions/${r.conditionId}/events`).catch(() => ({ events: [] as EventLine[] }))
        ]);
        const events = e.events.filter((x) => x.status !== "void").sort((a, b) => (a.occurredOn ?? "").localeCompare(b.occurredOn ?? "") || a.id - b.id);
        return [r.conditionId, { head, schedules: s.lines ?? [], events }] as const;
      })
    ]).then((entries) => {
      if (!live) return;
      const m = new Map(entries);
      const init: Record<string, string> = {};
      for (const r of rows) {
        const d = m.get(r.conditionId)!;
        init[`c${r.conditionId}:flat`] = text(d.head.flatAmount);
        init[`c${r.conditionId}:unit`] = text(d.head.unitAmount);
        init[`c${r.conditionId}:qty`] = text(d.head.quantity);
        for (const s of d.schedules) { init[`s${s.id}:due`] = text(s.dueOn); init[`s${s.id}:pay`] = text(s.payOn); }
        for (const e of d.events) { init[`e${e.id}:on`] = text(e.occurredOn); init[`e${e.id}:ins`] = text(e.inspectedOn); init[`e${e.id}:amt`] = text(e.amount); init[`e${e.id}:qty`] = text(e.quantity); }
        if (r.payment) init[`p${r.payment.id}:due`] = text(r.payment.dueOn);
        for (const x of r.rounds ?? []) if (x.payment) init[`p${x.payment.id}:due`] = text(x.payment.dueOn);
      }
      setV(init); setData(m);
    }).catch((e: ApiError) => { if (live) setError(e.message); });
    api.get<{ staff: Staff[] }>("/staff").then((r) => { if (live) setStaff(r.staff.filter((s) => (s.status ?? "active") === "active")); }).catch(() => undefined);
    return () => { live = false; };
  }, [rows.map((r) => r.conditionId).join(",")]);

  const set = (k: string, value: string) => setV((cur) => ({ ...cur, [k]: value }));
  const edited = (k: string, was: unknown) => (text(was) !== (v[k] ?? "") ? "edited" : undefined);

  /** 行の正（直した値）。 */
  const liveOf = (r: GridRow) => {
    const d = data?.get(r.conditionId);
    if (!d) return null;
    const unit = d.head.pricingModel === "unit_rate";
    const total = unit
      ? (num(v[`c${r.conditionId}:unit`]) ?? 0) * (num(v[`c${r.conditionId}:qty`]) ?? 0)
      : num(v[`c${r.conditionId}:flat`]);
    const due = latest(d.schedules.map((s) => v[`s${s.id}:due`]));
    const pay = latest(d.schedules.map((s) => v[`s${s.id}:pay`]));
    const evOn = latest(d.events.map((e) => v[`e${e.id}:on`]));
    const evIns = latest(d.events.map((e) => v[`e${e.id}:ins`] || v[`e${e.id}:on`]));
    const evAmt = d.events.reduce((s, e) => s + (num(v[`e${e.id}:amt`]) ?? 0), 0);
    const payments = new Map<number, { id: number; paymentNo: string | null; amount: number; dueOn: string }>();
    for (const x of r.rounds ?? []) if (x.payment) payments.set(x.payment.id, { id: x.payment.id, paymentNo: x.payment.paymentNo, amount: x.payment.amount, dueOn: v[`p${x.payment.id}:due`] ?? "" });
    if (!payments.size && r.payment) payments.set(r.payment.id, { id: r.payment.id, paymentNo: r.payment.paymentNo, amount: r.payment.amount ?? 0, dueOn: v[`p${r.payment.id}:due`] ?? "" });
    return { d, unit, total: total === null ? null : Math.round(total), due, pay, evOn, evIns, evAmt, payments: [...payments.values()] };
  };

  /** 文書ごと（束ねた文書は1枚）に、載っている行と、作り直したときの値。 */
  const docs = useMemo(() => {
    const out = new Map<number, { id: number; documentNo: string | null; part: "order" | "settlementDoc"; rows: GridRow[]; doc: NonNullable<GridRow["order"]> }>();
    for (const r of rows) {
      for (const part of ["order", "settlementDoc"] as const) {
        const d = r[part];
        if (!d || d.phase === "draft") continue;
        const got = out.get(d.id) ?? { id: d.id, documentNo: d.documentNo, part, rows: [], doc: d };
        got.rows.push(r); out.set(d.id, got);
      }
    }
    return out;
  }, [rows]);
  const targetOf = (docId: number) => {
    const g = docs.get(docId);
    if (!g || !data) return null;
    const lives = g.rows.map(liveOf).filter((x): x is NonNullable<typeof x> => Boolean(x));
    // 金額は、載っている条件が全部この表にあるときだけ比べられる。
    const complete = g.doc.conditionCount <= g.rows.length;
    if (g.part === "order") {
      return {
        amount: complete ? lives.reduce((s, l) => s + (l.total ?? 0), 0) : null,
        delivery: latest(lives.map((l) => l.due)), inspection: null,
        payment: latest(lives.map((l) => l.pay))
      };
    }
    const payDue = latest(lives.flatMap((l) => l.payments.map((p) => p.dueOn)));
    return {
      amount: complete ? lives.reduce((s, l) => s + l.evAmt, 0) : null,
      delivery: latest(lives.map((l) => l.evOn)), inspection: latest(lives.map((l) => l.evIns)),
      // 支払期日の正は支払。無ければ比べない（作り直すと納品日から計算される）。
      payment: payDue
    };
  };
  const docDiffers = (docId: number) => {
    const g = docs.get(docId); const t = targetOf(docId);
    if (!g || !t) return false;
    const d = g.doc;
    return (t.amount !== null && d.amountExTax !== null && t.amount !== d.amountExTax)
      || (t.delivery !== null && isDate(d.deliveryOn) && t.delivery !== d.deliveryOn)
      || (t.inspection !== null && isDate(d.inspectionOn) && t.inspection !== d.inspectionOn)
      || (t.payment !== null && isDate(d.paymentOn) && t.payment !== d.paymentOn);
  };

  /** 行ごとの保存の中身（直した欄だけ）。 */
  const bodyOf = (r: GridRow, seenPay: Set<number>, seenDoc: Set<number>) => {
    const l = liveOf(r); if (!l) return null;
    const { d } = l;
    const out: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    if (l.unit) {
      if (num(v[`c${r.conditionId}:unit`]) !== d.head.unitAmount) c.unitAmount = num(v[`c${r.conditionId}:unit`]);
      if (num(v[`c${r.conditionId}:qty`]) !== d.head.quantity) c.quantity = num(v[`c${r.conditionId}:qty`]);
    } else if (num(v[`c${r.conditionId}:flat`]) !== d.head.flatAmount) c.flatAmount = num(v[`c${r.conditionId}:flat`]);
    if (Object.keys(c).length) out.condition = c;
    if (d.schedules.some((s) => (v[`s${s.id}:due`] ?? "") !== text(s.dueOn) || (v[`s${s.id}:pay`] ?? "") !== text(s.payOn))) {
      out.schedules = d.schedules.map((s) => ({
        seq: s.seq, label: s.label, triggerKind: s.triggerKind, plannedAmount: s.plannedAmount,
        dueOn: (v[`s${s.id}:due`] ?? "").trim() || null, payOn: (v[`s${s.id}:pay`] ?? "").trim() || null,
        contractForm: s.contractForm, serviceFrom: s.serviceFrom, serviceTo: s.serviceTo
      }));
    }
    const evs: Array<Record<string, unknown>> = [];
    for (const e of d.events) {
      const x: Record<string, unknown> = { id: e.id };
      if ((v[`e${e.id}:on`] ?? "") !== text(e.occurredOn)) x.occurredOn = (v[`e${e.id}:on`] ?? "").trim() || null;
      if ((v[`e${e.id}:ins`] ?? "") !== text(e.inspectedOn)) x.inspectedOn = (v[`e${e.id}:ins`] ?? "").trim() || null;
      if (num(v[`e${e.id}:amt`]) !== e.amount) x.amount = num(v[`e${e.id}:amt`]);
      if (num(v[`e${e.id}:qty`]) !== e.quantity) x.quantity = num(v[`e${e.id}:qty`]);
      if (Object.keys(x).length > 1) evs.push(x);
    }
    if (evs.length) out.events = evs;
    const pays = l.payments.filter((p) => !seenPay.has(p.id) && seenPay.add(p.id) && p.dueOn && p.dueOn !== text([...(r.rounds ?? []).map((x) => x.payment), r.payment].find((q) => q && q.id === p.id)?.dueOn));
    if (pays.length === 1) out.payment = { id: pays[0].id, dueOn: pays[0].dueOn };
    else if (pays.length > 1) out.payments = pays.map((p) => ({ id: p.id, dueOn: p.dueOn }));
    if (mode === "revise") {
      const re = [r.order, r.settlementDoc].filter((x): x is NonNullable<GridRow["order"]> => Boolean(x && x.phase !== "draft"))
        .filter((x) => docDiffers(x.id) && !seenDoc.has(x.id) && Boolean(seenDoc.add(x.id)));
      if (re.length) out.reissue = re.map((x) => x.id);
    }
    return out;
  };

  const plan = useMemo(() => {
    if (!data) return null;
    const seenPay = new Set<number>(), seenDoc = new Set<number>();
    const bodies = rows.map((r) => ({ r, body: bodyOf(r, seenPay, seenDoc) }));
    const docsToRemake = [...docs.values()].filter((g) => docDiffers(g.id));
    const steps: string[] = [];
    const n = (k: string) => bodies.filter((b) => b.body && b.body[k] !== undefined).length;
    if (n("condition")) steps.push(`条件を直す（${n("condition")} 本）`);
    if (n("schedules")) steps.push(`予定を直す（${n("schedules")} 本：納期・支払日）`);
    if (n("events")) steps.push(`実績を直す（${bodies.filter((b) => b.body?.events).map((b) => b.r.conditionNo ?? `#${b.r.conditionId}`).join("・")}）`);
    const payN = bodies.reduce((s, b) => s + (b.body?.payment ? 1 : 0) + ((b.body?.payments as unknown[] | undefined)?.length ?? 0), 0);
    if (payN) steps.push(`支払の期日を直す（${payN} 件）`);
    for (const g of docsToRemake) {
      const t = targetOf(g.id)!;
      const what = [t.amount !== null && g.doc.amountExTax !== null && t.amount !== g.doc.amountExTax ? `金額 ${yen(t.amount)}` : "",
        t.delivery && t.delivery !== g.doc.deliveryOn ? `納品日 ${t.delivery}` : "", t.inspection && t.inspection !== g.doc.inspectionOn ? `検収日 ${t.inspection}` : "",
        t.payment && t.payment !== g.doc.paymentOn ? `支払期日 ${t.payment}` : ""].filter(Boolean).join("・");
      steps.push(mode === "revise"
        ? `${g.part === "order" ? "発注書" : "検収書"} ${g.documentNo ?? `#${g.id}`} の訂正版を作る（${what}）${extent === "issue" ? `→ 決定日 ${issuedOn} で決定（-Rn）` : "→ 下書きまで"}`
        : `${g.part === "order" ? "発注書" : "検収書"} ${g.documentNo ?? `#${g.id}`} を下敷きに新しく作り、元を無効にする（${what}）${extent === "issue" ? `→ 決定日 ${issuedOn} で決定` : "→ 下書きまで"}`);
    }
    return { bodies, docsToRemake, steps };
  }, [data, v, mode, extent, issuedOn, rows, docs]);

  async function run() {
    if (!plan) return;
    setBusy(true);
    const said: string[] = [];
    const say = (t: string) => { said.push(t); setLog([...said]); };
    const drafts: Array<{ id: number; label: string; eventIds: number[] }> = [];
    // 1. 行ごとに まとめて直す（条件・予定・実績・支払・訂正版）。
    for (const { r, body } of plan.bodies) {
      if (!body || !Object.keys(body).length) continue;
      const name = r.conditionNo ?? `#${r.conditionId}`;
      try {
        const out = await api.patch<{ stoppedAt: { message: string } | null; reissued: Array<{ documentId: number; documentNo: string | null; draftId: number; repriced: string[]; pending: string[] }> }>(
          `/conditions/${r.conditionId}/bundle`, { ...body, reason: reason.trim() });
        if (out.stoppedAt) { say(`${name}：止まりました（${out.stoppedAt.message}）`); continue; }
        say(`${name}：直しました（${Object.keys(body).filter((k) => k !== "reissue").map((k) => ({ condition: "条件", schedules: "予定", events: "実績", payment: "支払", payments: "支払" })[k] ?? k).join("・") || "訂正版"}）`);
        for (const d of out.reissued ?? []) {
          drafts.push({ id: d.draftId, label: d.documentNo ?? `#${d.documentId}`, eventIds: [] });
          say(`${d.documentNo ?? `#${d.documentId}`}：訂正版を下書き #${d.draftId} に作りました${d.pending.length ? `。引き直せなかったもの：${d.pending.join("／")}` : ""}`);
        }
      } catch (e) { say(`${name}：${(e as ApiError).message}`); }
    }
    // 2. 新規：下敷きにして作り、元を無効にする。
    if (mode === "fresh") {
      for (const g of plan.docsToRemake) {
        const label = g.documentNo ?? `#${g.id}`;
        try {
          const made = await api.post<{ id: number }>(`/documents/${g.id}/derive`, {});
          await api.post(`/documents/${g.id}/void`, { reason: reason.trim() });
          const eventIds = g.part === "settlementDoc"
            ? g.rows.flatMap((r) => (r.rounds ?? []).filter((x) => x.eventId !== null && x.doc?.id === g.id).map((x) => x.eventId!))
            : [];
          drafts.push({ id: made.id, label, eventIds });
          say(`${label}：下敷きに新しい下書き #${made.id} を作り、元を無効にしました`);
        } catch (e) { say(`${label}：${(e as ApiError).message}`); }
      }
    }
    // 3. 担当者を入れ、望めば決定。
    for (const d of drafts) {
      try {
        if (ownerStaffId) {
          const cur = await api.get<{ manualInputs?: Record<string, unknown> }>(`/documents/${d.id}`);
          await api.patch(`/documents/${d.id}/draft`, { manualInputs: { ...(cur.manualInputs ?? {}), _ownerStaffId: Number(ownerStaffId) } });
        }
        if (extent === "issue") {
          const r = await api.post<{ documentNo?: string | null }>(`/documents/${d.id}/issue`, { issuedOn, ...(d.eventIds.length ? { eventIds: d.eventIds } : {}) });
          say(`${d.label} → ${r.documentNo ?? `#${d.id}`} を決定しました`);
        }
      } catch (e) { say(`下書き #${d.id}：${(e as ApiError).message}。文書の画面で中身を確かめてください`); }
    }
    setBusy(false); setDone(true);
  }

  const finish = () => (done ? onDone(`食い違いを直しました（${rows.length} 本）`) : onClose());
  const docCols = (part: "order" | "settlementDoc") => [...docs.values()].filter((g) => g.part === part);
  const shownDoc = new Set<number>();

  // 見出しと枠は呼ぶ側の Modal。
  return (
    <div className="stack" style={{ gap: 12 }}>
      {error && <div className="alert">{error}</div>}
      <div className="dm-common">
        <label className="field"><span>決定日</span><input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></label>
        <label className="field"><span>担当者（【ご連絡先】）</span>
          <select value={ownerStaffId} onChange={(e) => setOwnerStaffId(e.target.value)}>
            <option value="">案件の担当（既定）</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.department ? `（${s.department}）` : ""}</option>)}
          </select></label>
        <label className="field"><span>文書の出し方</span>
          <span className="seg">
            <button type="button" aria-pressed={mode === "revise"} onClick={() => setMode("revise")}>訂正版（-Rn）</button>
            <button type="button" aria-pressed={mode === "fresh"} onClick={() => setMode("fresh")}>新規（元を無効に）</button>
          </span></label>
        <label className="field"><span>どこまで行うか</span>
          <span className="seg">
            <button type="button" aria-pressed={extent === "draft"} onClick={() => setExtent("draft")}>下書きまで</button>
            <button type="button" aria-pressed={extent === "issue"} onClick={() => setExtent("issue")}>決定まで</button>
          </span></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}><span>直す理由（監査に残ります）</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>

      {!data ? <div className="faint">読み込んでいます…</div> : (
        <div className="tablewrap">
          <table className="dm">
            <thead>
              <tr className="grp">
                <th></th>
                <th className="live sep">条件</th>
                <th className="live sep" colSpan={2}>予定</th>
                <th className="live sep" colSpan={3}>実績</th>
                <th className="live sep" colSpan={2}>支払</th>
                <th className="frozen sep" colSpan={3}>発注書</th>
                <th className="frozen sep" colSpan={4}>検収書・計算書</th>
              </tr>
              <tr>
                <th>条件</th>
                <th className="sep">金額</th>
                <th className="sep">納期</th><th>支払日</th>
                <th className="sep">納品日</th><th>検収日</th><th>金額</th>
                <th className="sep">金額</th><th>期日</th>
                <th className="sep">金額</th><th>納品日</th><th>支払期日</th>
                <th className="sep">金額</th><th>納品日</th><th>検収日</th><th>支払期日</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const l = liveOf(r); if (!l) return null;
                const { d } = l;
                const docCell = (part: "order" | "settlementDoc") => {
                  const doc = r[part];
                  const cols = part === "order" ? 3 : 4;
                  if (!doc || doc.phase === "draft") return <td className="dm-frozen sep" colSpan={cols}><span className="faint">{doc ? "下書き" : "—"}</span></td>;
                  if (shownDoc.has(doc.id)) return <td className="dm-frozen sep" colSpan={cols}><span className="faint">同上（{doc.documentNo ?? `#${doc.id}`}）</span></td>;
                  shownDoc.add(doc.id);
                  const t = targetOf(doc.id);
                  const bundled = docs.get(doc.id)!.rows.length > 1 || doc.conditionCount > 1;
                  const note = doc.conditionCount > (docs.get(doc.id)?.rows.length ?? 0) ? `条件 ${doc.conditionCount} 本を載せた文書で、この表に無い条件があるので金額は比べません` : undefined;
                  return (
                    <>
                      <td className="dm-frozen sep dm-docno" title={note}>
                        <button className="linky code" onClick={() => onOpenDocument?.(doc.id)}>{doc.documentNo ?? `#${doc.id}`}</button>
                        {bundled && <div className="faint" style={{ fontSize: 11 }}>{doc.conditionCount} 本を1枚に</div>}
                        <div><Frozen value={doc.amountExTax} target={t?.amount ?? null} fmt={(x) => yen(Number(x))} note={note} /></div>
                      </td>
                      <Frozen value={isDate(doc.deliveryOn) ? doc.deliveryOn : doc.deliveryOn ?? null} target={isDate(doc.deliveryOn) ? t?.delivery ?? null : null} />
                      {part === "settlementDoc" && <Frozen value={isDate(doc.inspectionOn) ? doc.inspectionOn : doc.inspectionOn ?? null} target={isDate(doc.inspectionOn) ? t?.inspection ?? null : null} />}
                      <Frozen value={isDate(doc.paymentOn) ? doc.paymentOn : doc.paymentOn ?? null} target={isDate(doc.paymentOn) ? t?.payment ?? null : null} />
                    </>
                  );
                };
                return (
                  <tr key={r.conditionId}>
                    <td><div className="dm-name">{r.name}</div><div className="code faint">{r.conditionNo ?? `#${r.conditionId}`}</div><div className="faint" style={{ fontSize: 11 }}>{r.counterparty?.name ?? ""}</div></td>
                    <td className="sep">
                      {l.unit ? (
                        <div className="dm-stack">
                          <input className={`num ${edited(`c${r.conditionId}:unit`, d.head.unitAmount) ?? ""}`} inputMode="numeric" value={v[`c${r.conditionId}:unit`] ?? ""} onChange={(e) => set(`c${r.conditionId}:unit`, e.target.value)} title="単価" />
                          <span className="faint">× <input className={`num short ${edited(`c${r.conditionId}:qty`, d.head.quantity) ?? ""}`} inputMode="decimal" value={v[`c${r.conditionId}:qty`] ?? ""} onChange={(e) => set(`c${r.conditionId}:qty`, e.target.value)} title="数量" />{d.head.unitLabel ?? ""}</span>
                          <span className="faint code">= {yen(l.total)}</span>
                        </div>
                      ) : <input className={`num ${edited(`c${r.conditionId}:flat`, d.head.flatAmount) ?? ""}`} inputMode="numeric" value={v[`c${r.conditionId}:flat`] ?? ""} onChange={(e) => set(`c${r.conditionId}:flat`, e.target.value)} />}
                    </td>
                    <td className="sep">{d.schedules.length ? d.schedules.map((s) => (
                      <div key={s.id} className="dm-line">{d.schedules.length > 1 && <span className="faint">第{s.seq}回</span>}
                        <input type="date" className={edited(`s${s.id}:due`, s.dueOn)} value={v[`s${s.id}:due`] ?? ""} onChange={(e) => set(`s${s.id}:due`, e.target.value)} /></div>
                    )) : <span className="faint">—</span>}</td>
                    <td>{d.schedules.map((s) => (
                      <div key={s.id} className="dm-line"><input type="date" className={edited(`s${s.id}:pay`, s.payOn)} value={v[`s${s.id}:pay`] ?? ""} onChange={(e) => set(`s${s.id}:pay`, e.target.value)} /></div>
                    ))}</td>
                    <td className="sep">{d.events.length ? d.events.map((e) => (
                      <div key={e.id} className="dm-line">{d.events.length > 1 && <span className="faint">{(r.rounds ?? []).find((x) => x.eventId === e.id)?.seq ? `第${(r.rounds ?? []).find((x) => x.eventId === e.id)!.seq}回` : ""}</span>}
                        <input type="date" className={edited(`e${e.id}:on`, e.occurredOn)} value={v[`e${e.id}:on`] ?? ""} onChange={(ev) => set(`e${e.id}:on`, ev.target.value)} /></div>
                    )) : <span className="faint">まだ</span>}</td>
                    <td>{d.events.map((e) => (
                      <div key={e.id} className="dm-line"><input type="date" className={edited(`e${e.id}:ins`, e.inspectedOn)} value={v[`e${e.id}:ins`] ?? ""} onChange={(ev) => set(`e${e.id}:ins`, ev.target.value)} /></div>
                    ))}</td>
                    <td>{d.events.map((e) => {
                      const p = l.payments.find((x) => (r.rounds ?? []).find((y) => y.eventId === e.id)?.payment?.id === x.id);
                      const paid = (r.rounds ?? []).find((y) => y.eventId === e.id)?.payment?.status === "paid" || r.payment?.status === "paid";
                      return <div key={e.id} className="dm-line"><input className={`num ${edited(`e${e.id}:amt`, e.amount) ?? ""}`} inputMode="numeric" disabled={paid} title={paid ? `支払済み（${p?.paymentNo ?? ""}）なので金額は直せません` : undefined} value={v[`e${e.id}:amt`] ?? ""} onChange={(ev) => set(`e${e.id}:amt`, ev.target.value)} /></div>;
                    })}</td>
                    <td className="sep">{l.payments.length ? l.payments.map((p) => <div key={p.id} className="dm-line code">{p.paymentNo ?? `#${p.id}`}<br /><span className="faint">{yen(p.amount)}</span></div>) : <span className="faint">まだ</span>}</td>
                    <td>{l.payments.map((p) => {
                      const st = [...(r.rounds ?? []).map((x) => x.payment), r.payment].find((q) => q && q.id === p.id);
                      const paid = st?.status === "paid";
                      return <div key={p.id} className="dm-line"><input type="date" disabled={paid} className={edited(`p${p.id}:due`, st?.dueOn)} value={v[`p${p.id}:due`] ?? ""} onChange={(e) => set(`p${p.id}:due`, e.target.value)} title={paid ? "支払済み" : "支払期日の正。検収書はこれを印字します"} /></div>;
                    })}</td>
                    {docCell("order")}
                    {docCell("settlementDoc")}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && docCols("order").length + docCols("settlementDoc").length > 0 && (
        <p className="faint" style={{ margin: 0 }}>灰色は決定したときに焼き付いた値。赤は、直した正（緑の列）と違うもの。束ねた文書は1枚として1回だけ作り直します。</p>
      )}

      <div>
        <b style={{ fontSize: 12.5 }}>この内容で直すと、この順に行います</b>
        {plan && plan.steps.length ? <ol className="fix-steps">{plan.steps.map((s) => <li key={s}>{s}</li>)}</ol> : <div className="faint">まだ何も変わりません（緑の列を直すか、赤が無ければ直すものはありません）</div>}
      </div>
      {log.length > 0 && <div className={done ? "note ok" : "note"}>{log.map((t, i) => <div key={i}>{t}</div>)}</div>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {!done
          ? <button className="btn primary" disabled={busy || !plan || !plan.steps.length || !reason.trim() || (extent === "issue" && !isDate(issuedOn))} onClick={() => void run()}>
              {busy ? "直しています…" : "この内容で直して文書を作り直す"}</button>
          : <button className="btn primary" onClick={finish}>閉じる</button>}
        {!done && <button className="btn" disabled={busy} onClick={onClose}>やめる</button>}
        <span className="faint">前後の値と理由は監査に残ります。決定した文書は、あとから訂正版が作れます</span>
      </div>
    </div>
  );
}
