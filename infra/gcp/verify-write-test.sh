#!/usr/bin/env bash
set -euo pipefail

test "${SERVICE}" != "legalbridge-v2-preview"
case "${PRIMARY_DB_MODE}" in
  validation)
    test "${DB_NAME}" != "legalbridge"
    test "${DB_USER}" != "legalbridge"
    if [ "${CONFIRM_ISOLATED_DB}" != "ISOLATED_DRAFT_TEST" ]; then
      echo "Write-test deployment blocked: isolated DB confirmation is missing."
      exit 1
    fi
    if [ "${CONFIRM_DOCUMENT_TABLES}" != "EMPTY_DOCUMENT_TABLES_CONFIRMED" ]; then
      echo "Document finalization deployment blocked: empty validation tables are not confirmed."
      exit 1
    fi
    ;;
  production)
    if [ "${CONFIRM_PRODUCTION_PRIMARY}" != "CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE" ]; then
      echo "Production primary deployment blocked: explicit cutover confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Production primary deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${CONFIRM_DOCUMENT_TABLES}" != "PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED" ]; then
      echo "Production primary deployment blocked: production document-table preflight is not confirmed."
      exit 1
    fi
    if [ "${AUTH_MODE}" = "disabled" ]; then
      echo "Production primary deployment blocked: upstream authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: PRIMARY_DB_MODE must be validation or production."
    exit 1
    ;;
esac
case "${AUTH_MODE}" in
  disabled)
    ;;
  cloudrun-iam)
    if [ "${CONFIRM_CLOUDRUN_IAM}" != "CLOUDRUN_IAM_PROXY_VALIDATION_ONLY" ]; then
      echo "Cloud Run IAM deployment blocked: explicit proxy-validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${AUTH_ADMIN_EMAILS}" != "tatsuya.kuramochi@arclight.co.jp" ]; then
      echo "Cloud Run IAM deployment blocked: service or sole administrator does not match the approved validation target."
      exit 1
    fi
    ;;
  iap)
    if [ "${CONFIRM_IAP_BACKEND}" != "IAP_BACKEND_READY" ]; then
      echo "IAP deployment blocked: backend readiness confirmation is missing."
      exit 1
    fi
    for value in "${AUTH_ADMIN_EMAILS}" "${AUTH_LEGAL_EMAILS}" "${AUTH_REQUESTER_DOMAINS}"; do
      if [ -z "$value" ] || [ "$value" = "BLOCKED" ]; then
        echo "IAP deployment blocked: role configuration is missing."
        exit 1
      fi
    done
    ;;
  *)
    echo "Deployment blocked: AUTH_MODE must be disabled, cloudrun-iam, or iap."
    exit 1
    ;;
esac
case "${BACKLOG_MODE}" in
  disabled)
    ;;
  readonly)
    if [ "${CONFIRM_BACKLOG_READONLY}" != "BACKLOG_READONLY_VALIDATION_ONLY" ]; then
      echo "Backlog deployment blocked: explicit read-only validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${BACKLOG_HOST}" != "arclight.backlog.com" ] || [ "${BACKLOG_PROJECT_KEY}" != "LEGAL" ]; then
      echo "Backlog deployment blocked: validation service, host, or project does not match the approved target."
      exit 1
    fi
    ;;
  live)
    echo "Backlog live writes remain blocked while the existing worker is authoritative."
    exit 1
    ;;
  *)
    echo "Deployment blocked: BACKLOG_MODE must be disabled or readonly."
    exit 1
    ;;
esac
case "${SLACK_DELIVERY_MODE}" in
  disabled)
    ;;
  live)
    if [ "${SLACK_DISPATCH_ENABLED}" != "true" ]; then
      echo "Slack live delivery requires SLACK_DISPATCH_ENABLED=true with the validation gate."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SLACK_DELIVERY_MODE must be disabled or live."
    exit 1
    ;;
esac
case "${SLACK_DISPATCH_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_SLACK_DISPATCH}" != "SLACK_DISPATCH_VALIDATION_ONLY" ]; then
      echo "Slack dispatch deployment blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${SLACK_DELIVERY_MODE}" != "live" ]; then
      echo "Slack dispatch deployment blocked: service or delivery mode does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Slack dispatch deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    if [ "${SLACK_APPROVAL_WRITES_ENABLED}" != "true" ] || [ "${SLACK_NOTIFICATION_HISTORY_ENABLED}" != "true" ] || [ "${SLACK_NOTIFICATION_APPROVALS_ENABLED}" != "true" ]; then
      echo "Slack dispatch deployment blocked: approval writes, history, and approvals must all be enabled."
      exit 1
    fi
    if [ -z "${SLACK_DRY_RUN_USER_MAP}" ] || [ "${SLACK_DRY_RUN_USER_MAP}" = "UNRESOLVED" ]; then
      echo "Slack dispatch deployment blocked: an explicit validation recipient map is required."
      exit 1
    fi
    if [ -z "${SLACK_BOT_TOKEN_SECRET}" ] || [ "${SLACK_BOT_TOKEN_SECRET}" = "BLOCKED" ]; then
      echo "Slack dispatch deployment blocked: Slack bot token secret is not set."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SLACK_DISPATCH_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${OUTBOUND_CONDITION_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_OUTBOUND_WRITES}" != "OUTBOUND_WRITES_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Outbound deployment blocked: explicit production-schema validation confirmation is missing."
      exit 1
    fi
    expected_outbound_user="legalbridge_v2_outbound_writer"
    expected_outbound_secret="legalbridge-v2-outbound-db-password"
    if [ "${PRIMARY_DB_MODE}" = "production" ]; then
      expected_outbound_user="legalbridge_v2_runtime"
      expected_outbound_secret="legalbridge-v2-runtime-db-password"
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${OUTBOUND_DB_NAME}" != "legalbridge" ] || [ "${OUTBOUND_DB_USER}" != "$expected_outbound_user" ] || [ "${OUTBOUND_DB_PASSWORD_SECRET}" != "$expected_outbound_secret" ]; then
      echo "Outbound deployment blocked: service, database, dedicated user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Outbound deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: OUTBOUND_CONDITION_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${CONTRACT_INTAKE_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_CONTRACT_INTAKE_WRITES}" != "CONTRACT_INTAKE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Contract intake deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Contract intake deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Contract intake deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: CONTRACT_INTAKE_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${MATTER_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_MATTER_WRITES}" != "MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Matter management deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Matter management deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Matter management deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: MATTER_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${VENDOR_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_VENDOR_WRITES}" != "VENDOR_MASTER_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Vendor master deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Vendor master deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Vendor master deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: VENDOR_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${STAFF_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_STAFF_WRITES}" != "STAFF_MASTER_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Staff master deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Staff master deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Staff master deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: STAFF_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${SLACK_APPROVAL_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_SLACK_APPROVAL_WRITES}" != "SLACK_APPROVAL_WRITES_VALIDATION_ONLY" ]; then
      echo "Slack approval deployment blocked: explicit validation-only confirmation is missing."
      exit 1
    fi
    # 隔離検証DB、または本番runtime（006がlegalbridgeにSlack履歴/承認
    # テーブルを作成しruntimeへ権限付与済み）のいずれかを許可する。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Slack approval deployment blocked: target service is not the write-test environment."
      exit 1
    fi
    if [ "${DB_NAME}" != "legalbridge_v2_validation" ] && [ "${DB_NAME}" != "legalbridge" ]; then
      echo "Slack approval deployment blocked: unexpected database target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Slack approval deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    if [ "${SLACK_NOTIFICATION_HISTORY_ENABLED}" != "true" ] || [ "${SLACK_NOTIFICATION_APPROVALS_ENABLED}" != "true" ]; then
      echo "Slack approval deployment blocked: history and approval repositories must both be enabled."
      exit 1
    fi
    if [ -z "${SLACK_DRY_RUN_USER_MAP}" ] || [ "${SLACK_DRY_RUN_USER_MAP}" = "UNRESOLVED" ]; then
      echo "Slack approval deployment blocked: an explicit dry-run recipient map is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SLACK_APPROVAL_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${DRIVE_STORAGE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_DRIVE_STORAGE}" != "DRIVE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Drive deployment blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${GOOGLE_DRIVE_FOLDER_ID}" = "BLOCKED" ] || [ -z "${GOOGLE_DRIVE_FOLDER_ID}" ]; then
      echo "Drive deployment blocked: service or Shared Drive folder is not set."
      exit 1
    fi
    # _GWS_SA_KEY_SECRET は任意。未設定なら鍵ファイルをマウントせず
    # ADC（ランタイムSA + drive スコープ）で認証する（V1本番と同方式）。
    # その場合、ランタイムSAが対象の共有ドライブフォルダのメンバーで
    # あること。
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Drive deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: DRIVE_STORAGE_ENABLED must be true or false."
    exit 1
    ;;
esac
expected_write_scopes="drafts,documents,pdf"
if [ "${DRIVE_STORAGE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,drive"
fi
if [ "${SLACK_APPROVAL_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,slack-approvals"
fi
if [ "${OUTBOUND_CONDITION_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,outbound-conditions"
fi
if [ "${CONTRACT_INTAKE_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,contract-intake"
fi
if [ "${MATTER_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,matters"
fi
if [ "${VENDOR_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,vendors"
fi
if [ "${STAFF_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,staff"
fi
if [ "${SLACK_DISPATCH_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,slack,slack-dispatch"
fi
if [ "${WRITE_SCOPES}" != "$expected_write_scopes" ]; then
  echo "Deployment blocked: WRITE_SCOPES does not exactly match the enabled guarded capabilities."
  exit 1
fi
