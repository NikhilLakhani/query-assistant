import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseConfig } from '../config.js';
import { createDatabase, databaseIsReady } from './database.js';
import { Storage, StorageError } from './store.js';
import { estimateCost, fromNano, toNano } from './money.js';
import { dailyPeriod } from './period.js';
import { buildApp } from '../app.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !url.endsWith('/query_assistant_test') ||
  process.env.QUERY_ASSISTANT_ISOLATED_TEST !== '1'
) {
  throw new Error(
    'Run npm run test:integration from the root; direct database test execution is disabled.',
  );
}
const db = createDatabase(url);
const fixedNow = new Date('2026-10-30T12:00:00Z');
const config = (overrides: NodeJS.ProcessEnv = {}) =>
  parseConfig({
    NODE_ENV: 'test',
    ACCOUNTING_INR_PER_USD: '100',
    PRICE_VERSION: 'test-price-v1',
    ...overrides,
  });
const store = new Storage(db, config(), () => fixedNow);
const reportedUsage = {
  inputTokens: 100,
  outputTokens: 40,
  reasoningTokens: 10,
  cachedInputTokens: 20,
};

async function fixture(storage = store) {
  const user = await db.user.create({
    data: {
      username: `u_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      passwordHash: 'invalid-test-fixture-hash',
    },
  });
  const conversation = await storage.createConversation(user.id);
  const input = {
    userId: user.id,
    conversationId: conversation.id,
    idempotencyKey: randomUUID(),
    content: 'Test question',
    inputTokenBound: 1000,
    outputTokenBound: 200,
  };
  return { user, conversation, input };
}
async function clearPending() {
  const pending = await db.generationRequest.findMany({
    where: { status: { in: ['reserved', 'running'] } },
  });
  for (const row of pending)
    await store.settleGeneration({
      userId: row.userId,
      generationId: row.id,
      status: 'cancelled',
    });
}
async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof StorageError && error.code === code,
  );
}

test('PostgreSQL storage invariants and durable allowance behavior', async (t) => {
  t.after(() => db.$disconnect());
  t.afterEach(clearPending);

  await t.test(
    'clean migrations, ownership constraints, and nonnegative counters',
    async () => {
      assert.equal(await databaseIsReady(db), true);
      assert.equal(await db.ledgerLock.count(), 1);
      const a = await fixture();
      const b = await fixture();
      await expectCode(
        store.reserveGeneration({
          ...a.input,
          conversationId: b.conversation.id,
        }),
        'NOT_FOUND',
      );
      const r = await store.reserveGeneration(a.input);
      await assert.rejects(
        db.generationRequest.update({
          where: { id: r.generation.id },
          data: { conversationId: b.conversation.id },
        }),
      );
      const period = await db.quotaPeriod.findFirstOrThrow({
        where: { userId: a.user.id },
      });
      await assert.rejects(
        db.quotaPeriod.update({
          where: { id: period.id },
          data: { requestsReserved: -1 },
        }),
      );
      await assert.rejects(
        db.message.create({
          data: {
            conversationId: a.conversation.id,
            generationId: r.generation.id,
            sequence: 99,
            role: 'user',
            status: 'completed',
            content: 'duplicate role',
          },
        }),
      );
    },
  );

  await t.test(
    'concurrent identical submissions reserve and persist exactly once',
    async () => {
      const f = await fixture();
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () => store.reserveGeneration(f.input)),
      );
      assert.equal(
        new Set(receipts.map((value) => value.generation.id)).size,
        1,
      );
      assert.equal(receipts.filter((value) => !value.replayed).length, 1);
      assert.equal(
        await db.message.count({
          where: { conversationId: f.conversation.id },
        }),
        2,
      );
      assert.equal((await store.allowance(f.user.id)).requestsReserved, 1);
      await expectCode(
        store.reserveGeneration({ ...f.input, content: 'Different question' }),
        'CONFLICT',
      );
      assert.equal((await store.allowance(f.user.id)).requestsReserved, 1);
    },
  );

  await t.test(
    'parallel reservations cannot exceed user request or token limits',
    async () => {
      const limited = new Storage(
        db,
        config({
          USER_DAILY_REQUEST_LIMIT: '2',
          USER_MAX_ACTIVE_GENERATIONS: '20',
          GLOBAL_MAX_ACTIVE_GENERATIONS: '20',
        }),
        () => fixedNow,
      );
      const f = await fixture(limited);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          limited.reserveGeneration({
            ...f.input,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      assert.equal(
        results.filter((value) => value.status === 'fulfilled').length,
        2,
      );
      for (const result of results)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
      assert.equal((await limited.allowance(f.user.id)).requestsReserved, 2);
      await clearPending();
      const tokens = new Storage(
        db,
        config({ USER_DAILY_TOKEN_LIMIT: '1199' }),
        () => fixedNow,
      );
      const other = await fixture(tokens);
      await expectCode(tokens.reserveGeneration(other.input), 'QUOTA_EXCEEDED');
      assert.equal(
        await db.message.count({
          where: { conversationId: other.conversation.id },
        }),
        0,
      );
    },
  );

  await t.test(
    'durable per-user and application concurrency limits apply before dispatch',
    async () => {
      const one = new Storage(
        db,
        config({ GLOBAL_MAX_ACTIVE_GENERATIONS: '1' }),
        () => fixedNow,
      );
      const a = await fixture(one),
        b = await fixture(one);
      const results = await Promise.allSettled([
        one.reserveGeneration(a.input),
        one.reserveGeneration(b.input),
      ]);
      assert.equal(
        results.filter((value) => value.status === 'fulfilled').length,
        1,
      );
      const failed = results.find((value) => value.status === 'rejected');
      assert.ok(failed && failed.status === 'rejected');
      assert.equal(failed.reason.code, 'CONCURRENCY_LIMIT');
      const winner = results[0]?.status === 'fulfilled' ? a : b;
      await expectCode(
        one.reserveGeneration({
          ...winner.input,
          idempotencyKey: randomUUID(),
        }),
        'CONCURRENCY_LIMIT',
      );
    },
  );

  await t.test(
    'global daily and lifetime budget reservations are atomic across users',
    async () => {
      const day = dailyPeriod(fixedNow, 'Asia/Kolkata');
      const daily = await db.quotaPeriod.findUnique({
        where: {
          scope_ownerKey_periodStart: {
            scope: 'global_daily',
            ownerKey: 'global',
            periodStart: day.start,
          },
        },
      });
      const total = await db.quotaPeriod.findUnique({
        where: {
          scope_ownerKey_periodStart: {
            scope: 'global_total',
            ownerKey: 'global',
            periodStart: new Date(0),
          },
        },
      });
      const price = {
        inputNanoUsdPerMillion: toNano('0.30'),
        outputNanoUsdPerMillion: toNano('2.50'),
        inrPerUsdNano: toNano('100'),
      };
      const cost = estimateCost(1000, 200, price).nanoInr;
      for (const mode of ['daily', 'total'] as const) {
        const capped = new Storage(
          db,
          config({
            GLOBAL_DAILY_COST_LIMIT_INR:
              mode === 'daily'
                ? fromNano((daily?.costUsedNanoInr ?? 0n) + cost)
                : '500',
            GLOBAL_TOTAL_COST_LIMIT_INR:
              mode === 'total'
                ? fromNano((total?.costUsedNanoInr ?? 0n) + cost)
                : '1000',
          }),
          () => fixedNow,
        );
        const a = await fixture(capped),
          b = await fixture(capped);
        const result = await Promise.allSettled([
          capped.reserveGeneration(a.input),
          capped.reserveGeneration(b.input),
        ]);
        assert.equal(
          result.filter((value) => value.status === 'fulfilled').length,
          1,
        );
        const failed = result.find((value) => value.status === 'rejected');
        assert.ok(failed && failed.status === 'rejected');
        assert.equal(failed.reason.code, 'QUOTA_EXCEEDED');
        await clearPending();
      }
    },
  );

  await t.test(
    'dispatch claims and duplicate completion/cancellation settle once',
    async () => {
      const f = await fixture();
      const { generation } = await store.reserveGeneration(f.input);
      const claims = await Promise.all(
        Array.from({ length: 6 }, () =>
          store.markDispatched(f.user.id, generation.id),
        ),
      );
      assert.equal(claims.filter((value) => value.dispatch).length, 1);
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          store.settleGeneration({
            userId: f.user.id,
            generationId: generation.id,
            status: index % 2 ? 'cancelled' : 'completed',
            content: 'Preserved answer',
            reportedUsage,
          }),
        ),
      );
      assert.equal(outcomes.filter((value) => value.settled).length, 1);
      assert.equal(
        new Set(outcomes.map((value) => value.generation.status)).size,
        1,
      );
      const allowance = await store.allowance(f.user.id);
      assert.equal(allowance.requestsUsed, 1);
      assert.equal(allowance.requestsReserved, 0);
      assert.equal(allowance.tokensUsed, 150n);
      assert.equal(allowance.tokensReserved, 0n);
      assert.equal(
        await db.usageRecord.count({ where: { generationId: generation.id } }),
        1,
      );
      const usage = await db.usageRecord.findUniqueOrThrow({
        where: { generationId: generation.id },
      });
      assert.equal(usage.providerReportedNanoUsd, null);
      assert.equal(usage.accountingStatus, 'reported');
    },
  );

  await t.test(
    'recovery releases undispatched work and conservatively charges uncertain dispatched work',
    async () => {
      let now = new Date(fixedNow);
      const recovering = new Storage(db, config(), () => now);
      const a = await fixture(recovering),
        b = await fixture(recovering);
      const pending = await recovering.reserveGeneration(a.input);
      const running = await recovering.reserveGeneration(b.input);
      await recovering.markDispatched(b.user.id, running.generation.id);
      await recovering.checkpoint(
        b.user.id,
        running.generation.id,
        'Partial answer',
      );
      now = new Date(now.getTime() + 121000);
      assert.equal(await recovering.recoverExpired(), 2);
      assert.equal(await recovering.recoverExpired(), 0);
      const unused = await db.usageRecord.findUniqueOrThrow({
        where: { generationId: pending.generation.id },
      });
      const uncertain = await db.usageRecord.findUniqueOrThrow({
        where: { generationId: running.generation.id },
      });
      assert.equal(unused.accountedTokens, 0n);
      assert.equal((await recovering.allowance(a.user.id)).requestsUsed, 0);
      assert.equal(uncertain.accountingStatus, 'uncertain');
      assert.equal(uncertain.inputTokens, null);
      assert.equal(uncertain.accountedTokens, 1200n);
      assert.ok(uncertain.estimatedCostNanoInr > 0n);
      assert.equal(
        (
          await db.message.findFirstOrThrow({
            where: { generationId: running.generation.id, role: 'assistant' },
          })
        ).content,
        'Partial answer',
      );
      const late = await recovering.settleGeneration({
        userId: b.user.id,
        generationId: running.generation.id,
        status: 'completed',
        reportedUsage,
      });
      assert.equal(late.settled, false);
      assert.equal(late.generation.status, 'interrupted');
    },
  );

  await t.test(
    'settlement after midnight charges the reserved period and preserves ordering',
    async () => {
      let now = new Date('2026-10-31T18:29:59Z');
      const clock = new Storage(db, config(), () => now);
      const f = await fixture(clock);
      const { generation } = await clock.reserveGeneration(f.input);
      await clock.markDispatched(f.user.id, generation.id);
      now = new Date('2026-10-31T18:30:01Z');
      await clock.settleGeneration({
        userId: f.user.id,
        generationId: generation.id,
        status: 'completed',
        reportedUsage,
        content: 'Follow-up context',
      });
      assert.equal((await clock.allowance(f.user.id)).requestsUsed, 0);
      const previous = await db.quotaPeriod.findFirstOrThrow({
        where: { userId: f.user.id },
      });
      assert.equal(previous.requestsUsed, 1);
      assert.equal(previous.requestsReserved, 0);
      const messages = await db.message.findMany({
        where: { conversationId: f.conversation.id },
        orderBy: { sequence: 'asc' },
      });
      assert.deepEqual(
        messages.map((value) => value.sequence),
        [1, 2],
      );
      assert.deepEqual(
        messages.map((value) => value.role),
        ['user', 'assistant'],
      );
    },
  );

  await t.test(
    'chat deletion removes plaintext while retaining idempotency and accounting',
    async () => {
      const f = await fixture();
      const other = await fixture();
      const { generation } = await store.reserveGeneration(f.input);
      await expectCode(
        store.deleteConversation(f.user.id, f.conversation.id),
        'CONFLICT',
      );
      await expectCode(
        store.deleteConversation(other.user.id, f.conversation.id),
        'NOT_FOUND',
      );
      await store.markDispatched(f.user.id, generation.id);
      await store.settleGeneration({
        userId: f.user.id,
        generationId: generation.id,
        status: 'completed',
        reportedUsage,
        content: 'Deleted text',
      });
      const before = await store.allowance(f.user.id);
      await store.deleteConversation(f.user.id, f.conversation.id);
      assert.equal(
        await db.message.count({
          where: { conversationId: f.conversation.id },
        }),
        0,
      );
      assert.equal(
        (
          await db.generationRequest.findUniqueOrThrow({
            where: { id: generation.id },
          })
        ).conversationId,
        null,
      );
      assert.equal(
        await db.usageRecord.count({ where: { generationId: generation.id } }),
        1,
      );
      assert.equal(
        (await store.allowance(f.user.id)).costUsedNanoInr,
        before.costUsedNanoInr,
      );
      assert.equal((await store.reserveGeneration(f.input)).replayed, true);
    },
  );

  await t.test(
    'reconnection preserves quotas and price versions cannot be rewritten',
    async () => {
      const f = await fixture();
      const { generation } = await store.reserveGeneration(f.input);
      await store.markDispatched(f.user.id, generation.id);
      await store.settleGeneration({
        userId: f.user.id,
        generationId: generation.id,
        status: 'completed',
        reportedUsage,
      });
      const reconnected = createDatabase(url);
      try {
        const reopened = new Storage(reconnected, config(), () => fixedNow);
        assert.equal((await reopened.allowance(f.user.id)).requestsUsed, 1);
        const changed = new Storage(
          reconnected,
          config({ MODEL_INPUT_USD_PER_MILLION: '0.31' }),
          () => fixedNow,
        );
        await expectCode(
          changed.reserveGeneration({
            ...f.input,
            idempotencyKey: randomUUID(),
          }),
          'SERVICE_NOT_READY',
        );
        assert.equal((await reopened.allowance(f.user.id)).requestsReserved, 0);
      } finally {
        await reconnected.$disconnect();
      }
    },
  );

  await t.test(
    'database unavailability rejects reservation without any allowance bypass',
    async () => {
      const unavailable = createDatabase(
        'postgresql://test:test@127.0.0.1:1/query_assistant_test',
      );
      try {
        const blocked = new Storage(unavailable, config(), () => fixedNow);
        const f = await fixture();
        await expectCode(
          blocked.reserveGeneration(f.input),
          'STORAGE_UNAVAILABLE',
        );
        assert.equal((await store.allowance(f.user.id)).requestsReserved, 0);
      } finally {
        await unavailable.$disconnect();
      }
    },
  );

  await t.test(
    'a database error after reservation writes rolls the entire operation back',
    async () => {
      const f = await fixture();
      // Force a message-ordering conflict after the reservation and counters have
      // been staged, without touching any other fixture or application database.
      await db.message.create({
        data: {
          conversationId: f.conversation.id,
          sequence: 1,
          role: 'user',
          status: 'completed',
          content: 'Existing fixture message',
        },
      });
      await expectCode(store.reserveGeneration(f.input), 'STORAGE_UNAVAILABLE');
      assert.equal(
        await db.generationRequest.count({ where: { userId: f.user.id } }),
        0,
      );
      assert.equal(
        await db.quotaPeriod.count({ where: { userId: f.user.id } }),
        0,
      );
      assert.equal(
        await db.message.count({
          where: { conversationId: f.conversation.id },
        }),
        1,
      );
      assert.equal((await store.allowance(f.user.id)).requestsReserved, 0);
    },
  );

  await t.test(
    'reported usage above a bound is preserved and prevents further overspending',
    async () => {
      const capped = new Storage(
        db,
        config({ USER_DAILY_TOKEN_LIMIT: '1200' }),
        () => fixedNow,
      );
      const f = await fixture(capped);
      const { generation } = await capped.reserveGeneration(f.input);
      await capped.markDispatched(f.user.id, generation.id);
      await capped.settleGeneration({
        userId: f.user.id,
        generationId: generation.id,
        status: 'completed',
        reportedUsage: {
          inputTokens: 1000,
          outputTokens: 400,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
      });
      assert.equal((await capped.allowance(f.user.id)).tokensUsed, 1400n);
      await expectCode(
        capped.reserveGeneration({
          ...f.input,
          idempotencyKey: randomUUID(),
          inputTokenBound: 1,
          outputTokenBound: 1,
        }),
        'QUOTA_EXCEEDED',
      );
    },
  );

  await t.test(
    'readiness recognizes migrated storage while unfinished application stays unavailable',
    async () => {
      const app = buildApp(config(), { logger: false, database: db });
      try {
        const ready = await app.inject('/health/ready');
        assert.equal(ready.statusCode, 503);
        assert.equal(ready.json().checks.database, true);
        assert.equal(ready.json().checks.application, false);
      } finally {
        await app.close();
      }
    },
  );

  await t.test(
    'all durable period counters reconcile to reservations and usage records',
    async () => {
      const periods = await db.quotaPeriod.findMany({
        include: {
          allocations: {
            include: {
              reservation: {
                include: { generation: { include: { usage: true } } },
              },
            },
          },
        },
      });
      for (const period of periods) {
        let requests = 0,
          requestsReserved = 0;
        let tokens = 0n,
          tokensReserved = 0n,
          cost = 0n,
          costReserved = 0n;
        for (const allocation of period.allocations) {
          const reservation = allocation.reservation;
          if (reservation.settledAt) {
            const usage = reservation.generation.usage;
            assert.ok(usage);
            requests += reservation.generation.dispatchedAt ? 1 : 0;
            tokens += usage.accountedTokens;
            cost += usage.estimatedCostNanoInr;
          } else {
            requestsReserved += allocation.requests;
            tokensReserved += allocation.tokens;
            costReserved += allocation.costNanoInr;
          }
        }
        assert.equal(period.requestsUsed, requests);
        assert.equal(period.tokensUsed, tokens);
        assert.equal(period.costUsedNanoInr, cost);
        assert.equal(period.requestsReserved, requestsReserved);
        assert.equal(period.tokensReserved, tokensReserved);
        assert.equal(period.costReservedNanoInr, costReserved);
      }
    },
  );
});
