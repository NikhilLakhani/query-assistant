import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiErrorSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from '@query-assistant/contracts';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';

test('health distinguishes liveness from unfinished application readiness', async (t) => {
  const app = buildApp(parseConfig({}), { logger: false });
  t.after(() => app.close());
  const live = await app.inject('/health/live');
  assert.equal(live.statusCode, 200);
  const body = LivenessResponseSchema.parse(live.json());
  assert.equal(live.headers['x-request-id'], body.requestId);
  const ready = await app.inject('/health/ready');
  assert.equal(ready.statusCode, 503);
  assert.equal(
    ReadinessResponseSchema.parse(ready.json()).checks.application,
    false,
  );
});
test('unknown endpoints return safe errors and ignore client-supplied request IDs', async (t) => {
  const app = buildApp(parseConfig({}), { logger: false });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/nonexistent',
    headers: { 'x-request-id': 'untrusted' },
  });
  assert.equal(response.statusCode, 404);
  const parsed = ApiErrorSchema.parse(response.json());
  assert.equal(parsed.error.code, 'NOT_FOUND');
  assert.notEqual(parsed.error.requestId, 'untrusted');
});
test('CORS permits the configured frontend and does not grant another origin', async (t) => {
  const app = buildApp(parseConfig({}), { logger: false });
  t.after(() => app.close());
  const allowed = await app.inject({
    url: '/health/live',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(
    allowed.headers['access-control-allow-origin'],
    'http://localhost:5173',
  );
  const other = await app.inject({
    url: '/health/live',
    headers: { origin: 'https://untrusted.example' },
  });
  assert.notEqual(
    other.headers['access-control-allow-origin'],
    'https://untrusted.example',
  );
});

test('malformed/oversized bodies and internal failures stay within safe error contracts', async (t) => {
  const app = buildApp(parseConfig({}), { logger: false });
  t.after(() => app.close());
  app.post('/test-body', async () => ({ ok: true }));
  app.get('/test-failure', async () => {
    throw new Error('synthetic private provider diagnostics');
  });
  const malformed = await app.inject({
    method: 'POST',
    url: '/test-body',
    headers: { 'content-type': 'application/json' },
    payload: '{',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(
    ApiErrorSchema.parse(malformed.json()).error.code,
    'VALIDATION_ERROR',
  );
  const oversized = await app.inject({
    method: 'POST',
    url: '/test-body',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'x'.repeat(65536) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(
    ApiErrorSchema.parse(oversized.json()).error.code,
    'PAYLOAD_TOO_LARGE',
  );
  const failed = await app.inject('/test-failure');
  assert.equal(failed.statusCode, 500);
  assert.equal(
    ApiErrorSchema.parse(failed.json()).error.code,
    'INTERNAL_ERROR',
  );
  assert.ok(!failed.body.includes('synthetic private'));
});

test('security headers apply to errors and health; HSTS is production-only', async (t) => {
  for (const production of [false, true]) {
    const cfg = parseConfig({});
    const app = buildApp(
      { ...cfg, NODE_ENV: production ? 'production' : 'test' },
      { logger: false },
    );
    t.after(() => app.close());
    for (const url of ['/health/live', '/api/missing']) {
      const response = await app.inject(url);
      assert.match(
        String(response.headers['content-security-policy']),
        /frame-ancestors 'none'/,
      );
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(
        Boolean(response.headers['strict-transport-security']),
        production,
      );
    }
  }
});
test('structured logging preserves request IDs/categories without private errors, bodies, URLs or cookies', async (t) => {
  const { Writable } = await import('node:stream');
  let logs = '';
  const destination = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });
  const app = buildApp(parseConfig({}), { logDestination: destination });
  t.after(() => app.close());
  app.post('/test-private', async () => {
    throw new Error('PRIVATE_ERROR_123');
  });
  const response = await app.inject({
    method: 'POST',
    url: '/test-private?secret=PRIVATE_QUERY_123',
    headers: {
      cookie: 'PRIVATE_COOKIE_123',
      authorization: 'PRIVATE_AUTH_123',
      'x-csrf-token': 'PRIVATE_CSRF_123',
    },
    payload: {
      content: 'PRIVATE_PROMPT_123',
      password: 'PRIVATE_PASSWORD_123',
    },
  });
  assert.equal(response.statusCode, 500);
  assert.ok(!logs.includes('PRIVATE_'));
  const records = logs
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(
    records.some(
      (r) =>
        r.category === 'INTERNAL_ERROR' &&
        r.reqId === response.headers['x-request-id'],
    ),
  );
});
