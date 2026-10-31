# Local authentication and provisioning

Local username/password authentication includes approval before account creation,
one-use activation, durable cookie sessions, access revocation and ownership checks.
React forms expose the authentication flow; the administrator dashboard exposes
access requests, account status, quota editing and usage reports.

## First administrator

1. Follow `STORAGE.md` to configure Docker PostgreSQL and run `npm run db:migrate`.
   Apply all committed migrations, including authentication constraints.
2. Set `DATABASE_URL` and a locally generated `JWT_SIGNING_KEY` in `backend/.env`.
   Keep the approved origin `http://localhost:5173` and use localhost consistently.
   Development auth does not need the model key or accounting conversion: omit or
   comment those lines out until configured. Empty assignments/placeholders fail
   validation. Production requires all required configuration.
3. From the repository root:

   ```sh
   npm run admin:bootstrap -- --username YOUR_ADMIN_USERNAME
   ```

   The command prompts twice with terminal echo disabled. It accepts no password
   argument or password environment variable. Use an interactive terminal, not
   piping/redirecting. Usernames are 3–32 ASCII letters/digits/underscores, normalized
   to lowercase. Passwords are 12–128 characters and are not trimmed.

4. The command atomically creates the first admin, default quota, and audit record.
   It refuses if any admin already exists, including a revoked one. It cannot
   promote an existing user, and no HTTP route invokes it.
5. Run `npm run dev` and open the React UI. Readiness is 200 only with complete
   configuration, migrated storage and available local chat prerequisites; remote
   provider availability is not probed.

The privileged provisioning operation is integration-tested. Manual hidden-terminal
entry and Linux/Windows execution remain unrun. Keep passwords, signing keys, session cookies, and activation
codes out of chat, URLs, logs, and version control.

## Reviewer activation and login

Browser/API clients use cookies (`credentials: 'include'`). JSON mutations include
the exact configured `Origin` and an `X-CSRF-Token` bound to that browser session.

1. `GET /api/auth/csrf` obtains a CSRF token and, if needed, a signed HttpOnly
   anonymous-session cookie. Anonymous sessions expire after 15 minutes.
2. `POST /api/access-requests` supplies the desired username. It creates no user
   and collects no password. Existing names receive the same generic acknowledgement.
3. The admin signs in using `POST /api/auth/login`, refetches their CSRF token,
   and lists requests with `GET /api/admin/access-requests`.
4. `POST /api/admin/access-requests/:id/approve` accepts a reason and returns a
   256-bit activation code, once, with its 24-hour expiry. Only its hash is stored.
   The admin manually hands the code to the reviewer; the app sends no messages.
   Reissuing approval or rejecting a request invalidates its previous code.
5. The reviewer obtains their own CSRF session and calls `POST /api/auth/activate`
   with username, activation code, and their chosen password. Account creation,
   code consumption, and session rotation are atomic. Activated users always get
   role `user`; registration/activation do not accept a role.
6. Activation and login set authenticated cookies and return public user metadata
   and expiry, never a JWT in JSON. Refetch the CSRF token after either operation.
7. `GET /api/me` returns the current user and durable allowances. Paid generation
   is enabled after provider/accounting configuration.
8. `POST /api/auth/logout` revokes the session and clears the cookie. A new login
   preserves the stable user ID, ownership, and quotas.

Exact payloads, pagination, and errors are in `API.md` and shared Zod schemas.
The admin dashboard presents these account controls without requiring manual
API calls.

## Revocation and trusted roles

`GET /api/admin/users` lists account metadata and its version.
`PATCH /api/admin/users/:id/status` accepts `active`, `suspended`, or `revoked`,
the expected version, and a reason. Stale versions conflict. The last active admin
cannot be suspended/revoked. All admin endpoints check the role in the database.

Non-active status invalidates all sessions, blocks dispatch, and cancels pending
generation records in one ledger transaction, preserving uncertain dispatched
usage. Reactivation requires a new login; old cookies remain revoked. Audit events
record actor, target, reason, and before/after status without credentials/chat text.
The chat service rechecks sessions before dispatch and periodic checkpoints. The events
GET requires Origin and session-bound CSRF because attachment releases provider
work. Owned Stop aborts a local job; revocation signals jobs after the durable
transaction. The registry supports one backend instance. No operation guarantees
provider-side stopping or billing refunds.

## Sessions, passwords, and keys

- `jose` verifies HS256, configured issuer/audience, JWT type, required expiry/
  issued-at/subject/session-ID claims, and at most eight hours of lifetime/age.
  Every protected request also checks the durable session, subject/expiry binding,
  revocation, and account status. Roles in tokens/bodies cannot grant access.
- Production uses `__Host-qa_session`: Secure, HttpOnly, SameSite=Lax, Path=/, no
  Domain. Local HTTP uses `qa_session`. The app stores no token in browser local
  or session storage and accepts no alternative bearer-token login mechanism.
- CSRF tokens use a domain-separated HMAC key and session ID; the database stores
  only their hashes. Mutations require both a matching token and allowed Origin.
  Login/activation revoke the previous browser session. Logout clears it.
- Rotate `JWT_SIGNING_KEY` by replacing it locally/in the server secret manager
  and restarting the backend. Old JWT/CSRF tokens fail and users log in again.
  There is no overlapping grace key, refresh-token service, or remote JWKS download.
- Passwords use salted Argon2id: 19 MiB memory, two iterations, one lane. Unknown
  users receive dummy-hash verification. Four concurrent hash operations and a
  bounded 30-request/minute/IP public-auth limiter provide basic protection.
  The limiter resets on restart and is not distributed. Forwarded IP headers
  are not trusted by default.

Production expects HTTPS and a frontend/API sharing a site. HttpOnly cookies reduce
token theft through JavaScript but cannot prevent malicious same-origin scripts
from making requests; safe rendering remains necessary. Password reset/change,
MFA, account recovery, and extra admin provisioning are not implemented. Losing
admin credentials requires a trusted operator procedure, not a public bypass.
Expired session-row cleanup and broader operational hardening remain later work.

## operational limits

Public auth remains 30 attempts/minute/IP with bounded process-local buckets.
Owned Stop has a separate 30/minute/user limiter; stream attachment and submission
recovery have separate 20/60 limits, preserving a cancellation path after stream
throttling. Provider cooldown does not block authentication or saved-history reads.
The me allowance's generationAvailable also reflects cooldown/shutdown. Production
TLS, cookie and HSTS requirements are described in SECURITY.md.

## Same-origin streaming

There is a stream-GET-only provenance fallback for browsers that omit Origin:
exact same-origin Fetch Metadata plus the configured public Host, with the same
mandatory session CSRF token and ownership checks. Mutation Origin checks remain
strict. See API.md and SECURITY.md for the full conditions and verified rejection
cases. This is not another authentication mode or an anonymous stream bypass.
