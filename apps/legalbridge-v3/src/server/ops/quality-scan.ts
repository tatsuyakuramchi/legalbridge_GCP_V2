import type { Queryable } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * データ品質の点検。移行や運用で入った不整合を、毎日の仕事で拾い直す。
 *
 * 上げるのは「人が見て直すかどうかを決めるもの」で、機械が断定できるものでは
 * ない。だから見つけた根拠を detail に残し、直ったら自分で閉じる。
 */

export const WORK_PART_MISFILED = "WORK_PART_MISFILED";

/**
 * 素材が別の作品の下にある。
 *
 * 移行で、派生作品の素材が親作品のパートとして入っていた（作品「ito」の下に
 * NewIto_イラスト・itoレインボー_イラスト・New ito 原作ゲームデザイン）。
 * 作品の権利包絡はパートの取得条件の積で決まるので、よその素材が混ざると
 * 上限そのものが狂う。
 *
 * **「条件の作品とパートの作品が違う」では拾えない。** それは正常な形でもある。
 * 派生作品が原作のコアロジックの許諾を受けているとき、条件は派生作品のもので、
 * 指している素材は原作のもの——この参照こそが「どの原作を使っているか」を
 * 表している（本番で25件。ito クラシックが ito のコアロジックを使う、など）。
 *
 * 拾えるのは名前のほう。「NewIto_イラスト」が作品「ito」の下にあれば、素材の
 * 名前が別の作品を名乗っている。判定は名前頼りなので確定ではなく、人が見て
 * 決める材料として上げる。
 *
 *   ・空白・アンダースコア・ハイフンを落として比べる（NewIto と New ito）
 *   ・パート名が自分の作品名と同じものは除く（作品を1パートで表しただけ）
 *   ・いま置かれている作品名に含まれる作品名は当てない
 *     作品「ito クラシック」の下の「ito クラシック_イラスト」に「ito」が
 *     一致してしまうのを防ぐ。名乗っているのは親のほうで、置き場所は正しい
 */
const SUSPECT_SQL = `
  WITH norm AS (
    SELECT p.id, p.work_id, p.name, p.part_type,
           lower(translate(p.name, ' 　_-', '')) AS n_part,
           w.work_code, w.title AS work_title,
           lower(translate(w.title, ' 　_-', '')) AS n_work
      FROM work_parts p JOIN works w ON w.id = p.work_id
  )
  SELECT n.id, n.name, n.part_type, n.work_code, n.work_title,
         cand.work_code AS belongs_code, cand.title AS belongs_title,
         (SELECT count(*) FROM conditions c WHERE c.work_part_id = n.id) AS condition_count,
         (SELECT string_agg(DISTINCT cw.work_code, '・')
            FROM conditions c JOIN works cw ON cw.id = c.work_id
           WHERE c.work_part_id = n.id) AS used_by
    FROM norm n
    CROSS JOIN LATERAL (
      SELECT x.work_code, x.title
        FROM works x
       WHERE x.id <> n.work_id
         AND position(lower(translate(x.title, ' 　_-', '')) in n.n_part) > 0
         AND position(lower(translate(x.title, ' 　_-', '')) in n.n_work) = 0
       ORDER BY length(x.title) DESC
       LIMIT 1
    ) cand
   WHERE n.n_part <> n.n_work`;

export interface QualityScanResult { opened: number; resolved: number }

export async function scanWorkParts(client: Queryable): Promise<QualityScanResult> {
  try {
    const found = await client.query(SUSPECT_SQL);
    const rows = found.rows as Array<Record<string, any>>;

    for (const row of rows) {
      await client.query(
        `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
         VALUES ($1, 'work_part', $2, 'medium', $3::jsonb)
         ON CONFLICT (rule_code, target_type, target_id) DO UPDATE
           SET detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
        [WORK_PART_MISFILED, Number(row.id), JSON.stringify({
          part: String(row.name ?? ""),
          partType: row.part_type ?? null,
          filedUnder: `${row.work_code ?? ""} ${row.work_title ?? ""}`.trim(),
          looksLike: `${row.belongs_code ?? ""} ${row.belongs_title ?? ""}`.trim(),
          conditions: Number(row.condition_count ?? 0),
          usedBy: row.used_by ?? null
        })]);
    }

    // 直った（移した）ものは自分で閉じる。人が一覧から消す手間を残さない。
    const ids = rows.map((row) => Number(row.id));
    const closed = await client.query(
      `UPDATE data_quality_issues
          SET status = 'resolved', resolved_at = now()
        WHERE rule_code = $1 AND target_type = 'work_part' AND status = 'open'
          AND NOT (target_id = ANY($2::bigint[]))
        RETURNING id`,
      [WORK_PART_MISFILED, ids]);

    return { opened: rows.length, resolved: closed.rowCount ?? 0 };
  } catch (error) { throw translate(error); }
}
