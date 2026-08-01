#!/usr/bin/env bash
set -euo pipefail

# Copies only the public business schema from legalbridge into the isolated
# legalbridge_v2_validation database. No application rows are copied.
#
# Prerequisites:
#   1. Cloud SQL Auth Proxy is listening on LB_SCHEMA_HOST:LB_SCHEMA_PORT.
#   2. Run with the postgres database user.
#   3. The validation database contains no business tables yet. The guarded
#      lb_v2 Slack history/approval tables are allowed and retained.

readonly SOURCE_DATABASE="legalbridge"
readonly TARGET_DATABASE="legalbridge_v2_validation"
readonly DB_HOST="${LB_SCHEMA_HOST:-127.0.0.1}"
readonly DB_PORT="${LB_SCHEMA_PORT:-9470}"
readonly DB_USER="${LB_SCHEMA_USER:-postgres}"
readonly REQUIRED_CONFIRMATION="BOOTSTRAP_EMPTY_VALIDATION_BUSINESS_SCHEMA"

if [[ "${CONFIRM_VALIDATION_SCHEMA_BOOTSTRAP:-}" != "${REQUIRED_CONFIRMATION}" ]]; then
  echo "Refusing schema bootstrap without explicit confirmation." >&2
  echo "Set CONFIRM_VALIDATION_SCHEMA_BOOTSTRAP=${REQUIRED_CONFIRMATION}" >&2
  exit 1
fi

command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }

read -r -s -p "Postgres password: " LB_SCHEMA_PASSWORD
echo
export PGPASSWORD="${LB_SCHEMA_PASSWORD}"

dump_file="$(mktemp --suffix=.dump)"
toc_file="$(mktemp --suffix=.toc)"
cleanup() {
  unset PGPASSWORD LB_SCHEMA_PASSWORD
  rm -f -- "${dump_file}" "${toc_file}"
}
trap cleanup EXIT

psql_base=(psql -X -v ON_ERROR_STOP=1 -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}")

source_condition_lines="$("${psql_base[@]}" -d "${SOURCE_DATABASE}" -Atqc   "SELECT COALESCE(to_regclass('public.condition_lines')::text, '')")"
if [[ "${source_condition_lines}" != "condition_lines" ]]; then
  echo "Source database is missing public.condition_lines; refusing bootstrap." >&2
  exit 1
fi

unexpected_target_tables="$("${psql_base[@]}" -d "${TARGET_DATABASE}" -Atqc   "SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY schemaname, tablename)
     FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND NOT (
        schemaname = 'public'
        AND tablename IN (
          'lb_v2_slack_notification_history',
          'lb_v2_slack_notification_approvals'
        )
      )")"
if [[ -n "${unexpected_target_tables}" ]]; then
  echo "Validation database already contains business tables: ${unexpected_target_tables}" >&2
  echo "Refusing to overwrite or merge an existing business schema." >&2
  exit 1
fi

pg_dump   --host="${DB_HOST}"   --port="${DB_PORT}"   --username="${DB_USER}"   --dbname="${SOURCE_DATABASE}"   --format=custom   --schema-only   --schema=public   --no-owner   --no-privileges   --file="${dump_file}"

# public already exists in the validation database. Remove only its schema-level
# TOC entries; tables, sequences, functions, types, constraints and indexes remain.
pg_restore --list "${dump_file}"   | sed -E '/ SCHEMA - public /d; / COMMENT - SCHEMA public /d; / ACL - SCHEMA public /d'   > "${toc_file}"

pg_restore   --host="${DB_HOST}"   --port="${DB_PORT}"   --username="${DB_USER}"   --dbname="${TARGET_DATABASE}"   --use-list="${toc_file}"   --no-owner   --no-privileges   --single-transaction   --exit-on-error   "${dump_file}"

for required_table in condition_lines documents vendors works; do
  restored="$("${psql_base[@]}" -d "${TARGET_DATABASE}" -Atqc     "SELECT COALESCE(to_regclass('public.${required_table}')::text, '')")"
  if [[ "${restored}" != "${required_table}" ]]; then
    echo "Restore completed without required table public.${required_table}." >&2
    exit 1
  fi
done

echo "Business schema restored to ${TARGET_DATABASE} without application data."
echo "Existing lb_v2 Slack history and approval tables were retained."
