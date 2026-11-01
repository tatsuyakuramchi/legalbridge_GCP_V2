import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ppmToPct } from "../royalty/economics.js";

/**
 * 作品の刊行物（版元・ISBN・刊行日・本体価格。docs/work-editions.md、infra/v3/193）。
 *
 * 1 つの作品が版元を変えて何度も出る（アークライト版 → 新紀元社版）ので、版元は作品ではなく刊行物に持つ。
 * 版元との関係は 3 つ：
 *   own        … 自社刊行。版元は空（当社）でもよい。OUT 条件は持たない。
 *   group      … グループ会社。料率の取り決めが無いので、版元を記録するだけ（OUT 条件は持たない）。
 *   sublicense … 再許諾。根拠の OUT 条件（作品 × 版元で 1 本）を指す。重版・新装版で ISBN が増えても条件は増えない。
 * 作者への払いは作者の IN 条件（紙・電子）で決まる。刊行物はその「どの本の分か」を ISBN で当てるための台帳。
 */

export type EditionRelation = "own" | "group" | "sublicense";
export const EDITION_RELATIONS: EditionRelation[] = ["own", "group", "sublicense"];
export const RELATION_LABEL: Record<EditionRelation, string> = {
  own: "自社刊行", group: "グループ会社（料率なし）", sublicense: "再許諾"
};
/** CSV・画面の言い方から関係へ。 */
export const RELATION_OF: Record<string, EditionRelation> = {
  自社: "own", 自社刊行: "own", 当社: "own", own: "own",
  グループ: "group", グループ会社: "group", "グループ会社（料率なし）": "group", 子会社: "group", 料率なし: "group", group: "group",
  再許諾: "sublicense", ライセンス: "sublicense", ライセンスアウト: "sublicense", sublicense: "sublicense"
};

export interface Edition {
  id: number; workId: number;
  publisherPartyId: number | null; publisherName: string | null;
  relation: EditionRelation; relationLabel: string;
  isbn: string | null; editionTitle: string | null; publishedOn: string | null; listPrice: number | null;
  outConditionId: number | null; outConditionNo: string | null; outRatePct: number | null;
  notes: string | null;
  /** 確かめてほしいこと（再許諾なのに条件が無い など）。 */
  warnings: string[];
}

export interface EditionInput {
  publisherPartyId?: number | null;
  relation?: EditionRelation;
  isbn?: string | null;
  editionTitle?: string | null;
  publishedOn?: string | null;
  listPrice?: number | null;
  outConditionId?: number | null;
  notes?: string | null;
}

/**
 * ISBN を数字（と末尾の X）だけにして確かめる（純粋関数）。空は null。
 * 区切り（- ・空白）や、表計算から紛れ込むタブ・見えない文字（U+200E など）は落とす。
 * 13 桁（978／979）か 10 桁でチェックディジットが合うものだけ通す。
 */
export function normalizeIsbn(value: string | null | undefined): string | null {
  const raw = String(value ?? "").normalize("NFKC").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (!raw) return null;
  if (raw.length === 13 && /^\d{13}$/.test(raw)) {
    const sum = [...raw.slice(0, 12)].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== Number(raw[12])) throw new DomainError("VALIDATION", `ISBN ${raw} のチェックディジットが合いません`);
    return raw;
  }
  if (raw.length === 10 && /^\d{9}[\dX]$/.test(raw)) {
    const sum = [...raw].reduce((a, d, i) => a + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
    if (sum % 11 !== 0) throw new DomainError("VALIDATION", `ISBN ${raw} のチェックディジットが合いません`);
    return raw;
  }
  throw new DomainError("VALIDATION", `ISBN は 13 桁（または 10 桁）で入れてください（"${String(value).trim()}"）`);
}

/** 刊行物の確かめてほしいこと（純粋関数）。 */
export function editionWarnings(e: Pick<Edition, "relation" | "publisherPartyId" | "outConditionId" | "isbn">): string[] {
  const out: string[] = [];
  if (e.relation === "sublicense" && !e.outConditionId) out.push("再許諾なのに版元との条件（OUT）がありません。入金があっても作者への払いに繋がりません");
  if (e.relation !== "own" && !e.publisherPartyId) out.push("版元（取引先）が空です");
  if (!e.isbn) out.push("ISBN がありません（売上・製造の報告を ISBN で当てられません）");
  return out;
}

const SELECT = `
  SELECT e.id, e.work_id, e.publisher_party_id, p.name AS publisher_name, e.relation, e.isbn, e.edition_title,
         e.published_on, e.list_price, e.out_condition_id, oc.condition_no AS out_no, oc.rate_ppm AS out_rate_ppm, e.notes
    FROM work_editions e
    LEFT JOIN parties p ON p.id = e.publisher_party_id
    LEFT JOIN conditions oc ON oc.id = e.out_condition_id`;

const toEdition = (r: Record<string, any>): Edition => {
  const relation = (EDITION_RELATIONS as string[]).includes(String(r.relation)) ? r.relation as EditionRelation : "sublicense";
  const base = {
    id: Number(r.id), workId: Number(r.work_id),
    publisherPartyId: int(r.publisher_party_id), publisherName: str(r.publisher_name),
    relation, relationLabel: RELATION_LABEL[relation],
    isbn: str(r.isbn), editionTitle: str(r.edition_title),
    publishedOn: r.published_on ? String(r.published_on instanceof Date ? r.published_on.toISOString() : r.published_on).slice(0, 10) : null,
    listPrice: r.list_price === null || r.list_price === undefined ? null : Number(r.list_price),
    outConditionId: int(r.out_condition_id), outConditionNo: str(r.out_no),
    outRatePct: r.out_rate_ppm === null || r.out_rate_ppm === undefined ? null : ppmToPct(Number(r.out_rate_ppm)),
    notes: str(r.notes)
  };
  return { ...base, warnings: editionWarnings(base) };
};

const isMissingTable = (error: unknown) => (error as { code?: string })?.code === "42P01";

export class WorkEditionService {
  constructor(private readonly database: Queryable & Partial<Transactable>) {}

  /** 作品の刊行物。193 を当てる前の DB では空（available = false）。 */
  async list(workId: number): Promise<{ available: boolean; editions: Edition[] }> {
    try {
      const r = await this.database.query(
        `${SELECT} WHERE e.work_id = $1 AND e.status = 'active' ORDER BY e.published_on NULLS LAST, e.id`, [workId]);
      return { available: true, editions: (r.rows as Array<Record<string, any>>).map(toEdition) };
    } catch (error) {
      if (isMissingTable(error)) return { available: false, editions: [] };
      throw translate(error);
    }
  }

  /** ISBN で生きた刊行物を引く（売上・製造の報告を作品に当てるとき）。 */
  async findByIsbn(q: Queryable, isbn: string): Promise<Edition | null> {
    const n = normalizeIsbn(isbn);
    if (!n) return null;
    const r = await q.query(`${SELECT} WHERE e.isbn = $1 AND e.status = 'active' LIMIT 1`, [n]);
    return r.rows[0] ? toEdition(r.rows[0] as Record<string, any>) : null;
  }

  async create(workId: number, input: EditionInput, actor: string): Promise<Edition> {
    try {
      return await inTransaction(this.database as Transactable, (client) => this.createWithin(client, workId, input, actor));
    } catch (error) { throw translate(error); }
  }

  /** 取込から同じトランザクションで作るとき。 */
  async createWithin(client: Queryable, workId: number, input: EditionInput, actor: string): Promise<Edition> {
    const v = await this.validate(client, workId, input, null);
    const r = await client.query(
      `INSERT INTO work_editions (work_id, publisher_party_id, relation, isbn, edition_title, published_on, list_price,
                                  out_condition_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [workId, v.publisherPartyId, v.relation, v.isbn, v.editionTitle, v.publishedOn, v.listPrice, v.outConditionId, v.notes, actor]);
    const id = Number((r.rows[0] as { id: number }).id);
    await recordAudit(client, { actor, action: "work_edition.create", targetType: "work", targetId: workId, detail: { editionId: id, ...v } });
    return this.get(client, id);
  }

  async update(id: number, patch: EditionInput, actor: string): Promise<Edition> {
    try {
      return await inTransaction(this.database as Transactable, async (client) => {
        const cur = await this.get(client, id);
        const merged: EditionInput = {
          publisherPartyId: cur.publisherPartyId, relation: cur.relation, isbn: cur.isbn, editionTitle: cur.editionTitle,
          publishedOn: cur.publishedOn, listPrice: cur.listPrice, outConditionId: cur.outConditionId, notes: cur.notes,
          ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined))
        };
        // 関係を再許諾から外したら、根拠の条件は外す（自社・グループ会社は条件を持たない）。
        if (merged.relation !== "sublicense") merged.outConditionId = null;
        const v = await this.validate(client, cur.workId, merged, id);
        await client.query(
          `UPDATE work_editions SET publisher_party_id = $2, relation = $3, isbn = $4, edition_title = $5, published_on = $6,
                  list_price = $7, out_condition_id = $8, notes = $9, updated_at = now() WHERE id = $1`,
          [id, v.publisherPartyId, v.relation, v.isbn, v.editionTitle, v.publishedOn, v.listPrice, v.outConditionId, v.notes]);
        await recordAudit(client, { actor, action: "work_edition.update", targetType: "work", targetId: cur.workId, detail: { editionId: id, ...v } });
        return this.get(client, id);
      });
    } catch (error) { throw translate(error); }
  }

  async remove(id: number, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database as Transactable, async (client) => {
        const cur = await this.get(client, id);
        await client.query("UPDATE work_editions SET status = 'void', updated_at = now() WHERE id = $1", [id]);
        await recordAudit(client, { actor, action: "work_edition.void", targetType: "work", targetId: cur.workId,
                                    detail: { editionId: id, isbn: cur.isbn } });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  private async get(q: Queryable, id: number): Promise<Edition> {
    const r = await q.query(`${SELECT} WHERE e.id = $1 AND e.status = 'active'`, [id]);
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", `刊行物 ${id} が見つかりません`);
    return toEdition(r.rows[0] as Record<string, any>);
  }

  private async validate(q: Queryable, workId: number, input: EditionInput, selfId: number | null) {
    const relation = input.relation ?? (input.publisherPartyId ? "sublicense" : "own");
    if (!EDITION_RELATIONS.includes(relation)) throw new DomainError("VALIDATION", "版元との関係は 自社刊行／グループ会社／再許諾 のどれかです");
    const isbn = normalizeIsbn(input.isbn);
    const publisherPartyId = input.publisherPartyId ?? null;
    if (relation !== "own" && !publisherPartyId) throw new DomainError("VALIDATION", "版元（取引先）を選んでください");
    const w = await q.query("SELECT id FROM works WHERE id = $1", [workId]);
    if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
    if (publisherPartyId) {
      const p = await q.query("SELECT id FROM parties WHERE id = $1", [publisherPartyId]);
      if (!p.rows[0]) throw new DomainError("NOT_FOUND", `版元（取引先 ${publisherPartyId}）が見つかりません`);
    }
    const outConditionId = relation === "sublicense" ? input.outConditionId ?? null : null;
    if (input.outConditionId && relation !== "sublicense") {
      throw new DomainError("VALIDATION", "版元との条件（OUT）を付けられるのは再許諾の刊行物だけです");
    }
    if (outConditionId) {
      const c = (await q.query(
        "SELECT direction, work_id, counterparty_id, status, condition_no FROM conditions WHERE id = $1", [outConditionId])).rows[0] as any;
      if (!c) throw new DomainError("NOT_FOUND", `条件 ${outConditionId} が見つかりません`);
      if (c.direction !== "out") throw new DomainError("VALIDATION", `${c.condition_no ?? `#${outConditionId}`} は許諾（OUT）の条件ではありません`);
      if (Number(c.work_id) !== workId) throw new DomainError("VALIDATION", `${c.condition_no ?? `#${outConditionId}`} はこの作品の条件ではありません`);
      if (publisherPartyId && Number(c.counterparty_id) !== publisherPartyId) {
        throw new DomainError("VALIDATION", `${c.condition_no ?? `#${outConditionId}`} は版元との条件ではありません（相手先が違います）`);
      }
    }
    if (isbn) {
      const d = (await q.query(
        `SELECT e.id, w.title FROM work_editions e JOIN works w ON w.id = e.work_id
          WHERE e.isbn = $1 AND e.status = 'active' AND ($2::bigint IS NULL OR e.id <> $2) LIMIT 1`, [isbn, selfId])).rows[0] as any;
      if (d) throw new DomainError("CONFLICT", `ISBN ${isbn} は「${d.title}」の刊行物に登録済みです`);
    }
    const listPrice = input.listPrice ?? null;
    if (listPrice !== null && (!Number.isInteger(listPrice) || listPrice < 0)) throw new DomainError("VALIDATION", "本体価格は 0 以上の整数（円）で入れてください");
    const publishedOn = input.publishedOn ? String(input.publishedOn).slice(0, 10) : null;
    if (publishedOn && !/^\d{4}-\d{2}-\d{2}$/.test(publishedOn)) throw new DomainError("VALIDATION", "刊行日は 2026-10-01 の形で入れてください");
    return {
      publisherPartyId, relation, isbn, outConditionId, listPrice, publishedOn,
      editionTitle: String(input.editionTitle ?? "").trim() || null, notes: String(input.notes ?? "").trim() || null
    };
  }
}

/** 作品の刊行物の根拠になっている OUT 条件（再許諾）。193 の前の DB では空。 */
export async function editionOutConditionIds(q: Queryable, workIds?: number[]): Promise<Set<number>> {
  try {
    const r = await q.query(
      `SELECT DISTINCT out_condition_id FROM work_editions
        WHERE status = 'active' AND out_condition_id IS NOT NULL ${workIds ? "AND work_id = ANY($1::bigint[])" : ""}`,
      workIds ? [workIds] : []);
    return new Set((r.rows as Array<{ out_condition_id: number }>).map((x) => Number(x.out_condition_id)));
  } catch (error) {
    if (isMissingTable(error)) return new Set();
    throw error;
  }
}

/** 作者の紙・電子の条件。刊行物の根拠になっている再許諾（OUT）にも効く。 */
export const PUB_IN_USAGES = ["pub_print", "pub_digital"];

/**
 * IN 条件の利用形態が OUT 条件に効くか（純粋関数）。ふつうは同じ利用形態だけ。
 * 刊行物の根拠になっている再許諾（版元に出版させる OUT）には、作者の紙・電子の条件も効く
 * （作者との取り決めは「紙は本体価格の 7%・電子は入金額の 85%」のように媒体で書かれている）。
 */
export function usageCovers(inUsage: string | null, outUsage: string | null, outBacksEdition: boolean): boolean {
  if (inUsage === outUsage) return true;
  return outBacksEdition && outUsage === "sublicense" && PUB_IN_USAGES.includes(String(inUsage));
}

/** 刊行物の根拠になっている OUT 条件か（1 本だけ）。193 の前の DB では false。 */
export async function backsEdition(q: Queryable, outConditionId: number): Promise<boolean> {
  return (await editionOutConditionIds(q)).has(outConditionId);
}

/** 監査：再許諾の刊行物で、版元との条件（OUT）が無いもの。193 の前の DB では空。 */
export async function editionsWithoutOut(q: Queryable): Promise<Array<Edition & { workTitle: string }>> {
  try {
    const r = await q.query(
      `${SELECT.replace("SELECT e.id", "SELECT w.title AS work_title, e.id")} JOIN works w ON w.id = e.work_id
        WHERE e.status = 'active' AND e.relation = 'sublicense' AND e.out_condition_id IS NULL
        ORDER BY p.name NULLS LAST, w.title, e.published_on NULLS LAST, e.id`);
    return (r.rows as Array<Record<string, any>>).map((x) => ({ ...toEdition(x), workTitle: String(x.work_title ?? "") }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw translate(error);
  }
}
