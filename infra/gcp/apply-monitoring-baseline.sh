#!/usr/bin/env bash
# apply-monitoring-baseline.sh
#   保守体制説明書 §0-3／§5 の「推奨設定」を GCP に実際に適用し、
#   「推奨」を「実設定」にするためのスクリプト。Cloud Shell で実行する。
#
#   適用内容:
#     1. Cloud SQL: 自動バックアップ 日次 03:00 JST（=18:00 UTC）開始・14世代保持、
#        PITR 有効・トランザクションログ 7日保持
#     2. Cloud Monitoring: 通知チャンネル（メール）
#     3. Cloud Run /health の uptime check（対象: UPTIME_SERVICES）
#     4. アラートポリシー 5本（保守体制説明書 §5 の名称どおり）
#        LB-PROD-CloudRun-5xx / LB-PROD-CloudRun-Latency / LB-PROD-CloudRun-Revision
#        LB-PROD-CloudSQL-Connection / LB-PROD-CloudSQL-Storage
#
#   実行例（Cloud Shell）:
#     NOTIFY_EMAIL="ops@example.com" bash infra/gcp/apply-monitoring-baseline.sh
#
#   注意:
#     - PITR が現在「無効」の場合、有効化には Cloud SQL インスタンスの再起動が伴う
#       （数十秒〜数分の接続断）。その場合は ACK_DB_RESTART=yes を付けて再実行する。
#     - 何度実行しても安全（既に在るものは作らない・一致している設定は触らない）。
#     - Slack #legalbridge-ops チャンネルは Slack 側で手動作成する（本スクリプト対象外）。

set -euo pipefail

PROJECT="${PROJECT:-legalbridge-488506}"
REGION="${REGION:-asia-northeast1}"
INSTANCE="${INSTANCE:-legalbridge-db}"
# uptime check を張る Cloud Run サービス（スペース区切り）。/health が認証なしで
# 200 を返すサービスだけを対象にする。読み取り側(Search API)を足すときはここに追記:
#   UPTIME_SERVICES="legalbridge-v2 <読み取りサービス名>" bash ...
UPTIME_SERVICES="${UPTIME_SERVICES:-legalbridge-v2}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
CHANNEL_DISPLAY="${CHANNEL_DISPLAY:-LegalBridge Ops メール}"

# 保守体制説明書 §0-3 の値（変更する場合は文書側も合わせて改訂する）
BACKUP_START_UTC="18:00"   # 03:00 JST
RETAINED_BACKUPS=14
PITR_LOG_DAYS=7

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "── $*"; }

[ -n "${NOTIFY_EMAIL:-}" ] || die "NOTIFY_EMAIL を指定してください（例: NOTIFY_EMAIL=ops@example.com bash $0）"
# プレースホルダをそのまま貼った事故を止める（実在のメールアドレス形式のみ許可）
case "${NOTIFY_EMAIL}" in
  *@*.*) : ;;
  *) die "NOTIFY_EMAIL がメールアドレスの形式ではありません: ${NOTIFY_EMAIL}（実際の通知先アドレスに置き換えてください）" ;;
esac
command -v gcloud >/dev/null || die "gcloud が必要です"
command -v python3 >/dev/null || die "python3 が必要です"

echo "プロジェクト: ${PROJECT} / リージョン: ${REGION} / インスタンス: ${INSTANCE}"
echo "通知先メール: ${NOTIFY_EMAIL}"
echo

# ── 1. Cloud SQL バックアップ／PITR ─────────────────────────────────────────
note "1/4 Cloud SQL バックアップ／PITR"
# csv形式で取得する。value() + awk だと未設定の空フィールド（PITR無効時の
# pointInTimeRecoveryEnabled 等）が読み飛ばされて後続の値がずれる。
CUR="$(gcloud sql instances describe "${INSTANCE}" --project "${PROJECT}" \
  --format='csv[no-heading](settings.backupConfiguration.enabled,settings.backupConfiguration.startTime,settings.backupConfiguration.backupRetentionSettings.retainedBackups,settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.backupConfiguration.transactionLogRetentionDays)')"
IFS=',' read -r CUR_ENABLED CUR_START CUR_KEEP CUR_PITR CUR_LOGDAYS <<< "${CUR}"
# 未設定（空）は無効として扱う
CUR_PITR="${CUR_PITR:-False}"
echo "  現状: backup=${CUR_ENABLED:-None} start=${CUR_START:-None}(UTC) 世代=${CUR_KEEP:-None} PITR=${CUR_PITR:-None} log保持=${CUR_LOGDAYS:-None}日"
echo "  目標: backup=True start=${BACKUP_START_UTC}(UTC=03:00 JST) 世代=${RETAINED_BACKUPS} PITR=True log保持=${PITR_LOG_DAYS}日"

if [ "${CUR_ENABLED}" = "True" ] && [ "${CUR_START}" = "${BACKUP_START_UTC}" ] \
   && [ "${CUR_KEEP}" = "${RETAINED_BACKUPS}" ] && [ "${CUR_PITR}" = "True" ] \
   && [ "${CUR_LOGDAYS}" = "${PITR_LOG_DAYS}" ]; then
  echo "  → 既に目標どおり。変更なし。"
else
  if [ "${CUR_PITR}" != "True" ] && [ "${ACK_DB_RESTART:-}" != "yes" ]; then
    die "PITR の有効化にはインスタンス再起動（短時間の接続断）が伴います。業務時間外に ACK_DB_RESTART=yes を付けて再実行してください。"
  fi
  gcloud sql instances patch "${INSTANCE}" --project "${PROJECT}" --quiet \
    --backup-start-time="${BACKUP_START_UTC}" \
    --retained-backups-count="${RETAINED_BACKUPS}" \
    --enable-point-in-time-recovery \
    --retained-transaction-log-days="${PITR_LOG_DAYS}"
  echo "  → 適用しました。"
fi

# ── 2. 通知チャンネル（メール）──────────────────────────────────────────────
note "2/4 Cloud Monitoring 通知チャンネル"
CHANNEL_NAME="$(gcloud beta monitoring channels list --project "${PROJECT}" \
  --filter="displayName=\"${CHANNEL_DISPLAY}\"" --format='value(name)' | head -1)"
if [ -z "${CHANNEL_NAME}" ]; then
  CHANNEL_NAME="$(gcloud beta monitoring channels create --project "${PROJECT}" \
    --display-name="${CHANNEL_DISPLAY}" --type=email \
    --channel-labels="email_address=${NOTIFY_EMAIL}" --format='value(name)')"
  echo "  → 作成: ${CHANNEL_NAME}"
else
  echo "  → 既存を使用: ${CHANNEL_NAME}"
fi

# ── 3. uptime check（Cloud Run /health）────────────────────────────────────
note "3/4 uptime check（${HEALTH_PATH}）"
EXISTING_CHECKS="$(gcloud monitoring uptime list-configs --project "${PROJECT}" \
  --format='value(displayName)' 2>/dev/null || true)"
for SVC in ${UPTIME_SERVICES}; do
  URL="$(gcloud run services describe "${SVC}" --project "${PROJECT}" --region "${REGION}" \
    --format='value(status.url)' 2>/dev/null || true)"
  if [ -z "${URL}" ]; then
    echo "  ! ${SVC}: Cloud Run サービスが見つかりません（スキップ）。'gcloud run services list' で実名を確認してください。"
    continue
  fi
  HOST="${URL#https://}"
  DISPLAY="LB-PROD-health-${SVC}"
  if echo "${EXISTING_CHECKS}" | grep -Fxq "${DISPLAY}"; then
    echo "  → ${DISPLAY}: 既存（スキップ）"
    continue
  fi
  if gcloud monitoring uptime create "${DISPLAY}" --project "${PROJECT}" \
       --resource-type=uptime-url \
       --resource-labels="host=${HOST},project_id=${PROJECT}" \
       --protocol=https --port=443 --path="${HEALTH_PATH}" \
       --period=5 --timeout=10 2>/dev/null; then
    echo "  → ${DISPLAY}: 作成（https://${HOST}${HEALTH_PATH} を5分間隔で確認）"
  else
    echo "  ! ${DISPLAY}: gcloud での作成に失敗。コンソール（Monitoring → Uptime checks）で"
    echo "    https://${HOST}${HEALTH_PATH} を対象に手動作成してください（5分間隔・タイムアウト10秒）。"
  fi
done

# ── 4. アラートポリシー 5本 ─────────────────────────────────────────────────
note "4/4 アラートポリシー（保守体制説明書 §5 の名称）"
EXISTING_POLICIES="$(gcloud alpha monitoring policies list --project "${PROJECT}" \
  --format='value(displayName)' 2>/dev/null || true)"
TMPDIR_POL="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_POL}"' EXIT
DB_ID="${PROJECT}:${INSTANCE}"

write_policy() { # $1=file $2=json
  printf '%s\n' "$2" > "${TMPDIR_POL}/$1"
}

write_policy 5xx.json "{
  \"displayName\": \"LB-PROD-CloudRun-5xx\",
  \"combiner\": \"OR\",
  \"documentation\": {\"mimeType\": \"text/markdown\", \"content\": \"Cloud Run で5xx応答が5分間に3件を超過。保守体制説明書 §5/§8 に従い対応。\"},
  \"conditions\": [{
    \"displayName\": \"5xx responses > 3 / 5min\",
    \"conditionThreshold\": {
      \"filter\": \"resource.type = \\\"cloud_run_revision\\\" AND metric.type = \\\"run.googleapis.com/request_count\\\" AND metric.labels.response_code_class = \\\"5xx\\\"\",
      \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_DELTA\", \"crossSeriesReducer\": \"REDUCE_SUM\", \"groupByFields\": [\"resource.label.service_name\"]}],
      \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 3, \"duration\": \"0s\"
    }
  }],
  \"notificationChannels\": [\"${CHANNEL_NAME}\"]
}"

write_policy latency.json "{
  \"displayName\": \"LB-PROD-CloudRun-Latency\",
  \"combiner\": \"OR\",
  \"documentation\": {\"mimeType\": \"text/markdown\", \"content\": \"Cloud Run の p95 レイテンシが 5 秒を超過（5分間）。\"},
  \"conditions\": [{
    \"displayName\": \"p95 latency > 5s\",
    \"conditionThreshold\": {
      \"filter\": \"resource.type = \\\"cloud_run_revision\\\" AND metric.type = \\\"run.googleapis.com/request_latencies\\\"\",
      \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_PERCENTILE_95\", \"crossSeriesReducer\": \"REDUCE_MEAN\", \"groupByFields\": [\"resource.label.service_name\"]}],
      \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 5000, \"duration\": \"300s\"
    }
  }],
  \"notificationChannels\": [\"${CHANNEL_NAME}\"]
}"

write_policy revision.json "{
  \"displayName\": \"LB-PROD-CloudRun-Revision\",
  \"combiner\": \"OR\",
  \"documentation\": {\"mimeType\": \"text/markdown\", \"content\": \"/health の uptime check が5分間失敗。デプロイ直後なら不良 revision を疑い、既知の正常 revision へ切り戻す（保守体制説明書 §8）。\"},
  \"conditions\": [{
    \"displayName\": \"health check failing\",
    \"conditionThreshold\": {
      \"filter\": \"resource.type = \\\"uptime_url\\\" AND metric.type = \\\"monitoring.googleapis.com/uptime_check/check_passed\\\"\",
      \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_NEXT_OLDER\", \"crossSeriesReducer\": \"REDUCE_COUNT_FALSE\", \"groupByFields\": [\"metric.label.check_id\"]}],
      \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 1, \"duration\": \"300s\"
    }
  }],
  \"notificationChannels\": [\"${CHANNEL_NAME}\"]
}"

write_policy sql-conn.json "{
  \"displayName\": \"LB-PROD-CloudSQL-Connection\",
  \"combiner\": \"OR\",
  \"documentation\": {\"mimeType\": \"text/markdown\", \"content\": \"Cloud SQL (${DB_ID}) が down、または稼働メトリクスが途絶。P1として §8 の初動へ。\"},
  \"conditions\": [
    {
      \"displayName\": \"database down\",
      \"conditionThreshold\": {
        \"filter\": \"resource.type = \\\"cloudsql_database\\\" AND resource.labels.database_id = \\\"${DB_ID}\\\" AND metric.type = \\\"cloudsql.googleapis.com/database/up\\\"\",
        \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_MAX\"}],
        \"comparison\": \"COMPARISON_LT\", \"thresholdValue\": 1, \"duration\": \"300s\"
      }
    },
    {
      \"displayName\": \"up metric absent\",
      \"conditionAbsent\": {
        \"filter\": \"resource.type = \\\"cloudsql_database\\\" AND resource.labels.database_id = \\\"${DB_ID}\\\" AND metric.type = \\\"cloudsql.googleapis.com/database/up\\\"\",
        \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_MAX\"}],
        \"duration\": \"600s\"
      }
    }
  ],
  \"notificationChannels\": [\"${CHANNEL_NAME}\"]
}"

write_policy sql-storage.json "{
  \"displayName\": \"LB-PROD-CloudSQL-Storage\",
  \"combiner\": \"OR\",
  \"documentation\": {\"mimeType\": \"text/markdown\", \"content\": \"Cloud SQL (${DB_ID}) のディスク使用率が80%超（15分継続）。容量拡張を検討。\"},
  \"conditions\": [{
    \"displayName\": \"disk utilization > 80%\",
    \"conditionThreshold\": {
      \"filter\": \"resource.type = \\\"cloudsql_database\\\" AND resource.labels.database_id = \\\"${DB_ID}\\\" AND metric.type = \\\"cloudsql.googleapis.com/database/disk/utilization\\\"\",
      \"aggregations\": [{\"alignmentPeriod\": \"300s\", \"perSeriesAligner\": \"ALIGN_MEAN\"}],
      \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 0.8, \"duration\": \"900s\"
    }
  }],
  \"notificationChannels\": [\"${CHANNEL_NAME}\"]
}"

for F in 5xx.json latency.json revision.json sql-conn.json sql-storage.json; do
  NAME="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['displayName'])" "${TMPDIR_POL}/${F}")"
  python3 -m json.tool "${TMPDIR_POL}/${F}" >/dev/null || die "${F} のJSONが不正です"
  if echo "${EXISTING_POLICIES}" | grep -Fxq "${NAME}"; then
    echo "  → ${NAME}: 既存（スキップ）"
  else
    gcloud alpha monitoring policies create --project "${PROJECT}" \
      --policy-from-file="${TMPDIR_POL}/${F}" >/dev/null
    echo "  → ${NAME}: 作成"
  fi
done

echo
note "完了。最終状態の確認:"
gcloud sql instances describe "${INSTANCE}" --project "${PROJECT}" \
  --format='yaml(settings.backupConfiguration)'
gcloud alpha monitoring policies list --project "${PROJECT}" \
  --filter='displayName:LB-PROD' --format='table(displayName,enabled)'
echo
echo "次にやること:"
echo "  1. 保守体制説明書 §0-3／§5 の「推奨」を「実設定（$(date +%Y-%m-%d) 確認）」へ改訂"
echo "  2. Slack に #legalbridge-ops チャンネルを作成（本スクリプトでは作成できません）"
echo "  3. テスト: 通知メールが届くか、コンソールからポリシーの Test 通知で確認"
