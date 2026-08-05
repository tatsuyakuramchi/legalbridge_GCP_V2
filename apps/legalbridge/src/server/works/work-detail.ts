// 作品詳細（Phase 2）の純関数。DB非依存・副作用なし。
// 読取リポジトリが集めた素の行を、UIが一望できる構造へ整形する。
//  - groupWorkConditions: 条件明細を 受領/支払・サブライセンス・素材紐付有無で分類。
//  - buildLineageView: 系譜（原作→派生N）をラベル付けし、parent_work_id 系譜と
//    work_relations の差分（未反映の親）を突き合わせる。

export interface WorkConditionLine {
  id: number;
  conditionName: string | null;
  direction: "receivable" | "payable" | null;
  flowDirection: "in" | "out" | null;
  sourceMaterialId: number | null;
  materialName: string | null;
  sublicenseAllowed: boolean | null;
  parentLicenseConditionId: number | null;
  ratePct: number | null;
  amountExTax: number | null;
  mgAmount: number | null;
  currency: string | null;
  documentNumber: string | null;
}

export interface GroupedWorkConditions {
  receivable: WorkConditionLine[];
  payable: WorkConditionLine[];
  // sublicense_allowed が真、または上流ライセンスインを持つ（親料率で分配される）明細。
  sublicense: WorkConditionLine[];
  // 素材（work_materials）に紐付かない作品レベル条件。
  workLevel: WorkConditionLine[];
  materialLinked: WorkConditionLine[];
  totals: {
    count: number;
    receivableCount: number;
    payableCount: number;
    sublicenseCount: number;
    workLevelCount: number;
  };
}

export function groupWorkConditions(lines: WorkConditionLine[]): GroupedWorkConditions {
  const receivable: WorkConditionLine[] = [];
  const payable: WorkConditionLine[] = [];
  const sublicense: WorkConditionLine[] = [];
  const workLevel: WorkConditionLine[] = [];
  const materialLinked: WorkConditionLine[] = [];

  for (const line of lines) {
    if (line.direction === "receivable") receivable.push(line);
    else if (line.direction === "payable") payable.push(line);

    if (line.sublicenseAllowed === true || line.parentLicenseConditionId != null) {
      sublicense.push(line);
    }
    if (line.sourceMaterialId == null) workLevel.push(line);
    else materialLinked.push(line);
  }

  return {
    receivable,
    payable,
    sublicense,
    workLevel,
    materialLinked,
    totals: {
      count: lines.length,
      receivableCount: receivable.length,
      payableCount: payable.length,
      sublicenseCount: sublicense.length,
      workLevelCount: workLevel.length
    }
  };
}

export interface LineageNode {
  workId: number;
  title: string | null;
  workCode: string | null;
}

export interface LineageTier extends LineageNode {
  // 原作＝"原作"、以降 selected へ向かって 派生1/派生2… 。
  label: string;
  isSelected: boolean;
}

export interface LineageView {
  // 原作(root) → selected の順。ラベル付き。
  chain: LineageTier[];
  // selected の直接の派生作品。
  children: LineageNode[];
  // work_relations 上は親だが parent_work_id 系譜に現れない親（未反映＝要確認）。
  unlinkedRelationParents: LineageNode[];
  depth: number; // selected の派生段数（原作=0）。
  isDerivative: boolean;
}

// ancestorsRootFirst: 原作→…→selected（selected を末尾に含む）。
// receivable-map と同じく works.parent_work_id を真の系譜とする。
export function buildLineageView(
  selectedId: number,
  ancestorsRootFirst: LineageNode[],
  children: LineageNode[],
  relationParents: LineageNode[]
): LineageView {
  const chain: LineageTier[] = ancestorsRootFirst.map((node, index) => ({
    ...node,
    label: index === 0 ? "原作" : `派生${index}`,
    isSelected: node.workId === selectedId
  }));

  const chainIds = new Set(ancestorsRootFirst.map((n) => n.workId));
  // parent_work_id 系譜に含まれない work_relations の親のみ「未反映」として拾う。
  const unlinkedRelationParents = relationParents.filter((p) => !chainIds.has(p.workId));

  const depth = Math.max(0, ancestorsRootFirst.length - 1);
  return {
    chain,
    children,
    unlinkedRelationParents,
    depth,
    isDerivative: depth > 0
  };
}
