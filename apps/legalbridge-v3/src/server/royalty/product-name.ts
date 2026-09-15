/**
 * 計算書の「製品名」と件名の「原作名」。
 *
 * 計算書は原作（イン条件の作品）ごとに出す。件名は原作名で、明細の行は
 * 利用形態で製品名の出し方が変わる：
 *
 *   自社製造・自社販売 … 当社の作品名（原作から作った製品）
 *   再許諾            … アウト条件の条件名（製品名・サブライセンサー名などを
 *                       条件名に書く運用）
 *   自社製造・他社販売 … アウト条件の条件名（製品名・ディストリビューター名など）
 *
 * ここが SQL の COALESCE（アウト条件の作品名、無ければイン条件の作品名）だけ
 * だったので、再許諾の行に作品名が出て条件名が出ず、自社販売の行にはイン条件が
 * ぶら下がる原作名が出ていた。決め方を1か所に置き、計算書の試算と文書の
 * 行見出しの両方がこれを使う。
 */

export interface ProductNameSource {
  usageType: string | null | undefined;
  outConditionName?: string | null;
  outWorkTitle?: string | null;
  /** イン条件がぶら下がる作品（ふつう原作）。 */
  inWorkTitle?: string | null;
  inWorkKind?: string | null;
  /** その原作から作った当社の作品（系譜の子）。 */
  childTitles?: Array<string | null> | null;
}

const text = (v: unknown) => String(v ?? "").trim();
const titles = (v: Array<string | null> | null | undefined) =>
  [...new Set((v ?? []).map(text).filter(Boolean))];

/** 明細の行の製品名。 */
export function statementProductName(s: ProductNameSource): string {
  const usage = text(s.usageType);
  if (usage === "sublicense" || usage === "oem") {
    return text(s.outConditionName) || text(s.outWorkTitle) || text(s.inWorkTitle);
  }
  // 自社製造・自社販売（利用形態なしの旧データも同じ扱い）。
  if (text(s.outWorkTitle) || text(s.outConditionName)) {
    return text(s.outWorkTitle) || text(s.outConditionName);
  }
  // イン条件が原作にぶら下がっているなら、製品はその原作から作った当社作品。
  // 1つに決まるときだけ使う。複数あれば原作名のまま出し、行の見出しで人が選ぶ
  // （当てずっぽうで片方の作品名を紙に出さない）。
  const children = titles(s.childTitles);
  if (text(s.inWorkKind) === "source_ip" && children.length === 1) return children[0];
  return text(s.inWorkTitle);
}

/**
 * 件名の原作名。イン条件の作品が原作ならその名前、作品（当社製品）に
 * ぶら下がっているなら系譜の親の原作名。原作が無ければ作品名のまま。
 */
export function originalWorkTitle(s: {
  inWorkTitle?: string | null; inWorkKind?: string | null;
  sourceTitles?: Array<string | null> | null;
}): string {
  if (text(s.inWorkKind) === "source_ip") return text(s.inWorkTitle);
  const sources = titles(s.sourceTitles);
  return sources.length ? sources.join("・") : text(s.inWorkTitle);
}

/**
 * 原作の子作品の題名を引く SQL 片。`work` は原作側の作品の別名（c.work_id）。
 * 終了した作品は数えない（統合済み・終了済みが「2つある」に化けない）。
 */
export const CHILD_TITLES_SQL = (workIdExpr: string) =>
  `(SELECT array_agg(DISTINCT cw.title)
      FROM work_lineage l JOIN works cw ON cw.id = l.child_work_id
     WHERE l.parent_work_id = ${workIdExpr} AND cw.status <> 'archived')`;

/** 作品の親の原作の題名を引く SQL 片。 */
export const SOURCE_TITLES_SQL = (workIdExpr: string) =>
  `(SELECT array_agg(DISTINCT pw.title)
      FROM work_lineage l JOIN works pw ON pw.id = l.parent_work_id
     WHERE l.child_work_id = ${workIdExpr} AND pw.kind = 'source_ip' AND pw.status <> 'archived')`;
