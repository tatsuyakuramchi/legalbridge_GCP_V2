-- =====================================================================
-- 132_pub_terms_short_labels.sql（ops sql / Cloud SQL Studio 用）
--
--   出版等利用許諾条件書のひな形の名前を短くする（A-038）。
--
--   127 で 2 本立てにしたとき、選ぶときの手がかりを名前に入れた。
--     出版等利用許諾条件書（V3・一覧形式／作品が少ないとき）   27 文字
--     出版等利用許諾条件書（V3・別紙形式／作品が多いとき）     26 文字
--   ひな形の名前は文書の一覧の「種別」の列にも出る。案件の右欄のような
--   狭いところでは、この長さだと列が押し広げられ、取引先の名前が 1 文字ずつ
--   に潰れて表が枠からはみ出す。
--
--   「作品が少ないとき／多いとき」は選ぶときの手がかりなので、名前から外して
--   文書作成のひな形の選択欄の下に出す（画面側）。名前は形式だけ残す。
--     出版等利用許諾条件書（V3・一覧形式）
--     出版等利用許諾条件書（V3・別紙形式）
--   点数が偏っているときに「もう片方のほうが読みやすい」と出す注意書きは
--   前からこの短い名前で書いてあるので、画面と本文の呼び方も揃う。
--
--   何度流しても同じ結果。実行:
--     Cloud SQL Studio にそのまま貼る／ローカルは
--     docker compose run --rm ops sql /v3/132_pub_terms_short_labels.sql
--
--   戻すとき:
--     UPDATE v3.document_templates
--        SET label = '出版等利用許諾条件書（V3・一覧形式／作品が少ないとき）'
--      WHERE template_key = 'pub_license_terms_v3';
--     UPDATE v3.document_templates
--        SET label = '出版等利用許諾条件書（V3・別紙形式／作品が多いとき）'
--      WHERE template_key = 'pub_license_terms_v3_annex';
-- =====================================================================

\pset pager off

UPDATE v3.document_templates
   SET label = '出版等利用許諾条件書（V3・一覧形式）'
 WHERE template_key = 'pub_license_terms_v3'
   AND label <> '出版等利用許諾条件書（V3・一覧形式）';

UPDATE v3.document_templates
   SET label = '出版等利用許諾条件書（V3・別紙形式）'
 WHERE template_key = 'pub_license_terms_v3_annex'
   AND label <> '出版等利用許諾条件書（V3・別紙形式）';

-- 確認。2 本とも 19 文字（全角18＋…）になっていること。
SELECT template_key AS キー, label AS 名前, length(label) AS 文字数, is_active AS 有効
  FROM v3.document_templates
 WHERE template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex')
 ORDER BY template_key;
