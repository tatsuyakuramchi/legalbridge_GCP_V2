import type { Queryable } from "../core/db.js";

/**
 * 依頼者（事業部の担当者）のメールを当てる（A-064）。
 *
 * 受付箱の依頼は経路で持っているものが違う：メールの依頼はメール、Slack の依頼は
 * Slack の ID、手で登録した依頼は名前だけ。文書のメールの下書き（担当者への確認）の
 * 宛先はメールなので、受け付けるときに一度当てて依頼に残す（あとで直せる）。
 *
 *   依頼のメール → 社員（staff.slack_user_id が Slack の ID）→ 社員（名前が一致し 1 人に決まる）
 */
export async function resolveRequesterEmail(
  q: Queryable,
  row: { requester_email?: string | null; requester_slack_id?: string | null; requester_name?: string | null }
): Promise<string | null> {
  const own = String(row.requester_email ?? "").trim().toLowerCase();
  if (own) return own;
  const slack = String(row.requester_slack_id ?? "").trim();
  if (slack) {
    const r = await q.query(
      "SELECT email FROM staff WHERE slack_user_id = $1 AND email IS NOT NULL AND email <> '' LIMIT 1", [slack]);
    const email = (r.rows[0] as { email?: string } | undefined)?.email;
    if (email) return String(email).trim().toLowerCase();
  }
  const name = String(row.requester_name ?? "").replace(/\s+/g, "").trim();
  if (name) {
    // 「山田 太郎」「山田太郎」の揺れは空白を落として比べる。2 人以上に当たれば決めない。
    const r = await q.query(
      `SELECT email FROM staff
        WHERE email IS NOT NULL AND email <> '' AND status = 'active'
          AND replace(replace(name, ' ', ''), '　', '') = $1 LIMIT 2`, [name]);
    if (r.rows.length === 1) return String((r.rows[0] as { email: string }).email).trim().toLowerCase();
  }
  return null;
}
