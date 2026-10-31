// Isolated packaging verification. No application volume or real provider key.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import https from 'node:https';
import { createConnection, createServer } from 'node:net';
import { prepare } from './setup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, '.artifacts/docker-step11');
await mkdir(artifacts, { recursive: true });
const pointer = join(artifacts, 'latest.json');
let state, workspace, env, ca;
const secrets = ['Synthetic-Docker-Only-Password!'];
const clean = (value) =>
  secrets.reduce((s, key) => s.split(key).join('[REDACTED]'), String(value));
async function run(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace ?? root,
      env: env ?? process.env,
      shell: false,
      ...options,
    });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (b) => {
      stdout += b;
    });
    child.stderr?.on('data', (b) => {
      stderr += b;
    });
    child.on('error', () => reject(new Error(`Could not start ${command}.`)));
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              clean(
                `${command} failed (${code}). ${stderr.slice(-5000)} ${stdout.slice(-2000)}`,
              ),
            ),
          ),
    );
    child.stdin?.end(input);
  });
}
const compose = (args, input) => run('docker', ['compose', ...args], input);
async function attachState(value) {
  assert.match(value.project, /^qa-docker-[a-f0-9-]+$/);
  assert.ok(!relative(artifacts, value.workspace).startsWith('..'));
  state = value;
  workspace = value.workspace;
  const local = parseEnv(await readFile(join(workspace, '.env'), 'utf8'));
  const backend = parseEnv(
    await readFile(join(workspace, 'backend/.env'), 'utf8'),
  );
  secrets.push(
    local.POSTGRES_PASSWORD,
    backend.JWT_SIGNING_KEY,
    backend.GEMINI_API_KEY,
  );
  env = {
    ...process.env,
    ...local,
    COMPOSE_PROJECT_NAME: state.project,
    COMPOSE_FILE: join(workspace, 'compose.yaml'),
  };
}
const origin = 'https://localhost:8443';
let cookie = '';
function request(
  path,
  {
    method = 'GET',
    body,
    csrf,
    stream = false,
    idempotencyKey,
    onChunk,
    extraHeaders = {},
  } = {},
) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      origin + path,
      {
        ca,
        family: 4,
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              }
            : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(stream ? { Accept: 'text/event-stream' } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const set = res.headers['set-cookie']?.[0];
        if (set) cookie = set.split(';')[0];
        let text = '';
        res.on('data', (b) => {
          text += b;
          onChunk?.(text);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Response interrupted')));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request deadline')));
    req.end(data);
  });
}
async function mutate(path, body, method = 'POST', extra = {}) {
  const token = await request('/api/auth/csrf');
  assert.equal(token.status, 200);
  return request(path, {
    method,
    body,
    csrf: token.json().csrfToken,
    ...extra,
  });
}
async function dbScript(script, oneShot = false) {
  return compose(
    oneShot
      ? ['run', '--rm', '--no-deps', '-T', 'api', 'node', '--input-type=module']
      : ['exec', '-T', 'api', 'node', '--input-type=module'],
    `import {createDatabase} from '/app/backend/dist/storage/database.js';const db=createDatabase(process.env.DATABASE_URL);try{${script}}finally{await db.$disconnect();}`,
  );
}
async function signature(database) {
  const sql = `SELECT json_build_object('users',(SELECT count(*) FROM "User"),'sessions',(SELECT count(*) FROM "Session"),'requests',(SELECT count(*) FROM "GenerationRequest"),'usage',(SELECT count(*) FROM "UsageRecord"),'messages',(SELECT md5(string_agg(content,',' ORDER BY id)) FROM "Message"),'used',(SELECT sum("requestsUsed") FROM "QuotaPeriod"),'reserved',(SELECT sum("requestsReserved") FROM "QuotaPeriod"))::text;`;
  return compose(
    [
      'exec',
      '-T',
      ...(database ? ['-e', `COPY_DATABASE=${database}`] : []),
      'db',
      'sh',
      '-c',
      'exec psql -U "$POSTGRES_USER" -d "${COPY_DATABASE:-$POSTGRES_DB}" -At',
    ],
    sql,
  );
}
try {
  if (process.argv.includes('--verify'))
    await attachState(JSON.parse(await readFile(pointer, 'utf8')));
  else {
    const id = randomUUID().slice(0, 8);
    workspace = join(artifacts, id, 'workspace');
    await mkdir(workspace, { recursive: true });
    for (const path of [
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      '.dockerignore',
      '.env.example',
      'compose.yaml',
      'compose.dev.yaml',
      'backend',
      'frontend',
      'packages',
      'docker',
      'scripts',
    ]) {
      await cp(join(root, path), join(workspace, path), {
        recursive: true,
        filter: (path) =>
          !path
            .split(/[\\/]/)
            .some((part) =>
              [
                'node_modules',
                'dist',
                'generated',
                '.env',
                '.env.local',
                '.artifacts',
              ].includes(part),
            ),
      });
    }
    await prepare(workspace);
    const backend = join(workspace, 'backend/.env');
    await writeFile(
      backend,
      (await readFile(backend, 'utf8')).replace(
        '# GEMINI_API_KEY=Enter_your_paid_key_locally',
        'GEMINI_API_KEY=synthetic-docker-no-provider-calls',
      ),
    );
    await attachState({ project: `qa-docker-${id}`, workspace });
    await writeFile(pointer, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(
      'Building and starting an isolated clean-input Docker project. No real key is used.',
    );
    await compose(['config', '--quiet']);
    await compose(['up', '--build', '-d', '--wait', '--wait-timeout', '180']);
    await compose([
      'cp',
      'web:/data/caddy/pki/authorities/local/root.crt',
      '.local/caddy-root.crt',
    ]);
  }
  ca = await readFile(join(workspace, '.local/caddy-root.crt'));
  assert.equal((await request('/health/ready')).status, 200);
  assert.ok((await request('/')).text.includes('Content-Security-Policy'));
  for (const service of ['db', 'api']) {
    const id = await compose(['ps', '-q', service]);
    const [inspection] = JSON.parse(await run('docker', ['inspect', id]));
    assert.equal(
      Object.keys(inspection.NetworkSettings.Ports ?? {}).filter(
        (p) => inspection.NetworkSettings.Ports[p],
      ).length,
      0,
    );
  }
  const runtime = JSON.parse(
    await compose([
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      `console.log(JSON.stringify({uid:process.getuid(),node:process.version,typescript:require('node:fs').existsSync('/app/node_modules/typescript'),tsx:require('node:fs').existsSync('/app/node_modules/tsx'),prismaCli:require('node:fs').existsSync('/app/node_modules/prisma')}))`,
    ]),
  );
  assert.notEqual(runtime.uid, 0);
  assert.equal(runtime.typescript, false);
  assert.equal(runtime.tsx, false);
  assert.equal(runtime.prismaCli, false);
  assert.equal(await compose(['exec', '-T', 'web', 'id', '-u']), '10001');
  if (process.argv.includes('--prepare')) {
    console.log(
      `Prepared ${state.project}. Run the interactive fixture CLI in the recorded workspace, then npm run test:docker -- --verify. No host trust store was changed.`,
    );
    process.exit(0);
  }
  // The normal automated path seeds only this isolated fixture using compiled
  // trusted provisioning code. --prepare also permits real hidden-TTY testing.
  await dbScript(
    `const {bootstrapAdmin}=await import('/app/backend/dist/auth/service.js');const {parseConfig}=await import('/app/backend/dist/config.js');if(!await db.user.findUnique({where:{username:'docker_admin_fixture'}}))await bootstrapAdmin(db,parseConfig(process.env),'docker_admin_fixture','Synthetic-Docker-Only-Password!');`,
  );
  const login = await mutate('/api/auth/login', {
    username: 'docker_admin_fixture',
    password: 'Synthetic-Docker-Only-Password!',
  });
  assert.equal(login.status, 200);
  assert.ok(login.headers['set-cookie'][0].includes('__Host-qa_session='));
  assert.match(login.headers['set-cookie'][0], /Secure/);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  const conversation = (
    await mutate('/api/conversations', { title: 'Docker persistence fixture' })
  ).json().conversation;
  const csrf = (await request('/api/auth/csrf')).json().csrfToken;
  // A normal production-server admission cancelled before attachment spends no
  // provider work, and its persisted terminal SSE replay crosses the TLS proxy.
  const admitted = await request(
    `/api/conversations/${conversation.id}/messages`,
    {
      method: 'POST',
      body: { content: 'Docker no-dispatch cancellation' },
      csrf,
      idempotencyKey: randomUUID(),
    },
  );
  assert.equal(admitted.status, 202);
  const generationId = admitted.json().generation.id;
  assert.equal(
    (await mutate(`/api/generations/${generationId}/cancel`, {})).status,
    200,
  );
  const replay = await request(`/api/generations/${generationId}/events`, {
    csrf,
    stream: true,
  });
  assert.equal(replay.status, 200);
  assert.ok(replay.text.includes('cancelled'));
  assert.equal(
    await dbScript(
      `console.log((await db.generationRequest.findUniqueOrThrow({where:{id:${JSON.stringify(generationId)}}})).dispatchedAt===null)`,
    ),
    'true',
  );
  // Test-only mounted provider fixture exercises progressive SSE through the
  // actual image, production auth/ledger and Caddy. No mock mode is added to app.
  await writeFile(
    join(workspace, '.local/proxy-fixture.mjs'),
    `
import {setTimeout as pause} from 'node:timers/promises';
import {buildApp} from '/app/backend/dist/app.js';
import {parseConfig} from '/app/backend/dist/config.js';
import {createDatabase} from '/app/backend/dist/storage/database.js';
const config=parseConfig(process.env), db=createDatabase(config.DATABASE_URL);
const provider={async countTokens(){return 100;},async *stream(turns,signal){yield {type:'delta',text:'Container proxy fixture'};await pause(1200,undefined,{signal});if(turns.at(-1).text==='Crash after checkpoint'){yield {type:'delta',text:' durable checkpoint'};await pause(60000,undefined,{signal});}if(turns.at(-1).text==='Slow container answer')await pause(10000,undefined,{signal});yield {type:'final',completed:true,usage:{inputTokens:100,outputTokens:20,reasoningTokens:0,cachedInputTokens:0}};}};
const app=buildApp(config,{database:db,provider,logger:false});
app.addHook('onClose',()=>db.$disconnect());
process.once('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});
await app.listen({host:'0.0.0.0',port:3001});
`,
  );
  await writeFile(
    join(workspace, 'proxy-check.yaml'),
    "services:\n  api:\n    restart: 'no'\n    command: [node, /fixture/server.mjs]\n    volumes:\n      - ./.local/proxy-fixture.mjs:/fixture/server.mjs:ro\n",
  );
  await compose([
    '-f',
    'compose.yaml',
    '-f',
    'proxy-check.yaml',
    'up',
    '-d',
    '--force-recreate',
    '--no-deps',
    '--wait',
    'api',
  ]);
  const mockCsrf = (await request('/api/auth/csrf')).json().csrfToken;
  const mockAdmission = await request(
    `/api/conversations/${conversation.id}/messages`,
    {
      method: 'POST',
      body: { content: 'Mock proxy streaming check' },
      csrf: mockCsrf,
      idempotencyKey: randomUUID(),
    },
  );
  assert.equal(mockAdmission.status, 202);
  const mockId = mockAdmission.json().generation.id;
  let deltaAt, terminalAt;
  const streamed = await request(`/api/generations/${mockId}/events`, {
    csrf: mockCsrf,
    stream: true,
    onChunk: (text) => {
      if (text.includes('event: delta') && !deltaAt)
        deltaAt = performance.now();
      if (text.includes('event: completed') && !terminalAt)
        terminalAt = performance.now();
    },
  });
  assert.equal(streamed.status, 200);
  assert.ok(
    deltaAt && terminalAt && terminalAt - deltaAt > 500,
    'Proxy must deliver delta before final settlement',
  );
  assert.ok(streamed.text.includes('Container proxy fixture'));
  let browserResult;
  if (process.argv.includes('--browser-check')) {
    const { containerBrowser } = await import('./container-browser-smoke.mjs');
    browserResult = await containerBrowser({
      origin,
      ca,
      username: 'docker_admin_fixture',
      password: 'Synthetic-Docker-Only-Password!',
      output: join(artifacts, 'browser'),
      root,
    });
  }
  const crashCsrf = (await request('/api/auth/csrf')).json().csrfToken;
  const crashKey = randomUUID();
  const crashReceipt = await request(
    `/api/conversations/${conversation.id}/messages`,
    {
      method: 'POST',
      body: { content: 'Crash after checkpoint' },
      csrf: crashCsrf,
      idempotencyKey: crashKey,
    },
  );
  assert.equal(crashReceipt.status, 202);
  const crashId = crashReceipt.json().generation.id;
  const crashing = request(`/api/generations/${crashId}/events`, {
    csrf: crashCsrf,
    stream: true,
  }).then(
    (value) => ({ completedEvent: value.text.includes('event: completed') }),
    () => ({ completedEvent: false }),
  );
  let checkpointed = false;
  for (let i = 0; i < 60; i++) {
    const saved = await dbScript(
      `console.log((await db.message.findFirst({where:{generationId:${JSON.stringify(crashId)},role:'assistant'}}))?.content.includes('durable checkpoint')??false);`,
    );
    if (saved === 'true') {
      checkpointed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    checkpointed,
    'Wait for a committed partial checkpoint before killing the process',
  );
  await compose(['kill', '--signal', 'SIGKILL', 'api']);
  assert.equal(
    (await crashing).completedEvent,
    false,
    'A killed generation must not appear completed',
  );
  // Accelerate expiry only in this isolated fixture, after the real process is
  // gone. Production reservation deadlines and recovery policy are unchanged.
  await dbScript(
    `await db.quotaReservation.update({where:{generationId:${JSON.stringify(crashId)}},data:{expiresAt:new Date(Date.now()-1000)}});`,
    true,
  );
  await compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'api']);
  let recovered;
  for (let i = 0; i < 50; i++) {
    recovered = (
      await request(
        `/api/conversations/${conversation.id}/submissions/${crashKey}`,
      )
    ).json();
    if (recovered.generation.status === 'interrupted') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(recovered.generation.status, 'interrupted');
  assert.equal(recovered.usage.accountingStatus, 'uncertain');
  assert.ok(recovered.assistantMessage.content.includes('durable checkpoint'));
  assert.equal(
    await dbScript(
      `console.log(await db.usageRecord.count({where:{generationId:${JSON.stringify(crashId)}}}));`,
    ),
    '1',
  );
  const postRecovery = (await request('/api/me')).json();
  assert.equal(postRecovery.allowance.requests.reserved, 0);
  assert.ok(postRecovery.allowance.requests.used >= 2);
  const before = await signature();
  await compose(['stop']);
  await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
  assert.equal(
    (await request('/api/me')).status,
    200,
    'JWT session survives process/container restart',
  );
  assert.equal(await signature(), before);
  assert.equal(
    (await request(`/api/conversations/${conversation.id}/messages`)).json()
      .items.length,
    6,
  );
  const copySuffix = randomUUID().slice(0, 8);
  const restoreName = `qa_restore_${copySuffix}`;
  const dump = join('backups', `step10-${copySuffix}.dump`);
  await run(process.execPath, ['scripts/database-copy.mjs', 'backup', dump]);
  await run(process.execPath, [
    'scripts/database-copy.mjs',
    'restore',
    dump,
    '--database',
    restoreName,
  ]);
  assert.equal(await signature(restoreName), before);
  await assert.rejects(
    run(process.execPath, [
      'scripts/database-copy.mjs',
      'restore',
      dump,
      '--database',
      restoreName,
    ]),
  );
  await assert.rejects(
    run(process.execPath, [
      'scripts/database-copy.mjs',
      'restore',
      dump,
      '--database',
      'query_assistant',
    ]),
  );
  await assert.rejects(
    run(process.execPath, ['scripts/database-copy.mjs', 'backup', dump]),
  );
  // Security regressions through the actual TLS proxy, after the restart reset.
  assert.equal((await request('/api/%61dmin/users?limit=1')).status, 200);
  cookie = '';
  for (const path of ['/api/admin/users', '/api/%61dmin/users'])
    assert.equal((await request(path)).status, 401);
  for (let i = 0; i < 30; i++) {
    const response = await request(
      i % 2 ? '/api/auth/login' : '/api/%61uth/login',
      {
        method: 'POST',
        extraHeaders: { 'X-Forwarded-For': `198.51.100.${i + 1}` },
      },
    );
    assert.equal(response.status, 401);
  }
  assert.equal((await request('/api/auth/csrf')).status, 429);
  // Another real socket client (the API container) must have its own budget.
  const otherClient = await compose(
    ['exec', '-T', 'api', 'node', '--input-type=module'],
    `import https from 'node:https';
     const status = await new Promise((resolve,reject)=>{
       const request=https.get({hostname:'web',port:8443,path:'/api/auth/csrf',servername:'localhost',headers:{Host:'localhost:8443'},ca:${JSON.stringify(ca.toString())}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
       request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('Deadline')));
     });console.log(status);`,
  );
  assert.equal(otherClient, '200');
  // Verify host development as well: an internal-only bridge alone prevents
  // host forwarding even when a port mapping appears in container metadata.
  const probe = createServer();
  await new Promise((done, fail) => {
    probe.once('error', fail);
    probe.listen(5432, '127.0.0.1', done);
  });
  await new Promise((done) => probe.close(done));
  await compose(['stop', 'api', 'web']);
  await compose([
    '-f',
    'compose.yaml',
    '-f',
    'compose.dev.yaml',
    'up',
    '-d',
    '--wait',
    'db',
  ]);
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port: 5432 });
    socket.setTimeout(5000, () =>
      socket.destroy(new Error('Development database connection deadline')),
    );
    socket.once('connect', () =>
      socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])),
    );
    socket.once('data', (data) => {
      socket.end();
      if (['N', 'S'].includes(data.toString())) done();
      else fail(new Error('Unexpected PostgreSQL response'));
    });
    socket.once('error', fail);
  });
  const result = {
    passed: true,
    project: state.project,
    workspace,
    runtime,
    checks: [
      'clean-input builds and idempotent migrations',
      'production readiness through verified local TLS',
      'non-root API and frontend; production-only API dependencies',
      'database and API have no published host ports',
      'secure HttpOnly cookie login',
      'cancel-before-attachment and terminal SSE replay through proxy; no paid provider call',
      'progressive proxy deltas precede completion with isolated mounted provider fixture',
      'session/messages/ledger survive stop and start',
      'backup restored into fresh database with identical signature',
      'existing backup and application/existing database overwrite refused',
      'explicit development bridge forwards PostgreSQL on 127.0.0.1:5432',
      'real SIGKILL after persisted partial text; actual server restart recovers interrupted uncertain usage exactly once',
      'admin route authorization, encoded auth throttling, forged forwarding rejection and independent proxy-client buckets',
    ],
    browser: browserResult ?? null,
    hostTrustChanged: false,
    paidCalls: 0,
  };
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('Docker packaging checks passed. ' + result.checks.join('; '));
} catch (error) {
  process.stderr.write(
    clean(
      error instanceof Error ? error.message : 'Docker verification failed.',
    ) + '\n',
  );
  process.exitCode = 1;
} finally {
  if (state && (!process.argv.includes('--prepare') || process.exitCode)) {
    await compose(['stop']).catch(() => {});
    console.log(
      `Retained isolated project ${state.project} and all volumes. No volumes were deleted.`,
    );
  }
}
