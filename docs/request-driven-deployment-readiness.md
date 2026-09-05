# LegalBridge V2 — Request Driven UI deployment readiness

Status: **DEPLOYMENT PREPARATION / PR remains DRAFT**

This document freezes the final UI direction and separates **must-fix before deployment** from **write-test / cutover validation**.

## 1. Frozen product direction

The standard experience is Request Driven:

```
Home / Today
  -> Request
      -> one primary "next action"
          -> search
          -> select
          -> quote canonical DB data
          -> confirm
          -> enter only missing facts
```

Users should not need to understand Matter / Work / Condition / Contract table structure to complete ordinary work.

The global escape hatch remains available from every screen:

**＋ 作成・関連付け**

It supports:

- 案件: create / edit / link
- 作品: create / edit / link
- 文書: create / edit / link
- 条件: create / edit / link
- 担当者: create / edit / link
- 取引先: create / edit / link
- 送信: Gmail / CloudSign / Slack

The normal workflow stays simple; legal/admin users can repair or supplement data without a future UI redesign.

## 2. MUST FIX before deployment

### A. Request Driven shell in the React application

Status: **CORE IMPLEMENTED IN MAIN / related-data chip enrichment and write-test smoke pending**.

Implemented behavior:

- Home = 今日やること / next actions, not a feature catalog. **Implemented.**
- Request detail shows exactly one primary next action. **Implemented.**
- Related-data chips show Matter / Work / Document / Condition / Vendor / Staff.
- The universal **＋ 作成・関連付け** entry point is available globally. **Implemented.**
- Domain screens remain available as management/repair screens, not the main day-to-day navigation. **Implemented via reduced nav + contextual/global entry points.**

Existing domain APIs and repositories should be reused; this is primarily an interaction-layer change.

### B. Restore normalized region/language selection in V2

Production data model and legacy implementation already support normalized 1:N values:

```
condition_lines
  -> condition_line_regions
       country_code / country_name / sort_order
  -> condition_line_languages
       language_code / language_name / sort_order
```

Legacy semantics:

- country/language selection, not free text
- multiple selection
- ISO/special codes
- WORLD = 全世界
- ALL = 全言語
- region presets (北米 / 欧州 / アジア / オセアニア / 中南米)
- child rows are canonical
- `condition_lines.region_territory` and `region_language` are compatibility display strings only

Current V2 regressions that must be removed:

- `LicenseContractWorkspace` uses a single free-text territory/language field.
- `OutboundConditionWorkspace` uses free-text territory and comma-separated languages.
- `PgOutboundConditionRepository` currently inserts only compatibility text columns and does not populate the child tables.

Required save behavior:

1. UI holds `regions: {code,name}[]` and `languages: {code,name}[]`.
2. Write `condition_lines`.
3. Replace child rows in the same transaction.
4. Compose compatibility strings from selected names.
5. Read child rows first; legacy text is fallback only.

### C. Slack attachment link must be issued after Backlog issue creation

Do not show a generic actionable upload URL before a Backlog issue exists.

Correct flow:

```
Slack intake
 -> create Backlog LEGAL-xxxx
 -> create/link Legal Request
 -> completion DM
      [LegalBridgeで続ける]
      [資料をアップロード]
 -> /attachments/upload?issue=LEGAL-xxxx&u=...&exp=...&sig=...
```

Reuse the existing legacy attachment uploader until a V2 uploader replaces it.

### D. Slack inbound gateway cutover remains separate

The V2 thin modal design exists, but the live Slack App Request URL still points at the legacy gateway.

Do not switch it before:

- `views.open`
- dynamic `views.update`
- `view_submission`
- Request creation
- Backlog issue creation
- signed attachment link
- V2 deep link

all pass in write-test.

## 3. Database deployment order

Run only after code parity is complete.

1. 014 Request workflow preflight
2. 014 Request workflow grants
3. 014 Request workflow verify
4. 015 generic legal document template
5. 016 royalty_statement v9
6. 017 M5 royalty normalization preflight
7. 018 M5 royalty normalization schema
8. 019 M5 royalty normalization backfill
9. 020 M5 runtime grants
10. 021 M5 verification
11. 022 condition attachment preflight
12. 023 condition attachment grants
13. 024 condition attachment verify
14. 025 request deadline / condition flow-direction backfill
15. 026 document number history / previous-number rendering support
16. 027 unified deadline runtime grants

Region/language child tables already exist in the production lineage; deployment preflight must verify the relations and runtime privileges rather than recreate or reinterpret them.

## 4. Build gate

The PR does not leave Draft until all pass:

```
npm ci
npm run typecheck
npm test
npm run build
```

No exception for UI-only changes.

## 5. Write-test deployment

Target only:

```
legalbridge-v2-write-test
```

Keep all current safety gates.

External integrations must not be silently dropped from WRITE_SCOPES.

Expected order remains capability-driven:

```
drafts,documents,pdf
[,drive]
[,slack-approvals]
[,outbound-conditions]
[,contract-intake]
[,matters]
[,vendors]
[,staff]
[,works]
[,materials]
[,condition-attachments]
[,gmail]
[,cloudsign]
[,gmail-inbound]
[,slack,slack-dispatch]
```

## 6. Mandatory smoke tests

### Request Driven UI

- legal review can complete without Matter
- standalone document can complete without Matter
- request can become a new Matter
- request can link to an existing Matter
- universal create/link entry point is accessible from Request and management screens
- related chips open the linked record

### Service / outsourcing

- service master agreement
- purchase order
- deliverable
- delivery
- inspection
- payment
- ownership/license choice for deliverables

### License / rights

- select existing Work from DB
- select Vendor from DB
- select source IN condition
- choose multiple regions
- choose multiple languages
- WORLD / ALL handling
- region preset expansion
- OUT scope must not exceed source IN scope
- child table rows persist and read back
- legacy compatibility text is composed correctly

### Historical repair

- attach a condition to an existing document
- attach Work to a past license document
- attach source Work/material where appropriate
- attach OUT condition to source IN with `parent_license_condition_id`
- do not rewrite historical PDF/form_data

### Royalty settlement

- manufacturing trigger
- sale trigger
- sublicense receipt trigger
- JPY / EUR / USD
- tax 10% / 0%
- bank/invoice fields
- no inferred paid status
- MG/AG warning behavior

### External

- PDF
- Drive
- Gmail
- CloudSign
- Slack notification
- Slack intake modal
- signed Backlog-linked attachment URL

## 7. Cutover order

```
code parity
 -> build gate
 -> DB preflight/migrations/verify
 -> write-test deployment
 -> smoke tests
 -> mark PR ready
 -> merge
 -> deploy merged commit
 -> switch Slack App Request URL last
```

## 8. No-go conditions

Do not deploy production when any of these remain true:

- Request Driven UI write-test smoke has not passed
- region/language is still free-text in V2
- child region/language rows are not written transactionally
- Slack attachment URL is not bound to a real Backlog issue
- Cloud Build/typecheck/test/build has not passed
- DB verification SQL has not passed
- write-test smoke has not passed

## 9. Document number continuity

Number reassignment must preserve the immediately previous number.

Implementation:

- `document_number_history` captures every `documents.document_number` change by DB trigger.
- Legacy `BASE_DOC_NO` / old-number form fields are backfilled when available.
- Document registry search/detail exposes the latest previous number.
- Template/PDF rendering injects `PREVIOUS_DOCUMENT_NUMBER`, `旧文書番号`, and compatible `BASE_DOC_NO` values.
- When the template itself does not render the previous number, the renderer adds a compact `旧文書番号：...` notice automatically.
