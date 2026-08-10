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
# コメント書き戻しは BACKLOG_MODE=live とは独立の限定capability（既定OFF）。
# 有効化には readonly接続＋検証専用の合言葉＋IAP等を要求する（liveブロックは維持）。
case "${BACKLOG_COMMENT_WRITE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_BACKLOG_COMMENT_WRITE}" != "BACKLOG_COMMENT_WRITEBACK_VALIDATION_ONLY" ]; then
      echo "Backlog comment write-back blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${BACKLOG_MODE}" != "readonly" ] || [ "${BACKLOG_HOST}" != "arclight.backlog.com" ] || [ "${BACKLOG_PROJECT_KEY}" != "LEGAL" ]; then
      echo "Backlog comment write-back blocked: service, mode, host, or project does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Backlog comment write-back blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: BACKLOG_COMMENT_WRITE_ENABLED must be true or false."
    exit 1
    ;;
esac
# 外部送信の総元栓。local 以外はサービス/認証を検証済みの write-test に限定する
# （各コネクタの *_MODE=live＋確認トークンに加え、この live が揃って初めて実送信）。
case "${INTEGRATION_MODE}" in
  local)
    ;;
  live)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Integration live blocked: external sends require the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Integration live blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: INTEGRATION_MODE must be local or live."
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
case "${WORK_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_WORK_WRITES}" != "WORK_MASTER_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Work master deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Work master deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Work master deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: WORK_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${MATERIAL_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_MATERIAL_WRITES}" != "MATERIAL_MASTER_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Material master deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Material master deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Material master deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: MATERIAL_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${RIGHTS_SOURCE_WRITES_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_RIGHTS_SOURCE_WRITES}" != "RIGHTS_SOURCE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Rights source deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Rights source deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Rights source deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: RIGHTS_SOURCE_WRITES_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${VENDOR_MERGE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_VENDOR_MERGE}" != "VENDOR_MERGE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Vendor merge deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Vendor merge deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Vendor merge deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: VENDOR_MERGE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${MATTER_MERGE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_MATTER_MERGE}" != "MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Matter merge deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Matter merge deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Matter merge deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: MATTER_MERGE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${MATTER_DELETE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_MATTER_DELETE}" != "MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Matter delete deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Matter delete deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Matter delete deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: MATTER_DELETE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${DOCUMENT_VOID_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_DOCUMENT_VOID}" != "DOCUMENT_VOID_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Document void deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Document void deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Document void deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: DOCUMENT_VOID_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${DOCUMENT_REISSUE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_DOCUMENT_REISSUE}" != "DOCUMENT_REISSUE_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Document reissue deployment blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Document reissue deployment blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Document reissue deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: DOCUMENT_REISSUE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${EXCEL_BATCH_ENABLED}" in
  false)
    ;;
  true)
    # 発行済みマークは隔離台帳(lb_v2_excel_export_ledger)への append のみ＝確認トークン不要。
    # 書込サービス限定＋IAP/IAM は必須。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Excel batch deployment blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Excel batch deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: EXCEL_BATCH_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${SETTINGS_WRITE_ENABLED}" in
  false)
    ;;
  true)
    # 会社プロファイル（app_settings・allowlist キー）編集。書込サービス限定＋IAP/IAM 必須。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Settings write deployment blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Settings write deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SETTINGS_WRITE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${WORKFLOW_RULES_WRITE_ENABLED}" in
  false)
    ;;
  true)
    # 承認ルート（department_workflow_rules）編集。書込サービス限定＋IAP/IAM 必須。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Workflow rules deployment blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Workflow rules deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: WORKFLOW_RULES_WRITE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${CONTRACT_MASTER_WRITE_ENABLED}" in
  false)
    ;;
  true)
    # 契約マスタ（contracts 列 UPDATE）編集。書込サービス限定＋IAP/IAM 必須。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Contract master deployment blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Contract master deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: CONTRACT_MASTER_WRITE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${SNIPPETS_WRITE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Snippets deployment blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Snippets deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SNIPPETS_WRITE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${JOBS_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Jobs endpoint blocked: limited to the write-test service."
      exit 1
    fi
    if [ -z "${JOBS_TRIGGER_TOKEN_SECRET}" ] || [ "${JOBS_TRIGGER_TOKEN_SECRET}" = "BLOCKED" ]; then
      echo "Jobs endpoint blocked: JOBS_TRIGGER_TOKEN_SECRET (shared-secret) is required."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Jobs endpoint blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: JOBS_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${SLACK_INTAKE_ENABLED}" in
  false)
    ;;
  true)
    # Slack 法務依頼インテーク受信口（16-3a）。署名シークレット必須・write-test 限定・IAP/IAM 必須。
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Slack intake blocked: limited to the write-test service."
      exit 1
    fi
    if [ -z "${SLACK_SIGNING_SECRET_NAME}" ] || [ "${SLACK_SIGNING_SECRET_NAME}" = "BLOCKED" ]; then
      echo "Slack intake blocked: SLACK_SIGNING_SECRET_NAME (Slack signing secret) is required."
      exit 1
    fi
    if [ -z "${SLACK_BOT_TOKEN_SECRET}" ] || [ "${SLACK_BOT_TOKEN_SECRET}" = "BLOCKED" ]; then
      echo "Slack intake blocked: SLACK_BOT_TOKEN_SECRET is required (views.open needs the bot token)."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Slack intake blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: SLACK_INTAKE_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${CONTRACT_EXPIRY_TRANSITION_ENABLED}" in
  false)
    ;;
  true)
    if [ "${CONFIRM_CONTRACT_EXPIRY}" != "CONTRACT_EXPIRY_LEGALBRIDGE_VALIDATION_ONLY" ]; then
      echo "Contract expiry transition blocked: explicit production validation confirmation is missing."
      exit 1
    fi
    if [ "${JOBS_ENABLED}" != "true" ]; then
      echo "Contract expiry transition blocked: JOBS_ENABLED=true is required (runs inside daily-checks)."
      exit 1
    fi
    if [ "${PRIMARY_DB_MODE}" != "production" ] || [ "${SERVICE}" != "legalbridge-v2-write-test" ] || [ "${DB_NAME}" != "legalbridge" ] || [ "${DB_USER}" != "legalbridge_v2_runtime" ] || [ "${DB_PASSWORD_SECRET}" != "legalbridge-v2-runtime-db-password" ]; then
      echo "Contract expiry transition blocked: service, database, runtime user, or password secret does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Contract expiry transition blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: CONTRACT_EXPIRY_TRANSITION_ENABLED must be true or false."
    exit 1
    ;;
esac
# 外部 Webhook 受信口（CloudSign 9-5 / Backlog 9-7）。共有シークレット未設定なら自動的に無効
# （webhooks-routes が token 未設定＝404）。シークレット注入時は write-test サービス限定。
# 外部プロバイダから到達するためユーザー認証はバイパス済み・共有シークレットのみで保護する。
for webhook_secret in "CLOUDSIGN_WEBHOOK_TOKEN_SECRET:${CLOUDSIGN_WEBHOOK_TOKEN_SECRET:-BLOCKED}" "BACKLOG_WEBHOOK_TOKEN_SECRET:${BACKLOG_WEBHOOK_TOKEN_SECRET:-BLOCKED}"; do
  webhook_name="${webhook_secret%%:*}"
  webhook_value="${webhook_secret#*:}"
  if [ -n "${webhook_value}" ] && [ "${webhook_value}" != "BLOCKED" ]; then
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Webhook endpoint blocked: ${webhook_name} is limited to the write-test service."
      exit 1
    fi
  fi
done
case "${GMAIL_DELIVERY_MODE}" in
  disabled)
    ;;
  live)
    if [ "${CONFIRM_GMAIL_DISPATCH}" != "GMAIL_DISPATCH_VALIDATION_ONLY" ]; then
      echo "Gmail dispatch deployment blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Gmail dispatch deployment blocked: service does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Gmail dispatch deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    if [ -z "${GMAIL_SENDER}" ] || [ "${GMAIL_SENDER}" = "BLOCKED" ]; then
      echo "Gmail dispatch deployment blocked: a send-as sender address is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: GMAIL_DELIVERY_MODE must be live or disabled."
    exit 1
    ;;
esac
# Gmail 送信の冪等履歴（append専用・Slack履歴同型）。有効化は隔離検証DBに限定する
# （grant 019 が lb_v2_gmail_send_history を作成・SELECT/INSERT のみ付与）。
case "${GMAIL_SEND_HISTORY_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Gmail send-history blocked: append-only history is limited to the write-test service."
      exit 1
    fi
    if [ "${DB_NAME}" != "legalbridge_v2_validation" ] && [ "${DB_NAME}" != "legalbridge" ]; then
      echo "Gmail send-history blocked: unexpected database target."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: GMAIL_SEND_HISTORY_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${CLOUDSIGN_MODE}" in
  disabled)
    ;;
  live)
    if [ "${CONFIRM_CLOUDSIGN_DISPATCH}" != "CLOUDSIGN_DISPATCH_VALIDATION_ONLY" ]; then
      echo "CloudSign dispatch deployment blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "CloudSign dispatch deployment blocked: service does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "CloudSign dispatch deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    if [ -z "${CLOUDSIGN_CLIENT_ID_SECRET}" ] || [ "${CLOUDSIGN_CLIENT_ID_SECRET}" = "BLOCKED" ]; then
      echo "CloudSign dispatch deployment blocked: a CloudSign client id secret (Secret Manager name) is required."
      exit 1
    fi
    # 検証中の誤送信防止：live 点火時は宛先allowlistを必須にする（V1 テストガード相当）。
    if [ -z "${CLOUDSIGN_ALLOWED_RECIPIENTS}" ] || [ "${CLOUDSIGN_ALLOWED_RECIPIENTS}" = "BLOCKED" ]; then
      echo "CloudSign dispatch deployment blocked: CLOUDSIGN_ALLOWED_RECIPIENTS (recipient allowlist) is required for validation."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: CLOUDSIGN_MODE must be live or disabled."
    exit 1
    ;;
esac
# CloudSign 依頼の冪等履歴（append専用・grant 022 で lb_v2_cloudsign_requests 作成・
# SELECT/INSERT/UPDATE のみ付与）。有効化は隔離検証DB＋write-testサービスに限定する。
case "${CLOUDSIGN_REQUEST_HISTORY_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "CloudSign request-history blocked: append-only history is limited to the write-test service."
      exit 1
    fi
    if [ "${DB_NAME}" != "legalbridge_v2_validation" ] && [ "${DB_NAME}" != "legalbridge" ]; then
      echo "CloudSign request-history blocked: unexpected database target."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: CLOUDSIGN_REQUEST_HISTORY_ENABLED must be true or false."
    exit 1
    ;;
esac
# 案件 Slack スレッド（法務相談・チャンネル投稿＋メンション）。外部投稿のため
# INTEGRATION_MODE=live＋Slack live＋投稿先チャンネル＋write-test＋IAP/IAM を要求する。
case "${MATTER_SLACK_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Matter Slack blocked: limited to the write-test service."
      exit 1
    fi
    if [ "${INTEGRATION_MODE}" != "live" ]; then
      echo "Matter Slack blocked: INTEGRATION_MODE=live is required for external Slack posts."
      exit 1
    fi
    if [ "${SLACK_DELIVERY_MODE}" != "live" ]; then
      echo "Matter Slack blocked: SLACK_DELIVERY_MODE=live is required."
      exit 1
    fi
    if [ -z "${SLACK_LEGAL_CONSULT_CHANNEL}" ] || [ "${SLACK_LEGAL_CONSULT_CHANNEL}" = "BLOCKED" ]; then
      echo "Matter Slack blocked: SLACK_LEGAL_CONSULT_CHANNEL (target channel) is required."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Matter Slack blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: MATTER_SLACK_ENABLED must be true or false."
    exit 1
    ;;
esac
case "${GMAIL_INBOUND_MODE}" in
  disabled)
    ;;
  live)
    if [ "${CONFIRM_GMAIL_INBOUND}" != "GMAIL_INBOUND_VALIDATION_ONLY" ]; then
      echo "Gmail inbound deployment blocked: explicit validation confirmation is missing."
      exit 1
    fi
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Gmail inbound deployment blocked: service does not match the approved target."
      exit 1
    fi
    if [ "${AUTH_MODE}" != "iap" ] && [ "${AUTH_MODE}" != "cloudrun-iam" ]; then
      echo "Gmail inbound deployment blocked: IAP or Cloud Run IAM authentication is required."
      exit 1
    fi
    if [ -z "${GMAIL_INBOUND_MAILBOX}" ] || [ "${GMAIL_INBOUND_MAILBOX}" = "BLOCKED" ]; then
      echo "Gmail inbound deployment blocked: a target mailbox is required."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: GMAIL_INBOUND_MODE must be live or disabled."
    exit 1
    ;;
esac
# 受信取込の登録台帳（append専用・grant 020 で lb_v2_inbound_contracts を作成・
# SELECT/INSERT/UPDATE のみ付与）。有効化は隔離検証DB＋write-testサービスに限定する。
case "${GMAIL_INBOUND_INTAKE_ENABLED}" in
  false)
    ;;
  true)
    if [ "${SERVICE}" != "legalbridge-v2-write-test" ]; then
      echo "Gmail inbound intake blocked: append-only intake ledger is limited to the write-test service."
      exit 1
    fi
    if [ "${DB_NAME}" != "legalbridge_v2_validation" ] && [ "${DB_NAME}" != "legalbridge" ]; then
      echo "Gmail inbound intake blocked: unexpected database target."
      exit 1
    fi
    ;;
  *)
    echo "Deployment blocked: GMAIL_INBOUND_INTAKE_ENABLED must be true or false."
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
if [ "${WORK_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,works"
fi
if [ "${MATERIAL_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,materials"
fi
if [ "${RIGHTS_SOURCE_WRITES_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,rights-sources"
fi
if [ "${VENDOR_MERGE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,vendor-merge"
fi
if [ "${MATTER_MERGE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,matter-merge"
fi
if [ "${MATTER_DELETE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,matter-delete"
fi
if [ "${DOCUMENT_VOID_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,document-void"
fi
if [ "${DOCUMENT_REISSUE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,document-reissue"
fi
if [ "${EXCEL_BATCH_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,excel-batch"
fi
if [ "${SETTINGS_WRITE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,settings"
fi
if [ "${WORKFLOW_RULES_WRITE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,workflow-rules"
fi
if [ "${CONTRACT_MASTER_WRITE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,contract-master"
fi
if [ "${SNIPPETS_WRITE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,snippets"
fi
if [ "${BACKLOG_COMMENT_WRITE_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,backlog-comment"
fi
if [ "${GMAIL_DELIVERY_MODE}" = "live" ]; then
  expected_write_scopes="$expected_write_scopes,gmail"
fi
if [ "${CLOUDSIGN_MODE}" = "live" ]; then
  expected_write_scopes="$expected_write_scopes,cloudsign"
fi
if [ "${GMAIL_INBOUND_MODE}" = "live" ]; then
  expected_write_scopes="$expected_write_scopes,gmail-inbound"
fi
if [ "${SLACK_DISPATCH_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,slack,slack-dispatch"
fi
if [ "${MATTER_SLACK_ENABLED}" = "true" ]; then
  expected_write_scopes="$expected_write_scopes,matter-slack"
fi
if [ "${WRITE_SCOPES}" != "$expected_write_scopes" ]; then
  echo "Deployment blocked: WRITE_SCOPES does not exactly match the enabled guarded capabilities."
  exit 1
fi
