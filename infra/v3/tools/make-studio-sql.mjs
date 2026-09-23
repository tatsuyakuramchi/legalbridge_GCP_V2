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
         -- 部分テンプレート（差し込む約款など）は書類ではないので数えない。
         (SELECT count(*)::text FROM v3.document_templates
           WHERE is_active
             AND category IS DISTINCT FROM 'partial'
             AND template_key NOT LIKE '\\_%'
             AND COALESCE(btrim(number_prefix), '') = '')
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
  SELECT 12, '口座表の権限（SELECT/INSERT/UPDATE。DELETE が無いこと）',
         COALESCE((SELECT string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type)
                     FROM information_schema.role_table_grants
                    WHERE grantee = 'legalbridge_v3_runtime'
                      AND table_name = 'party_bank_accounts'), '権限なし')
  UNION ALL
  SELECT 13, '欠けた振込先（A-012 が上げた不整合。high は振り込めない口座）',
         COALESCE((SELECT string_agg(severity || ' ' || n::text, ' / ' ORDER BY severity)
                     FROM (SELECT severity, count(*) AS n
                             FROM v3.data_quality_issues
                            WHERE rule_code = 'PARTY_BANK_INCOMPLETE' AND status = 'open'
                            GROUP BY severity) AS s), '0')
  UNION ALL
  SELECT 14, '空白だけの値（A-014 のあと 0 であること。担当者 / 取引先 / 口座）',
         (SELECT count(*)::text FROM v3.staff
           WHERE btrim(email) = '' OR btrim(department) = '' OR btrim(phone) = '')
         || ' / ' ||
         (SELECT count(*)::text FROM v3.parties
           WHERE btrim(address) = '' OR btrim(phone) = '' OR btrim(email) = '')
         || ' / ' ||
         (SELECT count(*)::text FROM v3.party_bank_accounts
           WHERE btrim(bank_name) = '' OR btrim(branch_name) = ''
              OR btrim(account_type) = '' OR btrim(account_number) = ''
              OR btrim(account_holder_kana) = '')
  UNION ALL
  SELECT 15, 'やり取りの記録（A-015。SELECT, INSERT だけ）',
         COALESCE((SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type)
                     FROM information_schema.role_table_grants
                    WHERE grantee = 'legalbridge_v3_runtime'
                      AND table_name = 'matter_communications'), '表が無い')
  UNION ALL
  SELECT 16, '一括作成の束（A-016。SELECT, INSERT, UPDATE と documents.batch_id）',
         COALESCE((SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type)
                     FROM information_schema.role_table_grants
                    WHERE grantee = 'legalbridge_v3_runtime'
                      AND table_name = 'document_batches'), '表が無い')
         || ' / batch_id=' || COALESCE((SELECT data_type FROM information_schema.columns
                    WHERE table_schema='v3' AND table_name='documents'
                      AND column_name='batch_id'), '無い')
  UNION ALL
  SELECT 17, '条件明細の仕様と帰属先（A-017。2 列）',
         (SELECT count(*)::text || ' 列' FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions'
             AND column_name IN ('spec','deliverable_ownership'))
  UNION ALL
  SELECT 18, '実績の検収書向けの列（A-018。4 列）',
         (SELECT count(*)::text || ' 列' FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='condition_events'
             AND column_name IN ('deliverable','inspected_on','inspector_dept','inspector_name'))
  UNION ALL
  SELECT 19, '条件の外部の発注番号（A-019。1 列）',
         (SELECT count(*)::text || ' 列' FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions' AND column_name='order_no')
  UNION ALL
  SELECT 20, '計算書の一意制約（A-020。旧 0・新 1）',
         (SELECT count(*)::text FROM pg_constraint
           WHERE conrelid = 'v3.statements'::regclass
             AND conname = 'statements_document_id_key')
         || ' / ' ||
         (SELECT count(*)::text FROM pg_indexes
           WHERE schemaname = 'v3' AND tablename = 'statements'
             AND indexname = 'statements_document_condition_uq')
  UNION ALL
  SELECT 21, '定型文（A-021。SELECT, INSERT, UPDATE と、使える文面の数）',
         COALESCE((SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type)
                     FROM information_schema.role_table_grants
                    WHERE grantee = 'legalbridge_v3_runtime'
                      AND table_name = 'text_snippets'), '表が無い')
         || ' / ' || COALESCE((SELECT count(*)::text FROM v3.text_snippets
                                WHERE is_active), '0') || ' 件'
  UNION ALL
  SELECT 22, '単価・個数・契約形式・役務提供期間（A-022。条件 2 / 予定 3 / 実績 3）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions'
             AND column_name IN ('quantity','contract_form'))
         || ' / ' || (SELECT count(*)::text FROM information_schema.columns
                       WHERE table_schema='v3' AND table_name='condition_schedules'
                         AND column_name IN ('contract_form','service_from','service_to'))
         || ' / ' || (SELECT count(*)::text FROM information_schema.columns
                       WHERE table_schema='v3' AND table_name='condition_events'
                         AND column_name IN ('contract_form','service_from','service_to'))
  UNION ALL
  SELECT 23, '実績の利用形態（A-023。4 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='condition_events'
             AND column_name IN ('usage_type','out_condition_id','unit_amount','rate_ppm'))
  UNION ALL
  SELECT 24, '実績の入金区分（A-024。1 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='condition_events'
             AND column_name = 'payment_stage')
  UNION ALL
  SELECT 25, '受領額の税込・税別（A-025。1 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='condition_events'
             AND column_name = 'tax_included')
  UNION ALL
  SELECT 26, '作品の統合先（A-026。1 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='works'
             AND column_name = 'merged_into_id')
  UNION ALL
  SELECT 27, '条件の利用形態・実績の作品・作品の著作権表示（A-027。4 列であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='conditions' AND column_name = 'usage_type')
        + (SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='condition_events' AND column_name = 'work_id')
        + (SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='works'
              AND column_name IN ('copyright_notice', 'third_party_rights')))::text
  UNION ALL
  SELECT 28, '条件の完了扱い（A-028。3 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions'
             AND column_name IN ('closed_at', 'closed_reason', 'closed_by'))
  UNION ALL
  SELECT 29, '案件の統合先（A-029。2 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='matters'
             AND column_name IN ('merged_into_id', 'merged_at'))
  UNION ALL
  SELECT 30, '実績の予定との差分・次のアクション（A-030。5 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='condition_events'
             AND column_name IN ('expected_quantity', 'expected_amount', 'variance_note', 'follow_up', 'follow_up_due_on'))
  UNION ALL
  SELECT 31, 'クレジット表記の履歴（A-031。表があり 6 列であること）',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='work_credits'
             AND column_name IN ('work_id', 'effective_from', 'edition', 'copyright_notice', 'third_party_rights', 'note'))
  UNION ALL
  SELECT 32, '取引先の代表者と連絡先の役割の印（A-032。3 列であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='parties' AND column_name IN ('representative_title', 'representative_name'))
        + (SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='party_contacts' AND column_name = 'roles'))::text
  UNION ALL
  SELECT 34, '条件ごとの自動更新（A-039。列が 3 つあること）',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions'
             AND column_name IN ('auto_renew', 'renew_months', 'renew_stopped_on'))::text
  UNION ALL
  SELECT 41, '条件明細の納期（A-041。列があること）',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='conditions' AND column_name='delivery_due')::text
  UNION ALL
  SELECT 43, '契約の種類・親・解除・更新の記録（A-043。列 7 と表 1 で 8 であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='agreements'
              AND column_name IN ('kind', 'domain', 'parent_id', 'counterparty_ref_no',
                                  'terminated_on', 'renewal_months', 'renewal_stopped_on'))
        + (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='v3' AND table_name='term_events'))::text
  UNION ALL
  SELECT 44, '案件の再定義（A-044。列 7 と表 1 で 8 であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='matters'
              AND column_name IN ('work_id', 'business_line', 'business_name', 'production',
                                  'parent_id', 'title_manual', 'remapped_from'))
        + (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='v3' AND table_name='matter_relations'))::text
  UNION ALL
  SELECT 45, '文書由来の契約行（A-045。0 であること）',
         (SELECT count(*) FROM v3.agreements a
           WHERE COALESCE(a.kind, 'master') IN ('master', 'standalone') AND a.domain IS NULL
             AND EXISTS (SELECT 1 FROM v3.documents d WHERE d.document_no = a.agreement_no))::text
  UNION ALL
  SELECT 46, '支払の採番漏れ（A-046。0 であること）',
         (SELECT count(*) FROM v3.payments WHERE payment_no IS NULL)::text
  UNION ALL
  SELECT 47, '文字列のまま焼き付いた真偽の値（A-047。0 であること）',
         (SELECT count(*) FROM v3.documents d
           WHERE jsonb_typeof(d.rendered_values) = 'object'
             AND EXISTS (SELECT 1 FROM jsonb_each(d.rendered_values) AS x
                          WHERE jsonb_typeof(x.value) = 'string' AND (x.value #>> '{}') IN ('true', 'false')))::text
  UNION ALL
  SELECT 48, '許諾料の扱い（A-048。列 1 と CHECK 1 で 2 であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='conditions' AND column_name='license_fee_basis')
        + (SELECT count(*) FROM pg_constraint
            WHERE conrelid='v3.conditions'::regclass AND conname='conditions_license_fee_basis_chk'))::text
  UNION ALL
  SELECT 49, '担当者の英語表記（A-049。列 2 であること）',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='v3' AND table_name='staff' AND column_name IN ('name_en', 'department_en'))::text
  UNION ALL
  SELECT 50, '事業区分の増設（A-050。CHECK に publishing があること＝1）',
         (SELECT count(*) FROM pg_constraint
           WHERE conrelid='v3.matters'::regclass AND conname='matters_business_line_chk'
             AND pg_get_constraintdef(oid) LIKE '%publishing%')::text
  UNION ALL
  SELECT 33, '翻訳版再許諾と別途合意（A-033。列 1 と CHECK 1 で 2 であること）',
         ((SELECT count(*) FROM information_schema.columns
            WHERE table_schema='v3' AND table_name='conditions' AND column_name = 'sublicense_consent')
        + (SELECT count(*) FROM pg_constraint
            WHERE conrelid='v3.conditions'::regclass AND conname='conditions_usage_type_chk'
              AND pg_get_constraintdef(oid) LIKE '%pub_sub_print%'))::text
) AS 確認 ORDER BY n;
`;

export const SOURCE_PATH = SOURCE;
export const TARGET_PATH = TARGET;

/** 004_amend.sql の中身から Studio 用を作る。試験もこれを使う。 */
/**
 * 元ファイルの確認節にある項目の数。psql 版は `\echo '--- ... ---'` で1項目ずつ出す。
 */
export function sourceCheckCount(source) {
  const end = source.indexOf("\nCOMMIT;\n");
  const tail = end < 0 ? source : source.slice(end);
  return (tail.match(/^\\echo '---/gm) ?? []).length;
}

/** この生成器が持っている確認項目の数。 */
export function studioCheckCount() {
  return (CHECKS.match(/^\s*SELECT \d+[, ]/gm) ?? []).length;
}

export function buildStudioSql(source) {
  // 確認は psql 版と Studio 版で別々に書いてある（Studio は結果を1本にまとめる
  // 必要があるので、同じ SQL は使えない）。別々ということは、片方に足して
  // もう片方に足し忘れられる。実際 A-012 の確認が Studio 版から落ちていて、
  // 生成物どうしを比べる --check では気づけなかった。数が合わなければ止める。
  const inSource = sourceCheckCount(source);
  const inStudio = studioCheckCount();
  if (inSource !== inStudio) {
    throw new Error(
      `確認項目の数が合いません（004_amend.sql に ${inSource} 項目、`
      + `この生成器の CHECKS に ${inStudio} 項目）。`
      + "片方だけに足すと、Studio で流した人は確かめられないまま終わります。");
  }

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
