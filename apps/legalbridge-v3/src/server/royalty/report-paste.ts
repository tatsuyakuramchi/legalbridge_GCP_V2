/**
 * 計算書の依頼文から報告の行を読む（純粋関数。画面とテストで使う）。
 *
 * 事業部からは、製造 1 回ぶんの売上がこういう形で来る：
 *
 *   デザイナーロイヤリティ：10％
 *   1
 *   版・言語：英語版
 *   入金企業：Asmodee
 *   前金：¥3,739,365
 *   後金：¥3,564,512
 *   2
 *   版・言語：中国語簡体字版
 *   …
 *
 * 1 行＝版・言語 × 入金企業。前金・後金はそれぞれ 1 件の報告（入金区分つき）になる。
 * 読めなかったところは空のまま返し、画面で人が直す。
 */

export interface PastedRow {
  /** 依頼文の通し番号（無ければ順番）。 */
  no: number;
  /** 版・言語（「版」は落とす）。例：英語、中国語簡体字 */
  language: string;
  /** 入金企業。 */
  company: string;
  /** 前金・後金。円。無ければ null。区分の無い「金額：」は advance に入れず total に。 */
  advance: number | null;
  balance: number | null;
  total: number | null;
}

export interface PastedReport {
  /** 依頼文の料率（％）。条件の料率と食い違えば画面で知らせる。 */
  ratePct: number | null;
  title: string | null;
  rows: PastedRow[];
}

const toHalf = (s: string) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/　/g, " ");

/** 「¥3,739,365」「3739365円」→ 3739365。読めなければ null。 */
export function readYen(value: string): number | null {
  const t = toHalf(value).replace(/[¥￥,\s円]/g, "").replace(/^JPY/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t));
}

/** 「キー：値」を読む。全角・半角のコロンどちらも。 */
function keyValue(line: string): [string, string] | null {
  const m = line.match(/^\s*([^：:]+?)\s*[：:]\s*(.*)$/);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

export function parseReportPaste(text: string): PastedReport {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => toHalf(l).trim()).filter(Boolean);
  const out: PastedReport = { ratePct: null, title: null, rows: [] };
  // 閉包の中で書き換えるので箱に入れる（TS の絞り込みが効かないため）。
  const box: { cur: PastedRow | null } = { cur: null };
  const flush = () => {
    if (box.cur && (box.cur.language || box.cur.company || box.cur.advance !== null || box.cur.balance !== null || box.cur.total !== null)) {
      out.rows.push(box.cur);
    }
    box.cur = null;
  };
  const start = (no?: number) => { flush(); box.cur = { no: no ?? out.rows.length + 1, language: "", company: "", advance: null, balance: null, total: null }; };

  for (const line of lines) {
    // 通し番号だけの行（「1」「2.」「(3)」）で次の行に移る。
    const num = line.match(/^[(（]?(\d{1,3})[)）.．]?$/);
    if (num) { start(Number(num[1])); continue; }
    const kv = keyValue(line);
    if (!kv) { if (!out.title && !box.cur) out.title = line; continue; }
    const [k, v] = kv;
    if (/ロイヤリティ|料率|印税率/.test(k) && !box.cur) {
      const r = v.match(/(\d+(?:\.\d+)?)\s*%/) ?? v.match(/^(\d+(?:\.\d+)?)$/);
      if (r) out.ratePct = Number(r[1]);
      continue;
    }
    if (/版|言語/.test(k)) {
      // 番号が無くても、版・言語が来たら新しい行。
      if (!box.cur || box.cur.language) start();
      box.cur!.language = v.replace(/版$/, "").trim();
      continue;
    }
    if (/入金企業|入金元|支払企業|会社|企業|許諾先/.test(k)) {
      if (!box.cur || box.cur.company) start();
      box.cur!.company = v;
      continue;
    }
    if (/前金|前払|アドバンス|advance/i.test(k)) { if (!box.cur) start(); box.cur!.advance = readYen(v); continue; }
    if (/後金|後払|残金|balance/i.test(k)) { if (!box.cur) start(); box.cur!.balance = readYen(v); continue; }
    if (/金額|入金額|受領額|売上/.test(k) && box.cur) { box.cur.total = readYen(v); continue; }
  }
  flush();
  return out;
}

/** 言語名をそろえる（版・字を落とす、繫→繁）。 */
const normLang = (s: string) => toHalf(s).replace(/\s/g, "").replace(/版$/, "").replace(/繫/g, "繁").replace(/字/g, "");

/**
 * 依頼文の言語を、許諾先の許諾言語から当てる。「中国語簡体字」→「簡体中国語」など。
 * 当たらなければ null。
 */
export function matchLanguage(language: string, candidates: string[]): string | null {
  const n = normLang(language);
  if (!n) return null;
  let best: { c: string; score: number } | null = null;
  for (const c of candidates) {
    const m = normLang(c);
    const score = m === n ? 3
      : (n.includes("簡体") && m.includes("簡体")) || (n.includes("繁体") && m.includes("繁体")) ? 2
      : (!/簡体|繁体/.test(n) && !/簡体|繁体/.test(m) && (m.includes(n) || n.includes(m))) ? 1 : 0;
    if (score && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

/** 会社名をそろえる（大文字小文字・記号・法人格を落とす）。 */
export const normCompany = (s: string) => toHalf(String(s ?? "")).toLowerCase()
  .replace(/[’'`´]/g, "'")
  .replace(/株式会社|有限会社|\(株\)|co\.?,?\s*ltd\.?|inc\.?|llc|gmbh|s\.?r\.?l\.?|limited|ltd\.?/g, "")
  .replace(/[\s.,'"・\-_/()]/g, "");

/** 会社名が許諾先（取引先名・条件名）に当たるか。 */
export function companyMatches(company: string, partyName: string | null, conditionName: string): boolean {
  const c = normCompany(company);
  if (!c) return false;
  const p = normCompany(partyName ?? "");
  if (p && (p.includes(c) || c.includes(p))) return true;
  return normCompany(conditionName).includes(c);
}

/**
 * 依頼文の 1 行に合う許諾先を選ぶ。会社が当たり、言語も許諾に入っているものを優先。
 * 会社だけ当たれば言語は null で返す（許諾外の言語なら人が直す）。
 */
export function pickOut<T extends { id: number; name: string; partyName: string | null; languages: string[] }>(
  row: { company: string; language: string }, outs: T[]
): { out: T; language: string | null } | null {
  const byCompany = outs.filter((o) => companyMatches(row.company, o.partyName, o.name));
  for (const o of byCompany) {
    if (!o.languages.length || o.languages.includes("全言語")) return { out: o, language: row.language ? normLang(row.language) : null };
    const lang = matchLanguage(row.language, o.languages);
    if (lang) return { out: o, language: lang };
  }
  return byCompany[0] ? { out: byCompany[0], language: null } : null;
}
