# Query Assistant

A React/TypeScript AI query assistant with a Node.js/TypeScript API, paid Gemini
3.5 Flash-Lite integration and PostgreSQL in Docker. Includes approved local
username/password accounts, streaming answers, saved conversations, Stop, daily
quotas and an administrator dashboard. Web search is excluded.

## Local setup

Requirements: Node 22.16+ within major 22 or Node 24, npm 10+, Docker with Linux
containers and Compose v2.24.4+. Use the commands from the repository root.

```sh
node scripts/setup.mjs
npm ci
```

The setup helper creates missing local environment files with random database and
signing secrets without overwriting existing configuration. Enter your paid Gemini
API key locally in `backend/.env`; never put a key into frontend configuration or
version control. The committed `.env.example` files contain placeholders only.
The default accounting conversion is INR 100/USD; estimates are not provider invoices.

For the full container stack:

```sh
npm run docker:up
npm run docker:admin -- --username YOUR_ADMIN_USERNAME
```

The administrator command prompts for a hidden password in an interactive terminal.
No privileged demo account is seeded. Open **https://localhost:8443** after following
the public CA export and trust instructions in [LOCAL_SETUP.md](LOCAL_SETUP.md).
Approve a requested username in the dashboard and manually hand its one-use activation
code to the user. Admins can later suspend/revoke access or edit quotas.

For host development instead:

```sh
npm run db:up
npm run db:migrate
npm run admin:bootstrap -- --username YOUR_ADMIN_USERNAME
npm run dev
```

Open http://localhost:5173. Use either host development or the full stack against a
database, with one backend instance. [LOCAL_SETUP.md](LOCAL_SETUP.md) covers Linux,
macOS and Windows tooling, build targets, secrets, TLS, troubleshooting and backup/restore.

## Architecture and decisions

The browser talks to Fastify; only Fastify calls Gemini and PostgreSQL. In the Docker
stack, Caddy serves the React assets and proxies `/api/*` on one HTTPS origin.
PostgreSQL persists identity, sessions, chat, quota reservations, usage and audit events.

- React with Vite and TypeScript provides a compact typed frontend and production build.
- Node.js with Fastify provides modular routes, validation boundaries and bounded requests.
- npm workspaces share one lockfile and a Zod contracts package for runtime validation
  and inferred TypeScript types in both apps.
- Prisma 7 with its PostgreSQL adapter supplies typed access and committed migrations;
  parameterized tagged SQL supports atomic ledger locking and reporting.
- `jose` and Argon2id implement signed JWT cookie sessions and password hashing.
  Sessions and roles are also checked against the database to support immediate revocation.
- The official `@google/genai` SDK handles generation; native fetch performs token
  counting with the system instruction. Provider access is isolated behind a backend
  interface. Changing providers requires an adapter plus usage/error/pricing validation.
- SSE streams answers with bounded buffers and durable checkpoints. Stop is best effort;
  ambiguous dispatched work retains conservative accounting instead of an assumed refund.
- A Temporal polyfill calculates timezone-aware quota boundaries. Atomic reservations
  enforce user and global estimated budgets before a provider call.
- Safe Markdown disables raw HTML/images and limits outbound links. Caddy and Fastify
  supply security headers. Playwright is not required: browser smoke scripts use Chrome
  directly; axe-core supplies selected automated accessibility checks.

The provider/model and local authentication mode are fixed. There is no email service,
web search, alternative provider mode or automated retrieval. Recent facts are not
guaranteed. There is no automatic paid retry or answer continuation.

Default per-user limits are 10 requests, 100,000 tokens and INR 100/day. Global local
estimate limits are INR 500/day and INR 1,000 lifetime. See the complete
[configuration reference](docs/CONFIGURATION.md), [API](docs/API.md),
[authentication](docs/AUTH.md), [storage](docs/STORAGE.md) and [security](docs/SECURITY.md).

## Verification

```sh
npm run check
npm run test:integration
npm run test:integration -- --browser-check
npm run test:docker -- --browser-check
```

`check` verifies documentation, formatting, lint, strict types, focused tests and
production builds without provider calls. Integration tests require Docker, create
an isolated PostgreSQL database and use a mocked provider. Browser checks require
Chrome or `CHROME_BIN` and built assets. Docker checks cover HTTPS, packaging,
streaming, crash recovery, restart persistence and fresh-target backup/restore.
Test containers are stopped and their volumes retained. Generated test output is ignored.

The application was locally checked with 46 focused tests, 55 mocked integration
leaf scenarios, 24 host browser groups, 13 Docker groups and six packaged HTTPS
browser groups. Twelve selected-rule axe scans reported no violations. These are
scoped checks, not comprehensive accessibility or production certification.

The GitHub Actions [workflow](.github/workflows/ci.yml) runs checks/integration on
Node 22 and 24 plus packaged Docker/browser checks on Ubuntu. It needs no API secrets
and does not publish or deploy. A remote workflow run has not been performed.

An explicitly paid optional transport check is `npm run test:integration -- --live-gemini`.
It uses a locally supplied key for two real generations. Default verification never
opts into it. Do not run it unintentionally or treat estimated costs as invoice caps.

## Operating limits and deployment

Run one API instance: live stream coordination, burst limits and cooldown are
process-local. Docker volumes preserve data through restart but are not off-host
backups or high availability. Setup never deletes volumes. Password reset, MFA,
distributed coordination and production least-privilege database roles remain future
work. Only local macOS execution has been exercised; Linux/Windows host behavior and
cloud deployment require their own validation. The pg 8 concurrent-query warning
remains unresolved. Provider processing/retention is governed by provider settings
and terms; no zero-retention guarantee is made.

[DEPLOYMENT.md](DEPLOYMENT.md) describes an AWS Mumbai container-host approach,
secret handling, certificates, monitoring and production trade-offs. No cloud
account or deployment is needed to run locally, and no hosted deployment is claimed.

This repository contains application source, tests, migrations, lockfile/build
configuration, Dockerfiles/Compose, environment examples and operational documentation.
Local credentials, personal notes, interview preparation, generated files, dumps,
logs and implementation planning history are excluded.
