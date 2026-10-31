# Security controls and operating limits

## Identity and authorization

Passwords use salted Argon2id. `jose` verifies JWT signatures, algorithms,
issuer/audience, required claims and expiry. Every protected request checks the
durable session and current account status. Administrator roles come from the
database. Guards attach to registered route metadata, including auto-HEAD routes,
rather than matching incoming URL strings. Admin writes recheck authority in their
transactions. User endpoints enforce resource ownership; reports omit chat content.

First-admin provisioning is a one-time interactive local command. Registration
requires prior admin approval and a hashed, one-use activation code. Users cannot
choose an administrator role. Status changes invalidate sessions; version checks
prevent stale updates and the last active admin is protected. See [authentication](AUTH.md).

Production JWT cookies are Secure, HttpOnly, SameSite=Lax, host-only and use the
`__Host-` prefix. Mutations require exact Origin and session-bound CSRF. Stream
attachment also requires CSRF and ownership; the narrowly scoped absent-Origin
fallback requires same-origin Fetch Metadata and the configured public Host.
CORS is an additional origin restriction, not an authorization mechanism.

## Input, rendering and communication

Shared Zod schemas reject unknown fields and invalid IDs, cursors and payloads.
Bodies are capped at 64 KiB. Prisma queries and tagged SQL bind caller values as
parameters. React Markdown skips raw HTML, allows selected elements, disables
images and restricts links to absolute HTTPS without credentials/control characters.
Links receive noopener/noreferrer; a model-generated destination is not certified safe.

Caddy terminates local HTTPS, serves the frontend and flushes API streams. Headers
include CSP, frame denial, nosniff, no-referrer and no-store where appropriate.
Only loopback 8443 is published by base Compose. PostgreSQL is private; the explicit
development override publishes its port on loopback only. Containers run non-root.
Local certificate trust is manual; CA private keys must never be exported or shared.

Direct development uses socket IPs. Compose sets `TRUSTED_PROXY_HOST=web`; only a
DNS-resolved trusted proxy socket may supply one forwarded client IP. Caddy overwrites
that header from its actual peer. Arbitrary client-supplied forwarding headers are
ignored. DNS lookups are coalesced, cached five seconds and bounded to one second;
lookup failure closes authentication with 503. Keep proxy DNS operator-controlled
and API ports private. Fastify global `trustProxy` remains disabled.

## Abuse controls and provider boundary

Authentication limits are 30 attempts/minute/client IP with bounded password work.
Submission limits are six attempts/minute/user; stream/recovery/Stop have independent
20/60/30 limits. Each process-local limiter retains at most 10,000 buckets.
Durable user/global quotas use atomic PostgreSQL reservations before dispatch and
idempotent settlement. User defaults are 10 requests and INR 100/day. Limits are
estimates, not guaranteed provider invoice caps. See [configuration](CONFIGURATION.md).

Only bounded owned completed context goes to Gemini. Model, prices, tools and system
instructions are server-controlled. There is no web search or tool execution. Keys
stay on the backend; credentials are excluded from model input and frontend config.
Provider retries and automatic continuation are disabled. Deadlines, bounded queues,
backpressure, output limits and a transient-error cooldown constrain resource use.
Stop/disconnect abort locally but cannot guarantee provider-side cancellation or refunds.
Uncertain dispatched work remains conservatively accounted. `store: false` is not a
zero-retention guarantee; provider terms and settings govern provider processing.

Logs omit request bodies/URLs and redact credential fields; public errors hide SQL,
stack traces, connection strings and raw provider diagnostics. Draft text is tab-memory
only; recovery metadata contains identifiers and timestamps, not prompts or credentials.
Admin activation codes exist only in UI memory when displayed. Real environment files,
local key notes, dumps, generated output and test artifacts are ignored.

## Verification and remaining work

Focused and isolated integration tests cover authorization, role escalation, CSRF,
ownership, activation races, revocation, route variants, trusted proxy behavior,
stream cancellation, quota concurrency and redacted errors. See [verification](../README.md#verification).
A minimatch 11.0.1 override replaces the affected development dependency; maintain
this override as parent tooling changes. A passing dependency audit is not a security certification.

Run one backend instance: live stream routing, cooldown and burst limits are local
to its process. MFA, password reset/account recovery, distributed limits and live-job
coordination are not implemented. Expired/revoked sessions are retained. Rotate a
compromised signing key and require renewed login. The local database bootstrap owner
is shared by application/migration/copy operations; hosted production should separate
least-privilege roles. Dumps contain sensitive records and are not encrypted or copied
off host by these helpers. A Docker host administrator can inspect runtime secrets.

Cloud deployment, off-host restore drills, capacity benchmarks and full manual
accessibility audits remain future work. Only the local macOS environment was exercised;
Windows/Linux host-specific behavior needs validation. The pg 8 concurrent-query
warning remains unresolved. See [deployment](../DEPLOYMENT.md) for the Mumbai plan.
