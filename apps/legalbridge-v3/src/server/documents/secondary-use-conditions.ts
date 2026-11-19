/**
 * 二次利用追加条件書の「許諾する二次利用」の行を、条件明細にする。
 *
 * この紙は基本契約から作り、条件明細は先に要らない（商品化・映像化の条件は、紙を作る段で初めて決まる）。
 * ただ、紙に書いただけで台帳に無いと、製造の報告や再許諾先からの入金を計算書・支払に回せない。
 * 決定のとき、条件の付いていない行から取得（IN）の利用許諾の条件を作り、文書に繋ぎ、行に condition_id を
 * 書き戻す。書き戻すので、作り直しや訂正版でもう一度決定しても二重には作らない
 * （発注書の手数料・経費の行と同じ作り。settlement-conditions.ts）。
 *
 *   自社で行う利用   → 自社製造・自社販売（in_house）。単価 × 数量 × 料率
 *   再許諾する利用   → 再許諾（sublicense）。再許諾先から受領した額 × 料率
 *   定額（一括）     → 同じ利用形態で、計算方式は定額
 *
 * 相手先と契約は、文書に付いた基本契約から。作った条件は、まず基本契約に載せる。そのあと決定の処理が
 * この紙の個別契約（基本契約の下。番号は紙の番号）を立てて、そこへ寄せる（agreements/auto.ts）。
 */

import type { Queryable } from "../core/db.js";
import { int, str } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionWriteService } from "../conditions/write-service.js";
import { SUT_USES_FIELD, isSecondaryUseTemplate, secondaryUses, type SecondaryUse, type SecondaryWork } from "./secondary-use.js";

export interface SecondaryUseSource {
  documentId: number;
  templateKey: string;
  matterId: number | null;
  /** 文書に付いた契約（基本契約）。相手先・向き・通貨の出どころ。 */
  agreementId: number | null;
  manual: Record<string, unknown>;
}

export interface SecondaryUseResult {
  /** condition_id を書き戻した手入力。作っていなければ元のまま。 */
  manual: Record<string, unknown>;
  created: Array<{ id: number; conditionNo: string | null; code: string; name: string }>;
}

/** 条件名。作品名｜利用区分（再許諾／再許諾先）。 */
export function secondaryUseConditionName(use: SecondaryUse): string {
  const tail = use.actor === "sublicense" ? `（${["再許諾", use.sublicensee].filter(Boolean).join("／")}）` : "";
  return `${use.workTitle}｜${use.category}${tail}`;
}

/** 条件明細にできない行の理由。できるなら null。 */
export function secondaryUseBlocker(use: SecondaryUse): string | null {
  const lacks: string[] = [];
  if (!use.workId) lacks.push("対象著作物");
  if (use.feeType === "flat") {
    if (use.flatAmount == null || use.flatAmount < 0) lacks.push("金額");
  } else if (use.ratePct == null || use.ratePct < 0 || use.ratePct > 100) {
    lacks.push("料率（0〜100%）");
  }
  if (use.termStart && use.termEnd && use.termEnd < use.termStart) lacks.push("許諾期間（終了が開始より前）");
  return lacks.length ? `${use.code}（${use.category}）：${lacks.join("・")}を入れてください` : null;
}

/**
 * 行から条件を作る。トランザクションは呼ぶ側が持つ。作った条件は document_conditions の末尾に足す。
 */
export async function materializeSecondaryUseRows(
  client: Queryable, writes: ConditionWriteService, source: SecondaryUseSource, actor: string
): Promise<SecondaryUseResult> {
  const created: SecondaryUseResult["created"] = [];
  if (!isSecondaryUseTemplate(source.templateKey)) return { manual: source.manual, created };
  const uses = secondaryUses(source.manual);
  if (!uses.length) {
    throw new DomainError("VALIDATION", "「許諾する二次利用」に行がありません。利用（商品化・映像化など）を 1 行以上入れてから決定してください");
  }
  const pending = uses.filter((u) => !u.conditionId);
  if (!pending.length) return { manual: source.manual, created };

  const blockers = pending.map(secondaryUseBlocker).filter((b): b is string => b !== null);
  if (blockers.length) throw new DomainError("VALIDATION", `条件明細を作れない行があります。${blockers.join("／")}`);

  // 相手先・向きは文書に付いた基本契約から（無ければ、画面が入れた相手先）。
  const agreement = source.agreementId
    ? (await client.query(
        "SELECT id, counterparty_id, direction, COALESCE(kind, 'master') AS kind FROM agreements WHERE id = $1",
        [source.agreementId])).rows[0] as Record<string, any> | undefined
    : undefined;
  const partyId = int(agreement?.counterparty_id) ?? int(source.manual._partyId);
  if (!partyId) {
    throw new DomainError("VALIDATION", "相手先が決まりません。契約の画面で基本契約を開き、「二次利用追加条件書を作る」から作ってください");
  }
  if (agreement && str(agreement.direction) === "out") {
    throw new DomainError("VALIDATION", "この基本契約は許諾（OUT）の契約です。二次利用追加条件書は、権利を取得する側（IN）の基本契約から作ります");
  }

  const last = await client.query(
    "SELECT COALESCE(max(line_no), 0) AS n FROM document_conditions WHERE document_id = $1", [source.documentId]);
  let lineNo = Number((last.rows[0] as { n: number } | undefined)?.n ?? 0);

  for (const use of pending) {
    const name = secondaryUseConditionName(use);
    const scopes = [
      ...parseRegions(use.regions).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
      ...parseLanguages(use.languages).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
    ];
    const made = await writes.createWithin(client, {
      matterId: source.matterId,
      name,
      direction: "in",
      kind: "license",
      counterpartyId: partyId,
      agreementId: int(agreement?.id),
      workId: use.workId,
      usageType: use.actor === "sublicense" ? "sublicense" : "in_house",
      pricingModel: use.feeType === "flat" ? "fixed" : "revenue_rate",
      // 画面は % で受け、保存は ppm（百万分率）。5% → 50000
      ratePpm: use.feeType === "flat" ? null : Math.round((use.ratePct ?? 0) * 10000),
      flatAmount: use.feeType === "flat" ? Math.round(use.flatAmount ?? 0) : null,
      currency: "JPY",
      taxCategory: "taxable",
      exclusivity: use.exclusivity,
      termStart: use.termStart || null, termEnd: use.termEnd || null,
      sublicensee: use.actor === "sublicense" ? use.sublicensee || null : null,
      scopes: scopes.length ? scopes : undefined,
      notes: [`二次利用（${use.category}）`, use.content, use.feeNote].filter(Boolean).join("／")
    }, actor);
    lineNo += 1;
    await client.query(
      `INSERT INTO document_conditions (document_id, condition_id, line_no)
       VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
      [source.documentId, made.id, lineNo]);
    use.row.condition_id = made.id;
    created.push({ id: made.id, conditionNo: made.conditionNo, code: use.code, name });
  }
  return { manual: { ...source.manual, [SUT_USES_FIELD]: source.manual[SUT_USES_FIELD] }, created };
}

/**
 * 行の作品を台帳から引いて、文脈に足す（context.secondaryWorks。作品 id → 作品と原作）。
 *
 * 二次利用の作品（シリーズのグッズ・アニメ化など）は、配下の書籍を原作として系譜に持つ。紙の「01 対象著作物」には
 * 原作を並べ、条件明細はその作品に 1 本付ける。原作の一覧は行に写さず、ここで毎回台帳から引く
 * （作品を選んだあとに原作を足したら、そのまま紙に出る）。決定した紙は値を焼き付けるので、後から変わらない。
 *
 * 出版の個別条件書の番号は、この相手先との出版（紙・電子）の条件が載っている個別契約から引く。
 */
export async function withSecondaryUseWorks(
  client: Queryable, templateKey: string, context: Record<string, any>, manual: Record<string, unknown>
): Promise<Record<string, any>> {
  if (!isSecondaryUseTemplate(templateKey)) return context;
  const ids = [...new Set(secondaryUses(manual).map((u) => u.workId).filter((n): n is number => n !== null))];
  if (!ids.length) return context;
  const partyId = int(context.condition?.counterpartyId) ?? int(context.condition?.counterparty?.id)
    ?? int((context.conditions as Array<Record<string, any>> | undefined)?.[0]?.counterpartyId) ?? int(manual._partyId);
  const works = (await client.query(
    `SELECT w.id, w.title, w.kind, to_jsonb(w) ->> 'source_title' AS source_title, w.copyright_notice
       FROM works w WHERE w.id = ANY($1::bigint[])`, [ids])).rows as Array<Record<string, any>>;
  const sources = (await client.query(
    `SELECT DISTINCT l.child_work_id AS child_id, p.id, p.title, p.copyright_notice
       FROM work_lineage l JOIN works p ON p.id = l.parent_work_id
      WHERE l.child_work_id = ANY($1::bigint[]) AND p.status <> 'archived'
      ORDER BY p.title`, [ids])).rows as Array<Record<string, any>>;
  const allIds = [...ids, ...sources.map((r) => Number(r.id))];
  // 作品ごとの出版の個別条件書の番号（この相手先の、紙・電子の条件が載っている個別契約）。
  const terms = partyId ? (await client.query(
    `SELECT DISTINCT ON (c.work_id) c.work_id, a.agreement_no
       FROM conditions c JOIN agreements a ON a.id = c.agreement_id
      WHERE c.work_id = ANY($1::bigint[]) AND c.counterparty_id = $2 AND c.direction = 'in'
        AND c.usage_type IN ('pub_print', 'pub_digital') AND c.status IN ('active', 'scheduled')
        AND COALESCE(a.kind, 'master') = 'supplement' AND a.agreement_no IS NOT NULL
      ORDER BY c.work_id, a.id DESC`, [allIds, partyId])).rows as Array<Record<string, any>> : [];
  const termsOf = new Map(terms.map((r) => [Number(r.work_id), String(r.agreement_no)]));
  const out: Record<number, SecondaryWork> = {};
  for (const w of works) {
    const id = Number(w.id);
    out[id] = {
      id, title: String(w.title ?? ""), kind: String(w.kind ?? ""),
      sourceTitle: str(w.source_title), copyright: str(w.copyright_notice), termsNo: termsOf.get(id) ?? null,
      sources: sources.filter((r) => Number(r.child_id) === id).map((r) => ({
        id: Number(r.id), title: String(r.title ?? ""), copyright: str(r.copyright_notice), termsNo: termsOf.get(Number(r.id)) ?? null
      }))
    };
  }
  return { ...context, secondaryWorks: out };
}
