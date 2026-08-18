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
# 土台は正式名（§4 で載せ替え済み）。旧 write-test は下の明示ケースで押さえる。
PRODUCTION_ENV="${PRODUCTION_ENV/SERVICE=legalbridge-v2-write-test/SERVICE=legalbridge-v2}"

# 検証プロファイル（隔離DB）。本番ゲートを先に踏まずに、個別の解禁ゲートまで到達させる。
VALIDATION_ENV='
PRIMARY_DB_MODE=validation
CONFIRM_ISOLATED_DB=ISOLATED_DRAFT_TEST
CONFIRM_DOCUMENT_TABLES=EMPTY_DOCUMENT_TABLES_CONFIRMED
AUTH_MODE=cloudrun-iam
AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp
CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY
SERVICE=legalbridge-v2
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
echo "── 承認済みサービス─────────────────────────────────────────────"
run_case "正式名で本番プロファイルが通る" allow || FAILED=1
run_case "旧 write-test でも通る（観察期間中は両方生きている）" allow \
  "SERVICE=legalbridge-v2-write-test" || FAILED=1
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
echo "── 旧サービスでもゲートは同じに効く────────────────────────────────"
run_case "旧名でも確認トークンは要る" block \
  "SERVICE=legalbridge-v2-write-test" "CONFIRM_PRODUCTION_PRIMARY=" || FAILED=1
run_case "旧名でもDB利用者は検証する" block \
  "SERVICE=legalbridge-v2-write-test" "DB_USER=postgres" || FAILED=1

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
  PROFILE=validation run_case "${key}: 正式名なら通る" allow "${common[@]}" || FAILED=1
  PROFILE=validation run_case "${key}: 旧名でも通る" allow \
    "SERVICE=legalbridge-v2-write-test" "${common[@]}" || FAILED=1
  PROFILE=validation run_case "${key}: 未承認名なら止まる" block "SERVICE=some-other-service" "${common[@]}" || FAILED=1
done

echo
echo "── Backlog live（起票解禁・§5-3）──────────────────────────────────"
BACKLOG_LIVE=(
  "BACKLOG_MODE=live" "BACKLOG_HOST=arclight.backlog.com" "BACKLOG_PROJECT_KEY=LEGAL"
  "CONFIRM_BACKLOG_LIVE=BACKLOG_LIVE_CUTOVER_V2_AUTHORITATIVE"
)
run_case "合言葉が揃えば live を通す" allow "${BACKLOG_LIVE[@]}" || FAILED=1
run_case "合言葉が無ければ live を拒む（V1 が権威の間は塞ぐ）" block \
  "BACKLOG_MODE=live" "BACKLOG_HOST=arclight.backlog.com" "BACKLOG_PROJECT_KEY=LEGAL" || FAILED=1
run_case "live でもプロジェクトが違えば拒む" block "${BACKLOG_LIVE[@]}" "BACKLOG_PROJECT_KEY=OTHER" || FAILED=1
# 未承認名は本番プロファイルだと先に別のゲートで落ちる。どのゲートが効いたかを見るため
# 隔離DB＋IAP で走らせる（他の解禁ゲートと同じ扱い）。
PROFILE=validation run_case "live でも未承認サービスなら拒む" block \
  "${BACKLOG_LIVE[@]}" "SERVICE=some-other-service" \
  "AUTH_MODE=iap" "CONFIRM_IAP_BACKEND=IAP_BACKEND_READY" \
  "AUTH_LEGAL_EMAILS=legal@arclight.co.jp" "AUTH_REQUESTER_DOMAINS=arclight.co.jp" || FAILED=1
run_case "BACKLOG_MODE が不正なら拒む" block "BACKLOG_MODE=whatever" || FAILED=1
# コメント書き戻しは readonly 専用ではない（live へ上げた途端にデプロイが落ちないこと）。
BACKLOG_COMMENT=(
  "BACKLOG_COMMENT_WRITE_ENABLED=true"
  "CONFIRM_BACKLOG_COMMENT_WRITE=BACKLOG_COMMENT_WRITEBACK_VALIDATION_ONLY"
  "BACKLOG_HOST=arclight.backlog.com" "BACKLOG_PROJECT_KEY=LEGAL"
  "WRITE_SCOPES=drafts,documents,pdf,backlog-comment"
)
run_case "コメント書き戻し: readonly で通る" allow \
  "BACKLOG_MODE=readonly" "CONFIRM_BACKLOG_READONLY=BACKLOG_READONLY_VALIDATION_ONLY" \
  "${BACKLOG_COMMENT[@]}" || FAILED=1
run_case "コメント書き戻し: live でも通る" allow "${BACKLOG_LIVE[@]}" "${BACKLOG_COMMENT[@]}" || FAILED=1
run_case "コメント書き戻し: Backlog 未接続なら拒む" block \
  "BACKLOG_MODE=disabled" "${BACKLOG_COMMENT[@]}" || FAILED=1

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
