import type { ConditionDetail, EnvelopeCheck, RightsEnvelope, ScopeType } from "../core/model.js";
import { scopeAllows, type ScopeOption } from "../core/rights-scope.js";

/**
 * 許諾範囲の照合。個々のIN条件ではなく、作品の権利包絡（構成パート全部の積）と比べる。
 * 個別のIN条件と比べると「本文の範囲内だから通す」という誤判定が起きるため。
 *
 * 範囲は「その次元に上限の指定が無ければ無制限」と解釈する（取得条件が
 * 地域を1件も挙げていなければ全世界、という現場の書き方に合わせている）。
 */
export function checkAgainstEnvelope(
  condition: Pick<ConditionDetail, "scopes" | "termEnd" | "exclusivity" | "sublicensable">,
  envelope: RightsEnvelope
): EnvelopeCheck {
  const violations: EnvelopeCheck["violations"] = [];
  if (envelope.acquiredCount === 0) {
    return { verdict: "unknown", violations: [] };
  }

  for (const dimension of ["region", "language", "media", "channel"] as ScopeType[]) {
    const allowed = envelope.scopes.find((s) => s.scopeType === dimension)?.values ?? [];
    if (!allowed.length) continue;                     // 上限の指定なし＝無制限
    const requested = condition.scopes.filter((s) => s.scopeType === dimension);
    // 地域・言語は ISO のコードで比べる（V2 と同じ）。媒体・チャネルはコードを
    // 持たないので名前で比べることになるが、判定は1本の関数に任せる。
    const universal = dimension === "language" ? "ALL" : "WORLD";
    const { ok, outside } = scopeAllows(
      allowed.map(asOption), requested.map(asOption), universal);
    if (!ok) {
      violations.push({
        dimension: labelOf(dimension),
        expected: allowed.map((a) => a.label).join("・"),
        actual: outside.map((o) => o.name).join("・"),
        limitedBy: null
      });
    }
  }

  if (envelope.termLimit && condition.termEnd && condition.termEnd > envelope.termLimit) {
    violations.push({
      dimension: "期間",
      expected: `${envelope.termLimit} まで`,
      actual: `${condition.termEnd} まで`,
      limitedBy: envelope.termLimitedBy
    });
  }

  if (envelope.exclusivityLimit === "non_exclusive" && condition.exclusivity === "exclusive") {
    violations.push({
      dimension: "独占",
      expected: "非独占のみ",
      actual: "独占",
      limitedBy: envelope.exclusivityLimitedBy
    });
  }

  if (!envelope.sublicensable && condition.sublicensable === true) {
    violations.push({
      dimension: "再許諾",
      expected: "不可",
      actual: "可",
      limitedBy: envelope.sublicenseLimitedBy
    });
  }

  return { verdict: violations.length ? "outside" : "inside", violations };
}

const labelOf = (dimension: ScopeType) =>
  dimension === "region" ? "地域"
  : dimension === "language" ? "言語"
  : dimension === "media" ? "媒体"
  : "チャネル";

const asOption = (scope: { code?: string | null; label: string }): ScopeOption =>
  ({ code: scope.code ?? "", name: scope.label });
