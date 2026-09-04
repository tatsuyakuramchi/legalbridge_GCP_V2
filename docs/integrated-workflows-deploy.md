# Integrated workflows deployment runbook

## 1. Database privilege preflight

Run in Cloud SQL Studio as an administrative DB user:

1. `014_production_request_workflow_preflight_studio.sql`
2. Review all results.
3. `014_production_request_workflow_grants_studio.sql`
4. `014_production_request_workflow_verify_studio.sql`

Every boolean in the final verification query required by this slice should be `true`.

## 2. Build gate

The existing `infra/gcp/cloudbuild-write-test.yaml` runs:

```
npm ci
npm run typecheck
npm test
npm run build
```

before image build and deployment. Do not bypass this step.

## 3. Minimum production write-test capability

The new workflows require:

- `drafts`: new license contract draft and royalty statement draft
- `documents`: normal finalization
- `pdf`: normal PDF generation
- `matters`: Request -> Matter link and new Matter
- `contract-intake`: keep existing executed-license intake available

If vendor/staff/work/material CRUD is already enabled on the current service, keep those flags and scopes in the deployment. Do not silently remove currently enabled capabilities.

The exact WRITE_SCOPES order must follow `verify-write-test.sh`:

```
drafts,documents,pdf[,drive][,slack-approvals][,outbound-conditions],contract-intake,matters[,vendors][,staff][,works][,materials][,gmail][,cloudsign][,gmail-inbound][,slack,slack-dispatch]
```

Only include optional entries when the matching guarded feature is enabled.

## 4. Safe core command example

This example keeps external live send adapters disabled and enables the commonly used production write-test capabilities. Adjust only to preserve already-enabled capabilities.

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --project=legalbridge-488506 \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf,contract-intake,matters,vendors,staff,works,materials|_CONTRACT_INTAKE_WRITES_ENABLED=true|_CONFIRM_CONTRACT_INTAKE_WRITES=CONTRACT_INTAKE_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_WRITES_ENABLED=true|_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY|_VENDOR_WRITES_ENABLED=true|_CONFIRM_VENDOR_WRITES=VENDOR_MASTER_LEGALBRIDGE_VALIDATION_ONLY|_STAFF_WRITES_ENABLED=true|_CONFIRM_STAFF_WRITES=STAFF_MASTER_LEGALBRIDGE_VALIDATION_ONLY|_WORK_WRITES_ENABLED=true|_CONFIRM_WORK_WRITES=WORK_MASTER_LEGALBRIDGE_VALIDATION_ONLY|_MATERIAL_WRITES_ENABLED=true|_CONFIRM_MATERIAL_WRITES=MATERIAL_MASTER_LEGALBRIDGE_VALIDATION_ONLY"
```

If Drive / Slack / Gmail / CloudSign are already enabled in the current revision, carry their current substitutions into the new build rather than using this minimal example.

## 5. Post-deploy smoke tests

```bash
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)

curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/health" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/runtime" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/requests?limit=3" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/work-rights?limit=3" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/license-settlements/conditions?limit=3" | python3 -m json.tool
```

Expected:

- `/health`: 200, production `legalbridge`, readOnly false.
- `/runtime`: writeCapabilities contains at least `drafts`, `documents`, `pdf`, `contract-intake`, `matters`.
- Request, Work/Rights and settlement condition APIs return JSON, not SPA HTML.
- No external message is sent by these smoke tests.

## 6. UI verification

Proxy:

```bash
gcloud run services proxy legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --port=8080
```

Verify:

1. 依頼
   - legal consultation -> legal_response
   - standalone document
   - existing/new Matter
   - license contract
   - license settlement
2. 作品・権利
   - material list
   - rights source
   - IN/OUT matrix
   - contracts and lineage
3. 新規ライセンス契約
   - select Work
   - select source IN condition for OUT
   - rights check
   - create draft
4. 利用許諾料精算
   - sublicense receipt net-basis example
   - manufacturing event example
   - create royalty_statement draft

## 7. Rollback

Do not delete DB rows automatically.

Use the previous known-good Cloud Run revision:

```bash
gcloud run revisions list --service=legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506

gcloud run services update-traffic legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 \
  --to-revisions=KNOWN_GOOD_REVISION=100
```
