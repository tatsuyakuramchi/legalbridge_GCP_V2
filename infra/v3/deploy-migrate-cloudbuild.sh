#!/usr/bin/env bash
# Cloud Build の migrate の段（infra/v3/cloudbuild.yaml）。Cloud SQL Auth Proxy でつなぎ、deploy-migrate.sh を流す。
#   MIGRATE=on のときだけ動く。つなぐのは表の持ち主のロール（既定 postgres）で、パスワードは Secret Manager から引く。
#   ビルドのサービスアカウントに要る権限：roles/cloudsql.client、管理者パスワードのシークレットの roles/secretmanager.secretAccessor
set -euo pipefail
if [ "${MIGRATE:-off}" != "on" ]; then
  echo "DB の移行は止めています（_MIGRATE=${MIGRATE:-off}）。トリガーの代入変数 _MIGRATE=on で動く"
  exit 0
fi
: "${INSTANCE:?}" "${PGDATABASE:?}" "${PGUSER:?}" "${ADMIN_SECRET:?}"

apt-get update -qq >/dev/null && apt-get install -y -qq postgresql-client >/dev/null
curl -sSfL -o /usr/local/bin/cloud-sql-proxy \
  "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${PROXY_VERSION:-v2.14.1}/cloud-sql-proxy.linux.amd64"
chmod +x /usr/local/bin/cloud-sql-proxy
cloud-sql-proxy --port 5432 "$INSTANCE" > /tmp/proxy.log 2>&1 &
for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 -p 5432 && break; sleep 1; done
pg_isready -q -h 127.0.0.1 -p 5432 || { cat /tmp/proxy.log >&2; echo "ERROR: Cloud SQL につながりません" >&2; exit 1; }

export PGHOST=127.0.0.1 PGPORT=5432
PGPASSWORD="$(gcloud secrets versions access latest --secret="$ADMIN_SECRET")"
export PGPASSWORD
psql -X -Atq -c "SELECT 'つないだ先: ' || current_user || '@' || current_database()"
bash "$(dirname "$0")/deploy-migrate.sh"
