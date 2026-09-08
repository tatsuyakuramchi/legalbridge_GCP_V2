import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 横断検索。
 *
 * 3,000件規模を一覧で辿るのは実用に耐えないので、番号・名前・相手先から
 * 直接たどり着けるようにする。V2 は案件・文書・取引先・作品の4種だったが、
 * V3 は条件が軸なので条件と支払も入れる。
 *
 * 表記ゆれは拾わない（部分一致だけ）。名寄せの手前で欲張ると、
 * 「出てこない」より質の悪い「関係ないものが出る」になる。
 */

export type SearchTarget = "matter" | "condition" | "document" | "party" | "work" | "payment";

export interface SearchHit {
  target: SearchTarget;
  id: number;
  /** 業務番号。無ければ null。 */
  code: string | null;
  title: string;
  /** 相手先・状態・金額など、同名を見分けるための手がかり。 */
  context: string;
}

const KIND_LABEL: Record<string, string> = {
  work: "作品フロー", outsourcing: "業務委託フロー", single: "条件なしフロー",
  license: "ライセンス", product: "製品", service: "役務", expense: "実費", fee: "手数料"
};

export class SearchRepository {
  constructor(private readonly database: Transactable) {}

  async search(query: string, limitPerType = 6): Promise<SearchHit[]> {
    const keyword = `%${query.trim()}%`;
    const limit = Math.min(Math.max(limitPerType, 1), 20);

    try {
      const [matters, conditions, documents, parties, works, payments] = await Promise.all([
        this.database.query(
          `SELECT m.id, m.matter_no, m.title, m.kind, m.status, p.name AS party
             FROM matters m LEFT JOIN parties p ON p.id = m.counterparty_id
            WHERE m.title ILIKE $1 OR COALESCE(m.matter_no,'') ILIKE $1
               OR COALESCE(p.name,'') ILIKE $1
            ORDER BY m.updated_at DESC LIMIT $2`, [keyword, limit]),

        this.database.query(
          `SELECT c.id, c.condition_no, c.name, c.direction, c.kind, c.status,
                  c.currency, c.flat_amount, p.name AS party, w.title AS work
             FROM conditions c
             JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN works w ON w.id = c.work_id
            WHERE c.name ILIKE $1 OR COALESCE(c.condition_no,'') ILIKE $1
               OR p.name ILIKE $1 OR COALESCE(w.title,'') ILIKE $1
            ORDER BY c.updated_at DESC LIMIT $2`, [keyword, limit]),

        this.database.query(
          `SELECT d.id, d.document_no, d.status, d.issued_at,
                  t.label AS template, a.title AS agreement
             FROM documents d
             LEFT JOIN document_template_versions v ON v.id = d.template_version_id
             LEFT JOIN document_templates t ON t.id = v.template_id
             LEFT JOIN agreements a ON a.id = d.agreement_id
            WHERE COALESCE(d.document_no,'') ILIKE $1 OR COALESCE(t.label,'') ILIKE $1
               OR COALESCE(a.title,'') ILIKE $1
            ORDER BY d.created_at DESC LIMIT $2`, [keyword, limit]),

        this.database.query(
          `SELECT id, party_code, name, kind, status, aliases
             FROM parties
            WHERE name ILIKE $1 OR COALESCE(party_code,'') ILIKE $1
               OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $1)
            ORDER BY status, name LIMIT $2`, [keyword, limit]),

        this.database.query(
          `SELECT id, work_code, title, kind, status
             FROM works
            WHERE title ILIKE $1 OR COALESCE(work_code,'') ILIKE $1
               OR COALESCE(title_kana,'') ILIKE $1
            ORDER BY title LIMIT $2`, [keyword, limit]),

        this.database.query(
          `SELECT y.id, y.payment_no, y.amount, y.currency, y.status, y.due_on,
                  p.name AS party
             FROM payments y JOIN parties p ON p.id = y.party_id
            WHERE COALESCE(y.payment_no,'') ILIKE $1 OR p.name ILIKE $1
               OR COALESCE(y.note,'') ILIKE $1
            ORDER BY y.id DESC LIMIT $2`, [keyword, limit])
      ]);

      const yen = (amount: unknown, currency: unknown) =>
        amount === null || amount === undefined ? "" : `${currency ?? "JPY"} ${Number(amount).toLocaleString("ja-JP")}`;
      const join = (...parts: Array<string | null | undefined>) =>
        parts.filter((p) => p !== null && p !== undefined && p !== "").join("・");

      return [
        ...matters.rows.map((r: any): SearchHit => ({
          target: "matter", id: Number(r.id), code: str(r.matter_no), title: String(r.title),
          context: join(str(r.party), KIND_LABEL[r.kind] ?? r.kind, r.status)
        })),
        ...conditions.rows.map((r: any): SearchHit => ({
          target: "condition", id: Number(r.id), code: str(r.condition_no), title: String(r.name),
          context: join(r.direction === "in" ? "IN 取得" : "OUT 許諾", str(r.party), str(r.work),
                        KIND_LABEL[r.kind] ?? r.kind, yen(r.flat_amount, r.currency), r.status)
        })),
        ...documents.rows.map((r: any): SearchHit => ({
          target: "document", id: Number(r.id), code: str(r.document_no),
          title: str(r.template) ?? str(r.agreement) ?? "（テンプレート不明）",
          context: join(r.status, dateStr(r.issued_at))
        })),
        ...parties.rows.map((r: any): SearchHit => ({
          target: "party", id: Number(r.id), code: str(r.party_code), title: String(r.name),
          context: join(r.kind === "individual" ? "個人" : "法人",
                        r.status !== "active" ? r.status : null,
                        ((r.aliases as string[] | null) ?? []).join(" / ") || null)
        })),
        ...works.rows.map((r: any): SearchHit => ({
          target: "work", id: Number(r.id), code: str(r.work_code), title: String(r.title),
          context: join(r.kind, r.status)
        })),
        ...payments.rows.map((r: any): SearchHit => ({
          target: "payment", id: Number(r.id), code: str(r.payment_no),
          title: `${r.party} への支払`,
          context: join(yen(r.amount, r.currency), r.status, dateStr(r.due_on))
        }))
      ];
    } catch (error) { throw translate(error); }
  }
}
