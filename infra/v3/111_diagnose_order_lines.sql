-- =====================================================================
-- 発注書の明細が空になる条件を見る（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   発注書の明細は、条件明細から組む。組み方は2通り。
--     ・予定明細（回）があれば、その回ごとに1行
--     ・無ければ、条件そのものを1行
--   後者は「定額（flat_amount）がある条件」だけを拾っていた。定期課金・
--   料率型・単価型の条件は定額を持たないので1行も出ず、品目名も仕様も空の
--   発注書になっていた。いまは選んだ条件を必ず1行にする。
--
--   この照会は「その行にいくら出るか」を見るためのもの。金額が 0 で出る
--   条件は、定額も単価も予定明細も入っていない。紙に品目名は出るが、
--   合計金額は人が入れることになる。
--
--   ★ 下の condition_no を、見たい条件の番号に書き換えて流す。
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 1. その条件が、明細の行になる条件を満たしているか
-- ---------------------------------------------------------------------
SELECT c.condition_no                                   AS 条件番号,
       c.name                                           AS 条件名,
       c.direction                                      AS 向き,
       c.pricing_model                                  AS 計算方式,
       c.flat_amount                                    AS 定額,
       c.unit_amount                                    AS 単価,
       c.quantity                                       AS 個数,
       c.rate_ppm                                       AS 料率ppm,
       c.deliverable_ownership                          AS 成果物の帰属,
       (SELECT count(*) FROM v3.condition_schedules s
         WHERE s.condition_id = c.id)                   AS 予定明細の数,
       CASE
         WHEN (SELECT count(*) FROM v3.condition_schedules s
                WHERE s.condition_id = c.id) > 0
           THEN '予定明細から組む（回ごとに1行）'
         WHEN COALESCE(c.flat_amount, 0) <> 0
           THEN '条件から1行。金額 = 定額'
         WHEN COALESCE(c.unit_amount, 0) <> 0
           THEN '条件から1行。金額 = 単価 × 個数'
         ELSE '★ 条件から1行。金額 0（人が入れる）'
       END                                              AS 明細の出方
  FROM v3.conditions c
 WHERE c.condition_no = 'CL-0000-00000';   -- ★ ここを書き換える

-- ---------------------------------------------------------------------
-- 2. 金額の入っていない条件を、まとめて探す
--
--    定額も単価も予定明細も無い。品目名は紙に出るが、合計金額は人が入れる
--    ことになる。数が多ければ、条件の登録のしかたを見直す材料になる。
-- ---------------------------------------------------------------------
SELECT c.condition_no AS 条件番号, c.name AS 条件名,
       c.pricing_model AS 計算方式, c.status AS 状態,
       p.name AS 取引先
  FROM v3.conditions c
  LEFT JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE c.direction = 'in'
   AND c.status IN ('active', 'draft')
   AND COALESCE(c.flat_amount, 0) = 0
   AND COALESCE(c.unit_amount, 0) = 0
   AND NOT EXISTS (SELECT 1 FROM v3.condition_schedules s WHERE s.condition_id = c.id)
 ORDER BY c.condition_no
 LIMIT 50;
