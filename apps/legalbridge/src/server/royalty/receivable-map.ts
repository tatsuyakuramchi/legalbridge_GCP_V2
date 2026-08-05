// 債権（分配構造）マップの段跨ぎカスケード計算（純関数・DB非依存）— Phase 1 S7。
//
// V1 `receivableMapService.getWorkLineage` のカスケードを移植。作品の派生系譜
// （root→selected）を段(tier)として、下位（より派生）で受領した金額が上位各段の
// 上流分配へも流れる構造を算定する：
//   - tier i の分配基礎 cascade_base = i 段〜最下段（selected）の受領合計。
//   - 各段の上流分配 = 料率 × cascade_base。
//   - 同一の上流契約（capability）は複数段で二重計上しない（seenCap）。
// 丸め：分配は Math.round（整数・円）。

export interface LineageUpstreamInput {
  capabilityId: number | null;  // 上流契約の識別（二重計上判定用）
  ratePct: number | null;       // 親ライセンスイン料率（null=算定不能）
  licensorName?: string | null;
}

export interface LineageTierInput {
  workId: number;
  workTitle?: string | null;
  workCode?: string | null;
  received: number;             // この段（作品）での受領合計
  upstream: LineageUpstreamInput[];
}

export interface LineageUpstreamResult extends LineageUpstreamInput {
  inherited: boolean;               // 上位段で計上済み（この段では0）
  distributeAmount: number | null;  // 料率不明なら null
}

export interface LineageTier {
  workId: number;
  workTitle: string | null;
  workCode: string | null;
  received: number;
  cascadeBase: number;
  distributed: number;
  retained: number;
  upstream: LineageUpstreamResult[];
}

export interface LineageCascade {
  chain: LineageTier[];
  totals: { received: number; distributed: number; retained: number };
}

// chain は root→selected の順。V1同様に上位段から seenCap を積む。
export function buildLineageCascade(chain: LineageTierInput[]): LineageCascade {
  const seenCap = new Set<number>();
  const result: LineageTier[] = chain.map((tier, i) => {
    let cascadeBase = 0;
    for (let j = i; j < chain.length; j++) cascadeBase += Number(chain[j].received) || 0;

    const upstream: LineageUpstreamResult[] = tier.upstream.map((u) => {
      const cap = u.capabilityId;
      const inherited = cap != null && seenCap.has(cap);
      if (cap != null) seenCap.add(cap);
      const distributeAmount = inherited
        ? 0
        : (u.ratePct == null ? null : Math.round(cascadeBase * (Number(u.ratePct) / 100)));
      return { ...u, inherited, distributeAmount };
    });

    const distributed = upstream.reduce((s, u) => s + (u.distributeAmount || 0), 0);
    const received = Number(tier.received) || 0;
    return {
      workId: tier.workId,
      workTitle: tier.workTitle ?? null,
      workCode: tier.workCode ?? null,
      received,
      cascadeBase,
      distributed,
      retained: received - distributed,
      upstream
    };
  });

  const received = result.reduce((s, n) => s + n.received, 0);
  const distributed = result.reduce((s, n) => s + n.distributed, 0);
  return { chain: result, totals: { received, distributed, retained: received - distributed } };
}
