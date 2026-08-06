// データ品質センター（Phase 4）の型と純関数。DB非依存・副作用なし。
// 各スキャンは読取リポジトリが実行し、ここで俯瞰サマリへ集計する。

export type Severity = "high" | "medium" | "low";

export interface QualitySample {
  id: number;
  label: string;
  detail: string;
  // クライアントの遷移導線（該当ビューへ）。任意。
  link?: { view: string; id?: number } | null;
}

export interface QualityCategory {
  key: string;
  label: string;
  description: string;
  severity: Severity;
  // available=false は権限不足・未整備（grant未適用）でスキャンできなかったことを示す。
  available: boolean;
  count: number;
  samples: QualitySample[];
}

export interface QualitySummary {
  totalIssues: number;
  highIssues: number;
  categoriesWithIssues: number;
  scannedCategories: number;
  unavailableCategories: number;
}

export interface QualityReport {
  categories: QualityCategory[];
  summary: QualitySummary;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// カテゴリ配列から俯瞰サマリを算出し、重大度→件数降順に並べ替えて返す。
export function summarizeQuality(categories: QualityCategory[]): QualityReport {
  const available = categories.filter((c) => c.available);
  const summary: QualitySummary = {
    totalIssues: available.reduce((sum, c) => sum + c.count, 0),
    highIssues: available.filter((c) => c.severity === "high").reduce((sum, c) => sum + c.count, 0),
    categoriesWithIssues: available.filter((c) => c.count > 0).length,
    scannedCategories: available.length,
    unavailableCategories: categories.length - available.length
  };
  const sorted = [...categories].sort((a, b) => {
    // 未スキャン(available=false)は末尾へ。
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    }
    return b.count - a.count;
  });
  return { categories: sorted, summary };
}
