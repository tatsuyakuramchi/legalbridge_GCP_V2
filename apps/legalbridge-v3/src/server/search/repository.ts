import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 横断検索。
 *
 * 3,000件規模を一覧で辿るのは実用に耐えないので、番号・名前・相手先から
 * 直接たどり着けるようにする。案件・条件・文書・取引先・作品・支払に加えて、
 * 契約（合意）と受付箱の依頼も引く。
 *
 * 揺れの吸収は「同じ字の書き方の違い」までにする：
 *   - 全角・半角（ＡＲＣ－ＰＯ → ARC-PO、ｶﾀｶﾅ → カタカナ）、大文字・小文字
 *   - ハイフン・長音の書き方（ー－‐―）
 *   - ひらがな・カタカナ（いと ↔ イト）
 * 似た名前を推測して当てることはしない。名寄せの手前で欲張ると、
 * 「出てこない」より質の悪い「関係ないものが出る」になる。
 *
 * 空白で区切った言葉は「すべてを含む」（ito 霧島 → ito を含み、かつ 霧島 を含む）。
 * 言葉は、その種類の検索の対象の欄（番号・名前・相手先・作品など）のどこかに
 * 当たればよい。並びは 番号の完全一致 → 番号の前方一致 → 名前の前方一致 → その他。
 */

export type SearchTarget =
  | "matter" | "condition" | "document" | "party" | "work" | "payment" | "agreement" | "request";

export const SEARCH_TARGETS: SearchTarget[] =
  ["matter", "agreement", "condition", "document", "request", "party", "work", "payment"];

export interface SearchHit {
  target: SearchTarget;
  id: number;
  /** 業務番号。無ければ null。 */
  code: string | null;
  title: string;
  /** 相手先・状態・金額など、同名を見分けるための手がかり。 */
  context: string;
}

export interface SearchResult {
  results: SearchHit[];
  /** 種類ごとに、上限を超えてまだあるか。画面が「もっと見る」を出す。 */
  more: Partial<Record<SearchTarget, boolean>>;
}

const KIND_LABEL: Record<string, string> = {
  work: "作品フロー", outsourcing: "業務委託フロー", single: "条件なしフロー",
  license: "ライセンス", product: "製品", service: "役務", expense: "実費", fee: "手数料"
};

const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hiraToKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** 言葉を揃える。NFKC（全角英数・半角カナ）、ハイフン類、空白。 */
export function normalizeQuery(query: string): string {
  return String(query ?? "").normalize("NFKC")
    .replace(/[‐‑‒–—―−ｰ－]/g, "-")
    .replace(/\s+/g, " ").trim();
}

/** 空白で区切った言葉。同じ言葉は1つに。 */
export function tokensOf(query: string): string[] {
  return [...new Set(normalizeQuery(query).split(" ").filter(Boolean))].slice(0, 6);
}

/**
 * 1語の ILIKE の型。ひらがな・カタカナの両方と、英数の間のハイフンの有無
 * （ARC-PO と ARCPO）の揺れを並べる。% と _ は字として扱う。
 */
export function patternsOf(token: string): string[] {
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const forms = new Set([token, hiraToKata(token), kataToHira(token)]);
  // 長音（ー）は検索語ではカタカナの長音、データ側はハイフンで入っていることがある
  for (const f of [...forms]) if (f.includes("ー")) forms.add(f.replace(/ー/g, "-"));
  return [...forms].map((f) => `%${esc(f)}%`);
}

interface Spec {
  target: SearchTarget;
  /** SELECT … FROM …（WHERE は付けない）。 */
  from: string;
  /** 検索の対象にする欄を並べた式。言葉はこのどこかに当たればよい。 */
  hay: string;
  /** 番号の欄（並びに使う）。 */
  code: string;
  /** 名前の欄（並びに使う）。 */
  name: string;
  /** 同じ強さのときの並び。 */
  tie: string;
  map: (r: any) => SearchHit;
}

const yen = (amount: unknown, currency: unknown) =>
  amount === null || amount === undefined ? "" : `${currency ?? "JPY"} ${Number(amount).toLocaleString("ja-JP")}`;
const join = (...parts: Array<string | null | undefined>) =>
  parts.filter((p) => p !== null && p !== undefined && p !== "").join("・");

const SPECS: Spec[] = [
  {
    target: "matter",
    from: `SELECT m.id, m.matter_no, m.title, m.kind, m.status, p.name AS party
             FROM matters m LEFT JOIN parties p ON p.id = m.counterparty_id`,
    hay: `concat_ws(' ', m.matter_no, m.title, p.name)`,
    code: "m.matter_no", name: "m.title", tie: "m.updated_at DESC",
    map: (r) => ({ target: "matter", id: Number(r.id), code: str(r.matter_no), title: String(r.title),
      context: join(str(r.party), KIND_LABEL[r.kind] ?? r.kind, r.status) })
  },
  {
    target: "agreement",
    from: `SELECT a.id, a.agreement_no, a.title, a.status, a.kind, p.name AS party
             FROM agreements a LEFT JOIN parties p ON p.id = a.counterparty_id`,
    hay: `concat_ws(' ', a.agreement_no, a.title, p.name)`,
    code: "a.agreement_no", name: "a.title", tie: "a.updated_at DESC",
    map: (r) => ({ target: "agreement", id: Number(r.id), code: str(r.agreement_no), title: String(r.title),
      context: join(str(r.party), r.kind === "master" ? "基本契約" : r.kind === "individual" ? "個別契約" : str(r.kind), r.status) })
  },
  {
    target: "condition",
    from: `SELECT c.id, c.condition_no, c.name, c.direction, c.kind, c.status,
                  c.currency, c.flat_amount, p.name AS party, w.title AS work
             FROM conditions c
             JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN works w ON w.id = c.work_id`,
    hay: `concat_ws(' ', c.condition_no, c.name, p.name, w.title)`,
    code: "c.condition_no", name: "c.name", tie: "c.updated_at DESC",
    map: (r) => ({ target: "condition", id: Number(r.id), code: str(r.condition_no), title: String(r.name),
      context: join(r.direction === "in" ? "IN 取得" : "OUT 許諾", str(r.party), str(r.work),
                    KIND_LABEL[r.kind] ?? r.kind, yen(r.flat_amount, r.currency), r.status) })
  },
  {
    // 文書は番号・ひな形・契約名に加えて、載っている条件の相手先・作品でも引く
    // （「霧島」で霧島さんの計算書・検収書が出るように）。
    target: "document",
    from: `SELECT d.id, d.document_no, d.status, d.issued_at,
                  t.label AS template, a.title AS agreement, dp.parties, dp.works
             FROM documents d
             LEFT JOIN document_template_versions v ON v.id = d.template_version_id
             LEFT JOIN document_templates t ON t.id = v.template_id
             LEFT JOIN agreements a ON a.id = d.agreement_id
             LEFT JOIN LATERAL (
               SELECT string_agg(DISTINCT p.name, ' ') AS parties, string_agg(DISTINCT w.title, ' ') AS works
                 FROM document_conditions dc
                 JOIN conditions c ON c.id = dc.condition_id
                 LEFT JOIN parties p ON p.id = c.counterparty_id
                 LEFT JOIN works w ON w.id = c.work_id
                WHERE dc.document_id = d.id) dp ON true`,
    hay: `concat_ws(' ', d.document_no, t.label, a.title, dp.parties, dp.works)`,
    code: "d.document_no", name: "t.label", tie: "d.created_at DESC",
    map: (r) => ({ target: "document", id: Number(r.id), code: str(r.document_no),
      title: str(r.template) ?? str(r.agreement) ?? "（テンプレート不明）",
      context: join(str(r.parties), str(r.works), r.status, dateStr(r.issued_at)) })
  },
  {
    target: "request",
    from: `SELECT r.id, r.request_no, r.title, r.state, r.counterparty_name, r.requester_name, r.backlog_issue_key
             FROM intake_requests r`,
    hay: `concat_ws(' ', r.request_no, r.title, r.counterparty_name, r.requester_name, r.backlog_issue_key)`,
    code: "r.request_no", name: "r.title", tie: "r.created_at DESC",
    map: (r) => ({ target: "request", id: Number(r.id), code: str(r.request_no), title: String(r.title),
      context: join(str(r.counterparty_name), str(r.requester_name) ? `依頼者 ${r.requester_name}` : null,
                    ({ new: "未処理", on_hold: "保留", accepted: "受付済", duplicate: "重複", dismissed: "対象外" } as Record<string, string>)[r.state] ?? r.state,
                    str(r.backlog_issue_key)) })
  },
  {
    target: "party",
    from: `SELECT id, party_code, name, kind, status, aliases FROM parties`,
    hay: `concat_ws(' ', party_code, name, name_kana, array_to_string(aliases, ' '))`,
    code: "party_code", name: "name", tie: "status, name",
    map: (r) => ({ target: "party", id: Number(r.id), code: str(r.party_code), title: String(r.name),
      context: join(r.kind === "individual" ? "個人" : "法人", r.status !== "active" ? r.status : null,
                    ((r.aliases as string[] | null) ?? []).join(" / ") || null) })
  },
  {
    target: "work",
    from: `SELECT id, work_code, title, kind, status FROM works`,
    hay: `concat_ws(' ', work_code, title, title_kana)`,
    code: "work_code", name: "title", tie: "title",
    map: (r) => ({ target: "work", id: Number(r.id), code: str(r.work_code), title: String(r.title),
      context: join(r.kind, r.status) })
  },
  {
    target: "payment",
    from: `SELECT y.id, y.payment_no, y.amount, y.currency, y.status, y.due_on, p.name AS party
             FROM payments y JOIN parties p ON p.id = y.party_id`,
    hay: `concat_ws(' ', y.payment_no, p.name, y.note)`,
    code: "y.payment_no", name: "p.name", tie: "y.id DESC",
    map: (r) => ({ target: "payment", id: Number(r.id), code: str(r.payment_no), title: `${r.party} への支払`,
      context: join(yen(r.amount, r.currency), r.status, dateStr(r.due_on)) })
  }
];

export class SearchRepository {
  constructor(private readonly database: Transactable) {}

  /** 横断検索。結果だけが要るとき（Slack の /法務検索）。 */
  async search(query: string, limitPerType = 6, targets: SearchTarget[] = SEARCH_TARGETS): Promise<SearchHit[]> {
    return (await this.find(query, { limitPerType, targets })).results;
  }

  async find(query: string, options: { limitPerType?: number; targets?: SearchTarget[] } = {}): Promise<SearchResult> {
    const tokens = tokensOf(query);
    if (!tokens.length) return { results: [], more: {} };
    const limit = Math.min(Math.max(options.limitPerType ?? 6, 1), 50);
    const whole = normalizeQuery(query);
    const specs = SPECS.filter((s) => (options.targets ?? SEARCH_TARGETS).includes(s.target));
    try {
      const rows = await Promise.all(specs.map((spec) => {
        // 言葉ごとに「どれかの型に当たる」を AND で重ねる。$1 は全体（並び用）。
        const params: unknown[] = [whole];
        const where = tokens.map((t) => {
          params.push(patternsOf(t));
          return `${spec.hay} ILIKE ANY($${params.length}::text[])`;
        }).join(" AND ");
        params.push(limit + 1);
        return this.database.query(
          `${spec.from}
            WHERE ${where}
            ORDER BY CASE WHEN lower(COALESCE(${spec.code}, '')) = lower($1) THEN 0
                          WHEN lower(COALESCE(${spec.code}, '')) LIKE lower($1) || '%' THEN 1
                          WHEN lower(COALESCE(${spec.name}, '')) LIKE lower($1) || '%' THEN 2
                          ELSE 3 END,
                     ${spec.tie}
            LIMIT $${params.length}`, params);
      }));
      const more: SearchResult["more"] = {};
      const results: SearchHit[] = [];
      specs.forEach((spec, i) => {
        const list = rows[i].rows as any[];
        if (list.length > limit) more[spec.target] = true;
        results.push(...list.slice(0, limit).map(spec.map));
      });
      return { results, more };
    } catch (error) { throw translate(error); }
  }
}
