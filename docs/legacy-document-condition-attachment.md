# Legacy document condition attachment

## Purpose

Historical documents may exist in the Document Registry / Google Drive router without canonical condition lines. This workflow repairs those relations without rewriting the historical PDF or `documents.form_data`.

## Canonical relationship

```
past document
  -> condition_lines.document_id
      -> condition_lines.work_id                 target / managed work
      -> condition_lines.source_work_id          source / original work
      -> condition_lines.source_material_id      optional material scope
      -> condition_lines.material_rights_source_id
      -> condition_lines.parent_license_condition_id   OUT -> source IN
```

`condition_lines.work_id` is the canonical work relation. `documents.ledger_ref_id` is only a primary-work hint for legacy compatibility, so one historical document can safely contain condition lines for more than one work.

## License IN repair

1. Open the historical document.
2. Add a condition attachment.
3. Select the target work (required).
4. Select source/original work when known. If omitted and the target work has an explicit `parent_work_id`, that parent is used as a safe source-work hint.
5. Select a material only when the license is material-specific.
6. Save the IN condition.

If a material is selected, the operation creates/reuses `material_rights_sources` with the historical document as its rights-source evidence.

## License OUT repair

1. Select the target work.
2. Select the applicable source IN condition when known.
3. Save the OUT condition with `parent_license_condition_id`.

If the source IN condition is not yet known, OUT can be saved with a warning and repaired later. Settlement should not be treated as fully traceable until the parent IN relation is set.

## Existing unattached condition rows

The backend supports `mode=link_existing` to attach a pre-existing `condition_lines` row instead of creating a duplicate. It refuses a condition already owned by another document/capability or a different work. Missing source-work/material/parent-IN data can be filled without changing an existing line number on the same document.

## Contract reconstruction

When the document has or is assigned a `contract_id`, the attachment workflow ensures `contract_works` links:

- target work: `licensed_work`
- source/original work: `licensed_source`

## Downstream behavior

After attachment:

- Work / Rights workspace includes the repaired condition because it reads by `condition_lines.work_id`.
- IN / OUT matrix can use `parent_license_condition_id`.
- Material-level rights provenance is available through `material_rights_sources`.
- Event-driven royalty settlement can use the repaired condition when the financial fields and parent IN relation are complete.

## Safety

- Historical document bytes and old template versions are not modified.
- Work is never guessed when no reliable relation exists; the operator must select it.
- An OUT condition with no source IN is allowed only with an explicit warning.
- A material must belong to the selected target work.
- Existing document/contract/work conflicts are rejected.

## Production activation

Run:

1. `022_condition_attachment_preflight_studio.sql`
2. `023_condition_attachment_grants_studio.sql`
3. `024_condition_attachment_verify_studio.sql`

Then deploy with `CONDITION_ATTACHMENT_WRITES_ENABLED=true` and `condition-attachments` in `WRITE_SCOPES`.