import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomUUID().slice(0, 8);
const container = `query-assistant-test-${suffix}`;
const volume = `${container}-data`;
const password = randomBytes(32).toString('hex');
const safe = (value) => value.split(password).join('[REDACTED]');
// Invoke npm's JS entry point directly: spawning npm.cmd without a shell does
// not work reliably on Windows, and no shell interpolation is needed here.
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error('Run this verification through npm run test:integration.');
let started = false;

async function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, shell: false });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () =>
      reject(
        new Error(
          `Could not start ${command}. Check installation and permissions.`,
        ),
      ),
    );
    child.on('close', (code) => {
      if (code !== 0)
        reject(
          new Error(safe(`${command} failed (${code}).\n${stdout}\n${stderr}`)),
        );
      else resolve(safe(stdout.trim()));
    });
  });
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await run('docker', [
        'exec',
        container,
        'pg_isready',
        '-U',
        'qa_test',
        '-d',
        'query_assistant_test',
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('The isolated PostgreSQL database did not become ready.');
}

const signatureSql = `SELECT json_build_object(
  'users',(SELECT count(*) FROM "User"),
  'userAuthState',(SELECT md5(string_agg("id"::text || "passwordHash" || "role"::text || "status"::text,',' ORDER BY "id")) FROM "User"),
  'sessions',(SELECT count(*) FROM "Session"),
  'sessionState',(SELECT md5(string_agg("id"::text || "csrfTokenHash" || coalesce("userId"::text,'anonymous') || coalesce("revokedAt"::text,'active') || "expiresAt"::text,',' ORDER BY "id")) FROM "Session"),
  'accessRequests',(SELECT count(*) FROM "AccessRequest"),
  'approvalState',(SELECT md5(string_agg("id"::text || "status"::text || coalesce("activationCodeHash",'none') || coalesce("activationExpiresAt"::text,'none'),',' ORDER BY "id")) FROM "AccessRequest"),
  'auditEvents',(SELECT count(*) FROM "AdminAuditEvent"),
  'generations',(SELECT count(*) FROM "GenerationRequest"),
  'usage',(SELECT count(*) FROM "UsageRecord"),
  'requestsUsed',(SELECT sum("requestsUsed") FROM "QuotaPeriod"),
  'tokensUsed',(SELECT sum("tokensUsed") FROM "QuotaPeriod"),
  'costUsed',(SELECT sum("costUsedNanoInr") FROM "QuotaPeriod"),
  'messages',(SELECT md5(string_agg("content",',' ORDER BY "id")) FROM "Message")
)::text;`;

try {
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  console.log(
    'Starting isolated PostgreSQL 17 test container (no application data is used).',
  );
  await run(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      container,
      '--mount',
      `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      '--env',
      'POSTGRES_USER=qa_test',
      '--env',
      'POSTGRES_DB=query_assistant_test',
      'postgres:17',
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  started = true;
  await waitForDatabase();
  const mapping = await run('docker', ['port', container, '5432/tcp']);
  const port = mapping.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Unexpected Docker loopback port mapping.');
  const databaseUrl = `postgresql://qa_test:${password}@127.0.0.1:${port}/query_assistant_test`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    QUERY_ASSISTANT_ISOLATED_TEST: '1',
    QUERY_ASSISTANT_VERIFY_GEMINI: process.argv.includes('--live-gemini')
      ? '1'
      : '0',
  };
  await run(
    process.execPath,
    [npmCli, 'run', 'db:migrate', '-w', '@query-assistant/backend'],
    env,
  );
  console.log('Migrations applied on a clean database.');
  // A second deploy must be a no-op, not a schema reset.
  await run(
    process.execPath,
    [npmCli, 'run', 'db:migrate', '-w', '@query-assistant/backend'],
    env,
  );
  console.log('Repeated migration deployment passed.');
  const output = await run(
    process.execPath,
    [npmCli, 'run', 'test:integration', '-w', '@query-assistant/backend'],
    env,
  );
  console.log(output);
  if (process.argv.includes('--browser-check')) {
    console.log(
      await run(process.execPath, ['scripts/browser-smoke.mjs'], env),
    );
  }
  const before = await run('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'qa_test',
    '-d',
    'query_assistant_test',
    '-At',
    '-c',
    signatureSql,
  ]);
  await run('docker', ['stop', '--time', '10', container]);
  await run('docker', ['start', container]);
  await waitForDatabase();
  const after = await run('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'qa_test',
    '-d',
    'query_assistant_test',
    '-At',
    '-c',
    signatureSql,
  ]);
  if (before !== after)
    throw new Error(
      'Persisted messages or ledger changed across container restart.',
    );
  console.log(
    'Container restart preserved authentication state, messages, requests, usage, and quota totals.',
  );
  const image = await run('docker', [
    'image',
    'inspect',
    'postgres:17',
    '--format',
    '{{index .RepoDigests 0}}',
  ]);
  await mkdir(join(root, '.artifacts'), { recursive: true });
  await writeFile(
    join(root, '.artifacts', 'integration-last-run.json'),
    JSON.stringify(
      {
        passed: true,
        liveGemini: process.argv.includes('--live-gemini'),
        browser: process.argv.includes('--browser-check'),
        container,
        volume,
        image,
        signature: JSON.parse(after),
      },
      null,
      2,
    ),
  );
  console.log(`Test image: ${image}`);
} catch (error) {
  console.error(
    safe(
      error instanceof Error
        ? error.message
        : 'Integration verification failed.',
    ),
  );
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      await run('docker', ['stop', '--time', '10', container]);
    } catch {
      console.error(`Could not stop the isolated container ${container}.`);
      process.exitCode = 1;
    }
    console.log(`Retained stopped test container: ${container}`);
    console.log(`Retained test volume: ${volume}. No volumes were deleted.`);
  }
}
