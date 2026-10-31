# Configuration reference

The authoritative server schema is `backend/src/config.ts`. Run `node scripts/setup.mjs`
from the root to generate missing local files; it preserves existing settings. Enter
secrets locally. Examples are placeholders, not usable credentials. This reference
covers every accepted application variable and the local Compose variables.

## Files and precedence

- Root `.env`: Compose interpolation for PostgreSQL identifiers/password only.
- `backend/.env`: server configuration loaded by dotenv in host development and by
  Compose `env_file` for the API. Existing process variables win over dotenv.
- `frontend/.env`: development Vite configuration. All `VITE_` values are public.
- Base `compose.yaml` explicitly overrides API `NODE_ENV`, `HOST`, `PORT`,
  `FRONTEND_ORIGIN` and `DATABASE_URL`; editing those fields in backend/.env does
  not change the full Docker stack. It builds the frontend for `https://localhost:8443`.
  The migration service receives its database URL directly from Compose.
- Frontend values are compiled into assets. Rebuild after changing a public origin.
  Restart/recreate the server after changing backend configuration. Never inject a
  provider key, password or signing key through a frontend value/build argument.

## Root Compose configuration

- `POSTGRES_PASSWORD`: **secret**, required by Compose, safe example
  `REPLACE_WITH_LOCALLY_GENERATED_PASSWORD`. Setup generates 32 random bytes as
  hex. The local URL composition requires at least 20 URL-safe letters, digits,
  underscores or hyphens. It initializes a new database; editing the file does
  not rotate an existing PostgreSQL password.
- `POSTGRES_DB`: public identifier, example/default `query_assistant`. Setup accepts
  letters, digits and underscores, starting with a letter or underscore.
- `POSTGRES_USER`: public identifier, example/default `query_assistant`, same syntax.
  The current local bootstrap uses the image's database owner; separate least
  privilege runtime/migration roles are a future production hardening task.

## Trusted proxy client identity

`TRUSTED_PROXY_HOST` is a non-secret backend DNS hostname, empty by default for
direct development. Compose sets `web`. Forwarded client addresses are used only
when the socket peer matches that hostname’s resolved addresses. Caddy replaces
X-Forwarded-For with its actual client address. Keep API ports private and trust
only an operator-controlled proxy DNS name. Untrusted direct clients cannot
select their rate-limit identity through headers. DNS failure fails authentication
requests closed until resolution recovers.

## Backend identity and connection settings

All settings below belong only on the server. Non-secret does not mean browser-selectable.
Defaults apply only when the variable is absent, not an empty assignment.

- `NODE_ENV`: `development` by default; also `test` or `production`. Production
  requires all four service secrets/settings below and an HTTPS frontend origin.
- `HOST`: `127.0.0.1` by default; Compose sets `0.0.0.0` for internal container access.
- `PORT`: `3001`, integer 1–65535. Container health checks/proxy also assume 3001;
  changing it requires changing those definitions together.
- `FRONTEND_ORIGIN`: `http://localhost:5173` for development. Exact HTTP(S) origin,
  no path/trailing slash. Production requires HTTPS; local Docker uses
  `https://localhost:8443`. Cookies, CORS, CSRF, the frontend build and stream Host
  validation must agree with this public origin.
- `DISPLAY_TIMEZONE`: `Asia/Kolkata`, valid IANA zone for displayed metadata.
- `QUOTA_RESET_TIMEZONE`: `Asia/Kolkata`, valid IANA zone for daily accounting.
  Changing it changes period boundaries; review accounting implications first.
- `DATABASE_URL`: **secret**, required in production and for persistence/auth/chat.
  Safe example `postgresql://REPLACE_USER:REPLACE_PASSWORD@REPLACE_HOST:5432/query_assistant`.
  Host setup generates a loopback URL; base Compose substitutes internal `db:5432`.
- `GEMINI_API_KEY`: **secret**, required in production and for chat. Safe example
  `REPLACE_LOCALLY`; setup comments it out until you enter the paid key. Omit the
  entire assignment for unconfigured development, rather than setting an empty value.
- `GEMINI_MODEL`: `gemini-3.5-flash-lite`. One server provider; no browser override.
  Changing the model requires capability/transport, token bounds and price review.
- `JWT_SIGNING_KEY`: **secret**, required in production and for authentication.
  Safe example `REPLACE_WITH_LOCALLY_GENERATED_SECRET`. Generate at least 32 random
  bytes; setup uses 48. Rotation requires new logins. Preserve it across normal restarts.
- `JWT_ISSUER`: `query-assistant`; `JWT_AUDIENCE`: `query-assistant-web`. Both must
  be nonempty and match verified issued claims. Changing them invalidates old JWTs.

## Backend accounting settings

These decimal strings accept up to nine decimal places, without currency symbols
or scientific notation. Estimates exclude provider invoice differences, tax and
fees. No setting is a provider-side hard billing cap.

- `ACCOUNTING_INR_PER_USD`: required positive decimal in production/chat. Approved
  example `100`; no schema default or live currency fetch.
- `MODEL_INPUT_USD_PER_MILLION`: default/example `0.30`.
- `MODEL_OUTPUT_USD_PER_MILLION`: default/example `2.50`.
- `PRICE_VERSION`: nonempty identifier. Schema fallback `2026-10-30`; shipped
  example `2026-10-30-inr100`. Keep a unique new version when model, price or
  conversion changes. Existing request snapshots stay immutable; reusing a
  version with different values is rejected by storage. These configured rates
  were checked on 31 October 2026, not promised as future provider prices.
- `USER_DAILY_REQUEST_LIMIT`: positive integer, default `10` dispatched attempts.
- `USER_DAILY_TOKEN_LIMIT`: positive integer, default `100000` accounted tokens.
- `USER_DAILY_COST_LIMIT_INR`: nonnegative decimal, default `100`.
- `GLOBAL_DAILY_COST_LIMIT_INR`: nonnegative decimal, default `500`.
- `GLOBAL_TOTAL_COST_LIMIT_INR`: nonnegative decimal, default `1000`.

Daily counters use stable account IDs, timezone boundaries and outstanding
reservations. Logging out does not reset them. Zero cost caps block paid allowance.
User defaults initialize account limits; existing accounts have persisted,
versioned quota controls edited through Administration. Changing an environment
value is not an audited replacement for an existing user's quota edit.

## Backend admission and output bounds

All are positive integers; the final five have the stated upper bounds.

- `USER_REQUESTS_PER_MINUTE`: `6` submission attempts, process-local burst control.
- `USER_MAX_ACTIVE_GENERATIONS`: `1` per user; `GLOBAL_MAX_ACTIVE_GENERATIONS`: `4`.
  The implemented registry remains local to one backend process.
- `MAX_PROMPT_CHARACTERS`: `8000`, maximum 8000 characters.
- `MAX_CONTEXT_TOKENS`: `16000`, maximum 16000 input/context tokens.
- `MAX_OUTPUT_TOKENS`: `2000`, maximum 2000 output tokens.
- `GENERATION_TIMEOUT_SECONDS`: `90`, maximum 90 seconds overall.
- `STREAM_IDLE_TIMEOUT_SECONDS`: `20`, maximum 20 seconds, cannot exceed overall timeout.

Changing these bounds may affect conservative reservations and usability near a
quota cap. UI/contracts have their own fixed upper bounds. Stop is best effort;
unknown dispatched usage receives conservative accounting, never a guaranteed refund.

## Frontend public setting

`VITE_API_BASE_URL` is the only application frontend variable. Development example
`http://localhost:3001`; local Docker build `https://localhost:8443`. It is public,
used for API requests and must match the selected topology. There are no provider,
model, auth-secret or search settings in the frontend. Local Compose hardcodes the
build argument; a hosted build must explicitly use its own HTTPS origin.

## Verification-only controls

Use documented npm commands instead of manually setting internal fixture flags.
`CHROME_BIN` optionally selects an installed Chrome executable for opt-in browser
checks. `--live-gemini` and `--model-evaluation` explicitly opt into paid calls;
ordinary checks do not. Internal `TEST_DATABASE_URL` and `QUERY_ASSISTANT_*` flags
are test-harness controls, not production configuration or a product mock mode.
See [local setup](../LOCAL_SETUP.md) and [verification and CI](../README.md#verification).
