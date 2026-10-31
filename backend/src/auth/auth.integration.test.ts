import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase } from '../storage/database.js';
import { AppError } from '../errors.js';
import { Auth, bootstrapAdmin } from './service.js';
import { digest } from './tokens.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !url.endsWith('/query_assistant_test') ||
  process.env.QUERY_ASSISTANT_ISOLATED_TEST !== '1'
)
  throw new Error('Use the isolated root integration-test harness.');
const db = createDatabase(url);
const config = parseConfig({
  NODE_ENV: 'test',
  JWT_SIGNING_KEY:
    'synthetic-test-key-with-more-than-sixty-four-characters-for-hmac-tests-only',
  ACCOUNTING_INR_PER_USD: '100',
  PRICE_VERSION: 'test-auth-v1',
});
const auth = new Auth(db, config);
const password = 'synthetic-test-only-password!';
const username = () => `u_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const headers = (token: string, csrfToken?: string) => ({
  cookie: `qa_session=${token}`,
  origin: config.FRONTEND_ORIGIN,
  ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
});
const cookieToken = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers['set-cookie'];
  const cookie = (Array.isArray(value) ? value[0] : value) as string;
  const token = cookie?.match(/^qa_session=([^;]+)/)?.[1];
  assert.ok(token, 'Expected an HttpOnly session cookie');
  return decodeURIComponent(token);
};
async function anonymous(app: FastifyInstance) {
  const result = await app.inject({
    url: '/api/auth/csrf',
    headers: { origin: config.FRONTEND_ORIGIN },
  });
  assert.equal(result.statusCode, 200);
  return {
    token: cookieToken(result),
    csrf: result.json().csrfToken as string,
  };
}
async function csrfFor(app: FastifyInstance, token: string) {
  const result = await app.inject({
    url: '/api/auth/csrf',
    headers: headers(token),
  });
  assert.equal(result.statusCode, 200);
  return result.json().csrfToken as string;
}
async function appFor(t: TestContext) {
  const app = buildApp(config, { logger: false, database: db });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('local authentication, approval, revocation, and resource authorization', async (t) => {
  t.after(() => db.$disconnect());
  const admin = await bootstrapAdmin(db, config, username(), password);
  const initial = await auth.csrf(undefined);
  const prelogin = await auth.identify(initial.issued!.token);
  const adminLogin = await auth.login(prelogin.sessionId, {
    username: admin.username,
    password,
  });
  const adminIdentity = await auth.identify(adminLogin.token, true, true);

  async function userFixture() {
    const name = username();
    const anonymous = await auth.csrf(undefined);
    const identity = await auth.identify(anonymous.issued!.token);
    await auth.requestAccess(identity.sessionId, name);
    const request = await db.accessRequest.findUniqueOrThrow({
      where: { username: name },
    });
    const approval = await auth.approve(adminIdentity.sessionId, request.id, {
      reason: 'Synthetic integration fixture',
    });
    return auth.activate(identity.sessionId, {
      username: name,
      activationCode: approval.activationCode,
      password,
    });
  }

  await t.test(
    'administrator guards follow matched routes for anonymous users, normal users and admin pagination',
    async (t) => {
      const app = await appFor(t);
      const user = await userFixture();
      for (const segment of ['admin', '%61dmin']) {
        for (const resource of [
          'users',
          'access-requests',
          'generations',
          'usage',
        ]) {
          const url = `/api/${segment}/${resource}`;
          assert.equal((await app.inject({ url })).statusCode, 401);
          assert.equal(
            (await app.inject({ url, headers: headers(user.token) }))
              .statusCode,
            403,
          );
          const allowed = await app.inject({
            url: `${url}?limit=1`,
            headers: headers(adminLogin.token),
          });
          assert.equal(allowed.statusCode, 200);
        }
      }
    },
  );

  await t.test(
    'first-admin bootstrap is one-time and registration cannot self-select a role',
    async (t) => {
      await assert.rejects(
        bootstrapAdmin(db, config, username(), password),
        (error) => error instanceof AppError && error.code === 'CONFLICT',
      );
      const app = await appFor(t),
        anon = await anonymous(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/access-requests',
        headers: headers(anon.token, anon.csrf),
        payload: { username: username(), role: 'admin' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');
      assert.equal(await db.user.count({ where: { role: 'admin' } }), 1);
    },
  );

  await t.test(
    'request → approval → one-time activation creates an ordinary user and hashes credentials',
    async (t) => {
      const app = await appFor(t),
        anon = await anonymous(app),
        name = username();
      const request = await app.inject({
        method: 'POST',
        url: '/api/access-requests',
        headers: headers(anon.token, anon.csrf),
        payload: { username: name.toUpperCase() },
      });
      assert.equal(request.statusCode, 202);
      assert.equal(await db.user.count({ where: { username: name } }), 0);
      const existing = await app.inject({
        method: 'POST',
        url: '/api/access-requests',
        headers: headers(anon.token, anon.csrf),
        payload: { username: admin.username },
      });
      assert.deepEqual(existing.json(), request.json());
      const adminCsrf = await csrfFor(app, adminLogin.token);
      const listing = await app.inject({
        url: '/api/admin/access-requests?status=pending',
        headers: headers(adminLogin.token),
      });
      assert.equal(listing.statusCode, 200);
      assert.ok(!listing.body.includes('activationCodeHash'));
      const row = listing
        .json()
        .items.find((value: { username: string }) => value.username === name);
      assert.ok(row);
      const approved = await app.inject({
        method: 'POST',
        url: `/api/admin/access-requests/${row.id}/approve`,
        headers: headers(adminLogin.token, adminCsrf),
        payload: { reason: 'Approve synthetic reviewer' },
      });
      assert.equal(approved.statusCode, 200);
      const code = approved.json().activationCode as string;
      const stored = await db.accessRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.ok(
        stored.activationCodeHash === digest(code) &&
          stored.activationCodeHash !== code,
      );
      const activated = await app.inject({
        method: 'POST',
        url: '/api/auth/activate',
        headers: headers(anon.token, anon.csrf),
        payload: { username: name, activationCode: code, password },
      });
      assert.equal(activated.statusCode, 201);
      assert.equal(activated.json().user.role, 'user');
      assert.ok(!('token' in activated.json()));
      assert.ok(!activated.body.includes('password'));
      const user = await db.user.findUniqueOrThrow({
        where: { username: name },
      });
      assert.ok(
        user.passwordHash.startsWith('$argon2id$') &&
          user.passwordHash !== password,
      );
      assert.equal(
        (await db.accessRequest.findUniqueOrThrow({ where: { id: row.id } }))
          .activationCodeHash,
        null,
      );
      const another = await anonymous(app);
      const reused = await app.inject({
        method: 'POST',
        url: '/api/auth/activate',
        headers: headers(another.token, another.csrf),
        payload: { username: name, activationCode: code, password },
      });
      assert.equal(reused.statusCode, 410);
      assert.equal(
        (
          await app.inject({
            url: '/api/me',
            headers: headers(cookieToken(activated)),
          })
        ).statusCode,
        200,
      );
    },
  );

  await t.test(
    'login uses generic failures, rotates sessions, and never returns JWTs in JSON',
    async (t) => {
      const user = await userFixture(),
        app = await appFor(t),
        anon = await anonymous(app);
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(anon.token, anon.csrf),
        payload: { username: username(), password },
      });
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(anon.token, anon.csrf),
        payload: {
          username: user.user.username,
          password: 'wrong-synthetic-password',
        },
      });
      assert.equal(unknown.statusCode, 401);
      assert.equal(wrong.statusCode, 401);
      assert.equal(unknown.json().error.message, wrong.json().error.message);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(anon.token, anon.csrf),
        payload: { username: user.user.username, password },
      });
      assert.equal(login.statusCode, 200);
      assert.ok(!('token' in login.json()));
      const setCookie = String(login.headers['set-cookie']);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\//i);
      await assert.rejects(auth.identify(anon.token));
      const newCsrf = await csrfFor(app, cookieToken(login));
      assert.ok(newCsrf !== anon.csrf);
    },
  );

  await t.test(
    'missing/malformed/expired/wrong-key/issuer/audience/algorithm JWTs fail over HTTP',
    async (t) => {
      const user = await userFixture(),
        app = await appFor(t);
      const identity = await auth.identify(user.token);
      const key = new TextEncoder().encode(config.JWT_SIGNING_KEY);
      const make = (
        options: {
          alg?: string;
          issuer?: string;
          audience?: string;
          expiry?: number;
          key?: Uint8Array;
          subject?: string;
          role?: string;
        } = {},
      ) =>
        new SignJWT({ ...(options.role ? { role: options.role } : {}) })
          .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
          .setSubject(options.subject ?? user.user.id)
          .setJti(identity.sessionId)
          .setIssuer(options.issuer ?? config.JWT_ISSUER)
          .setAudience(options.audience ?? config.JWT_AUDIENCE)
          .setIssuedAt(Math.floor(Date.now() / 1000))
          .setExpirationTime(
            options.expiry ?? Math.floor(identity.expiresAt.getTime() / 1000),
          )
          .sign(options.key ?? key);
      const missing = await app.inject('/api/me');
      assert.equal(missing.statusCode, 401);
      for (const token of [
        'bad',
        await make({ expiry: Math.floor(Date.now() / 1000) - 10 }),
        await make({ issuer: 'wrong' }),
        await make({ audience: 'wrong' }),
        await make({ alg: 'HS384' }),
        await make({
          key: new TextEncoder().encode(
            'another-synthetic-signing-key-with-at-least-thirty-two-bytes',
          ),
        }),
        await make({ subject: randomUUID() }),
      ]) {
        const response = await app.inject({
          url: '/api/me',
          headers: headers(token),
        });
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, 'UNAUTHENTICATED');
      }
      const bearer = await app.inject({
        url: '/api/me',
        headers: { authorization: `Bearer ${user.token}` },
      });
      assert.equal(bearer.statusCode, 401);
      const forgedRole = await app.inject({
        url: '/api/admin/users',
        headers: headers(await make({ role: 'admin' })),
      });
      assert.equal(forgedRole.statusCode, 403);
    },
  );

  await t.test(
    'CSRF requires the exact allowed origin and a token bound to the current session',
    async (t) => {
      const user = await userFixture(),
        app = await appFor(t);
      const csrf = await csrfFor(app, user.token),
        other = await anonymous(app);
      for (const requestHeaders of [
        headers(user.token),
        headers(user.token, 'wrong'),
        headers(user.token, other.csrf),
        { ...headers(user.token, csrf), origin: 'https://untrusted.example' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/conversations',
          headers: requestHeaders,
          payload: {},
        });
        assert.equal(response.statusCode, 403);
        assert.equal(response.json().error.code, 'CSRF_INVALID');
      }
      assert.equal(
        await db.conversation.count({ where: { userId: user.user.id } }),
        0,
      );
      const valid = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: headers(user.token, csrf),
        payload: {},
      });
      assert.equal(valid.statusCode, 201);
      const selfSelectedOwner = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: headers(user.token, csrf),
        payload: { userId: admin.id },
      });
      assert.equal(selfSelectedOwner.statusCode, 400);
      assert.equal(
        (
          await app.inject({
            url: '/api/me?unexpected=value',
            headers: headers(user.token),
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/conversations/not-a-uuid',
            headers: headers(user.token),
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/conversations?limit=101',
            headers: headers(user.token),
          })
        ).statusCode,
        400,
      );
    },
  );

  await t.test(
    'cross-user history, generation status, cancellation, deletion, and cursors are denied',
    async (t) => {
      const a = await userFixture(),
        b = await userFixture(),
        app = await appFor(t);
      const conversation = await auth.storage.createConversation(a.user.id);
      await auth.storage.createConversation(a.user.id);
      const receipt = await auth.storage.reserveGeneration({
        userId: a.user.id,
        conversationId: conversation.id,
        idempotencyKey: randomUUID(),
        content: 'Private fixture text',
        inputTokenBound: 100,
        outputTokenBound: 50,
      });
      const csrfB = await csrfFor(app, b.token),
        csrfA = await csrfFor(app, a.token);
      for (const path of [
        `/api/conversations/${conversation.id}`,
        `/api/conversations/${conversation.id}/messages`,
        `/api/generations/${receipt.generation.id}`,
      ]) {
        assert.equal(
          (await app.inject({ url: path, headers: headers(b.token) }))
            .statusCode,
          404,
        );
      }
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/generations/${receipt.generation.id}/cancel`,
            headers: headers(b.token, csrfB),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/conversations/${conversation.id}`,
            headers: headers(b.token, csrfB),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/conversations/${conversation.id}`,
            headers: headers(adminLogin.token),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/admin/users',
            headers: headers(b.token),
          })
        ).statusCode,
        403,
      );
      const forbiddenChange = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${a.user.id}/status`,
        headers: headers(b.token, csrfB),
        payload: {
          status: 'revoked',
          expectedVersion: 0,
          reason: 'Unauthorized fixture change',
        },
      });
      assert.equal(forbiddenChange.statusCode, 403);
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).status,
        'active',
      );
      const accessRequest = await db.accessRequest.findUniqueOrThrow({
        where: { username: a.user.username },
      });
      const forbiddenApproval = await app.inject({
        method: 'POST',
        url: `/api/admin/access-requests/${accessRequest.id}/approve`,
        headers: headers(b.token, csrfB),
        payload: { reason: 'Unauthorized fixture approval' },
      });
      assert.equal(forbiddenApproval.statusCode, 403);
      const page = await app.inject({
        url: '/api/conversations?limit=1',
        headers: headers(a.token),
      });
      assert.ok(page.json().nextCursor);
      assert.equal(
        (
          await app.inject({
            url: `/api/conversations?cursor=${page.json().nextCursor}`,
            headers: headers(b.token),
          })
        ).statusCode,
        400,
      );
      const history = await app.inject({
        url: `/api/conversations/${conversation.id}/messages?limit=1`,
        headers: headers(a.token),
      });
      assert.equal(history.statusCode, 200);
      const older = await app.inject({
        url: `/api/conversations/${conversation.id}/messages?limit=1&cursor=${history.json().nextCursor}`,
        headers: headers(a.token),
      });
      assert.equal(older.json().items[0].content, 'Private fixture text');
      const cancel = await app.inject({
        method: 'POST',
        url: `/api/generations/${receipt.generation.id}/cancel`,
        headers: headers(a.token, csrfA),
      });
      assert.equal(cancel.statusCode, 200);
      assert.equal(cancel.json().generation.status, 'cancelled');
    },
  );

  await t.test(
    'revocation invalidates existing sessions, settles active work, and reactivation cannot revive old JWTs',
    async (t) => {
      const user = await userFixture(),
        app = await appFor(t),
        adminCsrf = await csrfFor(app, adminLogin.token);
      const conversation = await auth.storage.createConversation(user.user.id);
      const { generation } = await auth.storage.reserveGeneration({
        userId: user.user.id,
        conversationId: conversation.id,
        idempotencyKey: randomUUID(),
        content: 'Revocation fixture',
        inputTokenBound: 100,
        outputTokenBound: 50,
      });
      await auth.storage.markDispatched(user.user.id, generation.id);
      await auth.storage.checkpoint(
        user.user.id,
        generation.id,
        'Saved partial text',
      );
      const version = (
        await db.user.findUniqueOrThrow({ where: { id: user.user.id } })
      ).version;
      const revoked = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${user.user.id}/status`,
        headers: headers(adminLogin.token, adminCsrf),
        payload: {
          status: 'revoked',
          expectedVersion: version,
          reason: 'Synthetic revocation test',
        },
      });
      assert.equal(revoked.statusCode, 200);
      assert.equal(
        (await app.inject({ url: '/api/me', headers: headers(user.token) }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await db.generationRequest.findUniqueOrThrow({
            where: { id: generation.id },
          })
        ).status,
        'cancelled',
      );
      assert.equal(
        (
          await db.usageRecord.findUniqueOrThrow({
            where: { generationId: generation.id },
          })
        ).accountingStatus,
        'uncertain',
      );
      const anon = await anonymous(app);
      const disabledLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(anon.token, anon.csrf),
        payload: { username: user.user.username, password },
      });
      assert.equal(disabledLogin.statusCode, 403);
      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${user.user.id}/status`,
        headers: headers(adminLogin.token, adminCsrf),
        payload: {
          status: 'active',
          expectedVersion: version,
          reason: 'Stale change',
        },
      });
      assert.equal(stale.statusCode, 409);
      const active = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${user.user.id}/status`,
        headers: headers(adminLogin.token, adminCsrf),
        payload: {
          status: 'active',
          expectedVersion: revoked.json().account.version,
          reason: 'Synthetic reactivation test',
        },
      });
      assert.equal(active.statusCode, 200);
      assert.equal(
        (await app.inject({ url: '/api/me', headers: headers(user.token) }))
          .statusCode,
        401,
      );
      const freshAnon = await anonymous(app);
      const relogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(freshAnon.token, freshAnon.csrf),
        payload: { username: user.user.username, password },
      });
      assert.equal(relogin.statusCode, 200);
      const me = await app.inject({
        url: '/api/me',
        headers: headers(cookieToken(relogin)),
      });
      assert.equal(me.json().allowance.requests.used, 1);
      assert.equal(
        await db.adminAuditEvent.count({
          where: {
            targetUserId: user.user.id,
            action: 'account_status_changed',
          },
        }),
        2,
      );
      const lastAdmin = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${admin.id}/status`,
        headers: headers(adminLogin.token, adminCsrf),
        payload: {
          status: 'suspended',
          expectedVersion: 0,
          reason: 'Last-admin guard test',
        },
      });
      assert.equal(lastAdmin.statusCode, 409);
    },
  );

  await t.test(
    'logout/relogin and a new application instance preserve durable usage',
    async (t) => {
      const user = await userFixture(),
        app = await appFor(t);
      const conversation = await auth.storage.createConversation(user.user.id);
      const { generation } = await auth.storage.reserveGeneration({
        userId: user.user.id,
        conversationId: conversation.id,
        idempotencyKey: randomUUID(),
        content: 'Quota fixture',
        inputTokenBound: 100,
        outputTokenBound: 50,
      });
      await auth.storage.markDispatched(user.user.id, generation.id);
      await auth.storage.settleGeneration({
        userId: user.user.id,
        generationId: generation.id,
        status: 'completed',
        reportedUsage: {
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
      });
      const before = await app.inject({
        url: '/api/me',
        headers: headers(user.token),
      });
      const csrf = await csrfFor(app, user.token);
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: headers(user.token, csrf),
      });
      assert.equal(logout.statusCode, 204);
      assert.match(String(logout.headers['set-cookie']), /Max-Age=0/i);
      assert.equal(
        (await app.inject({ url: '/api/me', headers: headers(user.token) }))
          .statusCode,
        401,
      );
      const anon = await anonymous(app);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(anon.token, anon.csrf),
        payload: { username: user.user.username, password },
      });
      const token = cookieToken(login);
      const anotherApp = await appFor(t);
      const after = await anotherApp.inject({
        url: '/api/me',
        headers: headers(token),
      });
      assert.equal(after.statusCode, 200);
      assert.deepEqual(
        after.json().allowance.requests,
        before.json().allowance.requests,
      );
      assert.deepEqual(
        after.json().allowance.tokens,
        before.json().allowance.tokens,
      );
      assert.deepEqual(
        after.json().allowance.estimatedCost,
        before.json().allowance.estimatedCost,
      );
    },
  );

  await t.test(
    'approval reissue/rejection/expiry and racing activation cannot create duplicate users',
    async (t) => {
      const app = await appFor(t),
        anon = await anonymous(app),
        name = username();
      await app.inject({
        method: 'POST',
        url: '/api/access-requests',
        headers: headers(anon.token, anon.csrf),
        payload: { username: name },
      });
      const request = await db.accessRequest.findUniqueOrThrow({
        where: { username: name },
      });
      const old = await auth.approve(adminIdentity.sessionId, request.id, {
        reason: 'Initial code',
      });
      const replacement = await auth.approve(
        adminIdentity.sessionId,
        request.id,
        { reason: 'Replace code' },
      );
      const oldResult = await app.inject({
        method: 'POST',
        url: '/api/auth/activate',
        headers: headers(anon.token, anon.csrf),
        payload: {
          username: name,
          activationCode: old.activationCode,
          password,
        },
      });
      assert.equal(oldResult.statusCode, 410);
      await auth.reject(adminIdentity.sessionId, request.id, {
        reason: 'Reject fixture',
      });
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/auth/activate',
        headers: headers(anon.token, anon.csrf),
        payload: {
          username: name,
          activationCode: replacement.activationCode,
          password,
        },
      });
      assert.equal(rejected.statusCode, 410);
      const expiredCode = await auth.approve(
        adminIdentity.sessionId,
        request.id,
        { reason: 'Expiry fixture' },
      );
      await db.accessRequest.update({
        where: { id: request.id },
        data: { activationExpiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/activate',
            headers: headers(anon.token, anon.csrf),
            payload: {
              username: name,
              activationCode: expiredCode.activationCode,
              password,
            },
          })
        ).statusCode,
        410,
      );
      const valid = await auth.approve(adminIdentity.sessionId, request.id, {
        reason: 'Concurrent activation fixture',
      });
      const other = await anonymous(app);
      const races = await Promise.all(
        [anon, other].map((browser) =>
          app.inject({
            method: 'POST',
            url: '/api/auth/activate',
            headers: headers(browser.token, browser.csrf),
            payload: {
              username: name,
              activationCode: valid.activationCode,
              password,
            },
          }),
        ),
      );
      assert.deepEqual(
        races.map((value) => value.statusCode).sort(),
        [201, 410],
      );
      assert.equal(await db.user.count({ where: { username: name } }), 1);
    },
  );

  await t.test(
    'public auth burst limits return 429 and do not trust spoofed forwarded IPs',
    async (t) => {
      const app = await appFor(t),
        anon = await anonymous(app);
      for (let i = 1; i < 30; i++)
        assert.equal(
          (
            await app.inject({
              url: '/api/auth/csrf',
              headers: headers(anon.token),
            })
          ).statusCode,
          200,
        );
      const blocked = await app.inject({
        url: '/api/auth/csrf',
        headers: {
          ...headers(anon.token),
          'x-forwarded-for': '198.51.100.123',
        },
      });
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().error.code, 'RATE_LIMITED');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
    },
  );

  await t.test(
    'production cookies are Secure, HttpOnly, host-only, and prefixed',
    async (t) => {
      const production = parseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: url,
        JWT_SIGNING_KEY: config.JWT_SIGNING_KEY,
        GEMINI_API_KEY: 'synthetic-not-a-real-provider-key',
        ACCOUNTING_INR_PER_USD: '100',
        FRONTEND_ORIGIN: 'https://app.example',
      });
      const app = buildApp(production, { logger: false, database: db });
      t.after(() => app.close());
      const response = await app.inject({
        url: '/api/auth/csrf',
        headers: { origin: production.FRONTEND_ORIGIN },
      });
      assert.equal(response.statusCode, 200);
      const cookie = String(response.headers['set-cookie']);
      assert.match(cookie, /^__Host-qa_session=/);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /; SameSite=Lax/i);
      assert.ok(!/Domain=/i.test(cookie));
    },
  );
});
