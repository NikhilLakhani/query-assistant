# Local setup

Run commands from the repository root. This guide supports host development and a
complete local Docker stack. Both use Docker PostgreSQL with the same schema and
local username/password accounts. Gemini remains a remote paid API; Docker does
not make answers work offline. AWS or Azure is not required for local execution.

## Prerequisites

- Linux, macOS, or Windows with Docker Engine/Desktop running **Linux containers**,
  Docker Compose v2.24.4 or later, and BuildKit/buildx. On Windows, use Docker
  Desktop with WSL2 and run the commands in PowerShell or a WSL terminal.
- Maintained Node.js 22 patch release (minimum 22.16) or Node.js 24, and npm 10+.
  `.nvmrc` selects Node 22. Host Node is used for setup/backup helpers; the images
  contain their own pinned Linux Node runtime. Container-only manual configuration
  is possible by copying the example files, but the documented commands use Node.
- Internet access for npm/base images, OS certificate packages, and Gemini.
  A paid Gemini API key configured locally. No API subscription purchase or
  cloud deployment is performed by setup.
- Available ports: 5173/3001 for host development; 5432 for the explicit development
  database override; 8443 for Docker HTTPS. The base stack publishes only 8443
  on loopback. Keep one backend instance because live jobs/rate buckets are local.

Linux images support linux/amd64 and linux/arm64. macOS/Windows hosts run these
inside Docker's Linux VM; these are not native Windows container images.
See README.md#verification for the OS/architecture combinations actually tested.

## Create configuration without overwriting existing files

The setup command uses only Node built-ins, so it also works before npm install:

```sh
node scripts/setup.mjs
npm ci
```

After installing dependencies, `npm run setup` is equivalent to the first command.
It creates root `.env`, `backend/.env`, `frontend/.env` and `.local/` only when
missing. It generates a random URL-safe database password and signing key, and
links the host database URL to that password. Existing files and secrets are
preserved, including on repeated runs; invalid existing root placeholders produce
a message instead of being overwritten. On Unix, new secret files use mode 0600;
Windows file ACLs depend on your user/profile permissions.

Open `backend/.env` in your editor. Uncomment `GEMINI_API_KEY=` and enter your paid
key there. Never enter secrets in chat, command arguments, frontend config or a
Docker build argument. Check all placeholders have been replaced. Root `.env`
contains Compose's database password and identifiers; `backend/.env` contains the
server key, signing key and server configuration. `frontend/.env` contains only
the public development API origin. All three files are ignored by Git and Docker.

If configuring manually, copy the three `.env.example` files using your file
manager, `cp` on macOS/Linux, or `Copy-Item` in PowerShell. Use at least 20 random
URL-safe characters (letters, digits, underscore or hyphen) for root
`POSTGRES_PASSWORD`, because the local Compose URL embeds it without URL escaping.
Use at least 32 random bytes for the signing key. Keep root identifiers and the
host `DATABASE_URL` consistent. Local setup generates compatible values itself.

Accepted estimate settings are INR 100/USD, INR 100/user/day, INR 500 global/day
and INR 1,000 global lifetime. Keep the model/prices/PRICE_VERSION consistent.
Changing prices or the INR conversion requires a new price version. These are
local estimates; provider invoices, exchange rates, taxes and fees can differ.

## Complete Docker execution

```sh
docker compose config --quiet
npm run docker:up
```

Do not print or share `docker compose config` without `--quiet`, container env,
or inspection output: expanded configuration contains runtime secrets.

The command builds three application targets: a one-shot migration image, the
production API image, and the static frontend/Caddy image. PostgreSQL first passes
its health check. Migrate runs `prisma migrate deploy`; the API starts only after
successful schema deployment. Web starts after API readiness. A running database
alone does not establish that migrations or application services are ready.
`docker:up` waits for readiness and fails if startup fails. Repeated migrations
are idempotent; an unsuccessful migration is not silently reset.

The backend and frontend run as non-root users. The backend runtime contains
compiled TypeScript and production dependencies, while migration tools stay in
the tooling stage. Compose uses exec-form commands, an init process for the API,
a read-only API root filesystem, writable temporary storage, and a 15-second
stop grace period around the server's ten-second shutdown deadline.

### Trust the local HTTPS certificate

Docker serves `https://localhost:8443`. The backend runs in production mode,
uses Secure HttpOnly cookies and requires an HTTPS frontend origin. Caddy issues
a certificate using a CA stored in this project's named `caddy-data` volume.
Its process is not allowed to install trust on your host automatically.

Export only the public root certificate:

```sh
docker compose cp web:/data/caddy/pki/authorities/local/root.crt .local/caddy-root.crt
```

Before using the browser, manually trust this local root certificate for your
own computer. Trusting it allows this CA to sign trusted certificates, so keep
the Caddy volume/private keys private. Do not upload or share that volume. The
exported root.crt itself is public. Do not disable TLS verification globally.

- macOS: open `.local/caddy-root.crt` in Keychain Access, add it to the login
  keychain and set trust for this local root to Always Trust. Follow the OS prompt.
- Windows PowerShell: `Import-Certificate -FilePath .local/caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root`.
- Debian/Ubuntu Linux: copy the public file to
  `/usr/local/share/ca-certificates/query-assistant-local.crt` with appropriate
  administrator privileges, then run `sudo update-ca-certificates`. Other
  distributions use their own trust tools.

Restart the browser if needed. Firefox or managed browsers may require importing
into their own certificate store. Use **localhost**, not a LAN IP or another
hostname: this local configuration/certificate/origin is for localhost:8443.
Test trust without modifying a system store using
`curl --cacert .local/caddy-root.crt https://localhost:8443/health/ready`.
In PowerShell, use `curl.exe` if `curl` names a PowerShell alias.

Do not remove the Caddy volume to troubleshoot trust: that replaces the local CA
and requires removing the old trust entry and trusting the new public certificate.
The project does not change host certificate trust stores automatically.

### Provision the first administrator and approve users

In an interactive terminal after startup:

```sh
npm run docker:admin -- --username YOUR_ADMIN_USERNAME
```

Enter and confirm a 12–128-character password at the hidden prompts. No password
argument or environment variable is accepted. The command refuses a second
bootstrap if any administrator exists. It does not seed a privileged demo account.

Open `https://localhost:8443`, sign in and select Administration. A new user first
requests a username, an administrator approves it with a reason, and the admin
privately hands over the one-time activation code. The user enters the code and
chooses a password. Approval alone does not create an account. Codes expire after
24 hours; a deliberate replacement invalidates the previous code. There is no
email service or outbound handoff automation. Suspension/revocation invalidates
sessions; restoring access requires a new login and preserves usage.

### Daily commands

```sh
docker compose ps
docker compose logs --tail=100 api web migrate
npm run docker:stop
npm run docker:up
```

`stop` and later `up` preserve the named PostgreSQL and Caddy volumes. `docker
compose down` removes containers/networks while retaining named volumes. Avoid
`down --volumes` or `docker volume rm`: these are destructive data/key deletion
operations, not setup or troubleshooting steps. No provided script removes volumes.
Do not share logs or dumps without reviewing them for sensitive operational data.

`npm run docker:migrate` explicitly redeploys committed migrations with the tooling
service; API startup already coordinates this. After changing backend environment,
use `docker compose up -d --force-recreate api web` to reload configuration. Signing
key replacement requires new user logins. The frontend origin is a **public build
setting**: changing it requires a frontend rebuild and matching server/proxy TLS
configuration. Editing frontend/.env after an image build does not alter its bundle.

## Host development

```sh
npm run db:up
npm run db:migrate
npm run admin:bootstrap -- --username YOUR_ADMIN_USERNAME
npm run dev
```

The first command combines compose.yaml and compose.dev.yaml and starts only db,
with its port explicitly bound to `127.0.0.1:5432` and a development-only bridge
for host port forwarding. The base internal network alone blocks that forwarding. The host `backend/.env` uses
`HOST=127.0.0.1`, development cookies, `FRONTEND_ORIGIN=http://localhost:5173`
and its matching host database URL. Open `http://localhost:5173`; health is
`http://localhost:3001/health/ready`. If an admin already exists, skip bootstrap.

Stop dev servers with Ctrl+C. `npm run db:stop` stops PostgreSQL and preserves data.
The base Docker stack overrides API bind address, database hostname, production
mode, trusted proxy hostname and frontend origin at runtime; it preserves the locally configured key,
signing key, quotas and prices. Do not run host and container backends together
against the same database: single-process generation coordination is assumed.
Development and full Compose intentionally use the same named database volume
unless you select a different Compose project. Stopping both before switching
avoids concurrent backends and confusing cookie/session state.

## Backup and restore

A dump includes chat text, usernames, password hashes, sessions, activation hashes
and accounting. Keep it private and encrypted off-machine as appropriate. A local
Docker volume is not an independent backup. The helper streams binary output and
does not use shell redirection, so the same commands work in PowerShell and Unix.

For a quiet snapshot, stop API/web first while leaving db running:

```sh
docker compose stop api web
npm run db:backup -- backups/before-change.dump
npm run db:restore -- backups/before-change.dump --database query_assistant_restore_check
```

Backup refuses an existing output path. Restore requires a **new** database name,
refuses the configured application database and an existing target, and uses a
single transaction with exit-on-error. A failed new restore database is left for
inspection; no database is automatically dropped. Global/other-user objects are
not exported as an extra cluster backup; the local database owner is used for the
restored objects. Check restored row counts, migrations and representative private
history yourself before any cutover.

The app continues to reference its original database. To deliberately switch
later, stop API/web, update root `POSTGRES_DB` and host `DATABASE_URL` to the verified
copy, then run `npm run docker:up`. Keep the original database and dump until you
have validated the restored application. Sessions may remain valid because their
DB records and signing key persist; plan key rotation if restoring a compromised
snapshot. Restored incomplete generations are subject to conservative recovery.
A restore does not synchronize or reverse charges already incurred at Gemini.

## Builds verification and troubleshooting

```sh
npm run check
npm run test:integration -- --browser-check
npm run test:docker
```

The integration browser check needs Chrome or `CHROME_BIN` and a prior
`npm run build`. `test:docker` uses a separate clean-input workspace, synthetic
credentials, a separate Compose project and volumes, verified TLS with the exported
CA, and no paid model calls. Its local 8443 and development-check 5432 publications must be free; stop your
application stack first if necessary. It retains and stops its isolated resources,
never deleting volumes. `npm run test:docker -- --browser-check` adds packaged
HTTPS browser flows; it verifies the local chain and scopes a test-only leaf
certificate pin to a fresh Chrome profile, without changing host trust.
Read exact coverage and limitations in README.md#verification.

To build for an explicit Linux architecture from any Docker host, run:

```sh
docker buildx build --platform linux/amd64 --load -f backend/Dockerfile -t query-assistant-api:amd64 .
docker buildx build --platform linux/arm64 --load -f backend/Dockerfile -t query-assistant-api:arm64 .
docker buildx build --platform linux/amd64 --load -f frontend/Dockerfile -t query-assistant-web:amd64 .
docker buildx build --platform linux/arm64 --load -f frontend/Dockerfile -t query-assistant-web:arm64 .
```

Cross builds may need Docker Desktop's emulation or a configured buildx builder.
Use one platform per `--load` command. Base images are pinned multi-platform
manifest digests, and npm uses the lockfile. OS certificate packages are installed
from Debian repositories during the build; bit-for-bit identical layers across
arbitrarily separated builds are not promised. Update image pins intentionally for
security maintenance. Publishing images or deploying is a separate authorized action.

If startup fails, inspect `docker compose ps`, migration logs and safe API logs.
Missing key/signing/accounting settings fail production startup. A healthy db with
failed migrate prevents API startup. A healthy API readiness check does not verify
that the Gemini key works and incurs no provider charge. API cooldown can make
readiness temporarily unhealthy while history is still available.

Port conflicts require stopping the other service, not deleting volumes. Database
password changes in `.env` do not change a password inside an initialized volume;
use an intentional PostgreSQL password rotation and matching connection settings.
A localhost certificate error requires the exported CA/trust check, not insecure
cookies. If a browser upgrades the host-development localhost HTTP URL to HTTPS after
using the production stack, use a separate development browser profile or clear
only its localhost transport-security entry. Slow/failed npm or apt downloads require network access; keep the failure
log private and retry the build. The documented pg 8 concurrent-query warning
remains unresolved. The written Mumbai hosting approach is in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration and verification

Read [CONFIGURATION.md](docs/CONFIGURATION.md) for every accepted variable, its
scope/default/secret status, Compose overrides and price-version rules.
`npm run docs:check` verifies required deliverables, configuration coverage, local
links and documented script names. It is included in `npm run check`.
See [README verification](README.md#verification) for tests and CI requirements.

If npm reports a permission/rename error inside an existing user cache, use a new
project-owned cache instead of changing global permissions or forcing overwrites:

```sh
npm ci --cache .local/npm-cache
```

The .local directory is ignored and excluded from source delivery. A failed install
is not a passed setup; rerun the combined check after the install succeeds.

After changing backend code or configuration, rebuild/recreate the Docker API and web
with `npm run docker:up`. No new secret or manual env entry is needed: Compose
sets TRUSTED_PROXY_HOST=web and host development defaults to direct socket IPs.
If auth reports the proxy unavailable, check the web service/Docker DNS and its
network membership. Keep API ports private and avoid trusting client-supplied headers.
