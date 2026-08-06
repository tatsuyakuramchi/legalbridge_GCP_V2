// 契約チェック（Phase 6・純関数・クライアント完結）。作品にぶら下がる条件明細を
// 認証時の整合ルールで点検し、指摘を返す。DB非依存（WorkDetail が読取済の条件を渡す）。
// データ品質センター（4-1）の横断スキャンとは別で、こちらは条件単位の作成時チェック。

export interface CheckCondition {
  id: number;
  conditionName: string | null;
  direction: string | null;
  sourceMaterialId: number | null;
  sublicenseAllowed: boolean | null;
  parentLicenseConditionId: number | null;
  ratePct: number | null;
  mgAmount: number | null;
}

export type CheckSeverity = "high" | "medium" | "low";
export interface CheckFinding {
  conditionId: number;
  conditionName: string;
  severity: CheckSeverity;
  code: string;
  message: string;
}

const label = (c: CheckCondition) => c.conditionName?.trim() || `条件#${c.id}`;

// 個々の条件に対する点検ルール。該当したものだけ指摘として返す。
export function checkWorkConditions(conditions: CheckCondition[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const add = (c: CheckCondition, severity: CheckSeverity, code: string, message: string) =>
    findings.push({ conditionId: c.id, conditionName: label(c), severity, code, message });

  for (const c of conditions) {
    if (c.sublicenseAllowed === true && c.parentLicenseConditionId == null) {
      add(c, "high", "SUBLICENSE_WITHOUT_PARENT", "サブライセンス許諾だが上流ライセンス条件が未リンクです");
    }
    if ((c.mgAmount ?? 0) > 0 && c.ratePct == null) {
      add(c, "medium", "MG_WITHOUT_RATE", "MGはあるが料率(rate)が未設定です");
    }
    if (c.ratePct != null && !c.direction) {
      add(c, "medium", "RATE_WITHOUT_DIRECTION", "料率はあるが方向(受取/支払)が未設定です");
    }
    if (c.direction === "receivable" && c.sourceMaterialId == null) {
      add(c, "low", "RECEIVABLE_WITHOUT_MATERIAL", "受取条件が素材に未紐付けです（作品レベル）");
    }
    if (!c.conditionName || !c.conditionName.trim()) {
      add(c, "low", "MISSING_NAME", "条件名が未入力です");
    }
  }
  return findings;
}

export function summarizeFindings(findings: CheckFinding[]): { high: number; medium: number; low: number; total: number } {
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length
  };
}
