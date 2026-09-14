-- =====================================================================
-- 106_rename_agreement_studio.sql（Cloud SQL Studio / psql 用）
--
--   合意（契約）の名前を変える。
--     制作業務委託基本契約 → 業務委託基本契約
--
--   名前は紙に出る。発注書の準拠契約の条項に
--     「業務委託基本契約（AGR-2025-0011）」
--   として差し込まれる。
--
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   これから作る文書から新しい名前で出る。
--
--   条件明細は合意の id で繋がっている（名前では繋いでいない）ので、
--   紐づきは動かない。作品や取引先の名寄せにも使っていない。
--
--   使い方（1つずつ、順に実行する）
--     【1】 報告。何も変えない。当たる合意を見る
--     【2】 変える。(false) を (true) に書き換えてから
--     【3】 確認
--     【4】 戻し方（控えておく）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
--
--   「そのまま一致」が変える対象。「含む」はそれ以外に似た名前が
--   無いかを見るためのもので、【2】では触らない。
-- ---------------------------------------------------------------------
SELECT a.id AS 合意id, a.agreement_no AS 契約番号, a.title AS いまの名前,
       p.name AS 取引先, a.direction AS 向き, a.status AS 状態,
       (a.title = '制作業務委託基本契約') AS そのまま一致,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id) AS ぶら下がる条件
  FROM v3.agreements a
  LEFT JOIN v3.parties p ON p.id = a.counterparty_id
 WHERE a.title LIKE '%制作業務委託基本契約%'
 ORDER BY (a.title = '制作業務委託基本契約') DESC, a.id;


-- ---------------------------------------------------------------------
-- 【2】変える。★ (false) を (true) に書き換えてから実行。
--
--   名前がそのまま「制作業務委託基本契約」の合意だけを変える。
--   「〇〇制作業務委託基本契約」のような別の名前には触らない
--   （【1】に出ていたら、変えるかどうかをこちらへ知らせてください）。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
done AS (
  UPDATE v3.agreements a
     SET title = '業務委託基本契約', updated_at = now()
    FROM go
   WHERE go.ok AND a.title = '制作業務委託基本契約'
  RETURNING a.id, a.agreement_no, a.title
)
SELECT d.agreement_no AS 契約番号, d.title AS 新しい名前
  FROM done d
UNION ALL
SELECT '0 件', '(false) を (true) に。既に変えてあるか、その名前の合意がありません'
 WHERE NOT EXISTS (SELECT 1 FROM done);


-- ---------------------------------------------------------------------
-- 【3】確認。古い名前が残っていないか。
-- ---------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM v3.agreements WHERE title = '制作業務委託基本契約') AS 古い名前,
  (SELECT count(*) FROM v3.agreements WHERE title = '業務委託基本契約')     AS 新しい名前,
  (SELECT count(*) FROM v3.agreements WHERE title LIKE '%制作業務委託基本契約%') AS 古い名前を含む;


-- ---------------------------------------------------------------------
-- 【4】戻し方。
--      UPDATE v3.agreements SET title = '制作業務委託基本契約'
--       WHERE agreement_no = '<【1】で控えた契約番号>';
-- ---------------------------------------------------------------------
SELECT a.agreement_no AS 契約番号, a.title AS いまの名前, a.updated_at AS 更新
  FROM v3.agreements a
 WHERE a.title IN ('業務委託基本契約', '制作業務委託基本契約')
 ORDER BY a.agreement_no;
