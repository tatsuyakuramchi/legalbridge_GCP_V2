/**
 * Cloud SQL Studio 用の 004_amend を作る。
 *
 * Studio は psql のクライアント機能（\set・\echo）を解釈しないので、それだけを
 * 落とす。中身は 004_amend.sql から取るので、片方だけ直して食い違うことがない。
 *
 * 確認は1本のクエリにまとめる。Studio は文ごとに結果を出すが、どれが見えるかは
 * 画面によるので、1つの表に全部入れておくほうが確実。
 *
 *   node infra/v3/tools/make-studio-sql.mjs        書き出す
 *   node infra/v3/tools/make-studio-sql.mjs --check 食い違っていないか見る
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "infra/v3/004_amend.sql";
const TARGET = "infra/v3/004_amend_studio.sql";

const HEADER = `-- =====================================================================
-- LegalBridge V3 スキーマの後追い変更（Cloud SQL Studio 用）
--
--   このファイルは自動生成。直さないこと。
--   直すのは infra/v3/004_amend.sql のほうで、そのあと
--     node infra/v3/tools/make-studio-sql.mjs
--   で作り直す。
--
--   使い方: Cloud SQL Studio のエディタに全部貼って実行する。
--           何度流しても同じ結果になる。
--   psql が使えるなら 004_amend.sql のほうを流すこと（確認の出力が読みやすい）。
-- =====================================================================

`;

/** 確認。Studio は最後の結果しか出さないことがあるので、1本にまとめる。 */
const CHECKS = `
-- =====================================================================
-- 確認（1本の表に全部出る）
-- =====================================================================
SELECT * FROM (
  SELECT 1 AS n, 'matter_links の種類' AS 項目,
         COALESCE((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                    WHERE c.conrelid = 'v3.matter_links'::regclass AND c.contype = 'c'
                    LIMIT 1), '(制約なし)') AS 結果
  UNION ALL
  SELECT 2, 'condition_schedules.pay_on',
         COALESCE((SELECT data_type FROM information_schema.columns
                    WHERE table_schema='v3' AND table_name='condition_schedules'
                      AND column_name='pay_on'), '無い')
  UNION ALL
  SELECT 3, 'matters.document_style',
         COALESCE((SELECT data_type FROM information_schema.columns
                    WHERE table_schema='v3' AND table_name='matters'
                      AND column_name='document_style'), '無い')
  UNION ALL
  SELECT 4, 'conditions.effective_from / series_id',
         (SELECT count(*)::text || ' 列' FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions'
             AND column_name IN ('effective_from','series_id'))
  UNION ALL
  SELECT 5, 'conditions.status で許す値',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                    WHERE conrelid='v3.conditions'::regclass
                      AND conname='conditions_status_chk'), '(制約なし)')
  UNION ALL
  SELECT 6, '系列が埋まっていない条件（0 であること）',
         (SELECT count(*)::text FROM v3.conditions WHERE series_id IS NULL)
  UNION ALL
  SELECT 7, '発行できないひな形（採番プレフィックス無し。0 が望ましい）',
         (SELECT count(*)::text FROM v3.document_templates
           WHERE is_active AND COALESCE(btrim(number_prefix), '') = '')
  UNION ALL
  SELECT 8, '自社プロファイル',
         COALESCE((SELECT value::text FROM v3.settings WHERE key='company_profile'), '無い')
  UNION ALL
  SELECT 9, '取引先の連絡先（住所 / 電話 / メール / 全件）',
         (SELECT count(*) FILTER (WHERE address IS NOT NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE phone   IS NOT NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE email   IS NOT NULL)::text || ' / ' ||
                 count(*)::text
            FROM v3.parties)
  UNION ALL
  SELECT 10, '振込先の欠け（銀行名なし / 支店名なし / 種別なし / 全件）',
         (SELECT count(*) FILTER (WHERE bank_name    IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE branch_name  IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE account_type IS NULL)::text || ' / ' ||
                 count(*)::text
            FROM v3.party_bank_accounts)
  UNION ALL
  SELECT 11, '中身の無い口座（0 であること）',
         (SELECT count(*)::text FROM v3.party_bank_accounts
           WHERE bank_name IS NULL AND branch_name IS NULL
             AND account_number IS NULL AND account_holder_kana IS NULL)
  UNION ALL
  SELECT 12, '口座表の権限（SELECT だけであること）',
         COALESCE((SELECT string_agg(DISTINCT privilege_type, ', ')
                     FROM information_schema.role_table_grants
                    WHERE grantee = 'legalbridge_v3_runtime'
                      AND table_name = 'party_bank_accounts'), '権限なし')
) AS 確認 ORDER BY n;
`;

export const SOURCE_PATH = SOURCE;
export const TARGET_PATH = TARGET;

/** 004_amend.sql の中身から Studio 用を作る。試験もこれを使う。 */
export function buildStudioSql(source) {
  // 変更の部分だけ取る（COMMIT まで）。そのあとは psql 用の確認なので使わない。
  const end = source.indexOf("\nCOMMIT;\n");
  if (end < 0) throw new Error("COMMIT; が見つかりません");
  const changes = source
    .slice(0, end + "\nCOMMIT;\n".length)
    .split("\n")
    .filter((line) => !line.startsWith("\\"))   // psql のクライアント機能を落とす
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return HEADER + changes.trimStart() + "\n" + CHECKS;
}

// コマンドとして呼ばれたときだけ書き出す（試験からの import では動かさない）。
if (process.argv[1] && process.argv[1].endsWith("make-studio-sql.mjs")) {
  const output = buildStudioSql(readFileSync(SOURCE, "utf8"));
  if (process.argv.includes("--check")) {
    if (readFileSync(TARGET, "utf8") !== output) {
      console.error(`${TARGET} が ${SOURCE} と食い違っています。`);
      console.error("node infra/v3/tools/make-studio-sql.mjs で作り直してください。");
      process.exit(1);
    }
    console.log("一致しています。");
  } else {
    writeFileSync(TARGET, output);
    console.log(`${TARGET} を書き出しました（${output.split("\n").length} 行）`);
  }
}
