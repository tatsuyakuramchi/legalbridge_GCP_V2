import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { StatusTag } from "./labels.js";
import {
  DRIFT_LABEL, FIELD_LABEL, driftSummary, repairPlan,
  type Drift, type DriftPart, type RepairStep
} from "../server/matters/drift.js";
import type { GridRow } from "../server/matters/grid.js";

/**
 * 金額の直し。条件と、そこから出した文書・実績・支払の食い違いを1枚で直す。
 *
 * 工程表は案件1件の中を見る画面で、食い違いは案件をまたいで散らばる。取引先の
 * 一式を直すときに案件を順に開いて回るのは現実的でないので、食い違いだけを
 * 集めてここに出す。範囲は案件1件と全社（念のための確認）。
 *
 * 直すのは1回の保存で「下書きを作って中身を引き直す」ところまで。**決定は人が
 * 押す**。番号が振られて元の版が退き、そこから送信に繋がる行為なので、まとめて
 * 自動で通さない。押す先は画面の下に「残り」として並べる（別画面に飛ばすと
 * 1枚の意味が無い）。
 */

interface DriftRow {
  row: GridRow;
  drift: Drift;
  matter: { id: number; matterNo: string | null; title: string } | null;
}
interface PendingDraft {
  id: number; supersedesId: number; supersedesNo: string | null;
  templateKey: string | null; reason: string | null; createdAt: string | null;
  conditionNo: string | null; conditionName: string | null; partyName: string | null;
  matter: { id: number; matterNo: string | null; title: string } | null;
  manualTotal: number | null;
}
interface Loaded { rows: DriftRow[]; drafts: PendingDraft[] }

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const shown = (v: number | string) => (typeof v === "number" ? yen(v) : v);
const docNo = (d: { documentNo: string | null; id: number } | null) =>
  d ? (d.documentNo ?? `#${d.id}`) : "—";

/** 段を横に並べた帯。焼き付いた値と、比べた相手を1目で。 */
function Chain({ row, drift }: { row: GridRow; drift: Drift }) {
  const hit = (part: DriftPart) => drift.flagged.filter((e) => e.part === part);
  const cell = (part: DriftPart, value: string, ref: string, phase?: string) => {
    const bad = hit(part);
    return (
      <div key={part} className={`step${bad.length ? " bad" : value === "—" ? " none" : ""}`}>
        <span className="k">{DRIFT_LABEL[part]}</span>
        <span className="v">{value}</span>
        <span className="r">{ref}</span>
        {phase && <span className="r"><StatusTag kind="document" value={phase} /></span>}
        {bad.filter((e) => e.field !== "amount").map((e) => (
          <span key={e.field} className="r">{FIELD_LABEL[e.field]} {e.value}</span>
        ))}
      </div>
    );
  };
  const amountOf = (part: "order" | "settlementDoc") => {
    const d = row[part];
    return d?.amountExTax !== null && d?.amountExTax !== undefined ? yen(d.amountExTax) : "—";
  };
  const allocated = row.settlement.plannedAmount + row.settlement.paidAmount;
  return (
    <div className="strip">
      <div className="step base">
        <span className="k">いまの条件</span>
        <span className="v">{yen(drift.bases[0].value as number)}</span>
        <span className="r">基準</span>
      </div>
      {cell("order", amountOf("order"), docNo(row.order), row.order?.phase)}
      {cell("event", row.events.count ? yen(row.settlement.deliveredAmount) : "—",
        row.events.count ? `${row.events.count} 件　${row.events.latestOn ?? ""}` : "まだ")}
      {cell("settlementDoc", amountOf("settlementDoc"), docNo(row.settlementDoc),
        row.settlementDoc?.phase)}
      {cell("payment", row.payment && allocated ? yen(allocated) : "—",
        row.payment ? `${row.payment.paymentNo ?? `#${row.payment.id}`}` : "まだ")}
    </div>
  );
}

function Plan(
  { steps, onOpenDocument, onOpenPayment }: {
    steps: RepairStep[];
    onOpenDocument?: (id: number) => void;
    onOpenPayment?: (id: number) => void;
  }
) {
  if (!steps.length) return null;
  return (
    <div className="plan">
      <b>直し方</b>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.kind === "auto" ? "auto" : "hand"}>
            {s.text}
            {s.kind === "hand" && s.go?.what === "document" && onOpenDocument && (
              <> <button className="linky" onClick={() => onOpenDocument(s.go!.id)}>文書を開く</button></>
            )}
            {s.kind === "hand" && s.go?.what === "payment" && onOpenPayment && (
              <> <button className="linky" onClick={() => onOpenPayment(s.go!.id)}>支払を開く</button></>
            )}
          </li>
        ))}
      </ol>
      <div className="why">
        黒は保存のときに走ります。赤は人が押します（決定すると番号が振られ、
        元の版が退きます。送信はさらにその先です）。
      </div>
    </div>
  );
}

export function DriftWorkspace(
  { initialMatterId, onOpenDocument, onOpenCondition }: {
    /** 案件の画面から開いたとき、その案件で絞った状態で出す。 */
    initialMatterId?: number | null;
    onOpenDocument?: (documentId: number) => void;
    onOpenCondition?: (conditionId: number) => void;
  }
) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<number | null>(initialMatterId ?? null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me")
      .then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, []);

  // 全社ぶんを1回引いて、範囲は画面で切り替える。案件を選ぶたびに引き直すと、
  // 「案件の一覧」自体が絞られて選び直せなくなる。
  useEffect(() => {
    setError(null);
    api.get<Loaded>("/drift")
      .then(setData)
      .catch((e: ApiError) => { setError(e.message); setData({ rows: [], drafts: [] }); });
  }, [version]);

  const matters = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of data?.rows ?? []) {
      if (r.matter) seen.set(r.matter.id, `${r.matter.matterNo ?? `#${r.matter.id}`}　${r.matter.title}`);
    }
    for (const d of data?.drafts ?? []) {
      if (d.matter) seen.set(d.matter.id, `${d.matter.matterNo ?? `#${d.matter.id}`}　${d.matter.title}`);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => scope === null || r.matter?.id === scope), [data, scope]);
  const drafts = useMemo(
    () => (data?.drafts ?? []).filter((d) => scope === null || d.matter?.id === scope), [data, scope]);

  // 範囲を変えると、見えていない行を選んだままになる。
  useEffect(() => {
    setPicked((prev) => new Set([...prev].filter((id) => rows.some((r) => r.row.conditionId === id))));
  }, [rows]);

  // まとめて直すのは実績・支払・訂正版に触るので管理者だけ（A-041 と同じ扱い）。
  // 決定は文書の画面と同じ権限にそろえる（ここだけ厳しいと運用が分かれる）。
  const canFix = role === "admin";
  const canIssue = role === "admin" || role === "legal";

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="faint">読み込んでいます…</div>;

  // すでに開いている訂正版の下書き。作りかけのものをもう一度作ろうとすると
  // サーバが断るので、手順のほうを「決定する」に差し替える。
  const openDrafts = new Map(data.drafts.map((d) => [d.supersedesId, d.id]));
  const plans = new Map(rows.map((r) => [r.row.conditionId, repairPlan(r.row, r.drift, openDrafts)]));
  const pickedRows = rows.filter((r) => picked.has(r.row.conditionId));

  async function fix() {
    setBusy(true); setError(null);
    const said: string[] = [];
    for (const r of pickedRows) {
      const plan = plans.get(r.row.conditionId);
      if (!plan) continue;
      const body: Record<string, unknown> = { reason: reason.trim() };
      if (plan.reissue.length) body.reissue = plan.reissue.map((d) => d.id);
      if (plan.paymentDueOn && r.row.payment) {
        body.payment = { id: r.row.payment.id, dueOn: plan.paymentDueOn };
      }
      const name = r.row.conditionNo ?? `#${r.row.conditionId}`;
      if (Object.keys(body).length <= 1) { said.push(`${name}：機械で直せる手順がありません`); continue; }
      try {
        const out = await api.patch<{
          stoppedAt: { section: string; message: string } | null;
          reissued: Array<{ documentNo: string | null; documentId: number; draftId: number;
                            repriced: string[]; pending: string[] }>;
        }>(`/conditions/${r.row.conditionId}/bundle`, body);
        if (out.stoppedAt) { said.push(`${name}：${out.stoppedAt.message}`); continue; }
        const made = (out.reissued ?? []);
        const fixedUp = made.flatMap((d) => d.repriced);
        const left = made.flatMap((d) => d.pending.map((p) => `${d.documentNo ?? `#${d.documentId}`}：${p}`));
        said.push(`${name}：訂正版 ${made.length} 枚を下書きで作りました`
          + (fixedUp.length ? `（${fixedUp.join("／")}）` : "")
          + (left.length ? `。引き直せなかったもの → ${left.join("／")}` : ""));
      } catch (e) { said.push(`${name}：${(e as ApiError).message}`); }
    }
    setNotice(said); setPicked(new Set()); setReason("");
    setBusy(false); setVersion((x) => x + 1);
  }

  async function issue(draftId: number) {
    setBusy(true);
    try {
      await api.post(`/documents/${draftId}/issue`, {});
      setNotice([`下書き #${draftId} を決定しました`]);
      setVersion((x) => x + 1);
    } catch (e) { setNotice([`下書き #${draftId}：${(e as ApiError).message}`]); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>金額の直し</h1>
      <p className="lede">
        条件や予定を直したあとに取り残された金額・日付を、ここだけで揃えます。
        決定済みの文書は書き換えられないので、訂正版の下書きを作るところまでを1回で行います。
      </p>

      <div className="stagefilter">
        <span className="faint">範囲</span>
        <button className="chip" aria-pressed={scope === null} onClick={() => setScope(null)}>
          すべて {data.rows.length}
        </button>
        <select value={scope ?? ""} onChange={(e) => setScope(e.target.value ? Number(e.target.value) : null)}>
          <option value="">案件で絞る…</option>
          {matters.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <span className="faint" style={{ marginLeft: "auto" }}>
          判定は工程表の「金額・日付が食い違い」と同じものです
        </span>
      </div>

      {notice.length > 0 && (
        <div className="note ok">
          {notice.map((t, i) => <div key={i}>{t}</div>)}
        </div>
      )}

      {pickedRows.length > 0 && (
        <div className="fixbar">
          <b>{pickedRows.length} 件を選んでいます</b>
          <label className="field" style={{ gridTemplateColumns: "78px minmax(260px,1fr)", margin: 0 }}>
            <span>直す理由<em className="req"> 必須</em></span>
            <input value={reason} placeholder="先方と納品数を再調整したため"
                   onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy || !reason.trim() || !canFix}
                  onClick={() => void fix()}>
            選んだ {pickedRows.length} 件を直す
          </button>
          <span className="faint">前後の値と理由は監査に残ります</span>
        </div>
      )}

      {!canFix && rows.length > 0 && (
        <div className="note warn">
          直すのは管理者だけです。実績・支払・訂正版に触るので A-041 と同じ扱いにしています。
        </div>
      )}

      {rows.length === 0 && (
        <div className="note ok">
          {scope === null ? "食い違いはありません。" : "この案件に食い違いはありません。"}
        </div>
      )}

      {rows.map((r) => {
        const plan = plans.get(r.row.conditionId)!;
        const on = picked.has(r.row.conditionId);
        return (
          <div key={r.row.conditionId} className="fixrow hit">
            <div className="fixhd">
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={on} disabled={!plan.steps.some((s) => s.kind === "auto")}
                       onChange={(e) => setPicked((prev) => {
                         const next = new Set(prev);
                         if (e.target.checked) next.add(r.row.conditionId); else next.delete(r.row.conditionId);
                         return next;
                       })} />
                <b>
                  {onOpenCondition
                    ? <button className="linky" onClick={() => onOpenCondition(r.row.conditionId)}>{r.row.name}</button>
                    : r.row.name}
                </b>
              </label>
              <span className="faint code">{r.row.conditionNo ?? `#${r.row.conditionId}`}</span>
              <span className="faint">{r.row.counterparty?.name ?? "（相手先なし）"}</span>
              <span className="faint">
                {r.matter ? `${r.matter.matterNo ?? ""}　${r.matter.title}` : "案件に繋がっていません"}
              </span>
              <span className="tag out" style={{ marginLeft: "auto" }}>
                {driftSummary(r.drift.flagged)}が食い違い
              </span>
            </div>
            <Chain row={r.row} drift={r.drift} />
            <Plan steps={plan.steps} onOpenDocument={onOpenDocument} />
            {!plan.steps.some((s) => s.kind === "auto") && (
              <div className="locked" style={{ marginTop: 6 }}>
                この行に、保存で直せる手順は残っていません。上の赤い手順を押してください。
              </div>
            )}
          </div>
        );
      })}

      <h2>残り：人が押すもの</h2>
      <p className="lede">
        訂正版は下書きで作ります。決定すると番号が振られ、元の版が退きます。
        送信はさらにその先で、ここでは行いません。
      </p>
      {drafts.length === 0
        ? <div className="faint">決定を待っている訂正版はありません。</div>
        : (
          <div className="rest tablewrap">
            <table>
              <thead>
                <tr>
                  <th>訂正版</th><th>条件</th><th>案件</th>
                  <th className="right">明細の合計</th><th>理由</th><th></th><th></th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="code">{d.supersedesNo ?? `#${d.supersedesId}`} の訂正版</div>
                      <div className="faint">下書き #{d.id}　<StatusTag kind="document" value="draft" /></div>
                    </td>
                    <td>
                      <div className="code">{d.conditionNo ?? "—"}</div>
                      <div className="faint">{d.partyName ?? ""}</div>
                    </td>
                    <td className="faint">{d.matter ? (d.matter.matterNo ?? d.matter.title) : "—"}</td>
                    <td className="right">
                      {d.manualTotal === null
                        ? <span className="faint">条件から出ます</span>
                        : yen(d.manualTotal)}
                    </td>
                    <td className="faint">{d.reason ?? ""}</td>
                    <td>
                      {onOpenDocument &&
                        <button className="btn btn-sm" onClick={() => onOpenDocument(d.id)}>開く</button>}
                    </td>
                    <td>
                      <button className="btn btn-sm primary" disabled={busy || !canIssue}
                              title="番号が振られ、元の版が退きます。送信はしません"
                              onClick={() => void issue(d.id)}>決定する</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
