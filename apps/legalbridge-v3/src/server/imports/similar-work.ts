import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";

/**
 * 作品名の表記ゆれ（全角・半角、空白、中黒・記号）だけが違う登録済みの作品を探す。
 * 新しく登録する取込で作品名が完全には当たらなかったとき、別の作品として二重に作らないために使う
 * （「クトゥルフ２０１０」と「クトゥルフ 2010」、「新クトゥルフ神話TRPG　ルールブック」と「…TRPG ルールブック」など）。
 */
const NORMALIZED = (col: string) =>
  `lower(regexp_replace(normalize(${col}, NFKC), '[\\s・･\\-－‐ー―:：!！?？()（）「」『』【】〈〉《》.,，、。/／~〜]', '', 'g'))`;

export async function similarWorkOf(q: Queryable, title: string): Promise<{ id: number; code: string | null; title: string } | null> {
  const r = await q.query(
    `SELECT id, work_code, title FROM works
      WHERE ${NORMALIZED("title")} = ${NORMALIZED("$1::text")} AND btrim(title) <> btrim($1)
      ORDER BY id LIMIT 1`, [title]);
  const w = r.rows[0] as { id: number; work_code: string | null; title: string } | undefined;
  return w ? { id: Number(w.id), code: w.work_code, title: String(w.title) } : null;
}

/** 表記ゆれの作品があれば止める（作品コードで指定するか、作品名を登録に合わせる）。 */
export async function refuseSimilarWork(q: Queryable, title: string): Promise<void> {
  const w = await similarWorkOf(q, title);
  if (w) {
    throw new DomainError("VALIDATION",
      `作品名「${title}」は登録済みの「${w.title}」（${w.code ?? `#${w.id}`}）と表記だけが違います。` +
      `同じ作品なら作品コード ${w.code ?? ""} を入れるか作品名を合わせてください（このままだと別の作品として二重に作られます）`);
  }
}
