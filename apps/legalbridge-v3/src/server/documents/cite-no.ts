import type { Queryable } from "../core/db.js";
import { baseDocumentNumber } from "./numbering.js";

/**
 * 文書番号の引用：当社番号か、相手方番号か、両方か（A-072）。
 *
 * 個別条件書・発注書・検収書・計算書は、基本契約・発注書・個別契約の番号を本文に引く。
 * 当社の番号（agreements.agreement_no / documents.document_no）のほかに、相手方が付けた
 * 番号（agreements.counterparty_ref_no / documents.counterparty_doc_no）を控えておき、
 * 文書フォームの「番号の出し方」（manual_inputs._refNoMode）でどれを紙に出すか選ぶ。
 *
 *   ours   … 当社番号（従来どおり。既定）
 *   theirs … 相手方番号。控えが無い番号は当社番号のまま（黙って空欄にしない）
 *   both   … 「当社番号（相手方番号 X）」
 *
 * 番号の出どころは多い（文脈の基本契約・条件の単体契約・関連文書・人が選んだ番号・
 * 計算書の契約番号）ので、文脈を組んだあとに 1 か所で置き換える（applyRefNoMode）。
 * 置き換えは「当社番号 → 出し方の文字」の表で引くだけなので、番号が表に無ければ変わらない。
 */
export type RefNoMode = "ours" | "theirs" | "both";

export const REF_NO_MODES: Array<{ value: RefNoMode; label: string; hint: string }> = [
  { value: "ours", label: "当社番号", hint: "当社が振った番号だけ（従来どおり）" },
  { value: "theirs", label: "相手方番号", hint: "相手方が付けた番号。控えが無い番号は当社番号のまま" },
  { value: "both", label: "両方", hint: "当社番号（相手方番号 ◯◯）の形" }
];

export function refNoModeOf(value: unknown): RefNoMode {
  const v = String(value ?? "").trim();
  return v === "theirs" || v === "both" ? v : "ours";
}

/** 1 つの番号の出し方。相手方番号が無ければ当社番号。 */
export function citeText(mode: RefNoMode, ours: string | null | undefined, theirs: string | null | undefined): string {
  const o = String(ours ?? "").trim();
  const t = String(theirs ?? "").trim();
  if (!o) return t;
  if (!t || mode === "ours" || t === o) return o;
  return mode === "theirs" ? t : `${o}（相手方番号 ${t}）`;
}

/** 当社番号 → 相手方番号 の表。訂正版の枝番（-R2）は本体の番号でも引けるようにする。 */
export type CounterpartyNos = Map<string, string>;

/**
 * 文脈に関わる契約・文書の相手方番号を集める。
 *   agreementIds … 文脈の契約（基本契約・条件が載っている契約・その親）
 *   conditionIds … 条件（同じ系列の版を含む）に結びついた文書
 *   numbers      … 人が選んだ番号（発注書番号・個別契約番号）。契約番号でも文書番号でも引く
 */
export async function loadCounterpartyNos(
  q: Queryable,
  scope: { agreementIds?: Array<number | null | undefined>; conditionIds?: number[]; numbers?: Array<string | null | undefined> }
): Promise<CounterpartyNos> {
  const map: CounterpartyNos = new Map();
  const agreementIds = [...new Set((scope.agreementIds ?? []).filter((x): x is number => Number.isInteger(x) && Number(x) > 0))];
  const conditionIds = [...new Set((scope.conditionIds ?? []).filter((x) => Number.isInteger(x) && x > 0))];
  const numbers = [...new Set((scope.numbers ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!agreementIds.length && !conditionIds.length && !numbers.length) return map;

  const a = await q.query(
    `SELECT a.agreement_no, a.counterparty_ref_no
       FROM agreements a
      WHERE a.counterparty_ref_no IS NOT NULL AND btrim(a.counterparty_ref_no) <> ''
        AND a.agreement_no IS NOT NULL
        AND (a.id = ANY($1::bigint[])
             OR a.id IN (SELECT parent_id FROM agreements WHERE id = ANY($1::bigint[]) AND parent_id IS NOT NULL)
             OR a.id IN (SELECT c.agreement_id FROM conditions c
                          WHERE c.agreement_id IS NOT NULL
                            AND COALESCE(c.series_id, c.id) IN (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = ANY($2::bigint[])))
             OR a.agreement_no = ANY($3::text[]))`,
    [agreementIds, conditionIds, numbers]);
  for (const row of a.rows as Array<{ agreement_no: string; counterparty_ref_no: string }>) {
    map.set(String(row.agreement_no), String(row.counterparty_ref_no).trim());
  }
  const d = await q.query(
    `SELECT d.document_no, d.counterparty_doc_no
       FROM documents d
      WHERE d.counterparty_doc_no IS NOT NULL AND btrim(d.counterparty_doc_no) <> ''
        AND d.document_no IS NOT NULL AND d.status <> 'void'
        AND (d.document_no = ANY($2::text[])
             OR EXISTS (SELECT 1 FROM document_conditions dc
                         JOIN conditions x ON x.id = dc.condition_id
                        WHERE dc.document_id = d.id
                          AND COALESCE(x.series_id, x.id) IN (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = ANY($1::bigint[]))))`,
    [conditionIds, numbers]);
  for (const row of d.rows as Array<{ document_no: string; counterparty_doc_no: string }>) {
    const no = String(row.document_no);
    const theirs = String(row.counterparty_doc_no).trim();
    map.set(no, theirs);
    // 紙には本体の番号で出す（訂正版の枝番は社内の番号）。本体の番号でも引けるように。
    const base = baseDocumentNumber(no);
    if (base && !map.has(base)) map.set(base, theirs);
  }
  return map;
}

/** 1 つの番号を出し方に合わせる。表に無ければそのまま。 */
export function citeNo(mode: RefNoMode, nos: CounterpartyNos, ours: string | null | undefined): string | null {
  const o = String(ours ?? "").trim();
  if (!o) return null;
  if (mode === "ours") return o;
  return citeText(mode, o, nos.get(o) ?? nos.get(baseDocumentNumber(o)) ?? null);
}

/** 「A / B」「A・B」のように並べた番号を、区切りを保ったまま 1 つずつ出し方に合わせる。 */
export function citeJoined(mode: RefNoMode, nos: CounterpartyNos, text: string | null | undefined): string | null {
  const s = String(text ?? "").trim();
  if (!s || mode === "ours") return s || null;
  return s.split(/( \/ |・)/).map((part, i) => (i % 2 === 1 ? part : citeNo(mode, nos, part) ?? part)).join("");
}

/**
 * 組み上がった文脈の番号を、出し方に合わせて置き換える。
 *
 * 触るのは「紙に引用される番号」だけ：文脈の基本契約・契約（とその親）の番号、条件の
 * 単体契約の番号、関連文書（同じ条件から出た発注書など）の番号、人が選んだ発注書番号、
 * 計算書の契約番号。文書そのものの番号（documentNumber）は当社の番号なので触らない。
 */
/** 計算書の契約番号（基本 / 個別）を出し方に合わせる。 */
export function citeContractRef<T extends { number: string; masterNumber?: string }>(mode: RefNoMode, nos: CounterpartyNos, ref: T): T {
  if (mode === "ours" || !nos.size) return ref;
  return { ...ref, number: citeJoined(mode, nos, ref.number) ?? ref.number,
           ...(ref.masterNumber !== undefined ? { masterNumber: citeJoined(mode, nos, ref.masterNumber) ?? ref.masterNumber } : {}) };
}

export function applyRefNoMode(context: Record<string, any>, mode: RefNoMode, nos: CounterpartyNos): void {
  if (mode === "ours" || !nos.size) return;
  const fix = (obj: Record<string, any> | null | undefined, key: string) => {
    if (!obj || obj[key] === null || obj[key] === undefined) return;
    const next = citeNo(mode, nos, String(obj[key]));
    if (next) obj[key] = next;
  };
  fix(context.masterAgreement, "no");
  fix(context.agreement, "no");
  for (const c of (context.conditions ?? []) as Array<Record<string, any>>) {
    fix(c, "standaloneNo");
    fix(c.agreement, "no");
  }
  // 関連文書は本体の番号で出す（訂正版の枝番は社内の番号。baseDocumentNumber と同じ扱い）。
  for (const d of (context.related ?? []) as Array<Record<string, any>>) {
    if (d.documentNo) d.documentNo = citeNo(mode, nos, baseDocumentNumber(String(d.documentNo))) ?? d.documentNo;
  }
  fix(context, "parentPoNo");
  if (context.contractRefText) context.contractRefText = citeJoined(mode, nos, String(context.contractRefText));
  context.refNoMode = mode;
}
