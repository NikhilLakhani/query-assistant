# PostgreSQL storage and accounting

PostgreSQL persists identity, sessions, owned conversations, generation state,
usage, atomic quotas and audit records. See [local setup](../LOCAL_SETUP.md) for
HTTPS packaging, migration and backup/restore commands.

## Local database setup

Prerequisites: Node/npm from the README, Docker Engine or Docker Desktop running,
and Docker Compose v2. Use the same npm commands on macOS, Linux, and Windows.
Only macOS execution has been verified in this environment.

1. Install dependencies from the root with `npm ci`.
2. Copy root `.env.example` to `.env`; replace `POSTGRES_PASSWORD` with a locally
   generated password. Keep the default database and database-user identifiers
   unless you also update the backend URL. Use at least 20 URL-safe characters for the Compose password. The setup helper
   creates compatible random credentials and preserves existing files.
3. Copy `backend/.env.example` to `backend/.env`. Set `DATABASE_URL` locally to
   `postgresql://<user>:<password>@localhost:5432/<database>`. Replace other example
   placeholders before running the backend. Do not paste secrets into chat.
4. `npm run db:up` starts PostgreSQL 17 and waits for its health check. This command
   explicitly selects `compose.dev.yaml`, publishing port 5432 on 127.0.0.1 only.
   `db` publishes no port in the base Compose file; the complete topology publishes
   only web on loopback 8443. The Docker backend uses hostname `db`.
5. `npm run db:migrate` applies committed migrations. A healthy container does not
   mean the schema exists; migrations must complete before storage is ready.
6. `npm run dev` starts both host applications. `/health/ready` returns 200 only
   when configuration, schema and the initialized chat service are available;
   it does not call Gemini or verify the remote key.
7. `npm run db:stop` stops the database and preserves `query-assistant_postgres-data`.
   `npm run db:up` starts it again with the same data. Changing the password in
   `.env` does not rotate a password inside an already initialized volume.

No accounts are seeded automatically. See `AUTH.md` for first-admin
provisioning and reviewer activation. Gemini is not called by migrations, storage
tests, or readiness checks.

Do not use `docker compose down --volumes` or delete the volume unless you intend
to delete all its data. Setup/tests never delete volumes. Backup/restore and complete
clean-machine packaging instructions are in ../LOCAL_SETUP.md.

## Schema and invariants

`backend/prisma/schema.prisma` describes users/roles/status, browser sessions,
access requests and hashed activation codes, conversations, ordered messages,
generation requests, immutable application-managed price snapshots, usage,
quota periods/reservations/allocations, a ledger coordination row, and admin audits.

The initial migration creates tables, indexes, enums, and foreign keys. The second
migration adds checks Prisma cannot express and the ledger marker. Important
constraints include normalized unique usernames, per-user idempotency keys, one
message per generation/role, unique message sequence numbers, composite ownership
and conversation/generation foreign keys, valid lifecycle timestamps, nonnegative
usage/counters, and unique quota scope/owner/period keys. Timestamps are UTC
`TIMESTAMPTZ`; daily boundaries follow the configured IANA timezone.

The new Prisma client is generated into ignored `backend/src/generated/prisma`.
Build, typecheck, test, and dev commands generate it without requiring a live
database. Never create tables opportunistically during server startup.

## Atomic reservation and settlement

`withLedgerLock` opens a short READ COMMITTED transaction and locks the migrated
`LedgerLock/global` row using a static tagged SQL query. All ledger mutations take
that same lock before reading/writing counters. This serializes reservations,
dispatch claims, settlement, recovery, and deletion across backend clients/processes.
Account-status/quota admin mutations also use this helper.

The shared lock deliberately trades throughput for simple correctness in this PoC.
It is a PostgreSQL lock, not an in-memory mutex. Generation cancellation/streaming
will still use the separately documented single-backend active registry. Multiple
HTTP replicas are not thereby ready for deployment.

Reservations check account status and ownership, idempotency, durable concurrency,
user request/token/cost limits, global daily cost, and global total cost. They insert
the request, two ordered messages, reservation allocations, and counter changes
atomically. Rejected work leaves none of those writes. Provider dispatch is outside
every database transaction. Only the caller winning `markDispatched` may contact
the provider; a duplicate claim must not send another request.

Each reservation allocates to three durable periods: the user's day, the global
day, and the application-wide total window. Settlement uses those recorded period
IDs, even if the answer finishes after midnight. Logout, a new browser session,
backend restart, or Docker restart does not replace the stable user or these rows.

Terminal settlement is idempotent: the first terminal transaction wins; later
callbacks return its result without charging/releasing twice. Dispatched attempts
consume a request. Cancellation before dispatch releases its request/token/cost
reservation without consuming a dispatched-request unit. Known reported usage is
preserved even if it exceeds an expected bound; new requests then fail if the
allowance is exhausted. Reservations cannot guarantee an exact provider bill.

## Recovery and persistence failures

Reservations expire after the configured overall generation deadline plus 30
seconds. Server startup and a 30-second timer process bounded recovery batches;
each item settles in its own transaction. A recovery pass never overlaps itself
inside one process. The database lock coordinates multiple recovery callers.

- Undispatched stale work is marked interrupted and releases its reservation.
- Dispatched stale work preserves saved partial text, marks token counts unknown,
  conservatively settles the full reserved token/cost bounds, and labels usage
  uncertain. No blanket refund is made after an ambiguous crash or abort.
- A database failure before reservation rejects the generation; there is no
  unmetered fallback. A database failure during settlement rolls all writes back,
  leaving durable pending state for later recovery. Do not retry a provider call
  to compensate for a failed database write.

PostgreSQL connection acquisition is bounded at three seconds; lock waits at
three seconds; statements and idle transactions at five seconds. The Prisma
transaction also has five-second acquisition/execution bounds. Database errors
become a safe `STORAGE_UNAVAILABLE` category without SQL, connection strings, or
chat content. These are application controls, not an infrastructure availability SLA.

Periodic text checkpoint scheduling and upstream cancellation are implemented by the chat service. The storage layer already supports bounded checkpoints and terminal partial
text. Only completed assistant messages will be eligible for future model context.

## Money and reported usage

Money is stored as integer billionths (nano-units) using PostgreSQL BIGINT and
JavaScript BigInt. No accumulated money passes through binary floating-point
arithmetic. Fractional conversions round upward to one nano-unit. API helpers
produce decimal strings.

Every request references a model/price-version snapshot containing input/output
prices and the explicit INR-per-USD conversion. Changing a rate while reusing its
existing model/version is rejected. Use a new `PRICE_VERSION` for any price or
conversion change. `ACCOUNTING_INR_PER_USD` remains unset in examples; tests use
a synthetic value of 100, which is not a selected real exchange rate.

Normalized visible output tokens and reasoning tokens are disjoint in the storage
API. Cached tokens are a subset of input, not additional input. Count billed
input + visible output + reasoning once. Provider adapters must normalize actual
metadata before calling this layer. Cached input is conservatively priced at the
full input rate in current estimates; no explicit caching service is configured.

Reported token metadata does not mean actual billed cost. `accountingStatus`
identifies reported token counts, estimated unused work, or uncertain usage.
`providerReportedNanoUsd` remains null unless the provider actually reports a cost.
All locally computed monetary values remain estimates and exclude provider taxes,
fees, and bank currency conversion. No invoice synchronization or search charges exist.

Deleting a chat removes its messages and conversation and detaches generation
metadata. It retains usage, allocations, stable owner IDs, price versions, and a
SHA-256 submission fingerprint for idempotency; no plaintext prompt/answer is kept
in those retained records. Deletion is blocked while the conversation has active
work, so paid output cannot race deletion.

## Verification

`npm run check` runs source checks, unit/API tests, and production builds.
`npm run test:integration` uses a fresh, isolated Docker database and generated
test-only credentials; it never consumes `backend/.env` as its database target.
The harness verifies empty-database migration, repeat migration, concurrency,
settlement, recovery, rollback, accounting reconciliation, and restart persistence.

Test scripts stop their containers and retain named volumes. Every invocation
creates another isolated volume; none is automatically removed. The most recent
successful run is recorded without credentials in ignored
`.artifacts/integration-last-run.json`. Interrupting a test may leave its container
running; use the printed container name to stop it. These are disposable synthetic
fixtures, distinct from the application Compose database.

See [verification](../README.md#verification) for checks and remaining limitations.
