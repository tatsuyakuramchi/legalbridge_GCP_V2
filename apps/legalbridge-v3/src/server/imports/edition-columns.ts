import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { RELATION_LABEL, RELATION_OF, normalizeProductCode, type EditionInput, type EditionRelation } from "../works/editions.js";

/**
 * 一括登録の「刊行物（出版）／製品（ボードゲーム）」の列（docs/work-editions.md）。
 * 出版作品の取込（版元・ISBN・刊行日・本体価格・版元料率）と、ゲーム作品の取込
 * （販売元・JAN・発売日・希望小売価格・販売元料率）で、読み方と作り方を同じにする。
 */

export interface EditionColumnNames {
  /** 読み上げ・止めるときの言い方（刊行物／製品）。 */
  thing: string;
  /** 相手の呼び方（版元／販売元）。 */
  partner: string;
  partnerCode: string;
  relation: string;
  code: string;      // ISBN／JAN
  date: string;      // 刊行日／発売日
  dateSuffix: string; // 刊／発売
  price: string;     // 本体価格／希望小売価格
  rate: string;      // 版元料率／販売元料率
  /**
   * 出版だけ：電子の料率の列（版元電子料率）。あれば版元との条件を紙・電子の 2 本に分ける（媒体の許諾範囲つき）。
   * 版元は紙と電子を別々に報告して払うので、1 本にまとめると入金から作者の紙・電子を取り違える。
   */
  rateDigital?: string;
  /** 自社の言い方（自社刊行／自社製造・自社販売）。 */
  ownLabel: string;
  /** 再許諾の条件を作るときの名前（作品名｜○○（相手））と備考・価格の基準・計算書の出し方。 */
  outName: string;
  outNotes: string;
  outPriceBasis: "list" | "receipts" | null;
  outTiming: "event" | "periodic";
}

export const PUB_EDITION_NAMES: EditionColumnNames = {
  thing: "刊行物", partner: "版元", partnerCode: "版元コード", relation: "版元との関係", code: "ISBN",
  date: "刊行日", dateSuffix: "刊", price: "本体価格", rate: "版元料率", rateDigital: "版元電子料率", ownLabel: "自社刊行",
  outName: "出版の再許諾", outNotes: "出版作品の取込で作成（版元料率。本体価格に対して）", outPriceBasis: "list", outTiming: "event"
};

export const GAME_EDITION_NAMES: EditionColumnNames = {
  thing: "製品", partner: "販売元", partnerCode: "販売元コード", relation: "販売元との関係", code: "JAN",
  date: "発売日", dateSuffix: "発売", price: "希望小売価格", rate: "販売元料率", ownLabel: "自社製造・自社販売",
  outName: "再許諾", outNotes: "ゲーム作品の取込で作成（販売元料率。受領額に対して）", outPriceBasis: "receipts", outTiming: "periodic"
};

export const editionColumns = (n: EditionColumnNames) =>
  [n.partner, n.partnerCode, n.relation, n.code, n.date, n.price, n.rate, ...(n.rateDigital ? [n.rateDigital] : [])];

export interface EditionRow {
  publisher: { id: number; name: string } | null;
  relation: EditionRelation;
  /** ISBN／JAN（数字だけ）。 */
  isbn: string | null; publishedOn: string | null; listPrice: number | null;
  /** 相手から当社への料率（%）。再許諾の条件（OUT）を作るか、既にあれば使う。 */
  outRatePct: number | null;
  /** 出版だけ：電子の料率（%）。版元との電子の再許諾の条件を作るか使う。 */
  outDigitalRatePct?: number | null;
}

const text = (row: Record<string, string>, header: string) => String(row[header] ?? "").trim();

function pct(value: string, header: string): number | null {
  const s = value.trim().replace(/[%％]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new DomainError("VALIDATION", `${header}は 0〜100（%）で入れてください（"${value.trim()}"）`);
  return n;
}

function date(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) throw new DomainError("VALIDATION", `日付は 2026-10-01 か 2026/10/01 の形で入れてください（"${s}"）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * 刊行物・製品の列を読む（どれも空なら null）。
 * 関係が空なら：料率があれば再許諾、相手が空なら自社、相手があって料率が無いときはどちらか分からないので止める。
 * ISBN／JAN が他の作品に登録済みなら止める（作品・条件を作ってから止まらないよう先に見る）。
 * 同じ作品（sameWorkId）に登録済みなら、その刊行物・製品は足さない（reuse = true。作者が何人いても 1 件）。
 */
export async function readEditionColumns(
  q: Queryable, row: Record<string, string>, n: EditionColumnNames,
  findParty: (code: string, name: string, what: string) => Promise<{ id: number; name: string }>,
  sameWorkId: number | null = null
): Promise<(EditionRow & { reuse: boolean }) | null> {
  if (!editionColumns(n).some((h) => text(row, h))) return null;
  const pName = text(row, n.partner);
  const pCode = text(row, n.partnerCode);
  const publisher = pName || pCode ? await findParty(pCode, pName, n.partner) : null;
  const relText = text(row, n.relation);
  if (relText && !RELATION_OF[relText]) {
    throw new DomainError("VALIDATION", `${n.relation}は「${n.ownLabel}」「グループ会社」「再許諾」${n === GAME_EDITION_NAMES ? "「他社販売」" : ""}のどれかです（"${relText}"）`);
  }
  const outRatePct = pct(text(row, n.rate), n.rate);
  const outDigitalRatePct = n.rateDigital ? pct(text(row, n.rateDigital), n.rateDigital) : null;
  let relation: EditionRelation;
  if (relText) relation = RELATION_OF[relText];
  else if (outRatePct !== null || outDigitalRatePct !== null) relation = "sublicense";
  else if (!publisher) relation = "own";
  else throw new DomainError("VALIDATION", `${n.partner} ${publisher.name} との関係を「${n.relation}」に入れてください（料率の取り決めが無いなら「グループ会社」）`);
  if (relation !== "own" && !publisher) throw new DomainError("VALIDATION", `${n.partner}を入れてください（${n.ownLabel}なら空でよい）`);
  if ((outRatePct !== null || outDigitalRatePct !== null) && relation !== "sublicense") {
    throw new DomainError("VALIDATION", `${n.rate}は再許諾のときだけです（${RELATION_LABEL[relation]}は料率で条件を作らない）`);
  }
  const priceText = text(row, n.price).replace(/[,，円¥￥\s]/g, "");
  const listPrice = priceText ? Number(priceText) : null;
  if (listPrice !== null && (!Number.isInteger(listPrice) || listPrice < 0)) {
    throw new DomainError("VALIDATION", `${n.price}は円の整数で入れてください（"${text(row, n.price)}"）`);
  }
  const isbn = normalizeProductCode(text(row, n.code), n.code);
  let reuse = false;
  if (isbn) {
    const hit = await q.query(
      `SELECT e.work_id, w.title FROM work_editions e JOIN works w ON w.id = e.work_id WHERE e.isbn = $1 AND e.status = 'active' LIMIT 1`, [isbn])
      .catch((error: { code?: string }) => {
        if (error?.code === "42P01") throw new DomainError("VALIDATION", `${n.thing}の台帳がまだありません（infra/v3/193 を当ててください）`);
        throw error;
      });
    const h = hit.rows[0] as { work_id: number; title: string } | undefined;
    if (h && sameWorkId !== null && Number(h.work_id) === sameWorkId) reuse = true;
    else if (h) throw new DomainError("CONFLICT", `${n.code} ${isbn} は「${h.title}」の${n.thing}に登録済みです。この行は飛ばされます`);
  }
  const publishedOn = date(text(row, n.date));
  if (!isbn && sameWorkId !== null) {
    // コードの無い刊行物・製品（海外版など）は、同じ作品・相手・関係・日付のものがあれば足さない（もう一度流しても二重にしない）。
    const same = await q.query(
      `SELECT 1 FROM work_editions WHERE work_id = $1 AND status = 'active' AND isbn IS NULL AND relation = $2
          AND publisher_party_id IS NOT DISTINCT FROM $3 AND published_on IS NOT DISTINCT FROM $4::date LIMIT 1`,
      [sameWorkId, relation, publisher?.id ?? null, publishedOn]).catch(() => ({ rows: [] }));
    if (same.rows[0]) reuse = true;
  }
  return { publisher, relation, isbn, publishedOn, listPrice, outRatePct, outDigitalRatePct, reuse };
}

/** 読み上げ（「刊行物 KADOKAWA（再許諾 12%） ISBN 978… 2004-09-10 刊」）。 */
export function editionRowLabel(e: EditionRow, n: EditionColumnNames): string {
  const who = e.publisher ? e.publisher.name : "当社";
  const rel = e.relation === "sublicense"
    ? `再許諾${n.rateDigital
        ? [e.outRatePct !== null ? ` 紙 ${e.outRatePct}%` : "", e.outDigitalRatePct != null ? ` 電子 ${e.outDigitalRatePct}%` : ""].join("") || `・${n.partner}との条件は付けない（後で）`
        : e.outRatePct !== null ? ` ${e.outRatePct}%` : `・${n.partner}との条件は付けない（後で）`}`
    : e.relation === "group" ? "グループ会社・料率なし"
    : e.relation === "own" ? n.ownLabel
    : `他社販売・${n.partner}との条件は既存の OEM を使う`;
  return `${n.thing} ${who}（${rel}）${e.isbn ? ` ${n.code} ${e.isbn}` : ` ${n.code} なし`}${e.publishedOn ? ` ${e.publishedOn} ${n.dateSuffix}` : ""}`;
}

export interface EditionWriteDeps {
  createOut?(input: {
    name: string; direction: "out"; kind: "license"; usageType: "sublicense"; counterpartyId: number; workId: number;
    pricingModel: "revenue_rate"; ratePpm: number; priceBasis: "list" | "receipts" | null; statementTiming: "event" | "periodic";
    currency: string; notes?: string | null;
    scopes?: Array<{ scopeType: "media"; label: string; code: string }>;
  }, actor: string): Promise<{ id: number; conditionNo: string | null }>;
  editions?: { create(workId: number, input: EditionInput, actor: string): Promise<{ id: number }> };
}

/**
 * 刊行物・製品を作る。
 *   再許諾 … 料率があれば相手との再許諾の条件（OUT、作品 × 相手で 1 本）を既存から使うか作って繋ぐ。
 *   他社販売（OEM）… 相手との OEM の条件（OUT）が 1 本だけあれば繋ぐ（料率では作らない。卸の取り決めは条件明細で）。
 * 同じ作品に同じ ISBN／JAN が登録済み（reuse）なら何もしない。返すのは読み上げの文（条件の番号）。
 */
export async function writeEditionRow(
  q: Queryable, deps: EditionWriteDeps, workId: number, title: string, e: EditionRow & { reuse?: boolean },
  n: EditionColumnNames, actor: string
): Promise<string> {
  if (e.reuse) return "";
  if (!deps.editions) throw new DomainError("VALIDATION", `${n.thing}の台帳がありません（193 を当ててください）`);
  const { outConditionId, made } = await ensurePartnerOuts(q, deps, workId, title, e, n, actor);
  await deps.editions.create(workId, {
    publisherPartyId: e.publisher?.id ?? null, relation: e.relation, isbn: e.isbn, publishedOn: e.publishedOn,
    listPrice: e.listPrice, outConditionId
  }, actor);
  return made.join("・");
}

/**
 * 相手（版元・販売元）との条件（OUT）を、既存から使うか作る。刊行物・製品そのものは作らない
 * （登録済みの刊行物に、あとから版元料率・版元電子料率を足すときにも使う）。
 *   再許諾 … 料率があれば、媒体ごと（出版）または 1 本（ゲーム）。料率が違えば止める。
 *   他社販売（OEM）… OEM の条件が 1 本だけあれば繋ぐ（料率では作らない）。
 * 返すのは刊行物が指す条件（紙、無ければ電子）と読み上げ。
 */
export async function ensurePartnerOuts(
  q: Queryable, deps: EditionWriteDeps, workId: number, title: string, e: EditionRow, n: EditionColumnNames, actor: string
): Promise<{ outConditionId: number | null; made: string[] }> {
  const made: string[] = [];
  let outConditionId: number | null = null;
  const pub = e.publisher;
  if (pub && e.relation === "oem") {
    const hit = await findOut(q, workId, pub.id, "oem", null);
    if (hit.length > 1) throw new DomainError("VALIDATION", `${pub.name} との他社販売（OEM）の条件が 2 本以上あります。条件明細で整理してから入れてください`);
    if (hit[0]) { outConditionId = hit[0].id; made.push(`${n.partner}との条件 ${hit[0].no}`); }
  } else if (pub && e.relation === "sublicense") {
    // 出版は紙・電子で条件を分ける（媒体の許諾範囲つき）。ゲームは媒体なしの 1 本。
    const wants: Array<{ media: "print" | "digital" | null; ratePct: number; label: string; priceBasis: "list" | "receipts" | null;
                         timing: "event" | "periodic"; column: string }> = [];
    if (e.outRatePct !== null) {
      wants.push({ media: n.rateDigital ? "print" : null, ratePct: e.outRatePct, label: n.rateDigital ? "紙" : "",
                   priceBasis: n.outPriceBasis, timing: n.outTiming, column: n.rate });
    }
    if (n.rateDigital && e.outDigitalRatePct != null) {
      wants.push({ media: "digital", ratePct: e.outDigitalRatePct, label: "電子", priceBasis: null, timing: "periodic", column: n.rateDigital });
    }
    for (const w of wants) {
      const hit = await findOut(q, workId, pub.id, "sublicense", w.media);
      const what = `${pub.name} との${w.label ? `${w.label}の` : ""}再許諾の条件`;
      if (hit.length > 1) throw new DomainError("VALIDATION", `${what}が 2 本以上あります。条件明細で整理してから入れてください`);
      let id: number; let no: string | null;
      if (hit[0]) {
        if (hit[0].ratePpm !== Math.round(w.ratePct * 10000)) {
          throw new DomainError("VALIDATION",
            `${what} ${hit[0].no ?? `#${hit[0].id}`} は料率 ${Number(hit[0].ratePpm) / 10000}% です（${w.column} ${w.ratePct}%）。条件明細で直すか、${w.column}を合わせてください`);
        }
        id = hit[0].id; no = hit[0].no;
      } else {
        if (!deps.createOut) throw new DomainError("VALIDATION", "再許諾の条件を作れません");
        const c = await deps.createOut({
          name: `${title}｜${n.outName}${w.label ? `・${w.label}` : ""}（${pub.name}）`, direction: "out", kind: "license", usageType: "sublicense",
          counterpartyId: pub.id, workId, pricingModel: "revenue_rate", ratePpm: Math.round(w.ratePct * 10000),
          priceBasis: w.priceBasis, statementTiming: w.timing, currency: "JPY",
          notes: w.media === "digital" ? "出版作品の取込で作成（版元電子料率）" : n.outNotes,
          ...(w.media ? { scopes: [{ scopeType: "media" as const, label: w.media === "print" ? "紙" : "電子", code: w.media }] } : {})
        }, actor);
        id = c.id; no = c.conditionNo;
      }
      // 刊行物（本）が指すのは紙の条件。電子だけなら電子の条件。
      if (outConditionId === null || w.media === "print") outConditionId = id;
      made.push(`${n.partner}との${w.label ? `${w.label}の` : ""}条件 ${no ?? `#${id}`}`);
    }
  }
  return { outConditionId, made };
}

/**
 * 作品 × 相手の生きた OUT 条件。media を渡すと媒体で絞る：紙は媒体が紙か媒体なし（193 の取込で作った条件）、電子は電子だけ。
 */
async function findOut(q: Queryable, workId: number, partyId: number, usage: string, media: "print" | "digital" | null):
  Promise<Array<{ id: number; no: string | null; ratePpm: number | null }>> {
  const rows = (await q.query(
    `SELECT c.id, c.condition_no, c.rate_ppm,
            (SELECT sc.code FROM condition_scopes sc WHERE sc.condition_id = c.id AND sc.scope_type = 'media' LIMIT 1) AS media
       FROM conditions c
      WHERE c.direction = 'out' AND c.kind = 'license' AND c.usage_type = $3 AND c.status IN ('active', 'scheduled')
        AND c.work_id = $1 AND c.counterparty_id = $2
      ORDER BY c.id`, [workId, partyId, usage])).rows as Array<{ id: number; condition_no: string | null; rate_ppm: number | null; media: string | null }>;
  return rows
    .filter((r) => !media || (media === "digital" ? r.media === "digital" : r.media !== "digital"))
    .map((r) => ({ id: Number(r.id), no: r.condition_no, ratePpm: r.rate_ppm === null ? null : Number(r.rate_ppm) }));
}
