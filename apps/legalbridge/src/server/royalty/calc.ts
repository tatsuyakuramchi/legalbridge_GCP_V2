/**
 * ロイヤリティ計算エンジン（純関数・DB非依存）— Phase 1 スライス1。
 *
 * V1（`LegalBridge_AI_GCP` worker `lib/billing.ts`, 4モデル版=正典）を V2 へ
 * 忠実移植したもの。発注書↔検収書 と 利用許諾条件書↔利用許諾料計算書 の
 * どちらも最終的に同じ形の金額カスケードへ収束する：
 *
 *   gross_ex_tax（計算型に依存）
 *     ↓ × acceptance_ratio（歩留率）
 *   after_acceptance
 *     ↓ MG floor：max(after_acceptance, mg_amount)
 *   after_mg
 *     ↓ − AG 相殺（累積消化）
 *   actual_ex_tax
 *     ↓ × tax_rate（ceil）
 *   total_inc_tax
 *
 * gross の形は契約の料金モデルで決まる：
 *   固定額型   gross = ceil(unit_price × (quantity − sample_quantity))
 *   サブスク型 gross = ceil(period_amount × period_count + initial_fee)
 *   業績連動型 gross = ceil(base_price × (quantity − sample_quantity) × rate_pct/100)
 *   売上報告型 gross = ceil(base_amount × rate_pct/100)（数量なし）
 *
 * 丸めポリシー（Legal合意）：消費税・その他の中間計算とも Math.ceil で統一。
 *
 * MG / AG モデル：
 *   - MG（最低保証）= 各計算書での floor。actual = max(after_acceptance, mg_amount)。
 *     MG 自体は消化されない（毎期独立の floor チェック）。
 *   - AG（前払保証）= 累積消化型。将来発生分から相殺、AG残高を超えるまで実支払ゼロ。
 *   - 計算順序：gross → acceptance → MG floor → AG offset → actual。
 *   - ag_consumed_before は呼び出し側（DB集計）が渡す。
 *
 * 互換注記：旧shapeの mg_consumed_* は MG が floor 化する前の消化型データで、
 * AG として再解釈すべきもの。既存呼び出し側との互換のため返却shapeは維持し、
 * 常に 0 / mg_amount / false を返す（deprecated）。
 */

// ─────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────

export type FixedTerms = {
  type: "fixed";
  unit_price: number; // 単価
  quantity: number; // 評価個数
};

export type SubscriptionTerms = {
  type: "subscription";
  period_amount: number; // 1期間あたり料金
  period_count: number; // 期間数
  period_unit?: "monthly" | "yearly"; // 表示用メタデータのみ
  initial_fee?: number; // イニシャル費用（MG/AG相殺対象）
};

export type PerformanceTerms = {
  type: "performance";
  base_price: number; // 基準価格（MSRP等）
  rate_pct: number; // 料率 %
  quantity: number; // 評価個数
};

/**
 * 売上報告型（RevenueTerms）：報告金額に料率を掛けるだけで数量・部数の概念を
 * 持たない。出版/ライセンスの「売上報告ベース」利用許諾料に使う。
 */
export type RevenueTerms = {
  type: "revenue";
  base_amount: number; // 報告金額（基準売上/被許諾者受領額）
  rate_pct: number; // 料率 %
};

export type FeeTerms =
  | FixedTerms
  | SubscriptionTerms
  | PerformanceTerms
  | RevenueTerms;

export type Adjustments = {
  /** 歩留率 0.0–1.0。既定 1.0（全量）。サブスクには通常適用しない。 */
  acceptance_ratio?: number;
  /** 不課金分の数量。fixed / performance のみ意味を持つ。 */
  sample_quantity?: number;

  /** MG（最低保証 = floor）総額。actual = max(after_acceptance, mg_amount)。 */
  mg_amount?: number;
  /** @deprecated MG が floor 化したため使用しない（shapeのみ維持）。 */
  mg_consumed_before?: number;

  /** AG（前払保証 = 累積消化）総額。 */
  ag_amount?: number;
  /** これまでに消化済のAG累計。DB集計で渡す。 */
  ag_consumed_before?: number;
};

export type FeeResult = {
  // 内訳（audit-friendly）
  gross_ex_tax: number;
  after_acceptance: number;

  /** MG が floor として適用された場合の上乗せ額 = max(0, mg_amount − after_acceptance)。 */
  mg_topup_this_time: number;
  mg_floor_applied: boolean; // mg_topup_this_time > 0 か否か

  /** @deprecated MG は floor 化したため常に 0。 */
  mg_consumed_this_time: number;
  /** @deprecated MG remaining の概念が無くなった。mg_amount をそのまま返す。 */
  mg_remaining_after: number;
  /** @deprecated 互換のため false 固定。 */
  mg_fully_consumed: boolean;

  ag_offset_this_time: number;
  ag_remaining_after: number;
  ag_fully_consumed: boolean;

  actual_ex_tax: number; // ユーザに請求する税抜額
  tax_rate: number;
  tax_amount: number;
  total_inc_tax: number;

  // 試算根拠（フォーム表示・ログ用）
  formula_breakdown: string;
};

// ─────────────────────────────────────────────────────────────────
//  Gross calculation by pricing model
// ─────────────────────────────────────────────────────────────────

function calcGross(terms: FeeTerms, adj: Adjustments): {
  gross: number;
  breakdown: string;
} {
  switch (terms.type) {
    case "fixed": {
      const samples = Number(adj.sample_quantity) || 0;
      const billable = Math.max(0, Number(terms.quantity) - samples);
      const unit = Number(terms.unit_price) || 0;
      const gross = Math.ceil(unit * billable);
      const breakdown = samples > 0
        ? `${unit} × (${terms.quantity} − ${samples}) = ${gross}`
        : `${unit} × ${billable} = ${gross}`;
      return { gross, breakdown };
    }
    case "subscription": {
      const periodAmount = Number(terms.period_amount) || 0;
      const periodCount = Number(terms.period_count) || 0;
      const initial = Number(terms.initial_fee) || 0;
      const recurring = periodAmount * periodCount;
      const gross = Math.ceil(recurring + initial);
      const breakdown = initial > 0
        ? `${periodAmount} × ${periodCount} (${terms.period_unit || "period"}) + initial ${initial} = ${gross}`
        : `${periodAmount} × ${periodCount} (${terms.period_unit || "period"}) = ${gross}`;
      return { gross, breakdown };
    }
    case "performance": {
      const samples = Number(adj.sample_quantity) || 0;
      const billable = Math.max(0, Number(terms.quantity) - samples);
      const base = Number(terms.base_price) || 0;
      const rate = Number(terms.rate_pct) || 0;
      const gross = Math.ceil(base * billable * (rate / 100));
      const breakdown = samples > 0
        ? `${base} × (${terms.quantity} − ${samples}) × ${rate}% = ${gross}`
        : `${base} × ${billable} × ${rate}% = ${gross}`;
      return { gross, breakdown };
    }
    case "revenue": {
      // 売上報告型 = 報告金額 × 料率（数量なし）。
      const base = Number(terms.base_amount) || 0;
      const rate = Number(terms.rate_pct) || 0;
      const gross = Math.ceil(base * (rate / 100));
      const breakdown = `${base} × ${rate}% = ${gross}`;
      return { gross, breakdown };
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  Main entry
// ─────────────────────────────────────────────────────────────────

/**
 * 1計算イベントのフルカスケードを算出する。
 *   gross → ×acceptance → −MG floor → −AG offset → +tax = total
 *
 * 純関数（DBなし）。呼び出し側が ag_consumed_before を自らの SUM() から渡す。
 */
export function calculateFee(
  terms: FeeTerms,
  adjustments: Adjustments = {},
  taxRate: number = 10
): FeeResult {
  // 1. Gross
  const { gross, breakdown } = calcGross(terms, adjustments);

  // 2. Acceptance ratio（null/NaN→1.0、範囲外は clamp）
  const rawRatio = adjustments.acceptance_ratio;
  const ratio =
    rawRatio == null || !Number.isFinite(Number(rawRatio))
      ? 1.0
      : Math.max(0, Math.min(1, Number(rawRatio)));
  const after_acceptance = Math.ceil(gross * ratio);

  // 3. MG floor：グロスが MG を下回ったら MG を採用（MG自体は消化されない）。
  const mgTotal = Number(adjustments.mg_amount) || 0;
  const after_mg = Math.max(after_acceptance, mgTotal);
  const mg_topup_this_time = Math.max(0, after_mg - after_acceptance);
  const mg_floor_applied = mg_topup_this_time > 0;
  // 旧shape互換（mg_consumed_* は使われない）
  const mg_consumed_this_time = 0;
  const mg_remaining_after = mgTotal;
  const mg_fully_consumed = false;

  // 4. AG offset（累積消化型・前払保証金から差し引き）
  const agTotal = Number(adjustments.ag_amount) || 0;
  const agConsumedBefore = Number(adjustments.ag_consumed_before) || 0;
  const agRemainBefore = Math.max(0, agTotal - agConsumedBefore);
  const ag_offset_this_time = Math.min(after_mg, agRemainBefore);
  const ag_remaining_after = agRemainBefore - ag_offset_this_time;
  const ag_fully_consumed =
    agTotal > 0 && agConsumedBefore + ag_offset_this_time >= agTotal;
  const actual_ex_tax = after_mg - ag_offset_this_time;

  // 5. Tax（ceil）
  const safeTaxRate = Number(taxRate) || 0;
  const tax_amount = Math.ceil(actual_ex_tax * (safeTaxRate / 100));
  const total_inc_tax = actual_ex_tax + tax_amount;

  return {
    gross_ex_tax: gross,
    after_acceptance,
    mg_topup_this_time,
    mg_floor_applied,
    mg_consumed_this_time,
    mg_remaining_after,
    mg_fully_consumed,
    ag_offset_this_time,
    ag_remaining_after,
    ag_fully_consumed,
    actual_ex_tax,
    tax_rate: safeTaxRate,
    tax_amount,
    total_inc_tax,
    formula_breakdown: breakdown,
  };
}

// ─────────────────────────────────────────────────────────────────
//  Convenience helpers
// ─────────────────────────────────────────────────────────────────

/**
 * 1明細の gross のみを算出（税・調整なし）。1行=1明細のテーブル用。
 */
export function grossOf(terms: FeeTerms): number {
  return calcGross(terms, {}).gross;
}
