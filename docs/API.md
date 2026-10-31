# API and stream contracts

The API implements health, CSRF, access requests, activation, login/logout,
current-user allowances, owned conversation history/deletion, streaming generation,
submission recovery and cancellation, plus administrator approval, account status,
quota editing and usage reporting.

The executable source of truth for payloads is
`packages/contracts/src/index.ts`. Both apps consume that package. Every exported
Zod schema supplies runtime validation and a TypeScript type through `z.infer`.
Requests use JSON, UTF-8, and strict body validation. Unknown body fields are
rejected, including caller-supplied roles, owners, models, and search options.
An unrecognized query parameter is also rejected. Money travels as decimal
strings with an explicit currency, not JSON floating-point sums.

## Conventions

- Base path: `/api`; health endpoints live at `/health`.
- IDs are UUIDs. The backend creates a fresh UUID request ID, returns it in
  `X-Request-ID`, and includes it in errors. Client-supplied request IDs are ignored.
- UTC timestamps use RFC 3339 `Z` notation. Display and daily reset timezone:
  Asia/Kolkata. Date filters use inclusive `from`, exclusive `to`, and require
  `from < to` when both are supplied.
- Lists use `limit` (default 30, maximum 100) and an optional opaque base64url
  cursor (maximum 512 characters). Responses contain `items` and `nextCursor`;
  a null cursor means the end. Invalid or wrong-scope cursors return 400.
- Conversations sort by updated time descending, then ID. Message pages use
  immutable per-conversation sequence numbers; items within a page display in
  ascending sequence order. Cursor semantics must avoid duplicates at ties.
- Request bodies are capped at 64 KiB. Prompt content is trimmed and bounded
  at 8,000 JavaScript string code units. Titles are at most 120 code units.
- Password creation accepts 12–128 characters without trimming. Usernames are
  3–32 ASCII letters, digits, or underscores, normalized to lowercase.
- All endpoints return `Cache-Control: no-store`. Credentials are never returned
  as JSON session tokens or put in local storage.

## Authentication and access

Target authentication is a verified JWT in an HttpOnly, SameSite=Lax cookie,
Secure in production. Validate HS256 only, issuer `query-assistant`, audience
`query-assistant-web`, expiry, subject, and server-side session/account state.
Every protected operation checks revocation and suspension through durable
state, including history reads, streams, and cancellation. No self-selected roles.
Sessions last at most eight hours and require login again after expiry; no refresh
token service is implemented. Anonymous CSRF sessions last 15 minutes. Local setup,
key-rotation behavior, and the verified auth flow are in `AUTH.md`.

State-changing requests require an allowed Origin and an `X-CSRF-Token` bound to
the browser session (including the pre-login session for login/activation/access
requests). Fetch clients use `credentials: 'include'`. Ordinary history GETs do
not start generation or change accounts; the CSRF GET may establish a browser
session. Stream attachment GET activates already-reserved work and has its own
mandatory CSRF/provenance guard below. CORS restricts
browser origins; it does not replace authentication or CSRF.
Production frontend/API must share a site; unrelated cross-site cookie deployment
would require revisiting the accepted session design.

- `GET /api/auth/csrf`: public. Response `CsrfResponseSchema` (200), establishes
  the pre-login CSRF session if needed. Rotate the CSRF token on login/logout.
- `POST /api/access-requests`: public and CSRF-protected. Body
  `AccessRequestBodySchema`; response `AccessRequestResponseSchema` (202), using
  the same generic acknowledgement whether a username is already in use.
- `POST /api/auth/activate`: public and CSRF-protected. Body `ActivateBodySchema`;
  response `SessionResponseSchema` (201) plus session cookie. Atomically consume
  a hashed, expiring, one-time approval code before creating an active user.
  Admin hands the code to the intended user outside this application.
- `POST /api/auth/login`: public and CSRF-protected. Body `LoginBodySchema`;
  response `SessionResponseSchema` (200) plus cookie. Invalid username/password
  combinations get the same `INVALID_CREDENTIALS` response (401).
- `POST /api/auth/logout`: authenticated and CSRF-protected; 204, revoke session
  and clear cookies. Logging out does not reset allowances.
- `GET /api/me`: authenticated. Response `CurrentUserResponseSchema` (200), with
  the stable user and durable allowance snapshot. It never includes global
  spending or other users' information.

Activation codes expire after 24 hours. An admin may reissue a code for an
unactivated request by approving again, invalidating the previous code. Codes are
returned only on the approval operation, never included in lists or logs. First
admin provisioning will use a trusted local command with a locally entered password.

## Conversations and generations

All routes below require an active authenticated user. Look up every resource by
owner; missing and another user's resources both return 404. Mutations also require
CSRF. There is no search field, external retrieval tool, or model selection in bodies.

- `POST /api/conversations`: `CreateConversationBodySchema` →
  `CreateConversationResponseSchema` (201). Default title: `New conversation`.
- `GET /api/conversations`: `PaginationQuerySchema` →
  `ConversationListResponseSchema` (200).
- `GET /api/conversations/:id`: `ResourceParamsSchema` →
  `CreateConversationResponseSchema` (200).
- `GET /api/conversations/:id/messages`: params plus `PaginationQuerySchema` →
  `MessageListResponseSchema` (200).
- `DELETE /api/conversations/:id`: 204. Delete chat content while preserving
  usage/accounting records. Return 409 if a generation is still active; the user
  must cancel it first so deletion cannot race persistence of a paid answer.
- `POST /api/conversations/:id/messages`: `SubmitMessageBodySchema` and a UUID
  `Idempotency-Key` header validated by `IdempotencyHeadersSchema` →
  `SubmitMessageResponseSchema` (202), exposing an early generation ID, saved user
  row, assistant ID, and events URL. The result is admission, not model success.
- `GET /api/generations/:id`: `GenerationResponseSchema` (200), for resolving
  ambiguous submit/cancel outcomes. It never starts or restarts generation.
- `GET /api/conversations/:id/submissions/:key`: owned read-only
  `AnswerResponseSchema` lookup by UUID idempotency key; 200 terminal, 202 active,
  404 missing/another user. Never dispatches work.
- `GET /api/generations/:id/events`: authenticated fetch SSE stream, described below; requires session CSRF and verified request provenance (the exact Origin or the strictly scoped same-origin GET fallback).
- `POST /api/generations/:id/cancel`: no body → `GenerationResponseSchema` (200).
  Cancellation is idempotent. A completed request remains completed. A request
  stopped before provider dispatch does not consume a dispatched-request unit.

Idempotency is scoped to the stable user, persisted across process restarts, and
binds the key to conversation and normalized content. Identical duplicate submissions
return the existing receipt (`replayed: true`), without another user message,
reservation, or provider call. A reused key with different content/conversation is 409. After an ambiguous network failure the client may repeat only the same key;
the client must never silently generate a new key to retry. No automatic paid retry
or generation restart occurs on page remount, refresh, or stream disconnection.

Final message states distinguish completed, cancelled, failed, and interrupted
partial answers. Only completed assistant answers enter future context. Input and
context are read from owned records and bounded before dispatch. Generation
states are `reserved → running → completed|cancelled|failed|interrupted`; cancellation
can also settle `reserved` directly. A terminal state cannot be changed by a
late callback. Durable recovery handles nonterminal requests after a crash.

## Generation behavior

Admission reserves configured maximum context/output before remote token preflight.
The loader includes at most 20 successful completed pairs, a 64,000-byte text
bound, and exact input token counting including the system instruction. Oldest
pairs are removed if needed; a prompt that cannot fit fails before dispatch.
Preflight failure releases undispatched allowance. The six-attempts/minute/user
limiter includes POST replays; GET recovery is read-only.

Generation uses one standard-tier Gemini attempt with minimal thinking, no tools,
no automatic retries or continuation, and no provider-managed chat state. Natural
nonempty STOP output completes; output-limited text is saved as failed; safety
blocked text is not displayed. Reported usage is normalized separately from cost.
Missing/inconsistent final usage retains conservative uncertainty. The overall
deadline and disconnect abort the client operation; remote billing may continue.
The owned cancel API aborts the matching local SDK operation and settles durable
state idempotently. Admin revocation signals local jobs after its transaction.

The browser saves only pending conversation ID/key/time in sessionStorage and
recovers via GET after an ambiguous failure. Credentials remain HttpOnly and
server-only. A confirmed missing result after 120 seconds can clear the stale
local marker; no paid retry is automatic.

## Stream protocol

Implemented in . There is one live subscriber per generation; a second active attachment receives 409.

Use authenticated `fetch` with `Accept: text/event-stream` and credentials. The
response is UTF-8 SSE with `Cache-Control: no-store`, buffering disabled, and no
automatic EventSource reconnect. Each event is framed as:

```text
event: delta
data: {"type":"delta","generationId":"11111111-1111-4111-8111-111111111111","text":"Hello"}

```

The `data` JSON must parse through `StreamEventSchema`; `event` matches its `type`.
An SSE event ends at a blank line. The client must handle CRLF, a multibyte UTF-8
character split between chunks, partial lines, and multiple events per network
chunk. Comment frames (`: heartbeat`) carry no application event. Event types:

- `started`: generation and assistant-message IDs.
- `delta`: incremental text for that generation, including plain Markdown text.
- `completed`: final success and usage/accounting status.
- `cancelled`: final cancellation and usage/accounting status; preserve partial text.
- `error`: safe API error and usage/accounting status; preserve partial text.

Each successful stream sends one terminal event. Connection loss without a terminal
event is an incomplete transport, never success; resolve durable status and reload
stored history. Before headers are sent, failures use regular JSON error statuses.
After headers, use an `error` event and close. No `sources` event exists because
search is excluded. Model text containing links is not evidence of a live search.

POST reserves and starts exactly one gated job. Events GET attaches a reader and
releases that existing job; it never creates new paid work. The job waits up to
15 seconds for attachment before preflight/dispatch, then cancels undispatched
work. The overall 90-second deadline includes this wait. The registry stores no
pre-attachment event queue. Disconnect cancels attached work. Terminal GET replay
reads saved text/outcome without Gemini; the UI uses read-only history recovery
rather than automatic reconnection.

Stop uses the receipt ID even before text or attachment. Deltas are split at
4,096 string code units and accumulated text is bounded at 128,000. At most one
checkpoint per second on new text avoids per-token writes. Node backpressure is
awaited with a five-second drain timeout. Provider reads/preflight have a 20-second
idle limit; the browser allows 25 seconds without bytes and 110 seconds overall.
The client validates UTF-8, framing, schemas and IDs, bounds frames at 1,048,576 string code units,
and treats missing or duplicate terminal events as transport errors. Terminal
frames follow durable settlement; persistence failure closes without fake success.

The process-local active registry supports one backend instance. Adding replicas
requires shared cancellation/routing coordination. Abort the upstream SDK operation
where supported; do not promise provider-side stopping, zero billing, or refunds.
Settle usage idempotently and preserve uncertainty if final usage is missing.

## Allowances and usage

Apply the accepted limits from `docs/CONFIGURATION.md`: reserve both user and global
budgets before dispatch, fail closed if storage is unavailable, and never hold a
database transaction open during generation. API allowance `remaining` is net of
both settled and reserved usage. Admin lowering a limit below existing usage must
block new work without erasing historical usage or active reservations.

`UsageSchema` records reported token counts separately from money estimates.
Nullable counts mean unknown, not zero. Cached input is a subset of input; reasoning
tokens must be normalized against the provider's output counts to avoid double
counting. Estimates retain their price version and the configured INR conversion.
Provider-reported cost is null unless actually returned; token metadata alone does
not turn our estimate into an actual provider bill. Preserve uncertain accounting
for cancellation, outages, and crashes. The daily token cap includes input and
billable output/reasoning, without double counting subsets. Search usage is absent.

## Administration

Every admin route requires active authentication, a trusted server-side admin role,
and CSRF on mutations. Normal users get 403. Responses exclude conversation text,
password hashes, signing material, activation codes except one-time approval output,
and provider keys. Privileged changes create an audit record transactionally.

- `GET /api/admin/access-requests`: `AdminAccessRequestQuerySchema` →
  `AccessRequestListResponseSchema` (200).
- `POST /api/admin/access-requests/:id/approve`: `AdminReasonBodySchema` →
  `ApprovalResponseSchema` (200). One-time code handoff only; never email automatically.
- `POST /api/admin/access-requests/:id/reject`: `AdminReasonBodySchema` →
  `AdminAccessRequestResponseSchema` (200).
- `GET /api/admin/users`: `AdminPageQuerySchema` →
  `AdminUserListResponseSchema` (200).
- `PATCH /api/admin/users/:id/status`: `AccountChangeBodySchema` →
  `AdminUserResponseSchema` (200). Suspension/revocation invalidates sessions,
  denies subsequent reads and writes, and aborts active generations. Reactivation
  requires a new login and does not reset quotas. Protect the last active admin
  from accidental suspension/revocation.
- `PATCH /api/admin/users/:id/quota`: `QuotaChangeBodySchema` →
  `AdminUserResponseSchema` (200). `expectedVersion` provides optimistic concurrency;
  stale updates get 409. Global caps still apply even if a user's allowance rises.
- `GET /api/admin/generations`: `AdminUsageQuerySchema` →
  `AdminGenerationListResponseSchema` (200). Paginated metadata only, including
  terminal/pending usage, outcomes, creation/dispatch/finish times, latency, safe
  error categories and immutable model/price/INR conversion snapshots.
- `GET /api/admin/usage`: `AdminUsageQuerySchema` → `AdminUsageResponseSchema`
  (200). Overall filtered aggregates are not limited to the current per-user page;
  `nextCursor` paginates only `perUser`. Include outcomes, reported token counts,
  estimated cost, unknown usage, latency, budgets, timezone, and last update time.
  The UI defaults From to the current Asia/Kolkata day; the API uses all time
  when date filters are absent. Provider invoice/next-bill
  data is not supplied or fabricated.

## Health and failures

`GET /health/live` returns `LivenessResponseSchema` (200) independently of third
parties. `GET /health/ready` returns `ReadinessResponseSchema` (200 or 503), reflecting
safe configuration, database/migration readiness, and initialized application state.
Readiness probes do not issue billable model calls. They return 200
when required configuration, migrated storage, and the chat service are available;
otherwise 503. This does not validate the API key or establish remote availability.

All JSON errors follow `ApiErrorSchema`: `error.code`, user-safe `message`, UUID
`requestId`, `retryable`, and optional `retryAfterSeconds`. A retryable flag describes
recoverability; it never authorizes an automatic second paid generation.

- 400: `VALIDATION_ERROR` (body, IDs, cursors, filters, malformed JSON).
- 401: `UNAUTHENTICATED`, `INVALID_CREDENTIALS` (including invalid/expired JWT).
- 403: `FORBIDDEN`, `ACCOUNT_DISABLED`, `CSRF_INVALID`.
- 404: `NOT_FOUND` (including unowned resource IDs).
- 409: `CONFLICT`, `CONCURRENCY_LIMIT` (idempotency/version/active state conflict).
- 410: `INVALID_ACTIVATION` (invalid/expired/used approval code, generic message).
- 413: `PAYLOAD_TOO_LARGE`; 415: `UNSUPPORTED_MEDIA_TYPE`.
- 429: `RATE_LIMITED`, `QUOTA_EXCEEDED`, with reset/retry information where known.
- 502: `PROVIDER_REJECTED` (including policy-blocked generation, without leaking
  provider diagnostics); this is not a fabricated assistant answer.
- 503: `PROVIDER_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `SERVICE_NOT_READY`.
- 504: `GENERATION_TIMEOUT`; 500: `INTERNAL_ERROR`.

Do not include SQL errors, stack traces, provider raw responses, secrets, chat
content, or connection strings in public errors. Every later route must implement
and test these contracts before its feature can be called complete.

## Reverse proxy requirements for SSE

For `/api/generations/:id/events`, disable response buffering, caching, and
compression that delays deltas. Preserve Content-Type and the backend's
`Cache-Control: no-store, no-cache, no-transform` and `X-Accel-Buffering: no`.
Use a read timeout above 110 seconds and forward the exact permitted browser
Origin, cookies, and CSRF header. For Nginx the relevant location settings are
`proxy_buffering off`, `proxy_cache off`, `gzip off`, and `proxy_read_timeout 120s`.
Do not add automatic retries for message POST or live stream attachment. These
are deployment requirements; a reverse proxy is not yet packaged or verified.

## faults and throttling

Separate fixed-window user limits apply to POST submissions (six/minute), stream
attachments (20/minute), submission recovery (60/minute), and Stop (30/minute).
The public auth limiter remains 30/minute/IP. Rate limits return safe 429 and
Retry-After; buckets are bounded and process-local. Stop has an independent bucket.

During provider cooldown, a new POST returns PROVIDER_UNAVAILABLE (503) with
Retry-After before reservation. An existing owned replay still validates and
returns its receipt. Readiness is 503 with application false, liveness stays 200,
and authenticated history/me remain available. generationAvailable reflects cooldown
and shutdown, not a paid provider probe. Three consecutive remote transient failures
open 30 seconds; transient Retry-After may open longer, capped at 24 hours.
No automatic provider retry, paid restart or health probe occurs on expiry.

Provider response headers have a ten-second deadline; subsequent idle/total limits
are unchanged. Safe failure events keep partial text and terminal accounting.
STORAGE_UNAVAILABLE is an explicit saved failure where settlement succeeds;
failed settlement still closes without a terminal success and needs recovery.
Security headers apply to JSON errors and SSE as documented in SECURITY.md.

## browser recovery and navigation

Selected-conversation restoration, allowance refresh, history pagination and
Check saved result use owned GET requests only. Client session metadata includes
the stable owner ID; prompt drafts stay in bounded tab memory. A failed events GET
after an admitted POST does not clear the pending submission marker. Recovery/Stop
resolve that operation instead of creating another paid POST. Admission 429/503
rejections still preserve typed text and expose manual retry guidance.

The UI exposes confirmed owned conversation deletion. Active/unresolved work blocks
the UI action, with the existing backend active-generation check authoritative.
Deleted plaintext does not restore used allowance or remove accounting history.

## report and quota semantics

Usage filters are `from` inclusive and `to` exclusive UTC ISO timestamps, optional
`userId` UUID, optional `outcome`, and the standard bounded limit/cursor. The
browser converts date inputs from IST midnight into UTC. Dates filter generation
creation time, including records whose conversation text was deleted. Invalid or
unknown filters get 400. Cursors are scoped to the report type and filter values;
changing filters requires starting a fresh page. They are pagination positions,
not authorization credentials. The per-user page includes users with matching
requests; accounts without requests remain in `/api/admin/users`.

`summary.requests` counts admitted records, including undispatched attempts;
`dispatchedRequests` counts records with a dispatch timestamp. Outcome counts
sum to requests. Known input/output/cache/reasoning totals omit null usage fields;
`accountedTokens` separately includes conservative bounds. Cached tokens are a
subset of input; reasoning is separate from output. `uncertainRequests`,
`missingUsageRequests`, `pendingRequests`, `reportedTokenRequests` and
`estimatedUsageRequests` prevent absent reporting from looking like known zero
usage. `reported` means provider-reported tokens, not provider-reported money.
Local estimated cost sums settled estimates in INR. Provider-reported cost sums
only non-null USD costs and includes its coverage count; null means none reported,
and partial coverage is not a complete provider bill. Gemini currently reports
usage tokens rather than monetary costs. There is no invoice synchronization.

Mean latency uses finishedAt minus createdAt for finished records only, including
attachment/preflight wait, with a separate sample count. One usage response reads
aggregates, its per-user page and current global budgets in one REPEATABLE READ
snapshot. Generation-detail and later-page requests are separate snapshots.
No endpoint loads all generation rows into Node memory. SQL aggregation is bounded
by existing database statement/transaction deadlines; this PoC has no cached
analytics service or production scale benchmark.

Global daily/lifetime budgets always cover the whole application and current
period, independent of report filters. The response supplies `budgetPeriodStart`,
`budgetResetsAt`, timezone and `lastUpdatedAt`; remaining clamps at zero after used
plus reserved. Money remains decimal strings, with database sums in integer nanos.

Quota edits allow 0–10,000 daily requests, 0–10,000,000 daily tokens and INR 0–100
with at most two decimals, within the accepted per-user cost cap. A nonblank
reason and current account `expectedVersion` are required. Status and quota share
that version. The ledger lock serializes edits with reservation/settlement; the
edit and before/after audit event commit together. Existing usage/reservations are
never rewritten or cancelled by a quota edit, even below the new limit. Subsequent
admissions use the new limits and global caps. A concurrent reservation either
precedes the edit and retains its reservation or follows it and uses the new quota.

The dashboard loads only after an administrator opens it. Every mutation presents
its target, proposed values and reason in a native confirmation dialog. Approval
codes exist in that mounted view only and can be dismissed; lists/storage/logs do
not persist the plaintext code. No automatic mutation retry or code delivery exists.

## same-origin stream attachment

Browsers can omit Origin on a same-origin GET. For the events route only, an
absent Origin is accepted when `Sec-Fetch-Site` is exactly `same-origin` and Host
exactly matches the configured FRONTEND_ORIGIN host/port. A present Origin must
still exactly match, including when Fetch Metadata is present. Null/wrong Origin,
same-site/cross-site/none or missing metadata, and wrong/missing Host cannot use
the fallback. The session-bound X-CSRF-Token is always required, as are active
identity and resource ownership. All ordinary mutations retain their exact-Origin
policy. A reverse proxy must preserve the public Host; untrusted forwarded Host
is not used. Nonbrowser clients can supply the exact allowed Origin explicitly.
Browsers without the needed provenance fail closed.
