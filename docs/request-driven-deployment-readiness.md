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

Status: **IMPLEMENTED IN MAIN / DB preflight + normalized read/write smoke passed; browser/UI smoke pending**.

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
17. 028 normalized territory/language preflight (read-only)

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


### 028 preflight result

028 passed against production `legalbridge`:

- `condition_line_regions.country_code` and `condition_line_languages.language_code` are `varchar(16)`; `WORLD` / `ALL` fit without schema change.
- Runtime SELECT/INSERT/DELETE/UPDATE privileges required by normalized scope persistence are present.
- 68 condition lines already have canonical region child rows and 68 have canonical language child rows.
- Only 2 region values and 2 language values remain legacy-text-only; runtime fallback remains active until those rows are explicitly reviewed.
- Existing production data already uses `WORLD / 全世界` and `ALL / 全言語`.


### Work-rights normalized scope smoke

The first write-test API smoke exposed two repository serialization defects:

- canonical region/language child rows existed in production but `work-rights/:id` returned empty arrays;
- PostgreSQL date values were rendered from JavaScript `Date` strings, producing values such as `Mon May 13`.

Main now reads scope child rows explicitly and groups them by `condition_line_id`, with legacy text only as fallback. Work-rights contract and condition dates are serialized as Asia/Tokyo calendar dates. Regression tests cover both behaviors. Re-deploy and repeat the read smoke before enabling outbound-condition writes.


### Normalized read smoke passed

Normalized scope read smoke passed on Cloud Run revision `legalbridge-v2-write-test-00114-ntx` through the authenticated Cloud Run proxy:

- work `1000000043` returned canonical `WORLD / 全世界` region child rows for IN conditions 600, 601, and 602;
- the same conditions returned canonical `ALL / 全言語` language child rows;
- condition and contract dates were serialized as `YYYY-MM-DD` Tokyo calendar dates;
- `/health` remained healthy against production `legalbridge`;
- outbound-condition writes remained disabled during this read smoke.

Next gate: enable only the guarded `outbound-conditions` capability and perform one reversible parent-IN/child-scope round-trip smoke while all external integrations remain disabled.


### Outbound write smoke first attempt

The first guarded outbound write smoke was safely rejected with HTTP 422 before any insert:

- validation accepted the normalized US/en payload;
- persistence rejected it with `OUTBOUND_SCOPE_EXCEEDS_SOURCE`;
- root cause was legacy source child rows whose code values are missing: the work-rights reader already falls back to compatibility text, while the outbound persistence path treated any child row as canonical;
- persistence now ignores incomplete child scope rows and falls back to the source compatibility text. This preserves fail-safe behavior when neither canonical rows nor usable legacy text exists.

Repeat typecheck/test/build, redeploy with the guarded outbound capability enabled, then retry the same reversible smoke payload.


### Normalized outbound write round-trip passed

The guarded outbound-condition write smoke passed against production schema via the Cloud Run write-test service:

- source work: `1000000043`;
- source IN condition: `601`;
- document: `CT-2026-00008` / document id `1033`;
- counterparty vendor id: `36`;
- target scope: `US / en`;
- POST returned HTTP 201 and created condition id `603`;
- API round-trip returned `direction=receivable`, `flowDirection=out`, `parentLicenseConditionId=601`, canonical region `US`, canonical language `en`, and ISO dates;
- external integrations remained disabled/local;
- smoke row `603` was deleted after verification;
- remaining document 1033 condition lines are 600/601/602 with line numbers 5001/5002/5003, confirming the transient smoke line 5004 followed the existing `MAX(line_no)+1` convention and cleanup completed.

Normalized territory/language read and guarded write paths are now verified. Browser/UI smoke and remaining request-detail enrichment remain before production readiness.


### Browser scope smoke navigation

Before browser smoke, UI reachability was corrected:

- `＋ 作成・関連付け` now exposes `ライセンス契約` and `アウト条件`;
- query deep links `?view=license-contract` and `?view=outbound` are recognized;
- the outbound workspace is restricted to legal/admin users in the client;
- browser smoke should verify WORLD/ALL exclusivity, presets, individual country/language search, source-IN summary, in-scope success, and out-of-scope NG display.


### Legacy scope UI containment

Browser-smoke preparation found and fixed two client-side legacy-scope issues:

- OutboundConditionWorkspace now evaluates legacy IN territory/language compatibility text when canonical child codes are unavailable, instead of deferring the first visible rejection to the server;
- LicenseContractWorkspace no longer treats any legacy text containing the character `全` as universal. Only explicit `全世界/world` (region) and `全言語/all language` (language) are universal.

Candidate `work 1000000039 / condition 341` provides WORLD region with legacy Japanese-only language and can be used to verify client-side language overreach with an English OUT selection.
