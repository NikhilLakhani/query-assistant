import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase } from '../storage/database.js';
import { Storage } from '../storage/store.js';
import { Auth } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { toNano, fromNano } from '../storage/money.js';
import {
  AdminUsageResponseSchema,
  AdminGenerationListResponseSchema,
} from '@query-assistant/contracts';

const url = process.env.TEST_DATABASE_URL;
if (
  !url?.endsWith('/query_assistant_test') ||
  process.env.QUERY_ASSISTANT_ISOLATED_TEST !== '1'
)
  throw new Error('Use the isolated integration harness.');
const db = createDatabase(url);
const now = new Date('2026-11-14T12:00:00Z');
const config = parseConfig({
  NODE_ENV: 'test',
  JWT_SIGNING_KEY:
    'synthetic-admin-test-signing-key-at-least-sixty-four-characters-only',
  ACCOUNTING_INR_PER_USD: '100',
  PRICE_VERSION: 'admin-test-v1',
  USER_DAILY_REQUEST_LIMIT: '100',
});
const store = new Storage(db, config, () => now),
  auth = new Auth(db, config);
const password = 'synthetic-admin-integration-password';
const username = () => `admin_${randomUUID().replaceAll('-', '').slice(0, 18)}`;

test('admin reporting and audited concurrent controls', async (t) => {
  const admin = await db.user.create({
    data: {
      username: username(),
      passwordHash: await hashPassword(password),
      role: 'admin',
    },
  });
  const a = await db.user.create({
    data: { username: username(), passwordHash: await hashPassword(password) },
  });
  const b = await db.user.create({
    data: { username: username(), passwordHash: 'synthetic-unused' },
  });
  const app = buildApp(config, { database: db, logger: false });
  await app.ready();
  t.after(async () => {
    const pending = await db.generationRequest.findMany({
      where: {
        userId: { in: [a.id, b.id] },
        status: { in: ['reserved', 'running'] },
      },
    });
    for (const g of pending)
      await store.settleGeneration({
        userId: g.userId,
        generationId: g.id,
        status: 'cancelled',
      });
    await app.close();
    await db.$disconnect();
  });
  async function login(name: string) {
    const anon = await auth.csrf(undefined);
    const i = await auth.identify(anon.issued!.token);
    const session = await auth.login(i.sessionId, { username: name, password });
    return {
      token: session.token,
      identity: await auth.identify(session.token, true),
    };
  }
  const ai = await login(admin.username),
    ui = await login(a.username);
  const headers = (which = ai, csrf = true) => ({
    cookie: `qa_session=${which.token}`,
    origin: config.FRONTEND_ORIGIN,
    ...(csrf
      ? { 'x-csrf-token': auth.tokens.csrf(which.identity.sessionId) }
      : {}),
  });
  const conversation = await store.createConversation(a.id);
  async function reserve(userId = a.id, conversationId = conversation.id) {
    return (
      await store.reserveGeneration({
        userId,
        conversationId,
        idempotencyKey: randomUUID(),
        content: 'PRIVATE_ADMIN_CHAT_MARKER',
        inputTokenBound: 1000,
        outputTokenBound: 200,
      })
    ).generation;
  }
  for (const status of [
    'completed',
    'cancelled',
    'failed',
    'interrupted',
  ] as const) {
    const g = await reserve();
    if (status !== 'cancelled') await store.markDispatched(a.id, g.id);
    await store.settleGeneration({
      userId: a.id,
      generationId: g.id,
      status,
      ...(status === 'completed'
        ? {
            reportedUsage: {
              inputTokens: 100,
              outputTokens: 40,
              reasoningTokens: 10,
              cachedInputTokens: 20,
              providerReportedNanoUsd: 123n,
            },
          }
        : {}),
    });
  }
  const running = await reserve();
  await store.markDispatched(a.id, running.id);
  const bc = await store.createConversation(b.id),
    reserved = await reserve(b.id, bc.id);
  const range = 'from=2026-11-14T00:00:00Z&to=2026-11-15T00:00:00Z';
  await t.test(
    'only admins read reports or mutate quotas; CSRF and strict filters apply',
    async () => {
      for (const path of ['/api/admin/usage', '/api/admin/generations']) {
        assert.equal((await app.inject({ url: path })).statusCode, 401);
        assert.equal(
          (await app.inject({ url: path, headers: headers(ui) })).statusCode,
          403,
        );
        for (const query of [
          'from=bad',
          'userId=not-a-uuid',
          'outcome=bad',
          'limit=101',
          'from=2026-11-15T00:00:00Z&to=2026-11-14T00:00:00Z',
          'unknown=x',
        ])
          assert.equal(
            (await app.inject({ url: `${path}?${query}`, headers: headers() }))
              .statusCode,
            400,
          );
      }
      const body = {
        dailyRequests: 5,
        dailyTokens: 5000,
        dailyCostLimitInr: '10',
        reason: 'Test',
        expectedVersion: 0,
      };
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/admin/users/${a.id}/quota`,
            headers: headers(ui),
            payload: body,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/admin/users/${a.id}/quota`,
            headers: headers(ai, false),
            payload: body,
          })
        ).statusCode,
        403,
      );
      for (const patch of [
        { dailyRequests: -1 },
        { dailyTokens: 1.5 },
        { dailyCostLimitInr: '100.01' },
        { dailyCostLimitInr: '9'.repeat(500) },
        { reason: '' },
        { role: 'admin' },
      ])
        assert.equal(
          (
            await app.inject({
              method: 'PATCH',
              url: `/api/admin/users/${a.id}/quota`,
              headers: headers(),
              payload: { ...body, ...patch },
            })
          ).statusCode,
          400,
        );
    },
  );
  await t.test(
    'summary reconciles records, partial provider costs, unknown tokens and all outcomes',
    async () => {
      const response = await app.inject({
        url: `/api/admin/usage?${range}`,
        headers: headers(),
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = AdminUsageResponseSchema.parse(response.json()),
        s = result.summary;
      assert.equal(s.requests, 6);
      assert.equal(s.dispatchedRequests, 4);
      assert.equal(s.pendingRequests, 2);
      assert.equal(s.missingUsageRequests, 2);
      assert.equal(s.uncertainRequests, 2);
      assert.equal(s.reportedTokenRequests, 1);
      assert.equal(s.estimatedUsageRequests, 1);
      assert.equal(s.providerReportedCostRequests, 1);
      assert.equal(s.inputTokens, 100);
      assert.equal(s.outputTokens, 40);
      assert.equal(s.cachedInputTokens, 20);
      assert.equal(s.reasoningTokens, 10);
      assert.equal(s.accountedTokens, 2550);
      assert.equal(s.providerReportedCost?.amount, '0.000000123');
      assert.equal(s.latencySamples, 4);
      assert.equal(s.meanLatencyMs, 0);
      assert.deepEqual(
        s.outcomes.map((o) => o.count),
        [1, 1, 1, 1, 1, 1],
      );
      const rows = await db.usageRecord.findMany({
        where: { generation: { userId: { in: [a.id, b.id] } } },
      });
      assert.equal(
        s.estimatedCost.amount,
        fromNano(rows.reduce((n, r) => n + r.estimatedCostNanoInr, 0n)),
      );
      assert.equal(
        result.perUser.reduce((n, u) => n + u.usage.requests, 0),
        s.requests,
      );
      assert.equal(
        result.perUser
          .reduce((n, u) => n + toNano(u.usage.estimatedCost.amount), 0n)
          .toString(),
        toNano(s.estimatedCost.amount).toString(),
      );
      assert.equal(result.globalDailyBudget.limit.amount, '500');
      assert.equal(result.globalTotalBudget.limit.amount, '1000');
      assert.equal(response.body.includes('PRIVATE_ADMIN_CHAT_MARKER'), false);
      assert.equal(response.body.includes('passwordHash'), false);
    },
  );
  await t.test(
    'filters, empty results, scoped pagination and price snapshots remain auditable',
    async () => {
      const first = (
        await app.inject({
          url: `/api/admin/usage?${range}&limit=1`,
          headers: headers(),
        })
      ).json();
      assert.ok(first.nextCursor);
      const next = (
        await app.inject({
          url: `/api/admin/usage?${range}&limit=1&cursor=${first.nextCursor}`,
          headers: headers(),
        })
      ).json();
      assert.equal(next.summary.requests, 6);
      assert.notEqual(first.perUser[0].user.id, next.perUser[0].user.id);
      assert.equal(next.nextCursor, null);
      assert.equal(
        (
          await app.inject({
            url: `/api/admin/usage?${range}&outcome=completed&cursor=${first.nextCursor}`,
            headers: headers(),
          })
        ).statusCode,
        400,
      );
      const filtered = (
        await app.inject({
          url: `/api/admin/usage?${range}&userId=${a.id}&outcome=interrupted`,
          headers: headers(),
        })
      ).json();
      assert.equal(filtered.summary.requests, 1);
      assert.equal(filtered.summary.uncertainRequests, 1);
      const empty = (
        await app.inject({
          url: '/api/admin/usage?from=2030-01-01T00:00:00Z',
          headers: headers(),
        })
      ).json();
      assert.equal(empty.summary.requests, 0);
      assert.equal(empty.summary.meanLatencyMs, null);
      assert.equal(empty.summary.providerReportedCost, null);
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const r: import('light-my-request').Response = await app.inject({
          url: `/api/admin/generations?${range}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          headers: headers(),
        });
        assert.equal(r.statusCode, 200, r.body);
        const page = AdminGenerationListResponseSchema.parse(r.json());
        for (const g of page.items) {
          ids.push(g.id);
          assert.equal(g.price.version, 'admin-test-v1');
          assert.equal(g.price.inrPerUsd, '100');
          assert.equal('content' in g, false);
        }
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 6);
      assert.equal(new Set(ids).size, 6);
    },
  );
  await t.test(
    'quota edits serialize with reservations, preserve accounting and audit before and after',
    async () => {
      const before = await store.allowance(a.id);
      const payload = {
        dailyRequests: 0,
        dailyTokens: 0,
        dailyCostLimitInr: '0',
        expectedVersion: 0,
        reason: 'Pause spending without changing history',
      };
      const responses = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: 'PATCH',
            url: `/api/admin/users/${a.id}/quota`,
            headers: headers(),
            payload,
          }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
      const after = await store.allowance(a.id);
      assert.equal(after.requestsUsed, before.requestsUsed);
      assert.equal(after.requestsReserved, before.requestsReserved);
      assert.equal(after.costUsedNanoInr, before.costUsedNanoInr);
      assert.equal(after.costReservedNanoInr, before.costReservedNanoInr);
      assert.equal(after.limits.dailyRequests, 0);
      const audit = await db.adminAuditEvent.findMany({
        where: { targetUserId: a.id, action: 'quota_changed' },
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.reason, payload.reason);
      assert.ok(audit[0]!.details as object);
      await store.settleGeneration({
        userId: a.id,
        generationId: running.id,
        status: 'cancelled',
      });
      await assert.rejects(
        reserve(),
        (e) => e instanceof Error && 'code' in e && e.code === 'QUOTA_EXCEEDED',
      );
      // Status and quota share the same version; a stale cross-control edit fails.
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/admin/users/${a.id}/status`,
            headers: headers(),
            payload: {
              status: 'suspended',
              expectedVersion: 0,
              reason: 'Stale edit',
            },
          })
        ).statusCode,
        409,
      );
      const g = await db.generationRequest.findUniqueOrThrow({
        where: { id: running.id },
      });
      assert.equal(g.status, 'cancelled');
    },
  );
  await t.test(
    'a simultaneous quota reduction and admission has a serialized outcome',
    async () => {
      const c = await db.user.create({
        data: { username: username(), passwordHash: 'synthetic-unused' },
      });
      const cc = await store.createConversation(c.id);
      const [edit, admission] = await Promise.allSettled([
        app.inject({
          method: 'PATCH',
          url: `/api/admin/users/${c.id}/quota`,
          headers: headers(),
          payload: {
            dailyRequests: 0,
            dailyTokens: 0,
            dailyCostLimitInr: '0',
            expectedVersion: 0,
            reason: 'Concurrent spending pause',
          },
        }),
        reserve(c.id, cc.id),
      ]);
      assert.equal(edit.status, 'fulfilled');
      if (edit.status === 'fulfilled') assert.equal(edit.value.statusCode, 200);
      const allowance = await store.allowance(c.id);
      assert.equal(allowance.limits.dailyRequests, 0);
      if (admission.status === 'fulfilled') {
        assert.equal(allowance.requestsReserved, 1);
        await store.settleGeneration({
          userId: c.id,
          generationId: admission.value.id,
          status: 'cancelled',
        });
      } else {
        assert.equal(allowance.requestsReserved, 0);
        assert.equal(admission.reason.code, 'QUOTA_EXCEEDED');
      }
      await assert.rejects(
        reserve(c.id, cc.id),
        (e) => e instanceof Error && 'code' in e && e.code === 'QUOTA_EXCEEDED',
      );
    },
  );
  await t.test(
    'deleting conversation text retains request reporting and cost totals',
    async () => {
      const path = `/api/admin/usage?${range}&userId=${a.id}`;
      const before = (
        await app.inject({ url: path, headers: headers() })
      ).json().summary;
      await store.deleteConversation(a.id, conversation.id);
      const after = (await app.inject({ url: path, headers: headers() })).json()
        .summary;
      assert.deepEqual(after, before);
      assert.equal(
        await db.message.count({ where: { conversationId: conversation.id } }),
        0,
      );
      await store.settleGeneration({
        userId: b.id,
        generationId: reserved.id,
        status: 'cancelled',
      });
    },
  );
});
