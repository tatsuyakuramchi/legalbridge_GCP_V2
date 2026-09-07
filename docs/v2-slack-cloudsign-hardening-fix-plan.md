# LegalBridge V2 Slack / CloudSign Hardening Fix Plan

## 1. Purpose

This document defines the final hardening work required for the Slack Matter integration and CloudSign integration currently implemented on `claude/github-analysis-development-1s2tht`.

The core functions are already present. The remaining work is intentionally limited to the following three issues:

1. Preserve and normalize CloudSign upstream error details.
2. Decide and normalize the canonical Matter↔Slack thread table, with V1 reuse as the default.
3. Prevent duplicate Slack root threads when two requests create a Matter thread concurrently.

This plan does **not** redesign the overall V2 integration architecture. Existing V2 capability gates, write scopes, admin/legal restrictions, runtime secret handling, Matter UI, CloudSign PDF generation, notification journaling, and staged deployment controls are retained.

---

## 2. Current State

### 2.1 CloudSign

The current V2 branch has already been corrected to use the V1-proven CloudSign wire protocol:

- `POST /token`
  - `application/x-www-form-urlencoded`
  - `client_id` in the request body
- token cache based on `expires_in`
- 30-second early expiry margin
- token cache invalidation when the configured client ID changes
- exactly one retry on HTTP 401
- `POST /documents`
  - `application/x-www-form-urlencoded`
  - `title`
- `POST /documents/{id}/files`
  - multipart field name `uploadfile`
- `POST /documents/{id}/participants`
  - `application/x-www-form-urlencoded`
- `POST /documents/{id}/reportees`
  - `application/x-www-form-urlencoded`
- `POST /documents/{id}` to finalize/send

Therefore, the principal V1/V2 HTTP-shape mismatch is already resolved.

The remaining CloudSign defect is observability: the response JSON returned by CloudSign is parsed but discarded on non-2xx responses. The caller therefore receives only a generic status-oriented exception such as `CloudSign API HTTP error: 400`.

That makes it impossible for the UI and logs to reliably distinguish, for example:

- recipient/email rejection
- client authentication/configuration failure
- IP restriction
- permission failure
- document state conflict
- rate limit
- upstream validation error

### 2.2 Slack

The current V2 branch already contains the Matter-oriented Slack path that was missing from the earlier implementation:

- one Matter root post
- `thread_ts`
- Matter replies
- `conversations.replies`
- Matter Slack read API
- Matter Slack write API
- Matter UI panel/history
- mention candidates
- Matter event notifications

This is separate from requester notification DMs and should remain separate.

The requester notification domain remains:

```text
Requester notification
  -> conversations.open
  -> DM chat.postMessage
  -> lb_v2_slack_notification_history
```

The Matter collaboration domain remains:

```text
Matter communication
  -> legal consultation channel
  -> one root per Matter
  -> thread_ts
  -> replies / conversations.replies
  -> Matter screen
```

The two domains must not be merged.

---

## 3. Decision Summary

### Decision A — CloudSign upstream error body must be preserved

Adopt structured error normalization in `FetchCloudSignApiClient` and expose only safe, actionable information to the API/UI.

### Decision B — V1 `matter_slack_threads` is the preferred canonical table

Before creating a V2-specific thread table, inspect the production `legalbridge` database.

If V1 `matter_slack_threads` exists and its required columns are compatible, V2 will reuse it.

Required minimum columns:

```text
matter_id
channel_id
thread_ts
root_text
created_by
created_at
```

The current `lb_v2_matter_slack_threads` table becomes a fallback only when the V1 table is absent or structurally incompatible.

This avoids splitting one business concept into two independent sources of truth during V1→V2 migration.

### Decision C — Matter root creation must be serialized per Matter

Use PostgreSQL locking so only one request can execute the critical section for a given Matter.

The critical section is:

```text
acquire Matter lock
  -> re-read existing thread
  -> if present: return it
  -> post root to Slack
  -> persist thread pointer
release lock
```

Because `DatabasePool` is a real `pg.Pool`, the implementation can use a dedicated `PoolClient` and a transaction/advisory lock without introducing another table.

Recommended lock:

```sql
SELECT pg_advisory_xact_lock(<namespace>, $matterId);
```

The Slack API call occurs while the Matter-specific transaction lock is held. This is acceptable because thread creation is infrequent and the lock scope is limited to one Matter. The DB transaction must have a short statement/operation timeout and must always rollback on failure.

---

# 4. CloudSign Hardening

## 4.1 Target files

Primary:

- `apps/legalbridge/src/server/integrations/cloudsign-api-adapter.ts`
- `apps/legalbridge/src/server/integrations/cloudsign-adapter.ts`
- `apps/legalbridge/src/server/integrations/cloudsign-api-adapter.test.ts`

Route/UI integration:

- `apps/legalbridge/src/server/documents/cloudsign-routes.ts`
- `apps/legalbridge/src/server/documents/cloudsign-routes.test.ts`
- `apps/legalbridge/src/client/DocumentIntegrations.tsx`

## 4.2 Extend CloudSignError

The error type should carry normalized metadata without leaking secrets.

Recommended shape:

```ts
export class CloudSignError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly operation?: string,
    public readonly upstreamCode?: string,
    public readonly upstreamMessage?: string
  ) {
    super(message);
  }
}
```

Do not include:

- bearer token
- client ID
- request Authorization header
- raw request body containing secrets
- full HTML error pages

## 4.3 Normalize upstream payload

On every non-2xx response, extract a bounded, safe error summary from common CloudSign response shapes.

Candidate keys:

```text
error
message
error_description
code
errors
```

Normalization rules:

1. Prefer explicit string `message` / `error_description`.
2. Preserve a short upstream code when present.
3. Convert structured `errors` to a bounded summary.
4. Truncate free-form text, e.g. 600 characters.
5. If body is unavailable, fall back to HTTP status only.
6. Never stringify request headers or Authorization values.

Example internal error:

```text
operation=addParticipant
status=400
upstreamCode=invalid_email
upstreamMessage=The specified email address is not allowed
```

## 4.4 Classify actionable cases

Introduce a stable V2-facing error category that does not depend on exact Japanese/English CloudSign wording.

Suggested categories:

```text
CLOUDSIGN_AUTH_ERROR
CLOUDSIGN_RECIPIENT_ERROR
CLOUDSIGN_IP_RESTRICTION
CLOUDSIGN_RATE_LIMIT
CLOUDSIGN_DOCUMENT_STATE_ERROR
CLOUDSIGN_VALIDATION_ERROR
CLOUDSIGN_UPSTREAM_ERROR
```

Classification may use:

- HTTP status
- upstream code
- conservative keyword matching against upstream message

Do not over-classify an unknown error as IP restriction merely because the original user-facing symptom mentioned an address.

## 4.5 Route response

`cloudsign-routes.ts` should return a structured safe response, for example:

```json
{
  "error": "CloudSignで宛先を受け付けられませんでした。宛先メールアドレスとCloudSign側の設定を確認してください。",
  "code": "CLOUDSIGN_RECIPIENT_ERROR",
  "status": 400,
  "detail": "The specified email address is not allowed"
}
```

Rules:

- API route itself may continue to return `502` for an upstream integration failure if desired, but the original CloudSign HTTP status must remain available in metadata.
- Use `400/409` only when V2 itself can authoritatively determine the request is invalid before contacting CloudSign.
- Do not leak raw CloudSign payloads to the browser.

## 4.6 UI behavior

`DocumentIntegrations.tsx` should display the normalized `error` field and, when safe, the bounded `detail`.

Examples:

```text
CloudSignで宛先を受け付けられませんでした。
CloudSign応答: The specified email address is not allowed
```

For IP restriction:

```text
CloudSign APIへの接続元IPが許可されていない可能性があります。
CloudSign側のIP制限設定とCloud Runの送信元構成を確認してください。
```

Static egress / Cloud NAT must be treated as a contingency only after CloudSign actually reports an IP-related failure.

## 4.7 CloudSign tests

Add tests for:

- token error body preservation
- 400 participant error preservation
- 401 still refreshes token exactly once
- second 401 is returned, not retried indefinitely
- 403 error classification
- 429 error classification
- unknown 5xx fallback
- error detail truncation
- no Authorization/token/client ID in serialized errors
- route maps normalized error to stable V2 code

Existing V1-wire tests must continue to pass:

- token body `client_id=...`
- no `client_secret`
- form-urlencoded document create
- multipart `uploadfile`
- form-urlencoded participants
- token reuse
- one 401 refresh

---

# 5. Slack Canonical Thread Table

## 5.1 Goal

One Matter must have one canonical Slack thread pointer regardless of whether the Matter was originally created/managed by V1 or V2.

## 5.2 Production preflight

Before changing production schema, run a read-only inspection:

```sql
SELECT to_regclass('public.matter_slack_threads') AS v1_table,
       to_regclass('public.lb_v2_matter_slack_threads') AS v2_table;
```

If `matter_slack_threads` exists, inspect columns and constraints:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'matter_slack_threads'
ORDER BY ordinal_position;
```

Also verify one-Matter uniqueness.

## 5.3 Preferred path: reuse V1 table

If compatible:

1. Change `PgMatterSlackThreadRepository` from:

```sql
lb_v2_matter_slack_threads
```

to:

```sql
matter_slack_threads
```

2. Do not create a second thread table.
3. Convert `024_matter_slack_threads_production_grants.sql` into a grants/preflight-only migration for the existing table, or supersede it with a new migration that grants only the required permissions.
4. Keep V2 operations limited to the minimum required privileges.

Required runtime permissions:

```text
SELECT
INSERT
```

If the race-condition solution needs no UPDATE/DELETE, continue to deny them.

5. Preserve existing V1 records so previously created Matter threads immediately appear in V2.

## 5.4 Fallback path: isolated V2 table

Only if `matter_slack_threads` is absent or incompatible:

- retain `lb_v2_matter_slack_threads`
- document why V1 reuse was not possible
- provide a migration/backfill mapping before V1 cutover
- do not allow both tables to silently become active sources of truth

The application must choose one repository table at runtime/deployment, not query both opportunistically on every request.

## 5.5 Validation environment

The validation DB may continue to use an isolated `lb_v2_matter_slack_threads` table if the V1 schema is intentionally absent there.

Production and validation do not need identical physical table names as long as repository configuration is explicit and tests cover both paths.

---

# 6. Slack Root Race-Condition Fix

## 6.1 Current risk

The current logical sequence is effectively:

```text
findByMatter
  -> no thread
post Slack root
insert ... ON CONFLICT DO NOTHING
```

Two simultaneous requests can both observe “no thread” and both create Slack roots before one DB insert loses the unique-key race.

Result:

- DB: one row
- Slack: two root posts
- one orphan root cannot be reached from the Matter pointer

A DB unique constraint alone is insufficient because the external side effect happens before the insert conflict is resolved.

## 6.2 Required behavior

For the same Matter ID, only one request may pass the pre-post check at a time.

Different Matter IDs must not block each other.

## 6.3 Recommended implementation: transaction advisory lock

Add a repository/service operation that obtains a dedicated `pg.PoolClient`:

```ts
async function withMatterSlackThreadLock<T>(
  matterId: number,
  work: (client: PoolClient) => Promise<T>
): Promise<T>
```

Outline:

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    'SELECT pg_advisory_xact_lock($1, $2)',
    [MATTER_SLACK_LOCK_NAMESPACE, matterId]
  );

  const existing = await findByMatterWithClient(client, matterId);
  if (existing) {
    await client.query('COMMIT');
    return existing;
  }

  const root = await channel.postMessage(...);
  const saved = await createWithClient(client, ...root);

  await client.query('COMMIT');
  return saved;
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
}
```

Use the two-int advisory-lock form with a fixed namespace constant rather than deriving a single arbitrary bigint hash.

Example namespace:

```ts
const MATTER_SLACK_LOCK_NAMESPACE = 0x4c42534c; // "LBSL"
```

The exact constant is less important than keeping it stable and documented.

## 6.4 Why advisory lock is preferred

- no new reservation table
- no provisional `thread_ts`
- no UPDATE permission required
- lock automatically releases at transaction end
- scoped to one Matter
- works across multiple Cloud Run instances
- protects the external Slack side effect, not only the DB insert

## 6.5 Timeouts and failure behavior

The transaction must not be allowed to hang indefinitely.

Recommended controls:

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
```

Application-level Slack HTTP timeout must also be finite.

Failure rules:

- Slack post fails before persistence → rollback, no DB pointer.
- DB insert fails after Slack root succeeds → rollback and emit a high-severity integration log containing Matter ID/channel/thread_ts so the orphan can be reconciled.
- A waiting concurrent request acquires the lock after the first request commits, re-reads the thread, and returns the existing pointer without posting a second root.

## 6.6 Concurrency tests

Add a test that launches two thread-create calls for the same Matter concurrently and asserts:

```text
Slack root posts = 1
DB thread rows = 1
returned thread_ts values = identical
```

Also add a different-Matter concurrency test showing Matter A does not serialize Matter B.

---

# 7. Matter Slack History Read Path

The read path should continue to use the Matter collaboration thread pointer, not notification history.

Preferred flow:

```text
GET /api/v2/matters/:id/slack...
  -> canonical Matter thread repository
  -> channel_id + thread_ts
  -> conversations.replies
  -> normalized message list
  -> Matter UI
```

`lb_v2_slack_notification_history` remains a requester-notification journal/dedup store and must not become the Matter conversation source of truth.

No aggressive polling is required. Fetch on Matter selection/open and explicit refresh is sufficient unless a later product requirement adds near-realtime behavior.

---

# 8. Deployment / Migration Sequence

## Phase 0 — Preflight

1. Confirm deployed code SHA.
2. Confirm target database is `legalbridge`.
3. Inspect `matter_slack_threads` existence/schema/unique constraint.
4. Inspect `lb_v2_matter_slack_threads` existence and row count.
5. Confirm Slack bot scopes required for posting and `conversations.replies`.
6. Confirm legal consultation channel ID.
7. Confirm CloudSign client ID secret is resolved at runtime.

No write operation in this phase.

## Phase 1 — CloudSign error observability

1. Implement structured upstream error preservation.
2. Add classification.
3. Update route response.
4. Update UI message.
5. Run unit tests.
6. Deploy to write-test.
7. Trigger a controlled invalid-recipient request and verify the real CloudSign reason is visible.

Do **not** change Cloud NAT/static egress in this phase.

## Phase 2 — Slack canonical table normalization

If V1 table is compatible:

1. grant V2 runtime required permissions on `matter_slack_threads`
2. switch repository target
3. verify an existing V1 Matter thread is visible from V2
4. ensure `lb_v2_matter_slack_threads` is no longer written by application code

If V1 table is not compatible, explicitly record fallback decision and retain the isolated V2 table.

## Phase 3 — Slack race-condition protection

1. add Matter advisory-lock helper
2. route all root-thread creation through it
3. keep reply posting outside this creation lock
4. run concurrent tests
5. deploy to write-test
6. perform controlled double-submit verification

## Phase 4 — Production verification

Verify:

- existing Matter opens its historical Slack thread
- new Matter creates exactly one root
- reply appears in the same thread
- Matter UI displays replies
- requester DM still works independently
- CloudSign draft creation works
- CloudSign send works
- invalid CloudSign recipient returns actionable reason
- no secrets appear in logs/UI

---

# 9. Acceptance Criteria

## CloudSign

- [ ] V1-compatible HTTP request shapes remain unchanged.
- [ ] `expires_in` token cache remains active.
- [ ] 401 is retried exactly once.
- [ ] Non-2xx CloudSign response preserves a bounded upstream error message internally.
- [ ] API returns a stable normalized integration error code.
- [ ] UI displays a useful, safe reason.
- [ ] No token/client ID/Authorization value is leaked.
- [ ] Static IP work is not introduced unless the upstream response actually indicates IP restriction.

## Slack

- [ ] Requester DM and Matter communication remain separate domains.
- [ ] Production uses one canonical Matter-thread table.
- [ ] Existing V1 `matter_slack_threads` is reused when compatible.
- [ ] Existing V1 Matter threads are visible from V2 without manual recreation.
- [ ] One Matter maps to one canonical `thread_ts`.
- [ ] Concurrent root creation emits only one Slack root.
- [ ] `conversations.replies` reads the canonical thread.
- [ ] Matter UI continues to show Slack history.
- [ ] Different Matter IDs are not unnecessarily serialized.

## Operational

- [ ] Relevant unit tests pass.
- [ ] Typecheck passes.
- [ ] Production build passes.
- [ ] write-test smoke test passes.
- [ ] DB preflight output is retained with deployment evidence.
- [ ] Rollback path is documented before production activation.

---

# 10. Suggested Test Matrix

| Area | Case | Expected |
|---|---|---|
| CloudSign token | valid token | cached until early expiry |
| CloudSign token | 401 once | refresh and retry once |
| CloudSign token | 401 twice | fail, no loop |
| CloudSign participant | invalid email | recipient-class error + safe upstream detail |
| CloudSign auth | invalid client | auth-class error |
| CloudSign API | 429 | rate-limit classification |
| CloudSign API | unknown 500 | generic upstream classification |
| Slack thread | existing V1 pointer | reuse without new root |
| Slack thread | new Matter | one root + one pointer |
| Slack thread | simultaneous create x2 | one root only |
| Slack thread | different Matter x2 | both can proceed independently |
| Slack replies | existing thread | `conversations.replies` returned |
| Slack notification | requester DM | remains independent of Matter thread |

---

# 11. Rollback

## CloudSign

CloudSign error normalization is backward-compatible with the corrected V1 wire protocol. If UI handling causes a regression, revert only route/UI structured-error exposure while retaining the corrected API request shape.

Do not revert to the former JSON/query-param CloudSign request implementation.

## Slack

If switching from `lb_v2_matter_slack_threads` to V1 `matter_slack_threads` causes an unexpected schema/privilege issue:

1. disable `matter-slack` write scope
2. keep Matter Slack history read disabled/degraded rather than creating new roots
3. revert repository target to the explicitly selected fallback table only after verifying row ownership
4. do not run an automatic bidirectional merge between two thread tables

The rollback objective is to avoid creating duplicate Slack roots or splitting new Matters between two sources of truth.

---

# 12. Non-Goals

The following are outside this fix:

- redesigning Matter UI
- merging requester DM notification history with Matter conversation history
- replacing Slack with another messaging system
- adding realtime websocket/SSE Slack synchronization
- changing CloudSign PDF rendering or template semantics
- changing CloudSign business authorization rules
- changing general V2 write-scope architecture
- broad Cloud Run networking changes without an observed CloudSign IP restriction

---

# 13. Implementation Order

Recommended order:

```text
1. CloudSign upstream error preservation
2. production DB preflight for matter_slack_threads
3. canonical Slack table decision
4. repository target normalization
5. Matter advisory-lock implementation
6. concurrent Slack tests
7. typecheck / unit tests / build
8. write-test deployment
9. controlled CloudSign + Slack smoke tests
10. production rollout
```

The critical design principle is to port and harden the proven V1 behavior while retaining V2's safety gates, instead of creating a second integration model for the same business operation.
