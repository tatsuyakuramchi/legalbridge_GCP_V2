/**
 * 発注書 CSV（一括作成・検収済み一括）の「許諾」の列。
 *
 * 成果物の帰属先を受注者にする発注では、発注者はその成果物を利用許諾で使う。
 * 許諾の条件は台帳の利用許諾条件（kind=license・direction=in、作品 × 受注者）
 * に立て、発注書の「■ 利用許諾条件」はそこから差し込む（A-048）。CSV に許諾の
 * 列を書けば、業務の条件と一緒にその許諾条件も作る。空なら作らない（束の
 * 画面が「許諾条件がありません」と出す）。
 *
 * 列は帰属先＝受注者の行だけに書く。発注者帰属の行に書いてあれば不備にする
 * （許諾する権利が受注者に残らないので、条件として意味を持たない）。
 */
import type { Queryable } from "../core/db.js";
import type { ConditionScope, LicenseFeeBasis } from "../core/model.js";
import { csvAmount } from "../imports/parse.js";
import { FEE_BASIS } from "../imports/fee-basis.js";
import { conditionNameFor, parseUsageType, USAGE_NAME_LABEL } from "../conditions/naming.js";
import type { ConditionUsageType } from "../core/condition-usage.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionInput, ConditionWriteService } from "../conditions/write-service.js";
import { normalizeDate } from "./csv-date.js";

export const LICENSE_COLUMNS: Array<{ key: string; label: string; note: string }> = [
  { key: "license_usage", label: "許諾利用形態",
    note: "帰属先＝受注者の行だけ。自社製造・自社販売 / 再許諾 / 自社製造・他社販売 / 出版（紙） / 出版（電子）。"
        + "書けば同じ作品 × 受注者の利用許諾条件も一緒に作る（作品の列が要る）。空なら作らない" },
  { key: "license_rate", label: "許諾料率", note: "%（例: 8）。許諾料の扱いが 別途 のとき" },
  { key: "license_amount", label: "許諾額", note: "円。定額の許諾料。料率と両方は書かない" },
  { key: "license_fee_basis", label: "許諾料の扱い", note: "別途 / 業務委託報酬に含む / 無償。空なら 別途" },
  { key: "license_term_start", label: "許諾期間開始", note: "2026-10-01。空なら発注日から" },
  { key: "license_term_end", label: "許諾期間終了", note: "空なら期間の定めなし" },
  { key: "license_regions", label: "許諾地域", note: "日本／全世界 など（／区切り）。空なら全世界" },
  { key: "license_languages", label: "許諾言語", note: "日本語／英語 など（／区切り）。空なら全言語" }
];

/** CSV の 1 行が書いている許諾の条件。 */
export interface LicenseSpec {
  usageType: ConditionUsageType;
  ratePct: number | null;
  flatAmount: number | null;
  feeBasis: LicenseFeeBasis;
  termStart: string | null;
  termEnd: string | null;
  scopes: ConditionScope[];
}

const LICENSE_KEYS = LICENSE_COLUMNS.map((c) => c.key);

/**
 * 行の許諾の列を読む。何も書いていなければ null。読めないところは issues に残す。
 * ownership は行の帰属先（"受注者" / "発注者" / "" / null）。
 */
export function readLicenseSpec(
  get: (key: string) => string, ownership: string | null, issues: string[]
): LicenseSpec | null {
  const filled = LICENSE_KEYS.some((k) => get(k) !== "");
  if (!filled) return null;
  if (ownership !== "受注者") {
    issues.push("許諾の列は 成果物の帰属先 が 受注者 の行だけに書けます（発注者帰属なら空に）");
    return null;
  }
  const usageRaw = get("license_usage");
  const usageType = parseUsageType(usageRaw);
  if (!usageType) {
    issues.push(usageRaw
      ? `許諾利用形態が読めない（${usageRaw}）。${Object.values(USAGE_NAME_LABEL).join(" / ")} のどれか`
      : `許諾利用形態が空。${Object.values(USAGE_NAME_LABEL).join(" / ")} のどれかを入れる`);
    return null;
  }
  const basisRaw = get("license_fee_basis");
  const feeBasis: LicenseFeeBasis | undefined = basisRaw ? FEE_BASIS[basisRaw] : "separate";
  if (!feeBasis) {
    issues.push(`許諾料の扱いは 別途 / 業務委託報酬に含む / 無償（${basisRaw}）`);
    return null;
  }
  const rateRaw = get("license_rate").replace(/[%％]/g, "");
  const ratePct = rateRaw ? Number(rateRaw) : null;
  if (rateRaw && (!Number.isFinite(ratePct) || ratePct! < 0 || ratePct! > 100)) {
    issues.push(`許諾料率は 0〜100（%）（${get("license_rate")}）`);
    return null;
  }
  const amountRaw = get("license_amount");
  const flatAmount = amountRaw ? csvAmount(amountRaw) ?? null : null;
  if (amountRaw && flatAmount === null) { issues.push(`許諾額が読めない（${amountRaw}）`); return null; }
  if (ratePct !== null && flatAmount !== null) {
    issues.push("許諾料率と許諾額は片方だけ書く");
    return null;
  }
  const startRaw = get("license_term_start");
  const termStart = normalizeDate(startRaw);
  if (startRaw && !termStart) { issues.push(`許諾期間開始が日付として読めない（${startRaw}）`); return null; }
  const endRaw = get("license_term_end");
  const termEnd = normalizeDate(endRaw);
  if (endRaw && !termEnd) { issues.push(`許諾期間終了が日付として読めない（${endRaw}）`); return null; }
  if (termStart && termEnd && termEnd < termStart) { issues.push("許諾期間の終了が開始より前"); return null; }
  const scopes: ConditionScope[] = [
    ...parseRegions(get("license_regions")).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
    ...parseLanguages(get("license_languages")).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
  ];
  return {
    usageType,
    ratePct: feeBasis === "separate" ? ratePct : null,
    flatAmount: feeBasis === "separate" ? flatAmount : null,
    feeBasis, termStart, termEnd, scopes
  };
}

/**
 * 束の行の許諾を、条件の登録入力にする。同じ利用形態は 1 本にまとめる
 * （2 行の品目が同じ許諾を書いていても条件は 1 本）。中身が食い違えば
 * 先に書いた行が勝つ（束の中で揃えるのは CSV を書く人の役目）。
 */
export function licenseInputsFor(
  specs: Array<LicenseSpec | null>,
  target: { counterpartyId: number; workId: number; workTitle: string | null;
            agreementId: number | null; matterId: number | null; issuedOn?: string | null }
): ConditionInput[] {
  const seen = new Set<string>();
  const inputs: ConditionInput[] = [];
  for (const spec of specs) {
    if (!spec || seen.has(spec.usageType)) continue;
    seen.add(spec.usageType);
    const name = conditionNameFor({ workTitle: target.workTitle ?? "", usageType: spec.usageType })
      ?? `${target.workTitle ?? ""}｜${USAGE_NAME_LABEL[spec.usageType]}`;
    const pricingModel: ConditionInput["pricingModel"] =
      spec.ratePct !== null ? "revenue_rate" : spec.flatAmount !== null ? "fixed" : "none";
    inputs.push({
      matterId: target.matterId, name, direction: "in", kind: "license",
      counterpartyId: target.counterpartyId, workId: target.workId,
      agreementId: target.agreementId,
      usageType: spec.usageType, pricingModel,
      ratePpm: spec.ratePct !== null ? Math.round(spec.ratePct * 10000) : null,
      flatAmount: spec.flatAmount, currency: "JPY",
      licenseFeeBasis: spec.feeBasis,
      termStart: spec.termStart ?? target.issuedOn ?? null, termEnd: spec.termEnd,
      exclusivity: "non_exclusive",
      scopes: spec.scopes.length ? spec.scopes : undefined
    });
  }
  return inputs;
}

/**
 * 許諾条件を作る。同じ作品 × 受注者 × 利用形態の生きている条件が既にあれば
 * 作らず、それを返す（同じ CSV を 2 回入れても 2 本にならない）。
 */
export async function createLicenseConditions(
  database: Queryable, conditions: ConditionWriteService, inputs: ConditionInput[], actor: string
): Promise<Array<{ id: number; conditionNo: string | null; usageType: ConditionUsageType | null; existed: boolean }>> {
  const made: Array<{ id: number; conditionNo: string | null; usageType: ConditionUsageType | null; existed: boolean }> = [];
  for (const input of inputs) {
    const r = await database.query(
      `SELECT id, condition_no FROM conditions
        WHERE kind = 'license' AND direction = 'in'
          AND work_id = $1 AND counterparty_id = $2 AND usage_type = $3
          AND status IN ('active', 'scheduled')
        ORDER BY id DESC LIMIT 1`,
      [input.workId, input.counterpartyId, input.usageType]);
    const hit = r.rows[0] as { id: number; condition_no: string | null } | undefined;
    if (hit) {
      made.push({ id: Number(hit.id), conditionNo: hit.condition_no ?? null, usageType: input.usageType ?? null, existed: true });
      continue;
    }
    const created = await conditions.create(input, actor);
    made.push({ id: created.id, conditionNo: created.conditionNo, usageType: input.usageType ?? null, existed: false });
  }
  return made;
}
