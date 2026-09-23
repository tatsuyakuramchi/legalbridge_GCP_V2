import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { conditionAmountLabel } from "./ConditionLabel.js";
import { useReadOnly } from "./read-only.js";
import { SignSwitch, SignTag } from "./SignState.js";
import { SendMany } from "./SendMany.js";
import type { GridDocument, GridParty, GridRow } from "../server/matters/grid.js";
import type { MatterDetail } from "../server/core/model.js";

/**
 * 取引先ごとの束。案件を開いたときの既定の見え方。
 *
 * 人が案件で考える単位は「この相手に対して、どこまで進んだか」。条件・実績・
 * 文書・支払を種類別のタブに分けると、1人分を追うのに4タブを往復する。
 * ここでは取引先ごとに束ね、1行＝条件1本、行の中を
 *
 *   条件 → 発注書 → 納品 → 検収書 → 支払
 *
 * の順に並べる。止まっている手が赤く出て、その場で押せる。種類別の表は
 * 「一覧」タブに畳み、まとめて決定・CSV のような横断の操作の置き場にする。
 *
 * 行の値は工程表（/matters/:id/grid）と同じ。判定はここで行う。
 */

type CellState = "ok" | "now" | "wait" | "none";
interface Cell {
  state: CellState;
  label: string;
  sub?: string | null;
  /** 止まっている手で押す操作。 */
  action?: { label: string; run: () => void } | null;
  /** 番号を押したときに開く文書。 */
  open?: (() => void) | null;
  /** 決定済みの文書。CloudSign の状態の札を出し、手で直せるようにする。 */
  doc?: GridDocument | null;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const md = (d: string | null | undefined) => (d ? d.slice(5).replace("-", "-") : null);

/** 行を 5 つの手に切る。最初の「まだ」が赤（いま）。払い切った行は赤にしない。 */
function cellsOf(
  row: GridRow, matterId: number,
  h: {
    onOpenDocument?: (id: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null, templateKey?: string | null) => void;
    onRecordEvent?: (conditionId: number) => void;
    onOpenPayments?: () => void;
  }
): { order: Cell; delivery: Cell; settlement: Cell; payment: Cell } {
  const done = row.settlement.done;
  let stuck = false;
  const now = (cell: Cell): Cell => {
    if (done || stuck) return { ...cell, state: "none", action: null };
    stuck = true;
    return cell;
  };
  const id = row.conditionId;

  // 発注書。無ければ作る、下書きなら決定する。
  let order: Cell;
  if (!row.order) {
    order = now({ state: "now", label: "未作成",
      action: h.onCompose ? { label: "発注書を作る", run: () => h.onCompose!([id], [], matterId, "purchase_order") } : null });
  } else if (row.order.phase === "draft") {
    order = now({ state: "now", label: "下書き", sub: row.order.documentNo ?? null,
      action: h.onOpenDocument ? { label: "決定する", run: () => h.onOpenDocument!(row.order!.id) } : null,
      open: h.onOpenDocument ? () => h.onOpenDocument!(row.order!.id) : null });
  } else {
    order = { state: "ok", label: row.order.documentNo ?? `#${row.order.id}`,
      sub: row.order.conditionCount > 1 ? `同じ発注書（${row.order.conditionCount} 本）` : null,
      open: h.onOpenDocument ? () => h.onOpenDocument!(row.order!.id) : null,
      doc: row.order };
  }

  // 納品（実績）。
  let delivery: Cell;
  if (row.events.count) {
    delivery = { state: "ok", label: md(row.events.latestOn) ?? "あり",
      sub: `${row.events.count} 件${row.schedules.total ? `・予定 ${row.schedules.done}/${row.schedules.total} 回` : ""}`,
      open: h.onRecordEvent ? () => h.onRecordEvent!(id) : null };
  } else {
    delivery = now({ state: "now", label: "納品待ち",
      sub: row.schedules.dueOn ? `納期 ${md(row.schedules.dueOn)}` : null,
      action: h.onRecordEvent ? { label: "実績を足す", run: () => h.onRecordEvent!(id) } : null });
  }

  // 検収書・計算書。実績から作るので、実績が無いうちは「まだ」。
  let settlement: Cell;
  if (row.settlementDoc) {
    settlement = { state: row.settlementDoc.phase === "draft" ? "wait" : "ok",
      label: row.settlementDoc.documentNo ?? `#${row.settlementDoc.id}`,
      sub: row.settlementDoc.phase === "draft" ? "下書き"
        : row.settlementDoc.amountExTax !== null ? yen(row.settlementDoc.amountExTax) : null,
      open: h.onOpenDocument ? () => h.onOpenDocument!(row.settlementDoc!.id) : null,
      doc: row.settlementDoc.phase === "draft" ? null : row.settlementDoc };
  } else if (row.events.count) {
    settlement = now({ state: "now", label: "実績はあるが未作成",
      action: h.onRecordEvent ? { label: "検収書を作る", run: () => h.onRecordEvent!(id) } : null });
  } else {
    settlement = { state: "none", label: "—" };
  }

  // 支払。
  let payment: Cell;
  if (row.payment) {
    const p = row.payment;
    if (p.status === "paid") {
      payment = { state: "ok", label: `支払済み${p.paidOn ? ` ${md(p.paidOn)}` : ""}`,
        sub: p.paymentNo, open: h.onOpenPayments ?? null };
    } else {
      payment = { state: "wait", label: `未払${p.amount !== null ? ` ${yen(p.amount)}` : ""}`,
        sub: [p.dueOn ? `期日 ${md(p.dueOn)}` : null, p.paymentNo].filter(Boolean).join(" ・ ") || null,
        action: h.onOpenPayments ? { label: "入金を記録", run: h.onOpenPayments } : null,
        open: h.onOpenPayments ?? null };
    }
  } else if (done) {
    payment = { state: "ok", label: "完了扱い", sub: row.settlement.closedReason ?? null };
  } else if (row.settlementDoc && row.settlementDoc.phase !== "draft") {
    payment = now({ state: "now", label: "未作成",
      action: h.onOpenPayments ? { label: "支払を起こす", run: h.onOpenPayments } : null });
  } else {
    payment = { state: "none", label: "—" };
  }
  return { order, delivery, settlement, payment };
}

interface Bundle {
  party: GridParty | null;
  rows: GridRow[];
  stuck: number;
  unpaid: number;
  ordered: number;
  inspected: number;
  done: boolean;
  /**
   * 決定済みで CloudSign にまだ送っていない文書（発注書・検収書）。同じ発注書に
   * 条件が何本も載っていれば 1 枚に数える。納品済みで発注書と検収書を一緒に
   * 作った相手には、この 2 枚を 1 封筒で送るのが一番早い。
   */
  unsent: GridDocument[];
}

function CellView(
  { cell, last, sign }: {
    cell: Cell; last?: boolean;
    /** CloudSign の札。editing がこの文書ならスイッチを開く。 */
    sign?: { editing: number | null; open: (id: number) => void; close: () => void;
             done: (message: string) => void; readOnly: boolean } | null;
  }
) {
  const d = cell.doc ?? null;
  return (
    <div className={`bcell ${cell.state}${last ? " last" : ""}`}>
      <div className="st">
        <i className="k"></i>
        {cell.open
          ? <button type="button" className="linky code" style={{ fontWeight: "inherit", color: "inherit" }}
                    onClick={cell.open}>{cell.label}</button>
          : <span>{cell.label}</span>}
      </div>
      {cell.sub && <div className="sub">{cell.sub}</div>}
      {d && sign && (
        <div className="sign">
          <SignTag sign={d.sign} disabled={sign.readOnly}
                   onClick={() => (sign.editing === d.id ? sign.close() : sign.open(d.id))} />
          {sign.editing === d.id && (
            <SignSwitch documentId={d.id} documentNo={d.documentNo} current={d.sign}
                        onDone={sign.done} onClose={sign.close} />
          )}
        </div>
      )}
      {cell.action && (
        <div className="act">
          <button type="button" className={`btn btn-sm${cell.state === "now" ? " primary" : ""}`}
                  onClick={cell.action.run}>{cell.action.label}</button>
        </div>
      )}
    </div>
  );
}

/** 契約の札。側（業務委託／許諾）が分かるものはそれも書く。移行した契約は側が空なので「契約」。 */
function agreementLabel(a: { kind: string; domain: string | null }): string {
  const side = a.domain === "service" ? "業務委託" : a.domain === "license" ? "許諾" : null;
  const kind = a.kind === "standalone" ? "単体契約" : a.kind === "master" ? "基本契約" : "契約";
  return side ? `${kind}（${side}）` : a.domain === null ? "契約" : kind;
}

export function MatterBundles(
  { detail, reloadKey, onOpenCondition, onOpenDocument, onCompose, onRecordEvent, onOpenPayments,
    onRegisterAgreement, onOpenList, channels, isAdmin }: {
    detail: MatterDetail;
    reloadKey?: number;
    onOpenCondition?: (conditionId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    onRecordEvent?: (conditionId: number) => void;
    onOpenPayments?: () => void;
    /** 契約の画面へ、その相手先を入れた状態で移る。 */
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
    /** 「一覧」タブへ（条件を作る・繋ぐはそちら）。 */
    onOpenList?: (kind: "conditions" | "events" | "documents" | "payments") => void;
    /** 送る手段の状態（CloudSign が動くか）。無ければ送る釦は出さない。 */
    channels?: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }> | null;
    isAdmin?: boolean;
  }
) {
  const readOnly = useReadOnly();
  const matterId = detail.id;
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [parties, setParties] = useState<GridParty[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "stuck" | "unpaid" | "done" | "nocontract">("all");
  const [sort, setSort] = useState<"stuck" | "name" | "unpaid">("stuck");
  const [q, setQ] = useState("");
  /** 開いている束。既定は詰まりと未払のある束だけ。 */
  const [opened, setOpened] = useState<Set<string> | null>(null);
  /** CloudSign の状態を手で直しているセル（文書 id）。 */
  const [signEditing, setSignEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  /** CloudSign でまとめて送っている束（取引先のキー）。 */
  const [sendingParty, setSendingParty] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.get<{ rows: GridRow[]; parties: GridParty[] }>(`/matters/${matterId}/grid`)
      .then((r) => { setRows(r.rows); setParties(r.parties ?? []); })
      .catch((e: ApiError) => { setError(e.message); setRows([]); });
  }, [matterId, reloadKey, bump]);
  useEffect(() => { setOpened(null); setFilter("all"); setQ(""); }, [matterId]);

  const h = { onOpenDocument, onCompose, onRecordEvent, onOpenPayments };
  const sign = {
    editing: signEditing, readOnly,
    open: (id: number) => setSignEditing(id),
    close: () => setSignEditing(null),
    done: (message: string) => { setSignEditing(null); setNotice(message); setBump((n) => n + 1); }
  };

  const bundles = useMemo<Bundle[]>(() => {
    if (!rows) return [];
    const byParty = new Map<string, Bundle>();
    for (const row of rows) {
      const key = String(row.counterparty?.id ?? "none");
      const b = byParty.get(key) ?? {
        party: parties.find((p) => p.id === row.counterparty?.id) ?? null,
        rows: [], stuck: 0, unpaid: 0, ordered: 0, inspected: 0, done: true, unsent: []
      };
      b.rows.push(row);
      for (const d of [row.order, row.settlementDoc]) {
        if (d && d.phase !== "draft" && d.sign.status === "unsent" && !b.unsent.some((x) => x.id === d.id)) {
          b.unsent.push(d);
        }
      }
      const cells = cellsOf(row, matterId, {});
      if (Object.values(cells).some((c) => c.state === "now")) b.stuck += 1;
      if (row.settlement.targetAmount !== null && !row.settlement.done) {
        b.unpaid += Math.max(row.settlement.targetAmount - row.settlement.paidAmount, 0);
      } else if (row.payment && row.payment.status !== "paid" && row.payment.amount) {
        b.unpaid += row.payment.amount;
      }
      b.ordered += row.order?.amountExTax ?? row.flatAmount ?? 0;
      b.inspected += row.settlementDoc?.amountExTax ?? 0;
      if (!row.settlement.done) b.done = false;
      byParty.set(key, b);
    }
    return [...byParty.values()];
  }, [rows, parties, matterId]);

  const kpi = useMemo(() => ({
    parties: bundles.filter((b) => b.party).length,
    conditions: rows?.length ?? 0,
    stuck: bundles.reduce((s, b) => s + b.stuck, 0),
    unpaid: bundles.reduce((s, b) => s + b.unpaid, 0),
    paid: (rows ?? []).reduce((s, r) => s + r.settlement.paidAmount, 0),
    // 「契約なし」に数えるのは登録が要る相手だけ。発注書の約款で取引している相手は正常。
    noContract: bundles.filter((b) => b.party && (b.party.contract === "none" || b.party.contract === "claimed")).length
  }), [bundles, rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = bundles.filter((b) => {
      if (filter === "stuck" && !b.stuck) return false;
      if (filter === "unpaid" && !b.unpaid) return false;
      if (filter === "done" && !b.done) return false;
      if (filter === "nocontract" && !(b.party && (b.party.contract === "none" || b.party.contract === "claimed"))) return false;
      if (needle) {
        const hay = [b.party?.name, b.party?.partyCode, ...b.rows.map((r) => r.name), ...b.rows.map((r) => r.conditionNo)]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    if (sort === "stuck") list = [...list].sort((a, b) => (b.stuck - a.stuck) || (b.unpaid - a.unpaid) || Number(a.done) - Number(b.done));
    if (sort === "name") list = [...list].sort((a, b) => (a.party?.name ?? "").localeCompare(b.party?.name ?? "", "ja"));
    if (sort === "unpaid") list = [...list].sort((a, b) => b.unpaid - a.unpaid);
    return list;
  }, [bundles, filter, sort, q]);

  const single = bundles.length === 1;
  const keyOf = (b: Bundle) => String(b.party?.id ?? "none");
  const isOpen = (b: Bundle) => single || filter !== "all" || Boolean(q.trim())
    || (opened ? opened.has(keyOf(b)) : b.stuck > 0 || b.unpaid > 0);
  const toggle = (b: Bundle) => setOpened((prev) => {
    const next = new Set(prev ?? bundles.filter((x) => x.stuck > 0 || x.unpaid > 0).map(keyOf));
    if (next.has(keyOf(b))) next.delete(keyOf(b)); else next.add(keyOf(b));
    return next;
  });
  const hidden = bundles.length - shown.length;

  if (error) return <div className="alert">{error}</div>;
  if (!rows) return <div className="faint">読み込んでいます…</div>;
  if (!rows.length) {
    return (
      <div className="note">
        この案件にはまだ条件明細がありません。
        {onOpenList && (
          <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => onOpenList("conditions")}>
            条件を作る・繋ぐ（一覧へ）
          </button>
        )}
      </div>
    );
  }

  const rowView = (row: GridRow, last: boolean) => {
    const cells = cellsOf(row, matterId, h);
    return (
      <div key={row.conditionId} className={`bchain${last ? " last" : ""}`}>
        <div className="name">
          {onOpenCondition
            ? <button type="button" className="linky" style={{ fontWeight: 600 }}
                      onClick={() => onOpenCondition(row.conditionId)}>{row.name}</button>
            : row.name}
          <span className="faint code">{row.conditionNo ?? `#${row.conditionId}`} ／ {conditionAmountLabel(row)}</span>
          {row.settlement.done && <span className="tag ok" style={{ marginTop: 2 }}>払い切り</span>}
        </div>
        <CellView cell={cells.order} sign={sign} />
        <CellView cell={cells.delivery} />
        <CellView cell={cells.settlement} sign={sign} />
        <CellView cell={cells.payment} />
        <div className="faint">{row.payment?.note ?? ""}</div>
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      {notice && (
        <div className="note ok row" style={{ justifyContent: "space-between" }}>
          <span>{notice}</span>
          <button type="button" className="linky" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}
      <div className="bkpi">
        <div><div className="faint">取引先</div><div className="n">{kpi.parties}</div></div>
        <div><div className="faint">条件</div><div className="n">{kpi.conditions}</div></div>
        <div><div className="faint">詰まり</div><div className={`n${kpi.stuck ? " out" : ""}`}>{kpi.stuck}</div></div>
        <div><div className="faint">未払残</div><div className={`n${kpi.unpaid ? " warn" : ""}`}>{yen(kpi.unpaid)}</div></div>
        <div><div className="faint">支払済み</div><div className="n">{yen(kpi.paid)}</div></div>
        <div><div className="faint">契約なしの相手</div><div className={`n${kpi.noContract ? " out" : ""}`}>{kpi.noContract}</div></div>
      </div>

      {!single && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="chips">
            {([["all", "すべて", bundles.length],
               ["stuck", "詰まりあり", bundles.filter((b) => b.stuck).length],
               ["unpaid", "未払あり", bundles.filter((b) => b.unpaid).length],
               ["done", "完了", bundles.filter((b) => b.done).length],
               ["nocontract", "契約なし", kpi.noContract]] as const).map(([v, label, n]) => (
              <button key={v} className="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                {label} {n}
              </button>
            ))}
          </div>
          <div className="row">
            <span className="faint">並び</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="stuck">詰まりが先</option>
              <option value="name">相手先名</option>
              <option value="unpaid">未払残が大きい順</option>
            </select>
            <input className="inline-input" value={q} placeholder="相手先・品目で絞る"
                   onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      )}

      {shown.map((b) => {
        const open = isOpen(b);
        const p = b.party;
        return (
          <div key={keyOf(b)} className={`bundle${b.stuck ? " stuck" : ""}${b.done ? " done" : ""}${open ? " open" : ""}`}>
            {/* 相手が1社の案件では束の見出しを省く（契約と未払残だけ1行で）。 */}
            <div className="bundle-hd">
              <div className="who">
                {single ? null : p
                  ? <><b>{p.name}</b><span className="faint code">{p.partyCode ?? ""}</span></>
                  : <b className="faint">（相手先なし）</b>}
                {p && (p.agreement
                  ? <span className="tag ok" title={p.agreement.domain ? undefined : "移行した契約で、業務委託か許諾かの区別が付いていません。契約の画面で直せます"}>
                      {agreementLabel(p.agreement)} {p.agreement.agreementNo ?? ""}
                    </span>
                  : p.contract === "spot"
                  ? <span className="tag ghost" title="基本契約を結ばず、発注書の約款で取引している相手。契約の登録は要りません">
                      基本契約なし（発注書の約款）
                    </span>
                  : p.contract === "claimed"
                  ? <span className="tag out" title="発注書には「基本契約に基づく」と書いてあるのに、その契約が登録されていません">
                      発注書は基本契約あり・未登録
                    </span>
                  : <span className="tag out" title="契約も発注書もまだ無い相手">契約なし</span>)}
                {b.done && <span className="tag ok">完了</span>}
                <span className="tag ghost">条件 {b.rows.length}</span>
                {b.stuck > 0 && !open && <span className="tag out">詰まり {b.stuck}</span>}
              </div>
              <div className="sum">
                <span>発注 <b>{yen(b.ordered)}</b></span>
                <span>検収 <b>{b.inspected ? yen(b.inspected) : "—"}</b></span>
                <span>未払残 <b>{yen(b.unpaid)}</b></span>
                {p && (p.contract === "none" || p.contract === "claimed") && onRegisterAgreement && (
                  <button className="btn btn-sm primary" disabled={readOnly}
                          onClick={() => onRegisterAgreement(p.id, p.name)}>契約を登録する</button>
                )}
                {p && b.unsent.length > 0 && channels && (
                  <button className="btn btn-sm" disabled={readOnly || !isAdmin}
                          title={isAdmin
                            ? `決定済みで未送信の ${b.unsent.map((d) => d.documentNo ?? `#${d.id}`).join("・")} を 1 つの封筒で送ります`
                            : "署名依頼は admin だけです"}
                          onClick={() => setSendingParty(sendingParty === keyOf(b) ? null : keyOf(b))}>
                    CloudSign でまとめて送る（{b.unsent.length} 枚）
                  </button>
                )}
                {!single && (
                  <button className="btn btn-sm" onClick={() => toggle(b)}>
                    {open ? "畳む" : `${b.rows.length} 行を開く`}
                  </button>
                )}
              </div>
            </div>
            {sendingParty === keyOf(b) && p && channels && (
              <div style={{ padding: "0 10px 10px" }}>
                <SendMany
                  title={`${p.name} へ ${b.unsent.length} 枚を 1 封筒で送る`}
                  documents={b.unsent.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: p.name }))}
                  channels={channels} isAdmin={Boolean(isAdmin)}
                  initialWay="cloudsign" prefillSigners
                  onDone={() => { setSendingParty(null); setNotice(`${p.name}：CloudSign で送りました`); setBump((n) => n + 1); }}
                  onClose={() => setSendingParty(null)} />
              </div>
            )}
            {open && (
              <div className="bchain-wrap">
                <div className="bchain cols">
                  <div>条件（品目）</div><div>発注書</div><div>納品</div><div>検収書</div><div>支払</div><div>備考</div>
                </div>
                {b.rows.map((r, i) => rowView(r, i === b.rows.length - 1))}
              </div>
            )}
          </div>
        );
      })}

      {hidden > 0 && (
        <div className="bfold">
          <span>絞り込みで {hidden} 社を隠しています</span>
          <button className="btn btn-sm" onClick={() => { setFilter("all"); setQ(""); }}>全部出す</button>
        </div>
      )}
      {!shown.length && <div className="faint">当てはまる取引先はありません</div>}

      <div className="blegend">
        <span><i style={{ background: "var(--out)", boxShadow: "0 0 0 3px var(--out-soft)" }}></i>いま止まっている手（押すとその場で操作）</span>
        <span><i style={{ background: "var(--warn)" }}></i>待ち（支払待ち）</span>
        <span><i style={{ background: "var(--ok)" }}></i>済</span>
        <span><i style={{ background: "var(--line-strong)" }}></i>まだ</span>
        <span><span className="tag ghost">CS</span> CloudSign の状態（未送信／送信済／締結済／取下げ）。押すと手で直せます</span>
        {onOpenList && (
          <button className="linky" style={{ marginLeft: "auto" }} onClick={() => onOpenList("conditions")}>
            種類別の表（条件明細・実績・文書・支払）は「一覧」へ
          </button>
        )}
      </div>
    </div>
  );
}
