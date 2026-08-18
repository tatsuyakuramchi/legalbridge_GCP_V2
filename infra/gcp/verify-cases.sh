#!/usr/bin/env bash
# verify-write-test.sh の振る舞いを固定するテスト。
#
# あのスクリプトは「検証済みの構成以外では書込・外部送信をさせない」最後の砦で、
# サービス名・DB・確認トークンを 40 箇所以上で突き合わせている。分岐が多く、
# 手で書き換えるとゲートが静かに緩む（＝本番へ意図しない書込を許す）事故になりやすい。
# ここで代表的な組み合わせを固定し、変更後も同じ判定になることを確かめる。
#
# 使い方: infra/gcp/verify-cases.sh        （全ケース実行・失敗があれば exit 1）
#         SHOW=1 infra/gcp/verify-cases.sh （ブロック理由も表示）

set -uo pipefail
cd "$(dirname "$0")/../.."

SCRIPT="infra/gcp/verify-write-test.sh"
[ -f "${SCRIPT}" ] || { echo "ERROR: ${SCRIPT} が見つかりません"; exit 2; }

# ── 土台：cloudbuild の substitutions 既定値（_FOO → FOO）──────────────────
BASE_ENV="$(python3 - <<'PY'
import yaml, shlex
subs = yaml.safe_load(open('infra/gcp/cloudbuild-write-test.yaml')).get('substitutions', {})
for key, value in subs.items():
    if key.startswith('_'):
        print(f"{key[1:]}={shlex.quote(str(value))}")
PY
)"

# ── 本番プロファイル（Profile D）：現在稼働中の構成に相当する上書き ────────
# 値は verify-write-test.sh 自身が要求している定数と、配信中ビルドの substitutions に合わせる。
PRODUCTION_ENV='
PRIMARY_DB_MODE=production
CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE
CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED
SERVICE=legalbridge-v2-write-test
DB_NAME=legalbridge
DB_USER=legalbridge_v2_runtime
DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password
AUTH_MODE=cloudrun-iam
AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp
CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY
INTEGRATION_MODE=live
'

# 検証プロファイル（隔離DB）。本番ゲートを先に踏まずに、個別の解禁ゲートまで到達させる。
VALIDATION_ENV='
PRIMARY_DB_MODE=validation
CONFIRM_ISOLATED_DB=ISOLATED_DRAFT_TEST
CONFIRM_DOCUMENT_TABLES=EMPTY_DOCUMENT_TABLES_CONFIRMED
AUTH_MODE=cloudrun-iam
AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp
CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY
SERVICE=legalbridge-v2-write-test
'

# PROFILE=validation を指定すると隔離DB構成で走る（既定は本番構成）。
run_case() {
  local name="$1" expect="$2"; shift 2
  local output status
  output="$(
    set -a
    eval "${BASE_ENV}"
    if [ "${PROFILE:-production}" = "validation" ]; then
      eval "${VALIDATION_ENV}"
    else
      eval "${PRODUCTION_ENV}"
    fi
    for override in "$@"; do eval "${override}"; done
    set +a
    bash "${SCRIPT}" 2>&1
  )"
  status=$?
  local actual="allow"; [ "${status}" -ne 0 ] && actual="block"
  if [ "${actual}" = "${expect}" ]; then
    printf 'ok   %-58s %s\n' "${name}" "${actual}"
    [ "${SHOW:-}" = "1" ] && [ "${actual}" = "block" ] && printf '       └ %s\n' "$(echo "${output}" | tail -1)"
    return 0
  fi
  printf 'FAIL %-58s 期待=%s 実際=%s\n' "${name}" "${expect}" "${actual}"
  echo "${output}" | tail -3 | sed 's/^/       /'
  return 1
}

FAILED=0
echo "── 現行の承認済みサービス（write-test）─────────────────────────────"
run_case "本番プロファイルはそのまま通る" allow || FAILED=1
run_case "サービス名が違えば本番DBを拒む" block "SERVICE=legalbridge-v2-preview" || FAILED=1
run_case "未知のサービス名は拒む" block "SERVICE=some-other-service" || FAILED=1

echo
echo "── 名前以外のゲートが効いていること（緩めていない確認）───────────────"
run_case "本番確認トークンが無ければ拒む" block "CONFIRM_PRODUCTION_PRIMARY=" || FAILED=1
run_case "DB利用者が違えば拒む" block "DB_USER=postgres" || FAILED=1
run_case "パスワードのシークレット名が違えば拒む" block "DB_PASSWORD_SECRET=other-secret" || FAILED=1
run_case "認証を無効にすれば拒む" block "AUTH_MODE=disabled" || FAILED=1
run_case "PRIMARY_DB_MODE が不正なら拒む" block "PRIMARY_DB_MODE=whatever" || FAILED=1
run_case "管理者メールが違えば拒む" block "AUTH_ADMIN_EMAILS=someone@example.com" || FAILED=1

echo
echo "── 正式サービス名（§4 の載せ替え先）────────────────────────────────"
run_case "正式名でも本番プロファイルが通る" allow "SERVICE=legalbridge-v2" || FAILED=1
run_case "正式名でも確認トークンは要る" block "SERVICE=legalbridge-v2" "CONFIRM_PRODUCTION_PRIMARY=" || FAILED=1
run_case "正式名でもDB利用者は検証する" block "SERVICE=legalbridge-v2" "DB_USER=postgres" || FAILED=1

echo
# ここは隔離DB構成で走らせる。本番ゲートで先に止まると、個別の解禁ゲートを
# 通ったのか確かめられない（「正しい理由で落ちている」ことまで見る）。
# 各 capability は「フラグ true ＋ WRITE_SCOPES に対応スコープ ＋ 認証あり」で初めて通る。
# 認証は AUTH_MODE=iap を使う。cloudrun-iam 分岐はそれ自体がサービス名を検査するため、
# 未承認名だと解禁ゲートに届く前に止まってしまい、「どのゲートが効いたか」が確かめられない。
echo "── 個別の解禁ゲート：承認済みなら通り、未承認なら止まる───────────────"
for pair in "EXCEL_BATCH_ENABLED:excel-batch" "SETTINGS_WRITE_ENABLED:settings" \
            "WORKFLOW_RULES_WRITE_ENABLED:workflow-rules" \
            "CONTRACT_MASTER_WRITE_ENABLED:contract-master" \
            "SNIPPETS_WRITE_ENABLED:snippets" "ATTACHMENT_UPLOAD_ENABLED:attachments"; do
  key="${pair%%:*}"; scope="${pair##*:}"
  common=(
    "AUTH_MODE=iap" "CONFIRM_IAP_BACKEND=IAP_BACKEND_READY"
    "AUTH_LEGAL_EMAILS=legal@arclight.co.jp" "AUTH_REQUESTER_DOMAINS=arclight.co.jp"
    "${key}=true" "WRITE_SCOPES=drafts,documents,pdf,${scope}"
  )
  PROFILE=validation run_case "${key}: write-test なら通る" allow "${common[@]}" || FAILED=1
  PROFILE=validation run_case "${key}: 正式名でも通る" allow "SERVICE=legalbridge-v2" "${common[@]}" || FAILED=1
  PROFILE=validation run_case "${key}: 未承認名なら止まる" block "SERVICE=some-other-service" "${common[@]}" || FAILED=1
done

echo
echo "── 承認リストは実行時に広げられない──────────────────────────────"
PROFILE=validation run_case "環境変数 APPROVED_SERVICES では広げられない" block \
  "SERVICE=some-other-service" "AUTH_MODE=iap" "CONFIRM_IAP_BACKEND=IAP_BACKEND_READY" \
  "AUTH_LEGAL_EMAILS=legal@arclight.co.jp" "AUTH_REQUESTER_DOMAINS=arclight.co.jp" \
  "EXCEL_BATCH_ENABLED=true" "WRITE_SCOPES=drafts,documents,pdf,excel-batch" \
  "APPROVED_SERVICES='some-other-service'" || FAILED=1

echo
if [ "${FAILED}" -ne 0 ]; then echo "失敗したケースがあります"; exit 1; fi
echo "全ケース期待どおり"
