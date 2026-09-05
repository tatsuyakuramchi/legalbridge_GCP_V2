# Slack intake redesign — V2 aligned

## Goal

Slack is the intake surface, not a second copy of every document form.

The previous gateway duplicated detailed fields for purchase orders, individual licenses, inspections and royalty statements. That created schema drift whenever a LegalBridge template or domain model changed.

V2 uses:

\`\`\`
Slack
  -> Request
      -> simple request completes in legal
      -> specialized work opens the LegalBridge workspace
          -> domain DB
          -> template context
          -> document
\`\`\`

## Core invariant

> Slack asks business facts needed to route the request. LegalBridge owns template-specific, contract-specific, financial and rights-specific fields.

Each selected workflow has at most five substantive input blocks, excluding the common workflow selector. The material-upload link is a shared context link and is not counted as an input field.

The active DB template catalog is loaded through \`TemplateRepository\`. Slack must not maintain copies of the 25+ template field schemas.

## Workflows

| Workflow | Slack asks | LegalBridge destination | Output |
|---|---|---|---|
| 法務相談・レビュー | 件名、希望納期、相談内容 | Request | legal_response when needed |
| 文書を作成 | Template、件名、相手方、概要 | Template/Document form | selected template |
| ライセンス契約を新規作成 | IN/OUT、件名、相手方、作品ヒント、概要 | LicenseContractWorkspace | selected license template |
| 発注書を作成 | 発注Template、件名、相手方、概要 | Order/Document workspace | purchase_order / intl_purchase_order |
| 納品・検収 | 対象発注/契約番号、納品日、概要 | Delivery/Inspection | inspection_certificate |
| 利用許諾料を精算 | 発生事由、対象契約、発生日、作品ヒント、補足 | LicenseSettlementWorkspace | royalty_statement |
| 納期変更 | 対象課題、新納期、理由 | Slack inline | no document |

## Template routing

The V2 catalog classifies templates as follows.

### Output-only / workflow-owned

- \`legal_response\` -> legal review
- \`royalty_statement\` -> license settlement
- \`inspection_certificate\` -> delivery / inspection

These templates are not shown in the generic "document create" selector.

### Purchase-order workflow

- \`purchase_order\`
- \`intl_purchase_order\`

### License-contract workflow

- \`license_master\`
- \`individual_license_terms\`
- \`individual_license_terms_v3\`
- \`igla_license_en\`
- \`igla_license_annex_en\`
- \`license_out_en\`

### Generic document workflow

All other active document templates are read from the DB and exposed as document choices, including the new \`legal_freeform\`.

No Slack code change is necessary just to add another normal document template.

## License contract

Slack does NOT collect:

- territory
- language
- exclusivity
- sublicense
- term
- royalty basis
- rate
- MG / AG
- Product-Out detail

Slack only asks IN/OUT and enough context to create the Request.

The LicenseContractWorkspace then resolves:

\`\`\`
Request
  -> Work
  -> source rights / IN condition
  -> IN / OUT
  -> condition matrix
  -> detailed terms
  -> template
\`\`\`

## Royalty / sublicense settlement

The old Slack form asked free-text sales, rate and unit-price values. That is removed from the V2 design.

Slack asks only:

\`\`\`
What happened?
  - manufacturing
  - sale
  - sublicense receipt

target contract if known
event / receipt date
work hint if known
summary / note
\`\`\`

The Settlement Workspace owns all money data:

\`\`\`
event
 -> OUT condition
 -> parent/source IN condition
 -> basis
 -> deductions
 -> rate / MG / AG
 -> canonical calculation
 -> royalty_statement
\`\`\`

This prevents Slack-entered royalty terms from overriding the contractual condition engine.

## Purchase order

Slack no longer captures a line-by-line shadow model of:

- IP ownership
- work specification
- payment method
- payment due date
- amount
- royalty terms

Those fields belong to the V2 order / condition / deliverable model. Slack asks only enough to open the Request.

## Document creation

The document selector is generated from the active DB Template catalog.

The generic workflow is intentionally appropriate for:

- NDA
- service agreement
- sales agreement
- publishing forms
- memorandum / agreement / notice / confirmation through \`legal_freeform\`
- other active templates not assigned to a specialized workflow

The actual template \`field_schema\` is rendered only by the LegalBridge document form.

## Modal implementation

Files:

- \`apps/legalbridge/src/server/integrations/slack-intake-design.ts\`
- \`apps/legalbridge/src/server/integrations/slack-intake-modal.ts\`
- \`apps/legalbridge/src/server/integrations/slack-intake-routes.ts\`

Read-only preview APIs:

\`\`\`
GET /api/v2/slack-intake/catalog
GET /api/v2/slack-intake/modal-preview?workflow=license_settlement
GET /api/v2/slack-intake/modal-preview?workflow=document_create&template_key=legal_freeform
\`\`\`

These allow the Slack Block Kit view to be validated against the production Template catalog before the Slack App Request URL is switched.

## Current/live gateway transition

The currently live modal is still implemented in the legacy \`LegalBridge_AI_GCP\` Slack gateway.

Do not modify the Slack App Request URL until:

1. V2 modal preview matches the accepted design.
2. Submission creates the Backlog issue / Legal Request without auto-generating a specialized document prematurely.
3. Request deep links route to the correct V2 workspace.
4. Slack signature verification is enabled.
5. views.open / views.update / view_submission pass a write-test smoke test.

The legacy gateway stays available as rollback until then.

## Acceptance criteria

- Adding a normal document template does not require adding all its fields to Slack.
- \`royalty_statement\` never renders its 64 document fields in Slack.
- Purchase order financial/right details are not duplicated in Slack.
- License contract detailed rights terms are not duplicated in Slack.
- Legal review can end without a Matter.
- Generic document creation can end without a Matter.
- License/order/settlement requests deep-link into the appropriate V2 workspace.
- Deadline change remains Slack-inline.


## Material upload link

Every workflow displays the same Slack context link:

```
📎 資料添付
[資料アップロードページを開く]
```

Configure it with:

```
SLACK_INTAKE_UPLOAD_URL=https://<current-legal-gateway>/attachments/upload
```

During the gateway transition this points to the existing upload page. After the V2 upload route is available, only this environment value needs to change; the modal definitions do not change.

If the URL is temporarily unavailable, the modal states that the request-completion DM will contain the upload link instead of rendering a broken URL.
