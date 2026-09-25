-- =====================================================================
-- ひな形の項目に入っている「既定値」を見る（読むだけ）
--
--   発注書の宛名の下に、誰も入れていない担当者名が刷られた。V3 の入力欄は
--   document_template_versions.variables（V1・V2 の field_schema）から作り、
--   手入力も自動の値も無い欄には variables[].default が入る。V2 のひな形は
--   この既定値に実在の人名を持っていたので、CSV からまとめて決定した発注書に
--   そのまま焼き付いた。
--
--   1 で全ひな形の既定値を並べる。人名・部署・メールなど「その文書ごとに人が
--   入れるべきもの」が既定値に入っていれば、137 で外す。
--
--   実行: docker compose run --rm ops sql /v3/136_show_template_defaults.sql
--         （本番は Cloud SQL Studio に貼る）
--   出力には既定値の文字列がそのまま出る（人名が入っていることがあるので、
--   画面写真を共有するときは伏せること）。
-- =====================================================================
\pset pager off

-- 1. 既定値を持つ項目（全ひな形・現行版）
SELECT t.template_key                       AS ひな形,
       v.version_no                          AS 版,
       x.item ->> 'name'                     AS 項目名,
       x.item ->> 'label'                    AS 見出し,
       x.item ->> 'type'                     AS 型,
       left(x.item ->> 'default', 60)        AS 既定値,
       CASE WHEN (x.item ->> 'name') || ' ' || COALESCE(x.item ->> 'label', '')
                 ~* '(contact|signer|rep|担当|通知|署名|代表|氏名|部署|mail|メール|電話|phone|様)'
            THEN '★ 人ごとに変わる欄。137 で外す' ELSE '' END AS 判定
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL jsonb_array_elements(COALESCE(v.variables, '[]'::jsonb)) AS x(item)
 WHERE t.is_active
   AND COALESCE(btrim(x.item ->> 'default'), '') <> ''
 ORDER BY 判定 DESC, ひな形, 項目名;

-- 2. 発注書の宛名まわりが差している変数（どの欄が宛名の下に出るか）
SELECT t.template_key, m[1] AS 変数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(
         substr(v.html_source, greatest(1, strpos(v.html_source, 'VENDOR_NAME') - 300), 1500),
         '\{\{([^}]+)\}\}', 'g') AS m
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 GROUP BY t.template_key, m[1] ORDER BY 1, 2;
