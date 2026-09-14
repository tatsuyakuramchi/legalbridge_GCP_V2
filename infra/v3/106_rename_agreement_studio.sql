-- =====================================================================
-- 106_rename_agreement_studio.sql（Cloud SQL Studio / psql 用）
--
--   合意（契約）の名前を変える。
--
--   名前は紙に出る。発注書の準拠契約の条項に
--     「業務委託基本契約（ARC-OUT-2026-0006）」
--   として差し込まれる。題名を入れずに登録した合意は題名が契約番号
--   そのままになっているので、その場合は番号だけが出る。
--
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   これから作る文書から新しい名前で出る。
--   条件明細は合意の id で繋がっている（名前では繋いでいない）ので、
--   紐づきは動かない。作品や取引先の名寄せにも使っていない。
--
--   使い方（1つずつ、順に実行する）
--     【0】 いまの名前を探す
--     【1】 報告。★ 変える名前を書いてから。何も変えない
--     【2】 変える。(false) を (true) に書き換えてから
--     【3】 確認
--     【4】 戻し方（控えておく）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【0】いまの名前を探す。変えたい契約の「契約番号」と「いまの名前」を控える。
--      LIKE の中身を、探したい言葉に書き換えて実行する。
-- ---------------------------------------------------------------------
SELECT a.agreement_no AS 契約番号, a.title AS いまの名前,
       p.name AS 取引先, a.status AS 状態,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id) AS ぶら下がる条件
  FROM v3.agreements a
  LEFT JOIN v3.parties p ON p.id = a.counterparty_id
 WHERE a.title LIKE '%業務委託%'          -- ★ 探したい言葉に書き換える
 ORDER BY ぶら下がる条件 DESC, a.agreement_no
 LIMIT 50;


-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
--      ★ 下の2つを、変えたい名前に書き換えてから実行する。
--
--      対象は「名前がそのまま一致する合意」。似た名前には触らない。
-- ---------------------------------------------------------------------
WITH rename(before, after) AS (
  VALUES ('制作業務委託基本契約', '業務委託基本契約')   -- ★ (変える前, 変えたあと)
)
SELECT a.agreement_no AS 契約番号, a.title AS いまの名前, r.after AS 変えたあと,
       p.name AS 取引先, a.status AS 状態,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id) AS ぶら下がる条件
  FROM v3.agreements a
  LEFT JOIN v3.parties p ON p.id = a.counterparty_id
  CROSS JOIN rename r
 WHERE a.title = r.before
 ORDER BY a.agreement_no;


-- ---------------------------------------------------------------------
-- 【2】変える。★ (false) を (true) に、名前も【1】と同じものに書き換える。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),                          -- ★ ここを (true) に
rename(before, after) AS (
  VALUES ('制作業務委託基本契約', '業務委託基本契約')     -- ★ 【1】と同じものを書く
),
done AS (
  UPDATE v3.agreements a
     SET title = r.after, updated_at = now()
    FROM go, rename r
   WHERE go.ok AND a.title = r.before
  RETURNING a.agreement_no, a.title
)
SELECT d.agreement_no AS 契約番号, d.title AS 新しい名前
  FROM done d
UNION ALL
SELECT '0 件', '(false) を (true) に。既に変えてあるか、その名前の合意がありません'
 WHERE NOT EXISTS (SELECT 1 FROM done);


-- ---------------------------------------------------------------------
-- 【3】確認。★ 名前を【1】と同じものに書き換えて実行する。
-- ---------------------------------------------------------------------
WITH rename(before, after) AS (
  VALUES ('制作業務委託基本契約', '業務委託基本契約')     -- ★ 【1】と同じものを書く
)
SELECT (SELECT count(*) FROM v3.agreements WHERE title = r.before) AS 変える前の名前,
       (SELECT count(*) FROM v3.agreements WHERE title = r.after)  AS 変えたあとの名前
  FROM rename r;


-- ---------------------------------------------------------------------
-- 【4】戻し方。【1】で控えた契約番号に、元の名前を書き戻す。
--      UPDATE v3.agreements SET title = '<元の名前>'
--       WHERE agreement_no = '<契約番号>';
-- ---------------------------------------------------------------------
