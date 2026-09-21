-- =====================================================================
-- ある取引先の「条件 → 発注書 → 実績 → 検収書 → 支払」が
-- どこまで繋がっているかを見る（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   「紐づけができていない」のか「そもそも文書が無い」のかは、見る場所が
--   違う。前者は繋ぎ直せば済み、後者は紙を作るところから始まる。ここは
--   その2つを分けて出す。
--
--   ★ 使い方
--     下の \set の中を、探したい取引先の名前の一部に書き換えて流す。
--     取引先名・カナ・別名・代表者名・担当者名のどれに当たっても拾う。
--
--     予備系（ops）は、ファイルを書き換えずに外から渡せる。
--       docker compose run --rm ops sql /v3/diag/party-documents.sql q=名前の一部
--
--     Cloud SQL Studio は文を1つずつ別のセッションで流すことがあり、
--     \set も \if も効かない。そのときは先頭の \ で始まる行をすべて消し、
--     エディタの置換で :'q' を '名前の一部' のように（引用符ごと）
--     全部置き換えてから流す。
--
--   ★ 読む順番
--     1 で取引先を特定する。2〜3 で「何があるべきか」を見る。
--     4〜8 が実際の欠け。9 に、何をすればよいかを1行ずつ出す。
-- =====================================================================

\pset pager off

-- 探す語。外から渡されていればそれを使う（ops sql … q=名前）。
-- 渡されていなければ、下の既定を書き換えてから流す。
\if :{?q}
\else
\set q '取引先名の一部'
\endif

-- ---------------------------------------------------------------------
-- 0. 何を探したか。1 が 0 件のとき、ここを見れば理由が分かる
--
--    探した語が「取引先名の一部」のままなら、変数が渡っていない。
--    当たった取引先が 0 で総数が入っているなら、その名前がこの DB に無い
--    （予備系は同期した時点までの写しなので、同期後に登録した相手は無い）。
-- ---------------------------------------------------------------------
SELECT :'q'                                              AS 探した語,
       (SELECT count(*) FROM v3.parties p
         WHERE p.name ILIKE '%' || :'q' || '%'
            OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
            OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
            OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
            OR EXISTS (SELECT 1 FROM v3.party_contacts c
                        WHERE c.party_id = p.id
                          AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%'))  AS 当たった取引先,
       (SELECT count(*) FROM v3.parties)                 AS 取引先の総数,
       (SELECT count(*) FROM v3.party_contacts)          AS 担当者の総数;

-- ---------------------------------------------------------------------
-- 1. 取引先の候補。ここで id を確かめる（同名・旧名があることがある）
-- ---------------------------------------------------------------------
SELECT p.id                                              AS 取引先id,
       p.party_code                                      AS 取引先コード,
       p.name                                            AS 取引先名,
       CASE p.kind WHEN 'corporate' THEN '法人' WHEN 'individual' THEN '個人'
                   ELSE p.kind END                       AS 区分,
       p.status                                          AS 状態,
       p.merged_into_id                                  AS 統合先id,
       COALESCE(p.representative_name, '')               AS 代表者,
       (SELECT string_agg(DISTINCT COALESCE(c.name, ''), '／')
          FROM v3.party_contacts c WHERE c.party_id = p.id
           AND COALESCE(c.name, '') <> '')               AS 担当者,
       (SELECT count(*) FROM v3.matters m
         WHERE m.counterparty_id = p.id)                 AS 案件の数,
       (SELECT count(*) FROM v3.conditions x
         WHERE x.counterparty_id = p.id)                 AS 条件の数
  FROM v3.parties p
 WHERE p.name ILIKE '%' || :'q' || '%'
    OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
    OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
    OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
    OR EXISTS (SELECT 1 FROM v3.party_contacts c
                WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
 ORDER BY p.id;

-- ---------------------------------------------------------------------
-- 2. その取引先の案件
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
)
SELECT m.matter_no                                       AS 案件番号,
       m.title                                           AS 案件名,
       m.kind                                            AS 種類,
       m.status                                          AS 状態,
       m.merged_into_id                                  AS 統合先id,
       (SELECT count(*) FROM v3.matter_links l
         WHERE l.matter_id = m.id AND l.target_type = 'condition')  AS 条件の数,
       (SELECT count(*) FROM v3.documents d
         WHERE d.matter_id = m.id)                       AS 文書の数
  FROM v3.matters m
 WHERE m.counterparty_id IN (SELECT id FROM target)
    OR EXISTS (SELECT 1 FROM v3.matter_links l
                JOIN v3.conditions c ON c.id::text = l.target_ref
               WHERE l.matter_id = m.id AND l.target_type = 'condition'
                 AND c.counterparty_id IN (SELECT id FROM target))
 ORDER BY m.matter_no;

-- ---------------------------------------------------------------------
-- 3. 条件ごとの棚卸し。ここが本体
--
--    発注書  … その条件に繋がっている発注書（document_conditions）
--    決済文書… 検収書・計算書。条件に繋がっているもの
--    実績    … その条件に付いている実績（有効なもの）
--    結ばれた… そのうち決済文書に結ばれている実績（condition_events.document_id）
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
),
doc AS (
  SELECT dc.condition_id, d.id, d.document_no, d.status, t.template_key
    FROM v3.document_conditions dc
    JOIN v3.documents d ON d.id = dc.document_id
    LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN v3.document_templates t ON t.id = tv.template_id
   WHERE d.status <> 'void'
)
SELECT c.condition_no                                    AS 条件番号,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       c.pricing_model                                   AS 計算方式,
       COALESCE(c.flat_amount, c.unit_amount)            AS 金額,
       (SELECT count(*) FROM v3.condition_schedules s
         WHERE s.condition_id = c.id)                    AS 予定明細,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active')          AS 実績,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active'
           AND e.document_id IS NOT NULL)                              AS 結ばれた実績,
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id
           AND x.template_key IN ('purchase_order', 'intl_purchase_order'))  AS 発注書,
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id
           AND x.template_key IN ('inspection_certificate', 'royalty_statement'))  AS 決済文書,
       -- ひな形の版が付いていない文書（V2 から来て版が繋がらなかったもの）。
       -- 発注書か検収書かが機械には分からないので、別の欄に出す。
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id
           AND x.template_key IS NULL)                   AS 種別不明の文書,
       (SELECT count(*) FROM v3.payment_allocations al
         WHERE al.condition_id = c.id)                   AS 支払の割当
  FROM v3.conditions c
 WHERE c.counterparty_id IN (SELECT id FROM target)
 ORDER BY c.condition_no;

-- ---------------------------------------------------------------------
-- 4. その取引先まわりの文書。条件に繋がっているか、実績が結ばれているか
--
--    「繋がっている条件」が 0 の文書は、紙はあるのに台帳と繋がっていない。
--    画面の つながり → 条件明細 →「繋ぐ」で繋ぐ。
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
),
mine AS (
  -- その取引先の案件。取引先が案件に直に付いていないこともある（V2 から来た
  -- 案件は counterparty_id が空のことがある）ので、条件からも辿る。
  SELECT m.id FROM v3.matters m
   WHERE m.counterparty_id IN (SELECT id FROM target)
      OR EXISTS (SELECT 1 FROM v3.matter_links l
                  JOIN v3.conditions c ON c.id::text = l.target_ref
                 WHERE l.matter_id = m.id AND l.target_type = 'condition'
                   AND c.counterparty_id IN (SELECT id FROM target))
)
SELECT d.document_no                                     AS 文書番号,
       COALESCE(t.template_key, '（版が無い）')          AS ひな形,
       d.status                                          AS 状態,
       d.issued_at::date                                 AS 発行日,
       m.matter_no                                       AS 案件番号,
       (SELECT count(*) FROM v3.document_conditions dc
         WHERE dc.document_id = d.id)                    AS 繋がっている条件,
       (SELECT string_agg(c.condition_no, '／' ORDER BY c.condition_no)
          FROM v3.document_conditions dc
          JOIN v3.conditions c ON c.id = dc.condition_id
         WHERE dc.document_id = d.id)                    AS 繋がり先,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.document_id = d.id AND e.status = 'active')           AS 結ばれた実績,
       CASE WHEN d.supersedes_id IS NOT NULL THEN '訂正版' ELSE '' END AS 版
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.matters m ON m.id = d.matter_id
 WHERE d.matter_id IN (SELECT id FROM mine)
    OR EXISTS (SELECT 1 FROM v3.document_conditions dc
                JOIN v3.conditions c ON c.id = dc.condition_id
               WHERE dc.document_id = d.id AND c.counterparty_id IN (SELECT id FROM target))
    OR EXISTS (SELECT 1 FROM v3.condition_events e
                JOIN v3.conditions c ON c.id = e.condition_id
               WHERE e.document_id = d.id AND c.counterparty_id IN (SELECT id FROM target))
 ORDER BY COALESCE(t.template_key, 'zz'), d.document_no;

-- ---------------------------------------------------------------------
-- 5. 条件はあるのに発注書が無い（＝紙を作るところから）
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
)
SELECT c.condition_no                                    AS 条件番号,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       COALESCE(c.flat_amount, c.unit_amount)            AS 金額,
       c.term_start                                      AS 開始日,
       c.order_no                                        AS 外部の発注番号
  FROM v3.conditions c
 WHERE c.counterparty_id IN (SELECT id FROM target)
   AND c.status = 'active'
   AND NOT EXISTS (
         SELECT 1 FROM v3.document_conditions dc
           JOIN v3.documents d ON d.id = dc.document_id
           LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN v3.document_templates t ON t.id = tv.template_id
          WHERE dc.condition_id = c.id AND d.status <> 'void'
            AND t.template_key IN ('purchase_order', 'intl_purchase_order'))
 ORDER BY c.condition_no;

-- ---------------------------------------------------------------------
-- 6. 実績はあるのに決済文書（検収書・計算書）が無い／結ばれていない
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
)
SELECT c.condition_no                                    AS 条件番号,
       c.name                                            AS 条件名,
       e.id                                              AS 実績id,
       e.occurred_on                                     AS 納品日,
       e.inspected_on                                    AS 検収日,
       e.quantity                                        AS 数量,
       e.amount                                          AS 金額,
       '結ぶ先の決済文書が無い'                          AS 状態
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE c.counterparty_id IN (SELECT id FROM target)
   AND e.status = 'active'
   AND e.document_id IS NULL
 ORDER BY c.condition_no, e.occurred_on;

-- ---------------------------------------------------------------------
-- 7. 紙はあるのに条件に繋がっていない文書（棚卸しの「浮いた文書」と同じ形）
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
),
mine AS (
  -- その取引先の案件。取引先が案件に直に付いていないこともある（V2 から来た
  -- 案件は counterparty_id が空のことがある）ので、条件からも辿る。
  SELECT m.id FROM v3.matters m
   WHERE m.counterparty_id IN (SELECT id FROM target)
      OR EXISTS (SELECT 1 FROM v3.matter_links l
                  JOIN v3.conditions c ON c.id::text = l.target_ref
                 WHERE l.matter_id = m.id AND l.target_type = 'condition'
                   AND c.counterparty_id IN (SELECT id FROM target))
)
SELECT d.document_no                                     AS 文書番号,
       t.template_key                                    AS ひな形,
       d.status                                          AS 状態,
       d.issued_at::date                                 AS 発行日,
       m.matter_no                                       AS 案件番号,
       jsonb_array_length(COALESCE(
         NULLIF(d.rendered_values -> 'items', 'null'::jsonb),
         NULLIF(d.rendered_values -> 'delivery_line_items', 'null'::jsonb),
         '[]'::jsonb))                                   AS 紙の明細行,
       CASE WHEN d.legacy_id IS NOT NULL THEN 'V2から移行' ELSE 'V3で作った' END AS 出どころ
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.matters m ON m.id = d.matter_id
 WHERE d.status <> 'void'
   AND NOT EXISTS (SELECT 1 FROM v3.document_conditions dc WHERE dc.document_id = d.id)
   AND (d.matter_id IN (SELECT id FROM mine)
        OR EXISTS (SELECT 1 FROM v3.condition_events e
                    JOIN v3.conditions c ON c.id = e.condition_id
                   WHERE e.document_id = d.id AND c.counterparty_id IN (SELECT id FROM target)))
 ORDER BY d.document_no;

-- ---------------------------------------------------------------------
-- 8. 支払。条件に割り当てが付いているか
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
)
SELECT y.payment_no                                      AS 支払番号,
       y.status                                          AS 状態,
       y.amount                                          AS 金額,
       y.due_on                                          AS 期日,
       y.paid_on                                         AS 入金日,
       (SELECT count(*) FROM v3.payment_allocations al
         WHERE al.payment_id = y.id)                     AS 割当の数,
       (SELECT string_agg(DISTINCT c.condition_no, '／')
          FROM v3.payment_allocations al
          JOIN v3.conditions c ON c.id = al.condition_id
         WHERE al.payment_id = y.id)                     AS 割当先の条件
  FROM v3.payments y
 WHERE y.party_id IN (SELECT id FROM target)
 ORDER BY y.payment_no NULLS FIRST, y.id;

-- ---------------------------------------------------------------------
-- 9. 仕分け。条件1本ごとに、次に何をすればよいか
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT p.id FROM v3.parties p
   WHERE p.name ILIKE '%' || :'q' || '%'
      OR COALESCE(p.name_kana, '') ILIKE '%' || :'q' || '%'
      OR COALESCE(p.representative_name, '') ILIKE '%' || :'q' || '%'
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || :'q' || '%')
      OR EXISTS (SELECT 1 FROM v3.party_contacts c
                  WHERE c.party_id = p.id AND COALESCE(c.name, '') ILIKE '%' || :'q' || '%')
),
state AS (
  SELECT c.id, c.condition_no, c.name, c.status,
         (SELECT count(*) FROM v3.condition_events e
           WHERE e.condition_id = c.id AND e.status = 'active')                AS events,
         (SELECT count(*) FROM v3.condition_events e
           WHERE e.condition_id = c.id AND e.status = 'active'
             AND e.document_id IS NOT NULL)                                    AS tied,
         (SELECT count(*) FROM v3.document_conditions dc
            JOIN v3.documents d ON d.id = dc.document_id
            LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
            LEFT JOIN v3.document_templates t ON t.id = tv.template_id
           WHERE dc.condition_id = c.id AND d.status <> 'void'
             AND t.template_key IN ('purchase_order', 'intl_purchase_order'))  AS orders,
         (SELECT count(*) FROM v3.document_conditions dc
            JOIN v3.documents d ON d.id = dc.document_id
            LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
            LEFT JOIN v3.document_templates t ON t.id = tv.template_id
           WHERE dc.condition_id = c.id AND d.status <> 'void'
             AND t.template_key IN ('inspection_certificate', 'royalty_statement')) AS settles,
         -- ひな形の版が付いていない文書。発注書とも決済文書とも数えられない
         -- ので、別に数える。これを見ないと「文書が無い」と読み違える。
         (SELECT count(*) FROM v3.document_conditions dc
            JOIN v3.documents d ON d.id = dc.document_id
            LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
           WHERE dc.condition_id = c.id AND d.status <> 'void'
             AND tv.id IS NULL)                                                AS unknown_docs,
         (SELECT count(*) FROM v3.payment_allocations al
           WHERE al.condition_id = c.id)                                       AS allocs
    FROM v3.conditions c
   WHERE c.counterparty_id IN (SELECT id FROM target) AND c.status = 'active'
)
SELECT condition_no                                      AS 条件番号,
       name                                              AS 条件名,
       orders                                            AS 発注書,
       events                                            AS 実績,
       tied                                              AS 結ばれた実績,
       settles                                           AS 決済文書,
       unknown_docs                                      AS 種別不明の文書,
       allocs                                            AS 支払の割当,
       CASE
         -- 版の無い文書が付いているときは、発注書か検収書かが機械には
         -- 分からない。数が 0 だからといって「無い」と言ってはいけない。
         WHEN orders = 0 AND settles = 0 AND unknown_docs > 0
           THEN 'H ひな形の版が無い文書が付いている。中身を確かめる（document-detail.sql）'
         WHEN orders = 0 AND events = 0 THEN 'A 発注書を作る（実績もまだ）'
         WHEN orders = 0 AND events > 0 THEN 'B 実績はある。発注書が無い（遡及で作るか、検収書だけで通すか）'
         WHEN events = 0 THEN 'C 発注書はある。実績を足す'
         WHEN settles = 0 THEN 'D 実績はある。検収書を作る'
         WHEN tied < events THEN 'E 検収書はある。実績を結ぶ（文書 → 対象の実績 → 結ぶものを選ぶ）'
         WHEN allocs = 0 THEN 'F 検収書まで繋がった。支払を立てる'
         ELSE 'G 繋がっている'
       END                                               AS 次にすること
  FROM state
 ORDER BY condition_no;
