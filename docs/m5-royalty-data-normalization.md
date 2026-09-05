# M5 — Royalty data normalization

## Goal

Stop treating `documents.form_data` as the only operational source for royalty calculations.

Historical documents remain immutable snapshots, but their business data is copied into the existing canonical M5 tables. Future royalty statement finalization writes both the document snapshot and canonical rows in one transaction.

## Production inventory used

The production inventory showed:

- `royalty_calculations`: 0 rows / 39 columns
- `royalty_statements`: 0 rows / 39 columns
- `royalty_statement_lines`: 0 rows / 21 columns
- `condition_receipts`: 0 rows / 21 columns
- `manufacturing_events`: 0 rows
- `sales_events`: 0 rows
- `condition_events`: 66 rows
- `payments`: 25 rows
- `royalty_payments`: 26 rows

These tables are therefore activated instead of replaced.

## Canonical ownership

| Business fact | Canonical table |
|---|---|
| Calculation result | `royalty_calculations` |
| Issued calculation statement header | `royalty_statements` |
| Statement calculation lines | `royalty_statement_lines` |
| Manufacturing fact | `manufacturing_events` |
| Sales fact | `sales_events` |
| Sublicense receipt fact | `condition_receipts` |
| Consumption of payable IN condition | `condition_events` |
| Actual / scheduled payment record | `payments` |
| Historical generated document snapshot | `documents.form_data` |

A calculation statement does **not** prove that payment occurred. M5 therefore does not manufacture a `payments` row from a statement.

## Legacy royalty_payments

`royalty_payments` contains 26 legacy rows.

M5 only links a legacy row to an existing `payments` row when an existing payment matches the Backlog issue or contract + due date and is identifiable as royalty/license payment.

Unmatched rows are retained and a `ROYALTY_PAYMENT_LINK_UNRESOLVED` data-quality issue is created.

This avoids turning a calculated obligation into a false payment event.

## Migration order

Run in Cloud SQL Studio:

1. `017_m5_royalty_normalization_preflight_studio.sql`
2. Review output.
3. `018_m5_royalty_normalization_schema_studio.sql`
4. `019_m5_royalty_normalization_backfill_studio.sql`
5. `020_m5_royalty_normalization_runtime_grants_studio.sql`
6. `021_m5_royalty_normalization_verify_studio.sql`

Then run template v9 migration if not already applied:

- `016_upgrade_royalty_statement_v9_studio.sql`

The application revision that contains `persistRoyaltyNormalization()` must only be deployed after 018 and 020 have been applied.

## Historical backfill

The source is finalized:

```
documents
WHERE template_type = 'royalty_statement'
```

Only object-root `form_data` is normalized.

M5 supports both current and legacy field names, including:

- `settlement_trigger`
- `calcType` / `rsCalcType`
- `source_condition_line_id` / `rsConditionLineId`
- `source_out_condition_line_id`
- `license_contract_id`
- `quantity` / `rsQuantity`
- `sampleQuantity` / `rsSampleQuantity`
- `MSRP` / `rsMsrp`
- `royaltyRatePct` / `rsRatePct` / `rsInRatePct`
- `actualRoyalty` / `actualRoyaltyStr`
- MG / AG fields
- tax / deadline fields
- `lines` arrays

Unknown legacy capability IDs are **not** treated as condition-line IDs merely because the integer happens to exist. They become a data-quality review item.

## Event mapping

### Manufacturing

```
royalty_statement
 -> manufacturing_events
 -> royalty_calculations
 -> condition_events(royalty_calc)
 -> royalty_statements
 -> royalty_statement_lines
```

### Sale

```
royalty_statement
 -> sales_events
 -> royalty_calculations
 -> condition_events(royalty_calc)
 -> royalty_statements
 -> royalty_statement_lines
```

### Sublicense receipt

```
royalty_statement
 -> condition_receipts
 -> OUT condition
 -> parent/source IN condition
 -> royalty_calculations
 -> condition_events(royalty_calc)
 -> royalty_statements
 -> royalty_statement_lines
```

## Data quality

Backfill does not silently guess uncertain relations.

Rules:

- `ROYALTY_STATEMENT_CONDITION_UNRESOLVED`
- `ROYALTY_STATEMENT_AMOUNT_UNRESOLVED`
- `ROYALTY_PAYMENT_LINK_UNRESOLVED`

When a later backfill resolves the value, the issue is automatically marked resolved.

## Future-write invariant

After this M5 slice:

```
Document Finalize transaction
  ├─ INSERT documents
  ├─ UPSERT manufacturing/sales/receipt event
  ├─ UPSERT royalty_calculations
  ├─ UPSERT condition_events
  ├─ UPSERT royalty_statements
  ├─ UPSERT royalty_statement_lines
  └─ COMMIT
```

If any canonical write fails, the document finalization transaction rolls back. This prevents a new finalized calculation statement from existing only as JSON while the canonical tables remain empty.

## Rollback policy

No destructive rollback.

- Historical `documents.form_data` remains unchanged.
- Legacy `royalty_payments` remains unchanged except optional `payment_id` linkage.
- Canonical rows can be corrected by forward-fix using `document_id` as the idempotency key.
- Do not delete historical documents to reverse M5.
