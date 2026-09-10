#!/bin/bash
# ローカル DB の初回起動時だけ走る（docker-entrypoint-initdb.d）。
# アプリが本番と同じ権限で動くように、同じ名前のランタイムロールを作る。
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE legalbridge_v3_runtime LOGIN PASSWORD '${V3_RUNTIME_PASSWORD}';
SQL
