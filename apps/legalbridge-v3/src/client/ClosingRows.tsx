import { money } from "./api.js";
import { PRICING_MODEL_LABEL } from "./labels.js";
import { STEP_TONE, type PeriodRow } from "./closing-types.js";

/**
 * 回の表。月で切っても条件で切っても、行の形は同じにする。
 *
 * 表を2つ作ると、同じ判断が2か所に置かれて片方が古くなる。切り口だけを
 * 変えて、同じ表に2つの入口を付ける。
 */
export function ClosingRows({
  rows, showParty = true, selected, onSelect,
  onOpenCondition, onOpenDocument, onRecord, empty
}: {
  rows: PeriodRow[];
  /** 条件1本を見ているときは相手先の列を畳む（全行同じなので邪魔になる）。 */
  showParty?: boolean;
  /** 選べる表にするなら渡す。渡さなければ見るだけ。 */
  selected?: Set<number>;
  onSelect?: (next: Set<number>) => void;
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
  /**
   * その回の実績を入れに行く。条件明細の画面の実績フォームを、この回を
   * 指した状態で開く。
   *
   * まとめて締めるのは「予定どおりの額でよい回」だけ。予定と実績が違う回は
   * 理由が要るし、料率は売上報告そのものを入れないと金額が出ない。どちらも
   * 既存のフォームの仕事なので、ここでは入口だけ出して送る。
   */
  onRecord?: (conditionId: number, scheduleId: number) => void;
  empty?: string;
}) {
  // 選べるのは予定の回だけ。浮いた実績は個別に締める。
  // 締め日の来ていない回も選ばせない。選べても必ず「対象から外す」に落ちるので、
  // チェックを入れられること自体が嘘になる。
  const selectable = rows.filter(canClose);
  const allOn = selectable.length > 0 && selectable.every((r) => selected?.has(r.scheduleId!));

  const toggle = (id: number) => {
    if (!onSelect || !selected) return;
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelect(next);
  };

  if (!rows.length) return <p className="faint">{empty ?? "この切り口では回が並んでいません。"}</p>;

  return (
    <div className="tablewrap">
      <table>
        <thead><tr>
          {onSelect && (
            <th style={{ width: 28 }}>
              <input type="checkbox" checked={allOn} aria-label="すべて選ぶ"
                onChange={() => onSelect(new Set(allOn ? [] : selectable.map((r) => r.scheduleId!)))} />
            </th>
          )}
          {showParty && <th>取引先／条件</th>}
          <th>回</th>
          <th className="num">予定額</th>
          <th>実績・報告</th>
          <th>決済文書</th>
          <th>支払</th>
          <th>状態</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => {
            const id = row.scheduleId;
            const canPick = canClose(row);
            return (
              <tr key={`${row.conditionId}-${id ?? `e${row.eventId}`}`}
                  className={row.lateDays > 0 ? "overdue" : ""}>
                {onSelect && (
                  <td>{canPick && (
                    <input type="checkbox" checked={selected?.has(id!) ?? false}
                      aria-label={`${row.conditionName} 第${row.seq ?? "?"}回を選ぶ`}
                      onChange={() => toggle(id!)} />
                  )}</td>
                )}
                {showParty && (
                  <td>
                    <div>{row.party?.name ?? "—"}</div>
                    <button className="linky" onClick={() => onOpenCondition?.(row.conditionId)}>
                      {row.conditionName}
                    </button>
                    <div className="faint">
                      {row.conditionNo ?? "—"}
                      　<span className="tag ghost">{PRICING_MODEL_LABEL[row.pricingModel] ?? row.pricingModel}</span>
                    </div>
                  </td>
                )}
                <td>
                  <div>{row.label ?? (row.seq ? `第${row.seq}回` : "—")}</div>
                  <div className="faint code">{row.closingOn ?? "締め日なし"}</div>
                  {row.lateDays > 0 && <div className="danger">{row.lateDays}日 遅れ</div>}
                  {row.unplanned && <div className="faint">予定の無い実績</div>}
                </td>
                <td className="num">
                  {row.plannedAmount === null ? "—"
                    : row.plannedAmount === 0 ? <span className="faint">—</span>
                    : money(row.plannedAmount, row.currency)}
                </td>
                <td>
                  {row.eventId !== null
                    ? <>
                        <div className="num">{money(row.eventAmount, row.currency)}</div>
                        <div className="faint code">{row.eventOn ?? ""}</div>
                      </>
                    // 締め日の前に「実績を入れる」は出さない。まだ起きていない
                    // ことを入れる欄を出しても、入れる中身が無い。
                    : onRecord && id !== null && !notYet(row.closingOn)
                    ? <button className="btn btn-sm"
                        onClick={() => onRecord(row.conditionId, id)}>
                        {row.pricingModel === "revenue_rate" ? "報告を入れる" : "実績を入れる"}
                      </button>
                    : <span className="faint">—</span>}
                </td>
                <td>
                  {row.documentId === null
                    ? <span className="faint">{row.documentLabel}まだ</span>
                    : <button className="linky code" onClick={() => onOpenDocument?.(row.documentId!)}>
                        {row.documentNo ?? `#${row.documentId}`}
                      </button>}
                </td>
                <td>
                  {row.paymentId === null
                    ? <span className="faint">—</span>
                    : <>
                        <div className="code">{row.paymentNo ?? `#${row.paymentId}`}</div>
                        <div className="faint">{row.paidOn ? `${row.paidOn} 済` : row.paymentStatus}</div>
                      </>}
                  <DueNote row={row} />
                </td>
                <td><span className={`tag ${STEP_TONE[row.step]}`}>{row.state}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 締め日がまだ来ていないか。サーバの notYet と同じ線。 */
const notYet = (closingOn: string | null) =>
  !!closingOn && closingOn > new Date().toISOString().slice(0, 10);

/**
 * その回を選べるか。サーバの refusalFor と同じ線で切る（そこで断られる行に
 * チェックを付けさせない）。
 */
const canClose = (row: PeriodRow): row is PeriodRow & { scheduleId: number } =>
  row.scheduleId !== null && row.step !== "done"
  && !!row.closingOn && !notYet(row.closingOn);

/**
 * 支払期日と、それがどこから来たか。
 *
 * 「上限60日」は下請法の上限であって約束の日ではない。そのまま出すと
 * 「60日後に払う約束がある」と読み違えるので、ここだけ色を変えて、
 * 条件に支払条件を入れる合図として扱う。
 */
export function DueNote({ row }: { row: PeriodRow }) {
  if (!row.due.on) return null;
  const limit = row.due.source === "limit";
  // 合図は1つで足りる。日付まで赤くすると、期日そのものが異常に見える。
  return (
    <div className="faint" title={row.due.label}>
      期日 {row.due.on}
      {limit && <span className="tag ghost out" style={{ marginLeft: 4 }}>上限60日</span>}
    </div>
  );
}
