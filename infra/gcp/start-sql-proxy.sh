#!/usr/bin/env bash
# Cloud SQL Auth Proxy を貼り直す（Cloud Shell 用）。
#
# 毎回引っかかる点を1本にまとめてある:
#   - ADC（メタデータサーバ）では認証できない。Cloud Shell では
#     "invalid token JSON from metadata: EOF" で落ちるため --token を明示する。
#   - アクセストークンの寿命は 1 時間。切れると psql が
#     "Error 401 ... ACCESS_TOKEN_TYPE_UNSUPPORTED" で落ちる。→ 貼り直す。
#   - 前のプロセスが残っていると "address already in use" になる。→ 先に止める。
#
# 使い方:
#   infra/gcp/start-sql-proxy.sh          # 5432 で貼り直す
#   PORT=5433 infra/gcp/start-sql-proxy.sh
#   PROXY=~/cloud-sql-proxy で実体の場所を上書き（既定 ~/cloud-sql-proxy）

set -euo pipefail

PROJECT="${PROJECT:-legalbridge-488506}"
INSTANCE="${INSTANCE:-${PROJECT}:asia-northeast1:legalbridge-db}"
PORT="${PORT:-5432}"
PROXY="${PROXY:-$HOME/cloud-sql-proxy}"
LOG="${LOG:-/tmp/cloud-sql-proxy.log}"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -x "${PROXY}" ] || die "${PROXY} が見つかりません（ダウンロード後に chmod +x してください）"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  die "gcloud の認証が切れています。先に 'gcloud auth login' を実行してください。"
fi

echo "既存のプロキシを停止します…"
pkill -f cloud-sql-proxy 2>/dev/null || true
# ポートが解放されるまで待つ（すぐ起動すると address already in use になる）。
for _ in $(seq 1 10); do
  if ! (exec 3<>/dev/tcp/127.0.0.1/"${PORT}") 2>/dev/null; then break; fi
  sleep 1
done

TOKEN="$(gcloud auth print-access-token)"
[ -n "${TOKEN}" ] || die "アクセストークンを取得できませんでした"

echo "プロキシを起動します（${INSTANCE} → 127.0.0.1:${PORT}）…"
nohup "${PROXY}" --token "${TOKEN}" --port "${PORT}" "${INSTANCE}" >"${LOG}" 2>&1 &

for _ in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/"${PORT}") 2>/dev/null; then
    exec 3>&-
    grep -q "Authorizing with OAuth2 token" "${LOG}" \
      && echo "OK: OAuth2 トークンで認証しました（ログ: ${LOG}）" \
      || echo "起動しました（ログ: ${LOG}）"
    echo "このトークンは約1時間で失効します。401 が出たらこのスクリプトを再実行してください。"
    exit 0
  fi
  sleep 1
done

echo "--- ${LOG} ---" >&2
tail -20 "${LOG}" >&2 || true
die "プロキシが ${PORT} で待ち受けませんでした"
