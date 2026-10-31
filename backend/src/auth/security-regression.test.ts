import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import type { Database } from '../storage/database.js';
import { Tokens, digest } from './tokens.js';
import { ProxyClientAddress } from './proxy-client.js';
import { AuthRateLimit } from './rate-limit.js';

const config = parseConfig({
  NODE_ENV: 'test',
  JWT_SIGNING_KEY: 'SyntheticSecurityRegressionSigningKey01234567890123456789',
});

test('administrator route guards reject anonymous and normal users for every URL spelling and method', async () => {
  const tokens = new Tokens(config);
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + 3600) * 1000);
  const user = { id: userId, role: 'user', status: 'active' };
  let adminReads = 0;
  const db = {
    session: {
      findUnique: async () => ({
        id: sessionId,
        userId,
        user,
        expiresAt,
        revokedAt: null,
        csrfTokenHash: digest(tokens.csrf(sessionId)),
      }),
    },
    user: {
      findMany: async () => {
        adminReads++;
        return [];
      },
    },
    accessRequest: {
      findMany: async () => {
        adminReads++;
        return [];
      },
    },
    generationRequest: {
      findMany: async () => {
        adminReads++;
        return [];
      },
    },
  } as unknown as Database;
  const app = buildApp(config, { logger: false, database: db });
  try {
    await app.ready();
    const cookie = `qa_session=${await tokens.sign(sessionId, userId, expiresAt)}`;
    for (const prefix of ['admin', '%61dmin', 'ad%6din']) {
      for (const path of ['users', 'access-requests', 'generations', 'usage']) {
        for (const headers of [{}, { cookie }]) {
          const response = await app.inject({
            url: `/api/${prefix}/${path}`,
            headers,
          });
          assert.equal(response.statusCode, 'cookie' in headers ? 403 : 401);
        }
      }
      for (const [method, path] of [
        ['POST', `access-requests/${userId}/approve`],
        ['POST', `access-requests/${userId}/reject`],
        ['PATCH', `users/${userId}/quota`],
        ['PATCH', `users/${userId}/status`],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/api/${prefix}/${path}`,
          headers: { cookie },
        });
        assert.equal(response.statusCode, 403);
      }
    }
    assert.equal(adminReads, 0);
  } finally {
    await app.close();
  }
});

test('auth throttling follows matched routes and counts encoded and HEAD requests once', async () => {
  const app = buildApp(config, { logger: false, database: {} as Database });
  try {
    await app.ready();
    for (let i = 0; i < 30; i++) {
      const response = await app.inject({
        method: i % 2 ? 'HEAD' : 'POST',
        url: i % 2 ? '/api/%61uth/csrf' : '/api/%61uth/login',
      });
      assert.notEqual(response.statusCode, 429);
    }
    for (const url of ['/api/auth/login', '/api/%61uth/login']) {
      const response = await app.inject({ method: 'POST', url });
      assert.equal(response.statusCode, 429);
    }
  } finally {
    await app.close();
  }
});

const request = (peer: string, forwarded?: string) =>
  ({
    ip: peer,
    raw: { socket: { remoteAddress: peer } },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  }) as FastifyRequest;

test('trusted proxy clients get independent buckets while direct spoofed headers are ignored', async () => {
  const address = new ProxyClientAddress('web', async () => [
    { address: '172.31.0.20' },
  ]);
  const limit = new AuthRateLimit();
  const attacker = request('::ffff:172.31.0.20', '198.51.100.10');
  const victim = request('172.31.0.20', '198.51.100.20');
  for (let i = 0; i < 30; i++) limit.take(await address.key(attacker));
  assert.throws(() => limit.take('198.51.100.10'));
  assert.doesNotThrow(() => limit.take('198.51.100.20'));
  assert.equal(await address.key(victim), '198.51.100.20');
  assert.equal(
    await address.key(request('203.0.113.5', '198.51.100.20')),
    '203.0.113.5',
  );
  assert.equal(
    await new ProxyClientAddress().key(attacker),
    '::ffff:172.31.0.20',
  );
  await assert.rejects(
    address.key(request('172.31.0.20', '198.51.100.10, 198.51.100.20')),
  );
});

test('proxy resolution failure fails closed and concurrent requests share one lookup', async () => {
  let lookups = 0;
  const address = new ProxyClientAddress('web', async () => {
    lookups++;
    throw new Error('Synthetic DNS failure');
  });
  const results = await Promise.allSettled([
    address.key(request('172.31.0.20')),
    address.key(request('172.31.0.20')),
  ]);
  assert.equal(lookups, 1);
  assert.ok(results.every((r) => r.status === 'rejected'));
});
