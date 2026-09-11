-- =====================================================================
-- 検収書の【ご連絡先】が空欄になる理由を、文書から辿って特定する
--
--   本文の {{inspectorDept}} / {{inspectorName}} / {{inspectorEmail}} は
--   3つとも「案件の担当者（matters.owner_staff_id → staff）」から引く。
--   ひな形の variables には宣言が無いので、フォームに入力欄も出ない。
--   つまり空欄の原因は次のどれか:
--
--     (a) 案件が繋がっていない        → 3つとも空
--     (b) 案件に担当者が設定されていない → 3つとも空
--     (c) 担当者の email が空          → メールだけ空
--
--   アプリは空白だけの文字列も「空」として扱う（str() が btrim して判定）。
--   email IS NULL だけで探すと '' や ' ' を取りこぼすので、ここでは
--   NULLIF(btrim(...), '') で見る。退職者も除外しない（退職者が案件の
--   担当のままなら、その名前が書類に出る）。
--
--   読むだけ。何も書き換えない。Cloud SQL Studio にそのまま貼れる。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 特定の文書について調べる。文書番号を書き換えて実行する。
-- ---------------------------------------------------------------------
SELECT
  d.document_no                                   AS 文書番号,
  COALESCE(m.matter_no, '(案件なし)')             AS 案件,
  COALESCE(s.name, '(担当者なし)')                AS 担当者,
  COALESCE(s.status, '—')                         AS 在籍,
  COALESCE(NULLIF(btrim(s.department), ''), '(空)') AS 部署,
  COALESCE(NULLIF(btrim(s.email), ''), '(空)')      AS メール,
  CASE
    WHEN d.matter_id IS NULL              THEN '案件が繋がっていない → 3つとも空になる'
    WHEN m.owner_staff_id IS NULL         THEN '案件に担当者が未設定 → 3つとも空になる'
    WHEN NULLIF(btrim(s.email), '') IS NULL
      THEN '担当者のメールが空 → 取引先・担当＞担当者 で ' || s.name || ' に入れる'
    ELSE 'メールは入っている。発行済みなら発行時の値が焼き付いているので、'
         || '訂正版を出すと反映される'
  END                                             AS 判定
  FROM v3.documents d
  LEFT JOIN v3.matters m ON m.id = d.matter_id
  LEFT JOIN v3.staff   s ON s.id = m.owner_staff_id
 WHERE d.document_no = 'ARC-INS-2026-1001';   -- ← 調べたい文書番号

-- ---------------------------------------------------------------------
-- 2. メールが空の担当者を全部出す（空白だけの文字列も拾う・退職者も含む）。
--    「何件直せばいいか」はこれで分かる。
-- ---------------------------------------------------------------------
SELECT s.id, s.staff_code AS コード, s.name AS 氏名,
       s.status AS 在籍,
       COALESCE(NULLIF(btrim(s.department), ''), '(空)') AS 部署,
       CASE WHEN s.email IS NULL THEN 'NULL'
            WHEN btrim(s.email) = '' THEN '空白だけ'
            ELSE s.email END AS メールの状態,
       (SELECT count(*) FROM v3.matters m WHERE m.owner_staff_id = s.id) AS 担当案件数
  FROM v3.staff s
 WHERE NULLIF(btrim(s.email), '') IS NULL
 ORDER BY 担当案件数 DESC, s.name;

-- ---------------------------------------------------------------------
-- 3. 担当者が未設定の案件。ここが空だと書類の【ご連絡先】が丸ごと空になる。
-- ---------------------------------------------------------------------
SELECT m.matter_no AS 案件, m.title AS 件名, m.status AS 状態,
       (SELECT count(*) FROM v3.documents d WHERE d.matter_id = m.id) AS 文書数
  FROM v3.matters m
 WHERE m.owner_staff_id IS NULL
   AND EXISTS (SELECT 1 FROM v3.documents d WHERE d.matter_id = m.id)
 ORDER BY 文書数 DESC, m.matter_no;
