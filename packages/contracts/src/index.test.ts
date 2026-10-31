import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccessRequestBodySchema,
  AdminDateFilterSchema,
  IdempotencyHeadersSchema,
  MoneySchema,
  QuotaChangeBodySchema,
  PaginationQuerySchema,
  StreamEventSchema,
  SubmitMessageBodySchema,
} from './index.js';

test('paid submissions reject blank, oversized, and unapproved tool fields', () => {
  for (const body of [
    { content: '   ' },
    { content: 'a'.repeat(8001) },
    { content: 'hello', search: true },
    { content: 'hello', userId: 'someone-else' },
  ])
    assert.equal(SubmitMessageBodySchema.safeParse(body).success, false);
  assert.deepEqual(SubmitMessageBodySchema.parse({ content: ' hi ' }), {
    content: 'hi',
  });
});

test('pagination, identifiers, and date filters are bounded', () => {
  assert.equal(PaginationQuerySchema.parse({ limit: '10' }).limit, 10);
  for (const limit of ['0', '101', '1.5', 'NaN']) {
    assert.equal(PaginationQuerySchema.safeParse({ limit }).success, false);
  }
  assert.equal(
    IdempotencyHeadersSchema.safeParse({ 'idempotency-key': 'bad' }).success,
    false,
  );
  assert.equal(
    AdminDateFilterSchema.safeParse({
      from: '2026-10-31T00:00:00Z',
      to: '2026-10-30T00:00:00Z',
    }).success,
    false,
  );
});

test('registration cannot self-select roles and normalizes usernames', () => {
  assert.deepEqual(AccessRequestBodySchema.parse({ username: 'Reviewer' }), {
    username: 'reviewer',
  });
  assert.equal(
    AccessRequestBodySchema.safeParse({ username: 'reviewer', role: 'admin' })
      .success,
    false,
  );
});

test('money is a precise decimal string and stream terminal events require usage', () => {
  assert.equal(
    MoneySchema.safeParse({ amount: 0.1, currency: 'USD' }).success,
    false,
  );
  assert.equal(
    MoneySchema.safeParse({ amount: '0.000001', currency: 'USD' }).success,
    true,
  );
  assert.equal(
    StreamEventSchema.safeParse({
      type: 'completed',
      generationId: '11111111-1111-4111-8111-111111111111',
    }).success,
    false,
  );
});

test('admin dates compare instants and quota edits stay inside the approved cost budget', () => {
  assert.equal(
    AdminDateFilterSchema.safeParse({
      from: '2026-10-30T00:00:00Z',
      to: '2026-10-30T00:00:00.500Z',
    }).success,
    true,
  );
  assert.equal(
    AdminDateFilterSchema.safeParse({
      from: '2026-10-30T00:00:00Z',
      to: '2026-10-30T00:00:00.000Z',
    }).success,
    false,
  );
  const body = {
    dailyRequests: 0,
    dailyTokens: 0,
    dailyCostLimitInr: '100.00',
    expectedVersion: 0,
    reason: 'Approved cap',
  };
  assert.equal(QuotaChangeBodySchema.safeParse(body).success, true);
  for (const patch of [
    { dailyCostLimitInr: '100.01' },
    { dailyCostLimitInr: '9'.repeat(500) },
    { dailyRequests: 10001 },
    { reason: '  ' },
    { expectedVersion: -1 },
  ])
    assert.equal(
      QuotaChangeBodySchema.safeParse({ ...body, ...patch }).success,
      false,
    );
});
