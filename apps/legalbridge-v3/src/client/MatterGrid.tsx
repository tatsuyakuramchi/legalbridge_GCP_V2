import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { SettlementTag, StatusTag } from "./labels.js";
import { conditionAmountLabel } from "./ConditionLabel.js";
import {
  GRID_FILTER_LABEL, applyFilter, filterCounts, groupByParty,
  type GridDocument, type GridFilter, type GridRow
} from "../server/matters/grid.js";

/**
 * 工程表。条件1本を1行に、予定・発注書・実績・検収書・支払を横に並べる。
 *
 * これまで条件・実績・文書・支払はタブごとに分かれていた。1本ずつは追えても、
 * 取引先が20社を超える案件では「どの社のどれが止まっているか」を目で拾う
 * しかなかった。段で絞れば止まっている行だけが残る。
 *
 * ここは読む画面。押すとその段の画面へ移る（作る・開くは既存の口を使う）。
 */

const FILTERS: GridFilter[] = ["all", "order", "event", "settlementDoc", "payment", "settled"];

/** 文書のセル。あれば番号と段階、無ければ作る口。 */
function DocCell(
  { doc, make, onOpen, onMake }: {
    doc: GridDocument | null;
    make: string;
    onOpen?: (documentId: number) => void;
    onMake?: () => void;
  }
) {
  if (!doc) {
    return onMake
      ? <button className="btn btn-sm" onClick={onMake}>{make}</button>
      : <span className="faint">—</span>;
  }
  return (
    <>
      <div className="code">
        {onOpen
          ? <button className="linky" onClick={() => onOpen(doc.id)}>{doc.documentNo ?? `#${doc.id}`}</button>
          : (doc.documentNo ?? `#${doc.id}`)}
      </div>
      <div style={{ marginTop: 3 }}><StatusTag kind="document" value={doc.phase} /></div>
    </>
  );
}

function Row(
  { row, picked, onPick, onOpenCondition, onOpenDocument, onCompose, onRecordEvent,
    onOpenPayments, indent }: {
    row: GridRow;
    picked: boolean;
    onPick: (on: boolean) => void;
    onOpenCondition?: (conditionId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    onRecordEvent?: (conditionId: number) => void;
    /** 支払タブへ移る。支払はここでは起こさず、既存の口へ渡す。 */
    onOpenPayments?: () => void;
    /** 取引先でまとめているとき、取引先の列を畳んで条件を下げる。 */
    indent?: boolean;
  }
) {
  const money = conditionAmountLabel(row);
  return (
    <tr className={picked ? "sel" : undefined}>
      <td><input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)}
                 aria-label={`${row.conditionNo ?? row.conditionId} を選ぶ`} /></td>
      {!indent && (
        <td className="grid-party">
          {row.counterparty
            ? <b>{row.counterparty.name}</b>
            : <span className="faint">（相手先なし）</span>}
        </td>
      )}
      <td style={indent ? { paddingLeft: 22 } : undefined}>
        <div>
          {onOpenCondition
            ? <button className="linky" onClick={() => onOpenCondition(row.conditionId)}>{row.name}</button>
            : row.name}
        </div>
        <div className="faint code">{row.conditionNo ?? `#${row.conditionId}`}　{money}</div>
        <div style={{ marginTop: 3 }}>
          <StatusTag kind="condition" value={row.status} />
          {" "}<SettlementTag settlement={row.settlement} compact />
        </div>
      </td>
      <td>
        {row.schedules.total
          ? <span className={`tag ${row.schedules.done >= row.schedules.total ? "ok" : row.schedules.done ? "warn" : ""}`}
                  title="実績の付いた回 ／ 予定の回">
              {row.schedules.done}/{row.schedules.total} 回
            </span>
          : <span className="faint">—</span>}
      </td>
      <td>
        <DocCell doc={row.order} make="作る" onOpen={onOpenDocument}
                 onMake={onCompose && (() => onCompose([row.conditionId], [], undefined, "purchase_order"))} />
      </td>
      <td>
        {row.events.count
          ? <>
              <div>
                {onRecordEvent
                  ? <button className="linky" onClick={() => onRecordEvent(row.conditionId)}>
                      {row.events.count} 件
                    </button>
                  : `${row.events.count} 件`}
              </div>
              <div className="faint">直近 {row.events.latestOn ?? "—"}</div>
            </>
          : onRecordEvent
            ? <button className="btn btn-sm" onClick={() => onRecordEvent(row.conditionId)}>記録する</button>
            : <span className="faint">—</span>}
      </td>
      <td>
        {/* 検収書・計算書は実績から作る。実績が無いうちは作れないので、
            押すと実績タブへ移る（そこで実績を選んで作る）。 */}
        <DocCell doc={row.settlementDoc} make="実績から作る" onOpen={onOpenDocument}
                 onMake={row.events.count && onRecordEvent
                   ? () => onRecordEvent(row.conditionId) : undefined} />
      </td>
      <td>
        {row.payment
          ? <>
              <div className="code">{row.payment.paymentNo ?? `#${row.payment.id}`}</div>
              <div style={{ marginTop: 3 }}><StatusTag kind="payment" value={row.payment.status} /></div>
            </>
          : onOpenPayments
            ? <button className="btn btn-sm"
                      title="支払タブへ移る。検収書・計算書から起こすか、条件に宛てて起こす"
                      onClick={onOpenPayments}>起こす</button>
            : <span className="faint">—</span>}
      </td>
    </tr>
  );
}

export function MatterGrid(
  { matterId, partyId, reloadKey, onOpenCondition, onOpenDocument, onCompose, onRecordEvent,
    onOpenPayments }: {
    matterId: number;
    /** 取引先で絞っているとき。工程表もそれに合わせる。 */
    partyId?: number | null;
    reloadKey?: number;
    onOpenCondition?: (conditionId: number) => void;
    onOpenDocument?: (documentId: number) => void;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    /** 実績タブをその条件で開く。検収書・計算書もそこから作る。 */
    onRecordEvent?: (conditionId: number) => void;
    /** 支払タブを開く。 */
    onOpenPayments?: () => void;
  }
) {
  const [all, setAll] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GridFilter>("all");
  const [grouped, setGrouped] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    setError(null);
    api.get<{ rows: GridRow[] }>(`/matters/${matterId}/grid`)
      .then((r) => setAll(r.rows))
      .catch((e: ApiError) => { setError(e.message); setAll([]); });
  }, [matterId, reloadKey]);

  // 案件の取引先の絞り込みをそのまま効かせる。工程表だけ別の社が出ると混乱する。
  const mine = useMemo(
    () => (all ?? []).filter((r) => !partyId || r.counterparty?.id === partyId), [all, partyId]);
  const counts = useMemo(() => filterCounts(mine), [mine]);
  const rows = useMemo(() => applyFilter(mine, filter), [mine, filter]);
  const groups = useMemo(() => (grouped ? groupByParty(rows) : []), [rows, grouped]);

  // 絞り込みを変えると、見えていない行を選んだままになる。
  useEffect(() => {
    setPicked((prev) => new Set([...prev].filter((id) => rows.some((r) => r.conditionId === id))));
  }, [rows]);

  if (error) return <div className="alert">{error}</div>;
  if (!all) return <div className="faint">読み込んでいます…</div>;
  if (!all.length) {
    return (
      <div className="faint">
        この案件には条件明細がありません。条件明細タブで作るか、すでにある条件を繋いでください。
      </div>
    );
  }

  const pickedRows = rows.filter((r) => picked.has(r.conditionId));
  const canOrder = pickedRows.filter((r) => !r.order);
  const canSettle = pickedRows.filter((r) => r.events.count > 0 && !r.settlementDoc);

  const head = (
    <tr>
      <th></th>
      {!grouped && <th className="stage-hd">取引先</th>}
      <th className="stage-hd">条件<span className="stage-sub">番号・金額</span></th>
      <th className="stage-hd">予定<span className="stage-sub">回の消化</span></th>
      <th className="stage-hd">発注書<span className="stage-sub">条件の文書</span></th>
      <th className="stage-hd">実績<span className="stage-sub">納品・検収</span></th>
      <th className="stage-hd">検収書<span className="stage-sub">結果の文書</span></th>
      <th className="stage-hd">支払<span className="stage-sub">起こす・払う</span></th>
    </tr>
  );
  const rowOf = (r: GridRow, indent?: boolean) => (
    <Row key={r.conditionId} row={r} indent={indent}
         picked={picked.has(r.conditionId)}
         onPick={(on) => setPicked((prev) => {
           const next = new Set(prev);
           if (on) next.add(r.conditionId); else next.delete(r.conditionId);
           return next;
         })}
         onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
         onCompose={onCompose} onRecordEvent={onRecordEvent} onOpenPayments={onOpenPayments} />
  );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="stagefilter">
        <span className="faint">段で絞る</span>
        {FILTERS.map((f) => (
          <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {GRID_FILTER_LABEL[f]} {counts[f]}
          </button>
        ))}
        <label className="row" style={{ gap: 5, marginLeft: "auto" }}>
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          <span className="faint">取引先でまとめる</span>
        </label>
      </div>

      {/* 選んだ行にまとめて効く操作。かっこの数は、その操作ができる本数。 */}
      {pickedRows.length > 0 && (
        <div className="bulkbar">
          <b>{pickedRows.length} 本を選んでいます</b>
          {onCompose && (
            <button className="btn btn-sm primary" disabled={!canOrder.length}
                    title="選んだ条件をまとめて1枚の発注書にします"
                    onClick={() => onCompose(canOrder.map((r) => r.conditionId), [], matterId, "purchase_order")}>
              発注書をまとめて作る（{canOrder.length}）
            </button>
          )}
          {onCompose && (
            <button className="btn btn-sm" disabled={!canSettle.length}
                    title="選んだ条件の実績をまとめて1枚の検収書・計算書にします"
                    onClick={() => onCompose(canSettle.map((r) => r.conditionId), [], matterId, null)}>
              検収書・計算書をまとめて作る（{canSettle.length}）
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setPicked(new Set())}>選び直す</button>
          <span className="faint">かっこの数は、その操作ができる本数です</span>
        </div>
      )}

      <div className="tablewrap grid-wrap">
        <table>
          <thead>{head}</thead>
          <tbody>
            {grouped
              ? groups.map((g) => [
                  <tr key={`g${g.id ?? "none"}`} className="grid-grp">
                    <td colSpan={7}>
                      <b>{g.name}</b>
                      <span className="faint">　条件 {g.tally.conditions} 本</span>
                      <span className="faint">
                        　｜　発注書 {g.tally.orders} ／ 検収書 {g.tally.settlementDocs} ／ 支払 {g.tally.payments}
                      </span>
                    </td>
                  </tr>,
                  ...g.rows.map((r) => rowOf(r, true))
                ])
              : rows.map((r) => rowOf(r))}
            {!rows.length && (
              <tr><td colSpan={grouped ? 7 : 8} className="faint">
                {GRID_FILTER_LABEL[filter]} に当てはまる条件はありません。
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
