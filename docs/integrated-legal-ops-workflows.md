# LegalBridge V2 — Integrated Legal Ops Workflow Implementation

## Purpose

This slice implements the operating model agreed for LegalBridge V2 without replacing the existing production domain tables.

Three primary axes are exposed:

1. **Request** — legal work intake. A Request may complete without a Matter.
2. **Matter** — durable ongoing legal/business context.
3. **Work / Rights** — works, materials, rights sources, license conditions and lineage.

## Implemented user flows

### 1. Legal consultation — no Matter required

```
Backlog / Request
  -> legal_response document draft
  -> existing document finalization / Drive / communication flow
  -> Request can be treated as complete
```

The Request workspace opens the existing `legal_response` template using the Request's Backlog issue key.

### 2. Standalone memorandum / notice / agreement — no Matter required

```
Request
  -> choose any document template
  -> Document Draft
  -> Finalize / Drive / share
```

The Request issue key is preserved as the document issue key. A Matter is optional.

### 3. Ongoing work — Request -> Matter

A Request can be linked to an existing Matter using the existing `matter_issues` relation. A new Matter can also be created and the Request linked as its primary issue.

No new request-matter join table is introduced.

### 4. Work / Rights workspace

New routes:

- `GET /api/v2/work-rights`
- `GET /api/v2/work-rights/:id`

The projection uses existing tables:

- `works`
- `work_materials`
- `work_relations`
- `condition_lines`
- `contracts`
- `contract_works`
- `documents`
- `vendors`

The UI exposes:

- work overview / source-own-derived lineage
- materials
- rights sources represented by IN conditions and source documents
- IN / OUT condition matrix
- related contracts
- lineage

### 5. New license contract request

New client workspace: `LicenseContractWorkspace`.

Flow:

```
Request
  -> Work
  -> direction IN / OUT
  -> OUT: select source IN condition
  -> proposed license terms
  -> rights-scope checks
  -> choose template
  -> Document Draft
```

This slice intentionally **does not create an executed `contracts` row before signing**. The existing `ContractChainWizard` is an executed-contract intake and requires executed date / final identifiers. A pre-signing license request therefore stores its structured proposal in the document draft under `source_license_workflow`.

After execution, the existing contract intake / registry flow remains authoritative until the later Contract lifecycle slice formalizes DRAFT -> EXECUTED persistence.

### 6. Event-driven license settlement

New routes:

- `GET /api/v2/license-settlements/conditions`
- `POST /api/v2/license-settlements/preview`
- `POST /api/v2/license-settlements/draft`

Supported settlement triggers:

- `manufacturing`
- `sale`
- `sublicense_receipt`

For an OUT receivable condition with `parent_license_condition_id`, settlement follows:

```
OUT condition / event
  -> parent IN condition
  -> calculation under IN condition
  -> royalty_statement draft
```

Example:

```
Sublicense receipt EUR 8,000
- deductions EUR 850
= basis EUR 7,150
x IN royalty 25%
= payable royalty EUR 1,787.50
```

MG / AG are not automatically added or consumed by a single event. The calculation returns a warning because prior settlement history must be taken into account before determining MG/AG consumption.

The generated `royalty_statement` draft stores source condition IDs, event trigger, event date, basis amount, deductions and warnings in its snapshot.

## Safety model

- No legacy table is renamed or deleted.
- No document template is modified.
- Request -> Matter uses `matter_issues`.
- License contract drafting writes only to `document_drafts`.
- Settlement preview is read-only.
- Settlement document creation uses the existing DraftRepository.
- Existing guarded-write middleware remains authoritative.
- External sends remain behind existing Drive / Slack / Gmail / CloudSign gates.

## Required production runtime privileges

Apply and verify:

- `infra/gcp/sql/014_production_request_workflow_preflight_studio.sql`
- `infra/gcp/sql/014_production_request_workflow_grants_studio.sql`
- `infra/gcp/sql/014_production_request_workflow_verify_studio.sql`

New privilege requirement:

- SELECT `legal_requests`
- SELECT/INSERT/UPDATE `matter_issues`
- USAGE on `matter_issues_id_seq`

The script also reasserts read privileges required by Work / Rights and license settlement projections.

## Tests added

- Request can exist without any Matter.
- Request can be linked to a Matter when write capability is enabled.
- Sublicense receipt follows OUT -> parent IN condition and uses net receipt basis.
- Manufacturing event calculation excludes sample quantity.
- MG/AG are not automatically added per event.

## Known next slices

These are deliberately outside this safe vertical slice:

1. Formal pre-signing Contract state persistence (DRAFT / REVIEW / SIGNING / EXECUTED).
2. Persisted settlement-event ledger separate from document snapshot.
3. Automatic payment obligation and deadline generation after settlement approval.
4. Request completion status persisted in canonical `legal_requests` once M1 status migration is applied.
5. Automatic CloudSign completion -> Contract EXECUTED -> Drive -> deadline generation.
