// 検収書のサブスク（定期支払）明細を「周期ごとの明細」へ分割する（純関数）。
// サブスクは1行に複数周期が入るため、行単位の検収状態（今回検収/検収済み/未検収）では
// 「3期まで支払済み・今期を検収・残りは未検収」を表現できない。周期ごとに行を分ければ
// 既存の行単位ステータス・支払日ごとのPDFグループ表示がそのまま使える。
//
// 分割の情報源（優先順）:
//   1. 発注書の支払予定日（payment_schedule: [{date, amount}]）→ 各期の日付・金額を採用
//   2. 単価（unit_price=1周期の金額）× 周期数
//   3. 金額÷周期数の均等割（端数は最終期に寄せて合計を保存する）

export type InspectionRow = Record<string, unknown>;

const toNum = (value: unknown): number => {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

function scheduleOf(row: InspectionRow): Array<{ date: string; amount: number }> {
  const raw = row.payment_schedule;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ date: String(x.date ?? "").trim(), amount: toNum(x.amount) }));
}

/** 分割できる行か（サブスクかつ周期が2以上）。 */
export function canSplitSubscription(row: InspectionRow): boolean {
  if (String(row.calc_method ?? "") !== "SUBSCRIPTION") return false;
  return splitCount(row) >= 2;
}

export function splitCount(row: InspectionRow): number {
  const schedule = scheduleOf(row);
  if (schedule.length >= 2) return schedule.length;
  return Math.trunc(toNum(row.inspected_quantity) || toNum(row.ordered_quantity)) || 1;
}

/**
 * 周期ごとの行に分割する。合計金額は必ず元の行と一致する。
 * 分割後の各行は 未検収（skip）で生成し、該当期だけを今回検収/検収済みへ切り替えてもらう
 * （どの期が支払済みかはユーザーにしか分からないため、安全側＝金額に入れない状態から始める）。
 */
export function splitSubscriptionLine(row: InspectionRow): InspectionRow[] | null {
  if (!canSplitSubscription(row)) return null;
  const count = splitCount(row);
  const schedule = scheduleOf(row);
  const total = toNum(row.inspected_amount_ex_tax) || toNum(row.ordered_amount_ex_tax);
  const unit = toNum(row.unit_price);

  // 各期の金額を決める（優先: 支払予定の金額 → 単価 → 均等割・端数は最終期）。
  const amounts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (schedule.length === count && schedule[i].amount > 0) amounts.push(schedule[i].amount);
    else if (unit > 0) amounts.push(unit);
    else amounts.push(Math.floor(total / count));
  }
  if (schedule.length !== count && unit <= 0 && total > 0) {
    // 均等割の端数は最終期に寄せて合計を保存する。
    const sum = amounts.reduce((s, v) => s + v, 0);
    amounts[count - 1] += total - sum;
  }

  const baseName = String(row.item_name ?? "").trim() || "定期支払";
  return amounts.map((amount, i) => ({
    ...row,
    item_name: `${baseName}（第${i + 1}期）`,
    calc_method: "SUBSCRIPTION",
    inspection_status: "skip",           // 安全側: 該当期だけを切り替えてもらう
    inspected_quantity: 1,
    ordered_quantity: 1,
    acceptance_ratio: 1,
    unit_price: amount,                  // 1期＝1周期の金額（数量変更時の再計算も整合）
    ordered_amount_ex_tax: amount,
    inspected_amount_ex_tax: amount,
    // 支払予定日があれば納品日（期日の目安）に写す。paid へ切替時の支払日入力の手掛かり。
    delivery_date: schedule.length === count ? schedule[i].date : String(row.delivery_date ?? ""),
    payment_schedule: undefined,         // 分割後の行には引き継がない（再分割の誤爆防止）
    paid_date: "", history_source: "", change_reason: ""
  }));
}
