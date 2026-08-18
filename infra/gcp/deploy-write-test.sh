#!/usr/bin/env bash
# 本番サービスの再デプロイ（フラグ据え置き）。runbook §2-0 の手順を1本にまとめ、
# 繰り返し踏んでいた事故を事前に止める:
#   - gcloud の認証切れ（プロキシ/ビルドが途中で落ちる）
#   - /tmp が消えて build-flags.json が無い
#   - 配信中リビジョンではなく無関係なビルドから設定を引き継ぐ
#   - 末尾の "." 忘れ（ソース未指定）
#   - 必須 substitution（例: CloudSign 宛先許可リスト）を空にして verify で弾かれる
#
# 使い方:
#   infra/gcp/deploy-write-test.sh                        # 現行設定のまま再デプロイ
#   infra/gcp/deploy-write-test.sh KEY=VALUE [KEY=VALUE]  # 一部フラグだけ変えて再デプロイ
#     例) infra/gcp/deploy-write-test.sh _SLACK_CONVERSATION_READ_MODE=live
#   DRY_RUN=1 infra/gcp/deploy-write-test.sh ...          # 送信せず差分だけ確認
#   SERVICE=... でデプロイ先を上書き（既定は正式名 legalbridge-v2）。
#     旧サービスへ出す場合のみ: SERVICE=legalbridge-v2-write-test ...
#   FLAGS_FROM=... で設定の引き継ぎ元を上書き（既定はデプロイ先自身）。
#     まだ存在しないサービスへ初めて出すときに使う（§4 の載せ替えで使用済み）:
#       SERVICE=<新> FLAGS_FROM=<稼働中> infra/gcp/deploy-write-test.sh
#   PROJECT=... で対象プロジェクトを上書き（既定 legalbridge-488506）。
#   Cloud Shell がリセットされて core/project が消えても動くよう常に --project を渡す。
#
# ファイル名は write-test のままだが、§4（2026-08-18）で正式名 legalbridge-v2 へ
# 載せ替え済み。参照している文書が多いため改名は §5 の旧サービス撤去とあわせて行う。

set -euo pipefail

PROJECT="${PROJECT:-legalbridge-488506}"
# 既定は正式名（§4 で載せ替え済み・2026-08-18）。旧 write-test へ出すときだけ
# SERVICE=legalbridge-v2-write-test を明示する。
SERVICE="${SERVICE:-legalbridge-v2}"
# フラグの引き継ぎ元。既定はデプロイ先そのもの。まだ存在しないサービスへ初めて出すときだけ、
# 稼働中のサービスを指定する:
#   SERVICE=<新> FLAGS_FROM=<稼働中> infra/gcp/deploy-write-test.sh
FLAGS_FROM="${FLAGS_FROM:-${SERVICE}}"
REGION="${REGION:-asia-northeast1}"
CONFIG="${CONFIG:-infra/gcp/cloudbuild-write-test.yaml}"
FLAGS_FILE="${FLAGS_FILE:-/tmp/build-flags.json}"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "${CONFIG}" ] || die "${CONFIG} が見つかりません（リポジトリのルートで実行してください）"
command -v jq >/dev/null || die "jq が必要です"

# cloudbuild の inline シェルを送信前に検査する。ビルドは 1 回数分かかり、
# 失敗しても "step exited with non-zero status: 127" しか出ないため、
# シェル構文の事故はここで止める（実際に 1 回無駄にした）。
CHECKER="$(dirname "$0")/check-cloudbuild.py"
if [ -f "${CHECKER}" ] && command -v python3 >/dev/null; then
  python3 "${CHECKER}" "${CONFIG}" || die "${CONFIG} のシェルスクリプトに問題があります（上の ERROR を修正してください）"
fi

# 安全ゲート（verify-write-test.sh）の判定が変わっていないことを確認する。0.2 秒。
# 分岐が多く、緩めた変更は「ビルドが通ってしまう」形で表面化するため、送信前に見る。
CASES="$(dirname "$0")/verify-cases.sh"
if [ -f "${CASES}" ]; then
  bash "${CASES}" >/dev/null || die "安全ゲートの判定が期待と違います（infra/gcp/verify-cases.sh を実行して確認してください）"
fi

# ── 1. 認証（切れていると proxy もビルドも落ちるので最初に止める）──────────────
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  die "gcloud の認証が切れています。先に 'gcloud auth login' を実行してください。"
fi
echo "認証: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"

# Cloud Shell がリセットされると core/project が消える。毎回 --project を明示して
# 「resource is not properly specified」で止まらないようにする。
echo "プロジェクト: ${PROJECT}"

# ── 2. 配信中リビジョンのイメージタグ＝ビルドID から現行設定を取得 ────────────
#     （'gcloud builds list' の最新 SUCCESS は別サービスのビルドを掴む事故がある）
if [ "${FLAGS_FROM}" = "${SERVICE}" ]; then
  echo "配信中リビジョンから現行設定を取得しています…"
else
  echo "デプロイ先: ${SERVICE}（設定の引き継ぎ元: ${FLAGS_FROM}）"
fi
IMAGE="$(gcloud run services describe "${FLAGS_FROM}" --project "${PROJECT}" --region "${REGION}" \
  --format='value(spec.template.spec.containers[0].image)')"
[ -n "${IMAGE}" ] || die "${FLAGS_FROM} の配信中イメージを取得できませんでした"
LAST_BUILD="${IMAGE##*:}"
echo "採用ビルド: ${LAST_BUILD}"

# ビルドは global。--region を付けると別プールを見に行って not found になる。
gcloud builds describe "${LAST_BUILD}" --project "${PROJECT}" \
  --format=json | jq '{substitutions}' > "${FLAGS_FILE}"

KEY_COUNT="$(jq -r '.substitutions | keys | length' "${FLAGS_FILE}")"
[ "${KEY_COUNT}" -ge 100 ] || die "substitutions が ${KEY_COUNT} 件しかありません（引き継ぎ失敗の疑い）"
echo "substitutions: ${KEY_COUNT} キー"

# ── 3. 引数で指定されたフラグだけ差し替える ──────────────────────────────────
for override in "$@"; do
  case "${override}" in
    _SERVICE=*) die "サービス名は SERVICE=... で指定してください（引き継ぎ元と食い違うと別サービスへ出ます）" ;;
    _*=*) ;;
    *) die "指定は _KEY=VALUE 形式です: ${override}" ;;
  esac
  key="${override%%=*}"
  value="${override#*=}"
  jq --arg k "${key}" --arg v "${value}" '.substitutions[$k] = $v' \
    "${FLAGS_FILE}" > "${FLAGS_FILE}.tmp" && mv "${FLAGS_FILE}.tmp" "${FLAGS_FILE}"
  echo "変更: ${key} = ${value}"
done

# デプロイ先は SERVICE を正とする（引き継ぎ元の _SERVICE をそのまま使うと、
# 載せ替え時に旧サービスへ上書きしてしまう）。
jq --arg s "${SERVICE}" '.substitutions._SERVICE = $s' \
  "${FLAGS_FILE}" > "${FLAGS_FILE}.tmp" && mv "${FLAGS_FILE}.tmp" "${FLAGS_FILE}"

# ── 4. verify が落とす条件をローカルで先に弾く（ビルド待ちの無駄をなくす）────
sub() { jq -r --arg k "$1" '.substitutions[$k] // ""' "${FLAGS_FILE}"; }

if [ "$(sub _CLOUDSIGN_MODE)" = "live" ]; then
  recipients="$(sub _CLOUDSIGN_ALLOWED_RECIPIENTS)"
  if [ -z "${recipients}" ]; then
    echo "CloudSign 宛先許可リスト: 空（無制限＝V1 と同じ）"
  elif printf '%s' "${recipients}" | tr ',' '\n' | grep -qv '@'; then
    # 説明文をそのまま値にしてしまう事故があったため、@ を含まない要素は弾く。
    die "_CLOUDSIGN_ALLOWED_RECIPIENTS にメールアドレスでない要素があります: ${recipients}
     無制限にする場合は空を指定してください:
     $0 '_CLOUDSIGN_ALLOWED_RECIPIENTS='"
  else
    echo "CloudSign 宛先許可リスト: ${recipients}"
  fi
fi
if [ "$(sub _SLACK_CONVERSATION_READ_MODE)" = "live" ]; then
  [ -n "$(sub _SLACK_BOT_TOKEN_SECRET)" ] || die "Slack 会話読取 live には _SLACK_BOT_TOKEN_SECRET が必要です"
  [ "$(sub _SLACK_NOTIFICATION_HISTORY_ENABLED)" = "true" ] ||
    die "Slack 会話読取 live には _SLACK_NOTIFICATION_HISTORY_ENABLED=true が必要です（スレッドアンカーの供給元）"
fi

echo "主要フラグ:"
jq -r '.substitutions | {_SERVICE, _INTEGRATION_MODE, _WRITE_SCOPES, _CLOUDSIGN_MODE, _CLOUDSIGN_ALLOWED_RECIPIENTS,
  _SLACK_DELIVERY_MODE, _SLACK_NOTIFICATION_HISTORY_ENABLED, _SLACK_CONVERSATION_READ_MODE}' "${FLAGS_FILE}"

# ── 5. 送信（"^|^" 区切り＋末尾の "." までを固定）───────────────────────────
SUBS="$(jq -r '.substitutions | to_entries | map("\(.key)=\(.value)") | join("|")' "${FLAGS_FILE}")"
if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY_RUN=1 のため送信しません。"
  exit 0
fi
echo "ビルドを送信します…"
gcloud builds submit --project "${PROJECT}" --config "${CONFIG}" --substitutions "^|^${SUBS}" .
