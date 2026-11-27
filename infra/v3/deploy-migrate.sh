#!/usr/bin/env bash
# =====================================================================
# DB を今のコードにそろえる。本番（Cloud Build のデプロイの前）とローカル（ops upgrade）で同じものを流す。
#
#   1. catchup_schema.sql      表・列・制約・引き金・ビュー・権限（何度流しても同じ結果。毎回流す）
#   2. deploy-migrations.txt   中身の登録など「1 回だけ流す」SQL（ひな形の登録など）。
#                              流したものは lb_ops.deploy_migrations に控え、2 回目からは流さない。
#
# つなぎ先は PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD（表の持ち主のロールで）。
# どこかで止まれば 0 以外で終わる（Cloud Build ならデプロイしない）。それより前に当てた分は残るが、
# どれも流し直してよい。
#
# 控えの表は v3 の外（lb_ops スキーマ）に置く。ローカルの中身で本番を入れ直す（ops push-export）とき、
# v3 の表は全部入れ替わるが、控えは消えない。
# =====================================================================
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PGOPTIONS="${PGOPTIONS:--c lock_timeout=30s -c statement_timeout=15min}"

echo "== 表の作りをそろえる（catchup_schema.sql）"
psql -X -q -v ON_ERROR_STOP=1 -f "$here/catchup_schema.sql"

psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS lb_ops;
CREATE TABLE IF NOT EXISTS lb_ops.deploy_migrations (
  name       text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

echo "== 1 回だけ流す SQL（deploy-migrations.txt）"
ran=0
while IFS= read -r line || [ -n "$line" ]; do
  name="$(printf '%s' "${line%%#*}" | tr -d '[:space:]')"
  [ -z "$name" ] && continue
  [[ "$name" =~ ^[A-Za-z0-9_.-]+\.sql$ ]] || { echo "ERROR: ファイル名の形が違います: $name" >&2; exit 1; }
  file="$here/$name"
  [ -f "$file" ] || { echo "ERROR: $name がありません" >&2; exit 1; }
  if [ -n "$(psql -X -Atq -c "SELECT 1 FROM lb_ops.deploy_migrations WHERE name = '$name'")" ]; then continue; fi
  echo "-- $name"
  psql -X -q -v ON_ERROR_STOP=1 -f "$file"
  psql -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO lb_ops.deploy_migrations (name, sha256) VALUES ('$name', '$(sha256sum "$file" | cut -c1-64)')"
  ran=$((ran + 1))
done < "$here/deploy-migrations.txt"
echo "== 完了（1 回だけ流す SQL：今回 ${ran} 本）"
