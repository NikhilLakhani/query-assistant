# AWS Mumbai deployment approach

This is a proposed deployment runbook for the existing application. It has not
been deployed to AWS. Local execution needs no AWS/Azure account. Cloud hosting
would let remote reviewers use a shared service; it adds cost and operational
responsibility. The accepted target is AWS Mumbai (`ap-south-1`), with PostgreSQL
inside Docker and local application username/password authentication. No Supabase,
Cognito, RDS or second auth mode is introduced. Provisioning, publication and
spending require a separate operator decision; this step creates documentation only.

## Proposed topology and rationale

Use one Linux EC2 host in Mumbai running the API, migration job, PostgreSQL 17 and
Caddy/static React frontend. Store database and Caddy state on encrypted EBS with
explicit retention on instance replacement. An EBS volume is tied to one Availability
Zone; record the host AZ and recovery procedure. Keep images in private ECR
repositories in Mumbai, one each for API runtime, migration tooling and web runtime.
Use immutable release identifiers and record deployed image digests.
[Amazon EBS documentation](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html)
and [ECR registry documentation](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Registries.html)
support these service choices. This topology is an application-specific recommendation.

The browser connects to one public HTTPS domain on Caddy. Caddy serves the built
React assets and proxies `/api/*` and `/health/*` to internal `api:3001`. API and
migration containers connect to internal `db:5432`; PostgreSQL has no host publication.
Only the API needs outbound HTTPS to Gemini. One host matches the implemented
process-local live registry, cancellation and rate controls. It has a single host/AZ
failure domain and planned maintenance downtime; it does not provide HA.

Start with a modest general-purpose instance, then choose memory/CPU/storage using
observed RSS, build/runtime use, concurrent streams and database growth. Build
images on a separate builder, not on a tiny production host. No exact instance
price, free tier, availability or monthly bill is assumed here.

## Networking and access

Use a VPC public subnet with an internet gateway and a stable public address/domain
for the single-host design. Restrict inbound security-group traffic to HTTPS 443;
allow HTTP 80 only for certificate issuance/redirect if using HTTP validation. Do
not expose 3001, 5432, local 8443 or Caddy's management endpoint publicly. Restrict
reviewer access when possible, while preserving the certificate validation path.
A private-subnet alternative needs outbound NAT or appropriate endpoints for AWS
services plus an internet path for Gemini; that adds cost/complexity to this PoC.

Use SSM Session Manager with least-privilege operator IAM instead of opening SSH
to the internet. Configure its agent, IAM instance profile and outbound/endpoints
as required. [AWS Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
describes access without inbound management ports. Require IMDSv2 and avoid static
AWS credentials in containers. The deployment role may push images; the host role
only pulls its selected repositories, reads its selected secrets and writes its
selected logs/backups. AWS role permissions do not replace application login/admin roles.

## Registry and release preparation

Run local `npm ci`, `npm run check`, isolated integration and Docker acceptance
checks before approving a release. Record the source revision/archive hash,
lockfile, Node/image pins, schema migration set and image digests in a release record.
Build three targets from the repository root on the target CPU architecture:

```sh
docker buildx build --platform linux/amd64 --target runtime --load -f backend/Dockerfile -t query-assistant-api:release .
docker buildx build --platform linux/amd64 --target tooling --load -f backend/Dockerfile -t query-assistant-migrate:release .
docker buildx build --platform linux/amd64 --load -f frontend/Dockerfile --build-arg VITE_API_BASE_URL=https://assistant.example.com -t query-assistant-web:release .
```

`assistant.example.com` is a placeholder to replace with the approved domain.
Choose `linux/arm64` consistently if the selected host uses ARM; both architectures
have local image evidence, not cloud deployment evidence. The web image still
contains the local Caddyfile, so the hosted configuration below must replace it.
No secret belongs in build arguments or layers. Examples deliberately build only;
registry creation, login, tagging and pushing follow an approved release process.
Use [AWS's ECR push procedure](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)
with short-lived IAM credentials, then deploy by `repository@sha256:...`, not `latest`.
The selected CI workflow verifies builds and does not publish or deploy.

## Changes required before hosted startup

The committed `compose.yaml` is a **local** stack. It binds 127.0.0.1:8443, pins
localhost origins and uses Caddy's internal CA. Copy its topology into an operator-owned
hosted manifest and make the following explicit changes before executing it:

1. Replace each application `build` with the approved ECR `image` digest. Keep a
   separate migrate service using the tooling image. Keep PostgreSQL's selected pin.
2. Set API `FRONTEND_ORIGIN=https://assistant.example.com`, production mode,
   internal HOST/PORT and the matching database URL. Build web with that exact
   public API origin. Preserve the public Host through the proxy: the same-origin
   stream fallback verifies it. Keep Fastify's global forwarded-header trust false;
   set TRUSTED_PROXY_HOST to the operator-controlled proxy service DNS name and
   preserve the Caddy rule that overwrites X-Forwarded-For from the client socket.
3. Mount a reviewed hosted Caddyfile read-only at `/etc/caddy/Caddyfile`. Use the
   public domain and a public CA rather than `tls internal`; remove the local
   `auto_https disable_redirects` setting so public HTTP can redirect to HTTPS; never ship the local
   CA private key as a public certificate. To retain non-root container operation,
   have Caddy listen internally on 8080/8443 with global `http_port 8080` and
   `https_port 8443`, publish host 80 to 8080 and host 443 to 8443. The public site
   address remains `https://assistant.example.com`, without a public 8443 suffix.
4. The existing web health check uses container HTTP port 8080 `/healthz`. Move
   that private health listener to e.g. `http://:8081` and update its image/manifest
   health check accordingly, so it does not conflict with the public HTTP listener.
   Keep the original static security headers, SPA fallback and API routes.
5. Preserve `reverse_proxy api:3001 { flush_interval -1 }`, avoid response buffering,
   caching and automatic retries for chat/stream routes. Forward `Origin`, cookies,
   Fetch Metadata and X-CSRF-Token unchanged. Keep connection/read/idle limits above
   the application's 90-second generation and 110-second browser bounds (e.g. 120
   seconds) on any added upstream proxy. Test deltas, Stop and disconnects end to end.
   Caddy documents [streaming proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).
6. Preserve non-root users, API read-only root/init/tmpfs, shutdown grace, internal
   database network, health/migration dependencies and persistent volumes. Place
   Docker's data root on the intended encrypted data disk or explicitly map the
   PostgreSQL/Caddy storage there with correct permissions; a named volume alone
   does not ensure storage is on the separate retained EBS disk.
7. Configure bounded Docker log rotation and the host service manager so Docker
   and the chosen deployment start after storage/network availability. An unhealthy
   Docker container is not automatically restarted by `restart: unless-stopped`;
   investigate/alert rather than repeatedly restarting during provider cooldown.

These are adaptation requirements, not a tested hosted override shipped by this
repository. Validate the resulting manifest privately with `docker compose -f
HOSTED_FILE config --quiet`, validate Caddy with its pinned image and mounted
configuration, then exercise the domain in a browser. Do not reuse the local
setup/backup helpers blindly with a differently named manifest/project: those
helpers call the root Compose topology. Adapt/review their invocation first.

## Runtime secrets and authentication

Store Gemini, JWT and database credentials in AWS Secrets Manager. Give only the
host release mechanism permission to retrieve those named secrets. Materialize
mode-0600 runtime env files outside the source checkout using a reviewed loader,
without stdout, command arguments or shell tracing; point the hosted manifest to
them. Compose does not fetch Secrets Manager automatically, and this app currently
reads environment variables rather than secret-file mounts. Operators with root
or Docker access can inspect container environment and database content.
[Secrets Manager retrieval](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets.html)
is an operator integration, not an implemented SDK dependency in this app.

Preserve the JWT key during ordinary redeploys. Rotate compromised keys and require
fresh logins; coordinate real PostgreSQL role-password rotation with connection
settings rather than editing an initialized-volume password alone. Never put a
secret in the frontend, Caddyfile, image tag, Dockerfile, CI log or public README.
Use [CONFIGURATION.md](docs/CONFIGURATION.md) for all settings and price-version rules.

Run the existing hidden-prompt first-admin provisioning command in an interactive,
trusted session against the hosted manifest's API image after migrations/readiness.
It refuses another bootstrap if an admin exists. Users request access and receive
an admin-approved activation code through a private manual handoff. No email,
cloud identity service, privileged seed or automatic account approval is required.
Database/session checks enforce later suspension and revocation.

## Migration startup and release sequence

Take and verify a private pre-release backup. Put the service in a planned
maintenance window and stop web/API to avoid mixing old and new writers. Pull the
approved images; start/wait for PostgreSQL; run the one-shot migrate service with
`prisma migrate deploy`; inspect its exit status. Start API only after successful
migration, then web only after API readiness. Do not use `prisma migrate dev`,
`db push` or reset in a deployed environment. Keep migration tooling out of the API runtime.

Validate local liveness and readiness, public verified HTTPS, cookie flags and
login, approved-account activation, one synthetic chat/follow-up, progressive SSE,
Stop and saved reload, and admin usage reconciliation. Any live Gemini smoke must
be explicitly budgeted; readiness makes no paid call and does not validate the key.
Record failures and keep maintenance in place if schema/startup fails. Do not
start a second API as a blue/green shortcut against the same live database.

## Observability and response

Collect redacted structured API stdout, migration outcomes and bounded container
logs into CloudWatch Logs with restricted access and finite retention. Avoid
request/response bodies, Authorization/cookies, CSRF/activation codes, connection
URLs and provider diagnostics. Correlate failures by generated request ID; inspect
user metadata only with a valid operational reason. Caddy access logging is not
currently enabled; do not add sensitive header/body logging as part of hosting.

Probe `/health/live` for process response and `/health/ready` for local service
readiness. Readiness includes local database/chat readiness and cooldown, not a
remote Gemini availability or billing guarantee. Web's process health alone does
not prove API health. Alert on sustained readiness failures, abnormal auth/403/429/
provider errors, uncertain/interrupted work, exhausted budgets, disk/inode pressure,
database connection pressure and backup age/failure. Add host memory/disk metrics
with an agent as needed; custom cloud alarms/dashboards are proposed, not implemented.
Investigate the documented pg deprecation warning before any pg-major upgrade.

## Backups restore and recovery

Use encrypted off-host PostgreSQL custom-format dumps plus retained EBS snapshots.
Set a documented retention policy (initial proposal: seven daily and four weekly
dumps), S3 encryption/access restrictions and lifecycle rules. Include Caddy certificate
state and the secret-recovery/rotation procedure separately. A database dump
contains private chats, usernames, hashes, sessions and accounting. Never upload it
as a CI artifact. Protect snapshot access and ensure the EBS data volume is not
set to delete accidentally with the host.

Take application-consistent backups: stop API/web for the quiet snapshot/dump or
use a reviewed PostgreSQL online backup/WAL design. EBS snapshots alone do not
establish application consistency, PITR or a tested RPO. Daily backups imply up to
roughly a day of data loss if no fresher recoverable copy exists; recovery time
must be measured, not promised. Retained quotas restored from an old dump may
undercount later provider charges; reconcile conservative billing limits before
reopening paid traffic.

Regularly restore into a separate database/isolated host, verify migrations,
counts/accounting signatures, sample private history and authentication, then
record the restore time and results. Keep the original database and encrypted
backup until deliberate cutover succeeds. Never restore over the live database or
remove volumes as troubleshooting. The local backup helper's refusal checks and
fresh-database restore are verified locally; scheduling, S3 transfer and AWS
recovery have not been implemented or tested.

## Rollback scaling and cost

Keep the previous image digests, manifest, configuration/price version and verified
backup. If a release fails before a schema change, stop the new API and revert to
the compatible previous images. After migration, verify old-code/schema compatibility;
Prisma deploy does not automatically undo schema/data changes. Prefer an additive
forward fix. A backup restore is a deliberate data-loss/reconciliation event and
requires stopping writers; it does not reverse remote provider charges. JWT key
rotation or old-snapshot recovery may invalidate/reintroduce sessions, so review
account revocations before reopening access.

Vertical sizing is the first scaling step. Adding backend replicas requires a
shared live-job/cancellation mechanism, distributed burst/auth limits and provider
cooldown, cross-replica connection routing, and a tested drain/lease/recovery design.
The PostgreSQL global ledger row also becomes a contention point. Durable budget
transactions alone do not make the full application horizontally scalable. Moving
the database or adopting managed auth would change the accepted implementation and
requires a separate design decision.

Budget separately for EC2, encrypted EBS, snapshots, ECR storage/scanning, public
IPv4, logs, Secrets Manager, S3, DNS/domain, data transfer and paid Gemini. NAT/ALB/
CDN, if added later, have extra fixed and traffic costs. Use current Mumbai prices
and billing alerts before provisioning; app quota estimates do not cap AWS charges
or match a provider invoice. No cloud price quote or provisioned resource is included.

Mumbai placement covers the proposed host, database, registry, secrets and backups.
Gemini remains an external API: Mumbai hosting does not guarantee Gemini processing
or retention in India. HTTPS egress has provider latency and possible transfer
costs. No cross-cloud database link exists in this selected design. Reassess
latency, egress cost, TLS and data terms before introducing a remote database or
another provider. Paid API data-use/abuse-monitoring terms remain as documented in
[SECURITY.md](docs/SECURITY.md).

## Verification boundary and references

Official service/proxy documentation was consulted on 31 October 2026. Local image,
TLS, restart, SIGKILL recovery and fresh-database restore evidence is recorded in
[README verification](README.md#verification). Cloud IAM, DNS/public certificates, hosted
Caddy adaptation, network rules, secret loader, scheduled backups, alarms, EC2
recovery and bill have **not** been executed. Complete those checks in a separately
authorized deployment, and keep the local reviewer path in [LOCAL_SETUP.md](LOCAL_SETUP.md).
