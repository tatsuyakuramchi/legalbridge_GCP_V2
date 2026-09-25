-- =====================================================================
-- ひな形の項目から、人ごとに変わる欄の「既定値」を外す
--
--   136 で見たとおり、V2 から来たひな形は 担当者名・通知先・署名者 のような
--   欄に実在の人名などを既定値として持っていた。手入力も自動の値も無いと
--   その既定値が紙に刷られる。まとめて決定する経路（CSV の取込）では人が
--   欄を見ないので、そのまま相手に出る。
--
--   やり方は 120 と同じ。現行版の variables から該当する項目の default だけを
--   落とし、新しい版を作って current_version_id を差し替える。本文は変えない。
--   外す欄が無ければ何もしない。何度流しても同じ。
--
--   対象: is_active なひな形すべて。項目名か見出しに
--         contact / signer / rep / 担当 / 通知 / 署名 / 代表 / 氏名 / 部署 /
--         mail / メール / 電話 / phone / 様
--         を含む項目。
--
--   実行: docker compose run --rm ops sql /v3/137_strip_person_defaults.sql
--         （本番は Cloud SQL Studio に貼る）
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = '<ひな形>';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は焼き付いた値のまま。直すなら訂正版を出す。
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  tpl record;
  cleaned jsonb;
  removed int;
  next_no int;
  new_id bigint;
  pattern constant text := '(contact|signer|rep|担当|通知|署名|代表|氏名|部署|mail|メール|電話|phone|様)';
BEGIN
  FOR tpl IN
    SELECT t.id AS tpl_id, t.template_key, v.id AS version_id, v.version_no, v.html_source, v.variables
      FROM v3.document_templates t
      JOIN v3.document_template_versions v ON v.id = t.current_version_id
     WHERE t.is_active
  LOOP
    SELECT count(*) INTO removed
      FROM jsonb_array_elements(COALESCE(tpl.variables, '[]'::jsonb)) AS x(item)
     WHERE COALESCE(btrim(x.item ->> 'default'), '') <> ''
       AND ((x.item ->> 'name') || ' ' || COALESCE(x.item ->> 'label', '')) ~* pattern;
    IF removed = 0 THEN
      CONTINUE;
    END IF;

    SELECT jsonb_agg(
             CASE WHEN COALESCE(btrim(x.item ->> 'default'), '') <> ''
                   AND ((x.item ->> 'name') || ' ' || COALESCE(x.item ->> 'label', '')) ~* pattern
                  THEN x.item - 'default'
                  ELSE x.item END
             ORDER BY x.ord)
      INTO cleaned
      FROM jsonb_array_elements(COALESCE(tpl.variables, '[]'::jsonb)) WITH ORDINALITY AS x(item, ord);

    SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
      FROM v3.document_template_versions WHERE template_id = tpl.tpl_id;

    INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
    VALUES (tpl.tpl_id, next_no, tpl.html_source, cleaned,
            format('137: 人ごとに変わる欄の既定値を %s 件外した（本文は %s 版と同じ）', removed, tpl.version_no),
            'sql:137')
    RETURNING id INTO new_id;
    UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl.tpl_id;
    RAISE NOTICE '% : 既定値を % 件外した。前の版 id=%（版 %）→ 新しい版 id=%（版 %）',
      tpl.template_key, removed, tpl.version_id, tpl.version_no, new_id, next_no;
  END LOOP;
END
$do$;

COMMIT;

-- 確認：残っている既定値（人ごとに変わる欄には無いこと）
SELECT t.template_key AS ひな形, v.version_no AS 版, x.item ->> 'name' AS 項目名, left(x.item ->> 'default', 40) AS 既定値
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL jsonb_array_elements(COALESCE(v.variables, '[]'::jsonb)) AS x(item)
 WHERE t.is_active AND COALESCE(btrim(x.item ->> 'default'), '') <> ''
 ORDER BY 1, 3;
