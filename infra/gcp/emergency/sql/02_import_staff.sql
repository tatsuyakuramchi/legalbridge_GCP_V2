\set ON_ERROR_STOP on
\pset pager off

-- 02_import_staff.sql — 担当者マスタの緊急登録（staging→検証→INSERT）。
-- CSV: work/master_staff.csv（templates/master_staff.csv のヘッダーどおり）
-- 実行: psql "$EMERGENCY_DSN" \
--         -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
--         -v csv=work/master_staff.csv \
--         -f infra/gcp/emergency/sql/02_import_staff.sql
-- 冪等性: 同名（staff_name 完全一致）の既存行はスキップする。

\if :{?confirm}
\else
  \echo '中止: -v confirm=LEGALBRIDGE_EMERGENCY_WRITE を付けて実行してください'
  \quit 2
\endif
SELECT :'confirm' = 'LEGALBRIDGE_EMERGENCY_WRITE' AS ok \gset
\if :ok
\else
  \echo '中止: confirm の値が不正です。何も変更していません。'
  \quit 2
\endif
\if :{?csv}
\else
  \echo '中止: -v csv=work/master_staff.csv のようにCSVパスを指定してください'
  \quit 2
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE stg_staff (
  staff_name text, email text, phone text,
  department text, department_code text, slack_user_id text
) ON COMMIT DROP;

\copy stg_staff FROM :'csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

SELECT COUNT(*) AS staged_rows FROM stg_staff;
DO $$
DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad FROM stg_staff WHERE COALESCE(trim(staff_name), '') = '';
  IF bad > 0 THEN RAISE EXCEPTION 'staff_name が空の行が % 行あります', bad; END IF;
  SELECT COUNT(*) INTO bad FROM (
    SELECT staff_name FROM stg_staff GROUP BY staff_name HAVING COUNT(*) > 1) d;
  IF bad > 0 THEN RAISE EXCEPTION 'CSV内で staff_name が重複しています（%件）', bad; END IF;
END $$;

\echo '--- 既存と同名のためスキップされる行 ---'
SELECT s.staff_name FROM stg_staff s JOIN staff t ON t.staff_name = s.staff_name;

WITH ins AS (
  INSERT INTO staff (staff_name, email, phone, department, department_code, slack_user_id)
  SELECT trim(s.staff_name),
         NULLIF(trim(s.email), ''), NULLIF(trim(s.phone), ''),
         NULLIF(trim(s.department), ''), NULLIF(trim(s.department_code), ''),
         NULLIF(trim(s.slack_user_id), '')
    FROM stg_staff s
   WHERE NOT EXISTS (SELECT 1 FROM staff t WHERE t.staff_name = trim(s.staff_name))
  RETURNING id, staff_name
)
SELECT COUNT(*) AS inserted_rows FROM ins;

\echo '--- 登録結果（この一覧を記録票に添付）---'
SELECT t.id, t.staff_name, t.email, t.department
  FROM staff t JOIN stg_staff s ON s.staff_name = t.staff_name
 ORDER BY t.id;

COMMIT;
