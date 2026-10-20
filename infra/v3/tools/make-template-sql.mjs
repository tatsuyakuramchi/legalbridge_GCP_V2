// 本文が 1 ファイルで完結するひな形（部分テンプレートに頼らない）の登録 SQL を templates/ から組み立てる。
//   node infra/v3/tools/make-template-sql.mjs
// 本文（templates/*.html）を直したらこれを流して SQL を作り直す。
// SQL は Cloud SQL Studio にそのまま貼れる（psql のメタコマンドを使わない）。
// 何度流しても同じ：未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const TARGETS = [
  {
    no: "169", key: "service_completion_notice", label: "役務提供完了通知書",
    body: "templates/service_completion_notice.html", mark: 'data-layout="scn-v1',
    prefix: "SC",
    // 分類は国内の検収書と同じ（文書の一覧・送付・経理提出で検収書と同じ扱い）。
    categoryFrom: "inspection_certificate",
    out: "169_service_completion_notice.sql",
    variables: [
      { name: "confirm_deadline", label: "確認期限", type: "date", group: "I. 基本情報",
        helpText: "送付日から 10 営業日。空なら発行日から数えて仮置きする" },
      { name: "remarks", label: "備考（追記）", type: "textarea", group: "III. 備考",
        helpText: "備考の末尾に 1 項目として出る" }
    ],
    title: "役務提供完了通知書（service_completion_notice）の登録",
    intro: `--   準委任で時間精算（月間包括枠＋実績時間。A-073）の委託料の決済文書。検収書の役務提供版：
--   成果物の検収ではなく、その月の役務の提供が完了したことを確認する。
--
--   ・V3 は、決済文書を作るときに条件が時間精算（conditions.time_settlement）なら
--     検収書ではなくこのひな形を既定にする（作業テーブル・取引管理・支払文書処理）。
--   ・明細は実績 1 件を 包括枠／超過／未消化の控除 の行に分けて出す（template-context.ts）。
--   ・受注者に登録番号があれば副題「兼 仕入明細書」。確認期限は送付日から 10 営業日。
--   ・署名欄は金額が発注時の合意と違うとき（超過・未消化の精算、予定と違う額）だけ出る。
--   ・採番は SC（ARC-SC-年-連番）。分類は国内の検収書と同じ。`
  }
];

function build(t) {
  const html = readFileSync(join(root, t.body), "utf8").trimEnd();
  if (!html.includes(t.mark)) throw new Error(`${t.body} に目印 ${t.mark} がありません`);
  if (html.includes("$tpl$")) throw new Error("本文に $tpl$ が含まれています（引用符と衝突）");
  const variables = JSON.stringify(t.variables).replace(/'/g, "''");
  return `-- =====================================================================
-- ${t.no} ${t.title}
--
${t.intro}
--
--   本文は infra/v3/${t.body}（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/${t.out}
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = '${t.key}';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$${html}
$tpl$;
  vars constant jsonb := '${variables}'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = '${t.categoryFrom}';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = '${t.key}';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('${t.key}', '${t.label}', base_category, '${t.prefix}', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, '${t.prefix}'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '${t.no}: ${t.label}は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '${t.no}: ${t.label}', 'sql:${t.no}')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '${t.no}: ${t.label}を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '${t.mark}') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = '${t.key}';
`;
}

export function buildAll() {
  return TARGETS.map((t) => ({ out: join(root, t.out), sql: build(t) }));
}

if (process.argv[1] && process.argv[1].endsWith("make-template-sql.mjs")) {
  for (const { out, sql } of buildAll()) {
    if (process.argv.includes("--check")) {
      let cur = "";
      try { cur = readFileSync(out, "utf8"); } catch { cur = ""; }
      if (cur !== sql) { console.error(`${out} が templates/ と食い違っています。node infra/v3/tools/make-template-sql.mjs で作り直してください。`); process.exit(1); }
      console.log(`${out}: 一致しています。`);
    } else {
      writeFileSync(out, sql);
      console.log(`${out} を書き出しました（${sql.split("\n").length} 行）`);
    }
  }
}
