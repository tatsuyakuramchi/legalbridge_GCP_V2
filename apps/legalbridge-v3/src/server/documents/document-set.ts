import { int, type Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";

/**
 * 文書をまとめて作る（基本契約書＋条件書・追加の条件書／基本契約書＋発注書・追加の発注書）。
 *
 * 1 つのフォームで入れ、決定は順番に行う。
 *   1. 基本契約の記録を決める（既存を使う／作る／作らない）
 *   2. 条件を基本契約に載せる（まだどの契約にも載っていない条件だけ）
 *   3. すべての文書を事前に確かめる（必須の欄が空なら、何も決定しない）
 *   4. 基本契約書 → 条件書・発注書 の順に下書きを作って決定する
 *
 * 順番が要るのは、条件書は決定した瞬間に合意を自動で起こすから（agreements/auto.ts）。
 * 条件が基本契約に載っていれば「基本契約の補助文書（-S01）」、載っていなければ単体契約になる。
 * 基本契約書を決定しても基本契約の記録は自動では立たないので、ここで先に立てる。
 *
 * 確かめで止まったときは、この呼び出しで作った基本契約の記録と条件の載せ替えを戻す。
 * 決定の途中で止まったときは、決定できたところまでを返す（番号の付いた文書は消さない）。
 */

export type SetDomain = "license" | "service";

export interface SetDocInput {
  templateKey: string;
  conditionIds: number[];
  manualInputs: Record<string, unknown>;
  /** main＝本体（条件書・発注書）／extra＝追加（著作物を分ける・別の作品）。表示と順番のため。 */
  role: "main" | "extra";
}

export interface DocumentSetInput {
  domain: SetDomain;
  counterpartyId: number;
  matterId: number | null;
  /** 基本契約。null なら作らない（条件書・発注書を単体で出す）。 */
  master: null | {
    /** 既にある基本契約を使う（基本契約書は作らない）。 */
    existingAgreementId?: number | null;
    /** 基本契約書を作るときのひな形と入力。 */
    templateKey?: string | null;
    title?: string | null;
    manualInputs?: Record<string, unknown>;
  };
  docs: SetDocInput[];
}

export interface SetResultDoc { role: "master" | "main" | "extra"; templateKey: string; id: number; documentNo: string | null }
export interface DocumentSetResult {
  agreement: { id: number; agreementNo: string | null; created: boolean } | null;
  documents: SetResultDoc[];
  /** 途中で止まったとき。決定できたところまでは documents にある。 */
  error?: string;
}

export interface DocumentSetDeps {
  db: Queryable;
  preview: (input: { templateKey: string; conditionIds: number[]; matterId: number | null;
                     agreementId: number | null; manualInputs: Record<string, unknown> })
    => Promise<{ missing: Array<{ name: string; label?: string | null }>; templateLabel?: string | null }>;
  createDraft: (input: { templateKey: string; conditionIds: number[]; matterId: number | null;
                         agreementId: number | null; manualInputs: Record<string, unknown> }) => Promise<{ id: number }>;
  issue: (id: number) => Promise<{ documentNo?: string | null } & Record<string, unknown>>;
  createAgreement: (input: { counterpartyId: number; direction: "in" | "out"; kind: "master"; domain: SetDomain; title: string })
    => Promise<{ id: number; agreementNo: string | null }>;
}

/** 条件書（決定で合意を起こす）か。これには文書の合意を付けない（付けると自動の合意が立たない）。 */
const TERMS_KEYS = new Set(["individual_license_terms_v3", "individual_license_terms_v4",
  "pub_license_terms_v3", "pub_license_terms_v3_annex"]);

export async function issueDocumentSet(deps: DocumentSetDeps, input: DocumentSetInput, actor: string): Promise<DocumentSetResult> {
  const docs = input.docs.filter((d) => d.templateKey);
  const makeMaster = Boolean(input.master && !input.master.existingAgreementId && input.master.templateKey);
  if (!docs.length && !makeMaster) throw new DomainError("VALIDATION", "作る文書を 1 つ以上選んでください");
  for (const d of docs) {
    if (!d.conditionIds.length) throw new DomainError("VALIDATION", "条件書・発注書には条件明細を 1 つ以上選んでください");
  }
  const allConditionIds = [...new Set(docs.flatMap((d) => d.conditionIds))];
  const conds = allConditionIds.length ? (await deps.db.query(
    `SELECT id, condition_no, direction, counterparty_id, agreement_id FROM conditions WHERE id = ANY($1::bigint[])`,
    [allConditionIds])).rows as any[] : [];
  if (conds.length !== allConditionIds.length) throw new DomainError("NOT_FOUND", "選んだ条件明細の一部が見つかりません");
  const others = conds.filter((c) => int(c.counterparty_id) !== input.counterpartyId);
  if (others.length) {
    throw new DomainError("VALIDATION", `相手先の違う条件明細が入っています（${others.map((c) => c.condition_no ?? `#${c.id}`).join("、")}）`);
  }
  const directions = [...new Set(conds.map((c) => String(c.direction)))];
  if (directions.length > 1) throw new DomainError("VALIDATION", "IN と OUT の条件明細は 1 つの束にできません");
  const direction = (directions[0] ?? "in") as "in" | "out";

  // 1. 基本契約の記録
  let agreement: DocumentSetResult["agreement"] = null;
  if (input.master?.existingAgreementId) {
    const a = (await deps.db.query(
      `SELECT id, agreement_no, counterparty_id, kind, direction FROM agreements WHERE id = $1`,
      [input.master.existingAgreementId])).rows[0] as any;
    if (!a) throw new DomainError("NOT_FOUND", `契約 ${input.master.existingAgreementId} が見つかりません`);
    if (int(a.counterparty_id) !== input.counterpartyId) throw new DomainError("VALIDATION", "選んだ基本契約の相手先が違います");
    agreement = { id: Number(a.id), agreementNo: a.agreement_no ?? null, created: false };
  } else if (makeMaster) {
    const title = String(input.master!.title ?? "").trim()
      || (input.domain === "license" ? "利用許諾基本契約" : "業務委託基本契約");
    const made = await deps.createAgreement({ counterpartyId: input.counterpartyId, direction, kind: "master", domain: input.domain, title });
    agreement = { id: made.id, agreementNo: made.agreementNo, created: true };
  }

  // 2. 条件を基本契約に載せる（まだ載っていないものだけ）
  let linked: number[] = [];
  if (agreement && allConditionIds.length) {
    const r = await deps.db.query(
      `UPDATE conditions SET agreement_id = $2, updated_at = now()
        WHERE id = ANY($1::bigint[]) AND agreement_id IS NULL RETURNING id`,
      [allConditionIds, agreement.id]);
    linked = (r.rows as any[]).map((x) => Number(x.id));
  }

  const agreementFor = (templateKey: string) => TERMS_KEYS.has(templateKey) ? null : agreement?.id ?? null;
  const plan: Array<{ role: SetResultDoc["role"]; templateKey: string; conditionIds: number[]; manualInputs: Record<string, unknown>; agreementId: number | null }> = [
    ...(makeMaster ? [{ role: "master" as const, templateKey: input.master!.templateKey!, conditionIds: [],
                        manualInputs: input.master!.manualInputs ?? {}, agreementId: agreement?.id ?? null }] : []),
    ...docs.map((d) => ({ role: d.role, templateKey: d.templateKey, conditionIds: d.conditionIds,
                          manualInputs: d.manualInputs ?? {}, agreementId: agreementFor(d.templateKey) }))
  ];

  // 3. すべてを先に確かめる。止まったら、ここで作ったものを戻す。
  const problems: string[] = [];
  for (const [i, p] of plan.entries()) {
    const r = await deps.preview({ templateKey: p.templateKey, conditionIds: p.conditionIds, matterId: input.matterId,
                                   agreementId: p.agreementId, manualInputs: p.manualInputs });
    if (r.missing.length) {
      problems.push(`${i + 1}. ${r.templateLabel ?? p.templateKey}：${r.missing.map((m) => m.label ?? m.name).join("・")}`);
    }
  }
  if (problems.length) {
    if (linked.length) {
      await deps.db.query("UPDATE conditions SET agreement_id = NULL WHERE id = ANY($1::bigint[]) AND agreement_id = $2",
        [linked, agreement!.id]);
    }
    if (agreement?.created) await deps.db.query("DELETE FROM agreements WHERE id = $1", [agreement.id]);
    throw new DomainError("VALIDATION", `必須の欄が空です。何も決定していません。\n${problems.join("\n")}`);
  }

  // 4. 順に作って決定する
  const out: SetResultDoc[] = [];
  for (const p of plan) {
    try {
      const draft = await deps.createDraft({ templateKey: p.templateKey, conditionIds: p.conditionIds, matterId: input.matterId,
                                            agreementId: p.agreementId, manualInputs: p.manualInputs });
      const issued = await deps.issue(draft.id);
      out.push({ role: p.role, templateKey: p.templateKey, id: draft.id, documentNo: (issued.documentNo as string | null) ?? null });
    } catch (e) {
      return { agreement, documents: out,
               error: `${out.length + 1} 枚目（${p.templateKey}）で止まりました：${(e as Error).message}。決定できた ${out.length} 枚はそのまま残っています` };
    }
  }
  void actor;
  return { agreement, documents: out };
}
