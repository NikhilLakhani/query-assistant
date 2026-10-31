import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config as loadEnv } from 'dotenv';
import {
  AnswerResponseSchema,
  MessageListResponseSchema,
} from '@query-assistant/contracts';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import type { Config } from '../config.js';
import { createDatabase } from '../storage/database.js';
import { AppError } from '../errors.js';
import { Storage } from '../storage/store.js';
import { hashPassword } from '../auth/password.js';
import { GeminiProvider } from './gemini.js';
import { Chat } from './service.js';
import type {
  TextProvider,
  Turn,
  ProviderAnswer,
  ProviderChunk,
} from './provider.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !url.endsWith('/query_assistant_test') ||
  process.env.QUERY_ASSISTANT_ISOLATED_TEST !== '1'
)
  throw new Error('Use the isolated root integration harness.');
const db = createDatabase(url);
const config = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: url,
  JWT_SIGNING_KEY:
    'synthetic-chat-test-signing-key-with-over-sixty-four-characters-for-tests',
  GEMINI_API_KEY: 'synthetic-provider-test-key',
  ACCOUNTING_INR_PER_USD: '100',
  PRICE_VERSION: 'test-chat-v1',
});
const password = 'synthetic-chat-test-password!';
class Fake implements TextProvider {
  calls: Turn[][] = [];
  counts: Turn[][] = [];
  tokens = 100;
  countError = false;
  answerError = false;
  usage = true;
  completed = true;
  async countTokens(turns: Turn[]) {
    this.counts.push(structuredClone(turns));
    if (this.countError)
      throw new Error('private synthetic preflight diagnostics');
    return this.tokens;
  }
  async *stream(turns: Turn[]): AsyncGenerator<ProviderChunk> {
    const result = await this.answer(turns);
    yield { type: 'delta' as const, text: result.content };
    yield { type: 'final' as const, ...result };
  }
  async answer(turns: Turn[]): Promise<ProviderAnswer> {
    this.calls.push(structuredClone(turns));
    if (this.answerError)
      throw new Error('private synthetic provider diagnostics');
    return {
      content: 'Synthetic test answer',
      completed: this.completed,
      ...(this.usage
        ? {
            usage: {
              inputTokens: 100,
              outputTokens: 40,
              reasoningTokens: 10,
              cachedInputTokens: 20,
            },
          }
        : {}),
      providerRequestId: 'synthetic-provider-request',
    };
  }
}
const cookie = (res: { headers: Record<string, unknown> }) => {
  const value = res.headers['set-cookie'];
  const token = (Array.isArray(value) ? value[0] : value) as string;
  assert.ok(token?.startsWith('qa_session='));
  return token.split(';')[0]!;
};
async function fixture(
  t: TestContext,
  provider: TextProvider = new Fake(),
  overrides: Partial<Config> = {},
) {
  const cfg = { ...config, ...overrides };
  const user = await db.user.create({
    data: {
      username: `chat_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      passwordHash: await hashPassword(password),
    },
  });
  const app = buildApp(cfg, { logger: false, database: db, provider });
  t.after(() => app.close());
  const anon = await app.inject({
    url: '/api/auth/csrf',
    headers: { origin: cfg.FRONTEND_ORIGIN },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      cookie: cookie(anon),
      origin: cfg.FRONTEND_ORIGIN,
      'x-csrf-token': anon.json().csrfToken,
    },
    payload: { username: user.username, password },
  });
  assert.equal(login.statusCode, 200);
  const session = cookie(login);
  const csrf = await app.inject({
    url: '/api/auth/csrf',
    headers: { cookie: session },
  });
  const headers = {
    cookie: session,
    origin: cfg.FRONTEND_ORIGIN,
    'x-csrf-token': csrf.json().csrfToken as string,
  };
  const created = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers,
    payload: { title: 'Synthetic fixture' },
  });
  assert.equal(created.statusCode, 201);
  const conversationId = created.json().conversation.id as string;
  const receipt = (content: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { content },
    });
  const submit = async (content: string, key = randomUUID()) => {
    const result = await receipt(content, key);
    if (result.statusCode !== 202) return result;
    const events = await app.inject({ url: result.json().eventsUrl, headers });
    if (![200, 409].includes(events.statusCode)) return events;
    for (let i = 0; i < 200; i++) {
      const saved = await app.inject({
        url: `/api/conversations/${conversationId}/submissions/${key}`,
        headers,
      });
      if (saved.statusCode !== 202) return saved;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Generation did not settle');
  };
  return { app, cfg, user, headers, session, conversationId, submit, receipt };
}

test('streaming authenticated question flow', async (t) => {
  t.after(() => db.$disconnect());
  await t.test(
    'login → question → follow-up → fresh application reload preserves messages and reported usage',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider);
      const first = await f.submit('Remember synthetic code ORCHID_42.');
      assert.equal(first.statusCode, 200);
      const result = AnswerResponseSchema.parse(first.json());
      assert.equal(result.generation.status, 'completed');
      assert.equal(result.usage?.accountingStatus, 'reported');
      assert.equal(result.usage?.estimatedCost?.amount, '0.0155');
      assert.equal(result.usage?.providerReportedCost, null);
      assert.equal(
        (
          await db.generationRequest.findUniqueOrThrow({
            where: { id: result.generation.id },
          })
        ).providerRequestId,
        'synthetic-provider-request',
      );
      assert.equal(
        (await f.submit('What code did I give you?')).statusCode,
        200,
      );
      assert.deepEqual(provider.calls[1], [
        { role: 'user', text: 'Remember synthetic code ORCHID_42.' },
        { role: 'model', text: 'Synthetic test answer' },
        { role: 'user', text: 'What code did I give you?' },
      ]);
      const fresh = buildApp(f.cfg, { logger: false, database: db, provider });
      t.after(() => fresh.close());
      const loaded = await fresh.inject({
        url: `/api/conversations/${f.conversationId}/messages`,
        headers: f.headers,
      });
      assert.equal(
        MessageListResponseSchema.parse(loaded.json()).items.length,
        4,
      );
      const me = await fresh.inject({ url: '/api/me', headers: f.headers });
      assert.equal(me.json().allowance.requests.used, 2);
      assert.equal(me.json().allowance.tokens.used, 300);
      assert.equal(me.json().allowance.generationAvailable, true);
      assert.equal((await fresh.inject('/health/ready')).statusCode, 200);
    },
  );
  await t.test(
    'same-key replay and concurrent duplicates make one provider call; changed content conflicts',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider),
        key = randomUUID();
      const responses = await Promise.all([
        f.submit('Same question', key),
        f.submit('Same question', key),
      ]);
      assert.ok(responses.every((res) => [200, 202].includes(res.statusCode)));
      const replay = await f.submit('Same question', key);
      assert.equal(replay.json().replayed, true);
      assert.equal(replay.json().generation.status, 'completed');
      assert.equal(provider.calls.length, 1);
      assert.equal(provider.counts.length, 1);
      assert.equal((await f.submit('Different question', key)).statusCode, 409);
      const recovered = await f.app.inject({
        url: `/api/conversations/${f.conversationId}/submissions/${key}`,
        headers: f.headers,
      });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().generation.id, replay.json().generation.id);
    },
  );
  await t.test(
    'missing CSRF, invalid input and cross-user resources never reach provider preflight',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider),
        other = await fixture(t);
      const path = `/api/conversations/${f.conversationId}/messages`;
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: path,
            headers: {
              cookie: f.session,
              origin: config.FRONTEND_ORIGIN,
              'idempotency-key': randomUUID(),
            },
            payload: { content: 'Question' },
          })
        ).statusCode,
        403,
      );
      assert.equal((await f.submit(' ')).statusCode, 400);
      assert.equal((await f.submit('x'.repeat(8001))).statusCode, 400);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: path,
            headers: { ...f.headers, 'idempotency-key': randomUUID() },
            payload: { content: 'Question', model: 'other-model' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: `/api/conversations/${other.conversationId}/messages`,
            headers: { ...f.headers, 'idempotency-key': randomUUID() },
            payload: { content: 'Question' },
          })
        ).statusCode,
        404,
      );
      const key = randomUUID();
      await f.submit('Owned question', key);
      assert.equal(
        (
          await other.app.inject({
            url: `/api/conversations/${f.conversationId}/submissions/${key}`,
            headers: other.headers,
          })
        ).statusCode,
        404,
      );
      assert.equal(provider.calls.length, 1);
    },
  );
  await t.test(
    'same-origin stream GET accepts only configured Host, Fetch Metadata and session CSRF',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider);
      const receipt = await f.receipt('Same-origin stream');
      assert.equal(receipt.statusCode, 202);
      const url = receipt.json().eventsUrl;
      const base = {
        cookie: f.session,
        host: new URL(f.cfg.FRONTEND_ORIGIN).host,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': f.headers['x-csrf-token'],
      };
      for (const change of [
        { 'sec-fetch-site': undefined },
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'none' },
        { host: 'untrusted.example' },
        { host: 'localhost:9999' },
        { 'x-csrf-token': undefined },
        { 'x-csrf-token': 'wrong' },
        { origin: 'https://untrusted.example' },
        { origin: 'null' },
      ]) {
        const headers = Object.fromEntries(
          Object.entries({ ...base, ...change }).filter(
            ([, value]) => value !== undefined,
          ),
        );
        const response = await f.app.inject({ url, headers });
        assert.equal(response.statusCode, 403);
        assert.equal(response.json().error.code, 'CSRF_INVALID');
      }
      assert.equal(provider.calls.length, 0);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/conversations',
            headers: base,
            payload: {},
          })
        ).statusCode,
        403,
        'Mutation Origin policy stays strict',
      );
      const attached = await f.app.inject({ url, headers: base });
      assert.equal(attached.statusCode, 200);
      assert.ok(attached.body.includes('event: completed'));
      assert.equal(provider.calls.length, 1);
    },
  );
  await t.test(
    'unfunded reservation and missing service configuration reject before remote calls',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider);
      await db.userQuota.create({
        data: {
          userId: f.user.id,
          dailyRequests: 0,
          dailyTokens: 100000,
          dailyCostNanoInr: 100000000000n,
        },
      });
      assert.equal((await f.submit('Question')).statusCode, 429);
      assert.equal(provider.counts.length, 0);
      const unconfigured = { ...f.cfg };
      delete unconfigured.GEMINI_API_KEY;
      const app = buildApp(unconfigured, { logger: false, database: db });
      t.after(() => app.close());
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/conversations/${f.conversationId}/messages`,
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload: { content: 'Question' },
      });
      assert.equal(rejected.statusCode, 503);
    },
  );
  await t.test(
    'oversized provider-counted prompt releases undispatched allowance',
    async (t) => {
      const provider = new Fake();
      provider.tokens = 16001;
      const f = await fixture(t, provider),
        result = AnswerResponseSchema.parse(
          (await f.submit('Synthetic question')).json(),
        );
      assert.equal(result.generation.status, 'failed');
      assert.equal(result.failure?.code, 'VALIDATION_ERROR');
      assert.equal(provider.calls.length, 0);
      assert.equal(provider.counts.length, 1);
      const allowance = await new Storage(db, config).allowance(f.user.id);
      assert.equal(allowance.requestsUsed, 0);
      assert.equal(allowance.tokensReserved, 0n);
      assert.equal(allowance.tokensUsed, 0n);
    },
  );
  await t.test(
    'old complete pairs are trimmed and failed/cancelled answers never enter context',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider),
        storage = new Storage(db, config);
      const make = async (
        content: string,
        status: 'completed' | 'cancelled',
      ) => {
        const r = await storage.reserveGeneration({
          userId: f.user.id,
          conversationId: f.conversationId,
          idempotencyKey: randomUUID(),
          content,
          inputTokenBound: 100,
          outputTokenBound: 100,
        });
        await storage.markDispatched(f.user.id, r.generation.id);
        await storage.settleGeneration({
          userId: f.user.id,
          generationId: r.generation.id,
          status,
          content: `answer:${content}`,
          reportedUsage: {
            inputTokens: 10,
            outputTokens: 10,
            reasoningTokens: 0,
            cachedInputTokens: 0,
          },
        });
      };
      await make('old complete', 'completed');
      await make('excluded cancelled prompt', 'cancelled');
      provider.countTokens = async (turns) => {
        provider.counts.push(structuredClone(turns));
        return turns.length > 1 ? 16001 : 100;
      };
      const result = await f.submit('Newest prompt');
      assert.equal(result.statusCode, 200);
      assert.equal(provider.counts.length, 2);
      assert.ok(!JSON.stringify(provider.counts).includes('cancelled'));
      assert.deepEqual(provider.calls[0], [
        { role: 'user', text: 'Newest prompt' },
      ]);
    },
  );
  await t.test(
    'preflight failures release allowance; dispatched errors retain uncertain charges and no diagnostic text',
    async (t) => {
      const preflight = new Fake();
      preflight.countError = true;
      const before = await fixture(t, preflight);
      const failed = await before.submit('Question');
      assert.equal(failed.json().generation.status, 'failed');
      assert.ok(!failed.body.includes('private synthetic'));
      assert.equal(
        (await new Storage(db, config).allowance(before.user.id)).requestsUsed,
        0,
      );
      const provider = new Fake();
      provider.answerError = true;
      const after = await fixture(t, provider),
        dispatched = await after.submit('Question');
      assert.equal(dispatched.json().usage.accountingStatus, 'uncertain');
      assert.ok(!dispatched.body.includes('private synthetic'));
      const allowance = await new Storage(db, config).allowance(after.user.id);
      assert.equal(allowance.requestsUsed, 1);
      assert.equal(allowance.tokensUsed, 18000n);
    },
  );
  await t.test(
    'missing usage and truncated output are saved honestly and never double-charge on replay',
    async (t) => {
      const provider = new Fake();
      provider.usage = false;
      provider.completed = false;
      const f = await fixture(t, provider),
        key = randomUUID(),
        result = await f.submit('Question', key);
      assert.equal(result.json().generation.status, 'failed');
      assert.equal(result.json().assistantMessage.status, 'failed');
      assert.equal(result.json().usage.accountingStatus, 'uncertain');
      await f.submit('Question', key);
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        1,
      );
    },
  );
  await t.test(
    'overall timeout prevents late completion and conservatively settles dispatched work',
    async (t) => {
      const provider = new Fake();
      provider.answer = async () => new Promise<never>(() => {});
      const f = await fixture(t, provider, {
        GENERATION_TIMEOUT_SECONDS: 1,
        STREAM_IDLE_TIMEOUT_SECONDS: 1,
      });
      const result = await f.submit('Question');
      assert.equal(result.json().failure.code, 'GENERATION_TIMEOUT');
      assert.equal(result.json().usage.accountingStatus, 'uncertain');
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        1,
      );
    },
  );
  await t.test(
    'logout during preflight prevents dispatch and disconnect cancellation consumes no undispatched request',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider);
      provider.countTokens = async () => {
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: f.headers,
          payload: {},
        });
        return 100;
      };
      const result = await f.submit('Question');
      assert.equal(result.statusCode, 401);
      assert.equal(provider.calls.length, 0);
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        0,
      );
      const other = await fixture(t);
      const chat = new Chat(db, config, new Fake());
      const receipt = await chat.submit(
        {
          userId: other.user.id,
          conversationId: other.conversationId,
          idempotencyKey: randomUUID(),
          content: 'Question',
        },
        async () => {},
      );
      chat.disconnect(other.user.id, receipt.generation.id);
      await chat.cancel(other.user.id, receipt.generation.id);
      assert.equal(
        (
          await chat.byKey(
            other.user.id,
            other.conversationId,
            (
              await db.generationRequest.findUniqueOrThrow({
                where: { id: receipt.generation.id },
              })
            ).idempotencyKey,
          )
        ).generation.status,
        'cancelled',
      );
      assert.equal(
        (await new Storage(db, config).allowance(other.user.id)).requestsUsed,
        0,
      );
    },
  );
  await t.test(
    'per-user submission limiter bounds preflight attempts independently of quota',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider, { USER_REQUESTS_PER_MINUTE: 1 });
      assert.equal((await f.submit('First')).statusCode, 200);
      const limited = await f.submit('Second');
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.json().error.code, 'RATE_LIMITED');
      assert.equal(provider.calls.length, 1);
    },
  );
  await t.test(
    'early receipt, owned Stop before attachment, and idempotent repeated Stop',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider),
        stranger = await fixture(t);
      const response = await f.receipt('Do not dispatch');
      assert.equal(response.statusCode, 202);
      const receipt = response.json();
      assert.equal(provider.counts.length, 0);
      assert.equal(provider.calls.length, 0);
      assert.equal(
        (
          await stranger.app.inject({
            url: receipt.eventsUrl,
            headers: stranger.headers,
          })
        ).statusCode,
        404,
      );
      const stop = {
        method: 'POST' as const,
        url: `/api/generations/${receipt.generation.id}/cancel`,
        headers: f.headers,
        payload: {},
      };
      assert.equal(
        (await stranger.app.inject({ ...stop, headers: stranger.headers }))
          .statusCode,
        404,
      );
      for (let n = 0; n < 2; n++)
        assert.equal(
          (await f.app.inject(stop)).json().generation.status,
          'cancelled',
        );
      assert.equal(provider.calls.length, 0);
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        0,
      );
      const replay = await f.app.inject({
        url: receipt.eventsUrl,
        headers: f.headers,
      });
      assert.match(replay.body, /event: cancelled/);
    },
  );
  await t.test(
    'real HTTP delivers partial text before completion; Stop preserves it and racing Stop cannot change completion',
    async (t) => {
      const provider = new Fake();
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      provider.stream = async function* (turns: Turn[]) {
        const result = await this.answer(turns);
        yield { type: 'delta' as const, text: 'Visible partial नमस्ते' };
        await gate;
        yield { type: 'final' as const, ...result };
      };
      const f = await fixture(t, provider);
      const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const receipt = (await f.receipt('Stream slowly')).json();
      const response = await fetch(address + receipt.eventsUrl, {
        headers: f.headers,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('Visible partial')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      assert.ok(!text.includes('event: completed'));
      assert.equal(
        (await f.app.inject({ url: receipt.eventsUrl, headers: f.headers }))
          .statusCode,
        409,
      );
      await f.app.inject({
        method: 'POST',
        url: `/api/generations/${receipt.generation.id}/cancel`,
        headers: f.headers,
        payload: {},
      });
      finish();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      assert.match(text, /event: cancelled/);
      const saved = await f.app.inject({
        url: `/api/conversations/${f.conversationId}/submissions/${receipt.userMessage.generationId ? (await db.generationRequest.findUniqueOrThrow({ where: { id: receipt.generation.id } })).idempotencyKey : ''}`,
        headers: f.headers,
      });
      assert.equal(
        saved.json().assistantMessage.content,
        'Visible partial नमस्ते',
      );
      assert.equal(saved.json().usage.accountingStatus, 'uncertain');
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        1,
      );
      provider.stream = Fake.prototype.stream;
      const done = await f.submit('Complete now');
      const stopped = await f.app.inject({
        method: 'POST',
        url: `/api/generations/${done.json().generation.id}/cancel`,
        headers: f.headers,
        payload: {},
      });
      assert.equal(stopped.json().generation.status, 'completed');
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        2,
      );
    },
  );
  await t.test(
    'socket disconnect cancels dispatched work; shutdown cancels an unattached receipt',
    async (t) => {
      const provider = new Fake();
      provider.stream = async function* () {
        yield { type: 'delta' as const, text: 'Partial' };
        await new Promise<never>(() => {});
      };
      const f = await fixture(t, provider);
      const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const key = randomUUID(),
        receipt = (await f.receipt('Disconnect', key)).json();
      const response = await fetch(address + receipt.eventsUrl, {
        headers: f.headers,
      });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      let saved;
      for (let n = 0; n < 100; n++) {
        saved = await f.app.inject({
          url: `/api/conversations/${f.conversationId}/submissions/${key}`,
          headers: f.headers,
        });
        if (saved.json().generation.status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(saved!.json().generation.status, 'cancelled');
      const second = (await f.receipt('Shutdown')).json();
      await f.app.close();
      assert.equal(
        (
          await db.generationRequest.findUniqueOrThrow({
            where: { id: second.generation.id },
          })
        ).status,
        'cancelled',
      );
    },
  );
  await t.test(
    'admin revocation signals the active upstream operation in the same backend',
    async (t) => {
      const provider = new Fake();
      let upstream: AbortSignal | undefined;
      const streaming: TextProvider = {
        countTokens: provider.countTokens.bind(provider),
        async *stream(_turns, signal) {
          upstream = signal;
          yield { type: 'delta', text: 'Partial before revocation' };
          await new Promise<never>(() => {});
        },
      };
      const f = await fixture(t, streaming),
        admin = await fixture(t);
      await db.user.update({
        where: { id: admin.user.id },
        data: { role: 'admin' },
      });
      const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const receipt = (await f.receipt('Revoke while streaming')).json();
      const response = await fetch(address + receipt.eventsUrl, {
        headers: f.headers,
      });
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('Partial before')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      const changed = await f.app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${f.user.id}/status`,
        headers: admin.headers,
        payload: {
          status: 'revoked',
          expectedVersion: 0,
          reason: 'Synthetic streaming revocation test',
        },
      });
      assert.equal(changed.statusCode, 200);
      assert.equal(upstream?.aborted, true);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      assert.match(text, /event: cancelled/);
      assert.equal(
        (await f.app.inject({ url: '/api/me', headers: f.headers })).statusCode,
        401,
      );
      assert.equal(
        (
          await db.generationRequest.findUniqueOrThrow({
            where: { id: receipt.generation.id },
          })
        ).status,
        'cancelled',
      );
    },
  );
  await t.test(
    'unattached receipt expires without provider calls',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider),
        key = randomUUID();
      await f.receipt('Abandoned receipt', key);
      await new Promise((resolve) => setTimeout(resolve, 15200));
      // Timer expiry initiates asynchronous settlement; observe durable completion
      // rather than assuming the database commits within 200ms under build load.
      const deadline = Date.now() + 10000;
      let status: string | undefined;
      do {
        const saved = await f.app.inject({
          url: `/api/conversations/${f.conversationId}/submissions/${key}`,
          headers: f.headers,
        });
        assert.equal(saved.statusCode, 200);
        status = saved.json().generation.status;
        if (status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      assert.equal(status, 'cancelled');
      assert.equal(provider.counts.length, 0);
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        0,
      );
    },
  );
  await t.test(
    'idle stream failure preserves text; periodic checkpoint survives failed final persistence and recovery',
    async (t) => {
      const provider = new Fake();
      provider.stream = async function* () {
        yield { type: 'delta' as const, text: 'Partial' };
        await new Promise<never>(() => {});
      };
      const f = await fixture(t, provider, { STREAM_IDLE_TIMEOUT_SECONDS: 1 });
      const idle = (await f.submit('Idle')).json();
      assert.equal(idle.generation.status, 'failed');
      assert.equal(idle.failure.code, 'GENERATION_TIMEOUT');
      assert.equal(idle.assistantMessage.content, 'Partial');
      assert.equal(idle.usage.accountingStatus, 'uncertain');
      provider.stream = async function* () {
        yield { type: 'delta' as const, text: 'First' };
        await new Promise((resolve) => setTimeout(resolve, 1100));
        yield { type: 'delta' as const, text: ' checkpoint' };
        yield { type: 'final' as const, completed: true };
      };
      const chat = new Chat(db, config, provider),
        key = randomUUID();
      t.after(() => chat.shutdown());
      chat.storage.settleGeneration = async () => {
        throw new Error('synthetic persistence failure');
      };
      const receipt = await chat.submit(
        {
          userId: f.user.id,
          conversationId: f.conversationId,
          idempotencyKey: key,
          content: 'Checkpoint',
        },
        async () => {},
      );
      const events: string[] = [];
      await (
        await chat.open(f.user.id, receipt.generation.id, randomUUID())
      )(async (e) => {
        events.push(e.type);
      });
      assert.deepEqual(events, ['started', 'delta', 'delta']);
      const partial = await chat.byKey(f.user.id, f.conversationId, key);
      assert.equal(partial.generation.status, 'running');
      assert.equal(partial.assistantMessage.content, 'First checkpoint');
      await new Storage(
        db,
        config,
        () => new Date(Date.now() + 180000),
      ).recoverExpired();
      const recovered = await chat.byKey(f.user.id, f.conversationId, key);
      assert.equal(recovered.generation.status, 'interrupted');
      assert.equal(recovered.assistantMessage.content, 'First checkpoint');
      assert.equal(recovered.usage?.accountingStatus, 'uncertain');
    },
  );
  await t.test(
    'three dispatched provider failures open cooldown without quota bypass; replay/history/liveness remain available',
    async (t) => {
      const provider = new Fake();
      provider.answerError = true;
      const f = await fixture(t, provider),
        keys = [randomUUID(), randomUUID(), randomUUID()];
      for (const key of keys) {
        const result = await f.submit('Synthetic outage', key);
        assert.equal(result.json().generation.status, 'failed');
        assert.equal(result.json().usage.accountingStatus, 'uncertain');
        assert.ok(!result.body.includes('private synthetic'));
      }
      assert.equal(provider.calls.length, 3);
      const before = await db.generationRequest.count({
        where: { userId: f.user.id },
      });
      const blocked = await f.submit('Blocked during cooldown');
      assert.equal(blocked.statusCode, 503);
      assert.equal(blocked.json().error.code, 'PROVIDER_UNAVAILABLE');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      assert.equal(
        await db.generationRequest.count({ where: { userId: f.user.id } }),
        before,
      );
      assert.equal(provider.calls.length, 3);
      const replay = await f.submit('Synthetic outage', keys[0]);
      assert.equal(replay.json().replayed, true);
      assert.equal(provider.calls.length, 3);
      const ready = await f.app.inject('/health/ready');
      assert.equal(ready.statusCode, 503);
      assert.equal(ready.json().checks.database, true);
      assert.equal(ready.json().checks.application, false);
      assert.equal((await f.app.inject('/health/live')).statusCode, 200);
      const me = await f.app.inject({ url: '/api/me', headers: f.headers });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().allowance.generationAvailable, false);
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        3,
      );
    },
  );
  await t.test(
    'database failures at dispatch/checkpoint fail closed and never become provider cooldown failures',
    async (t) => {
      const provider = new Fake(),
        f = await fixture(t, provider);
      const records: { category: string; phase: string }[] = [];
      const chat = new Chat(db, config, provider, (event) =>
        records.push(event),
      );
      t.after(() => chat.shutdown());
      const original = chat.storage.markDispatched.bind(chat.storage);
      chat.storage.markDispatched = async () => {
        throw new AppError('STORAGE_UNAVAILABLE', 'Storage is unavailable.');
      };
      const firstKey = randomUUID();
      const first = await chat.submit(
        {
          userId: f.user.id,
          conversationId: f.conversationId,
          idempotencyKey: firstKey,
          content: 'Dispatch unavailable',
        },
        async () => {},
      );
      await (
        await chat.open(f.user.id, first.generation.id, randomUUID())
      )(async () => {});
      assert.equal(provider.calls.length, 0);
      assert.equal(
        (await chat.byKey(f.user.id, f.conversationId, firstKey)).usage
          ?.inputTokens,
        0,
      );
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        0,
      );
      chat.storage.markDispatched = original;
      provider.stream = async function* () {
        yield { type: 'delta' as const, text: 'Visible partial' };
        await new Promise((resolve) => setTimeout(resolve, 1100));
        yield { type: 'delta' as const, text: ' checkpoint' };
        await new Promise<never>(() => {});
      };
      chat.storage.checkpoint = async () => {
        throw new AppError('STORAGE_UNAVAILABLE', 'Storage is unavailable.');
      };
      const key = randomUUID();
      const receipt = await chat.submit(
        {
          userId: f.user.id,
          conversationId: f.conversationId,
          idempotencyKey: key,
          content: 'Checkpoint unavailable',
        },
        async () => {},
      );
      const events: string[] = [];
      await (
        await chat.open(f.user.id, receipt.generation.id, randomUUID())
      )(async (e) => {
        events.push(e.type);
      });
      assert.equal(events.at(-1), 'error');
      const result = await chat.byKey(f.user.id, f.conversationId, key);
      assert.equal(result.generation.status, 'failed');
      assert.equal(result.failure?.code, 'STORAGE_UNAVAILABLE');
      assert.equal(
        result.assistantMessage.content,
        'Visible partial checkpoint',
      );
      assert.equal(result.usage?.accountingStatus, 'uncertain');
      assert.equal(chat.cooldown.available, true);
      assert.ok(
        records.some((event) => event.category === 'STORAGE_UNAVAILABLE'),
      );
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        1,
      );
    },
  );
  await t.test(
    'stream/recovery burst limits do not exhaust the separate Stop allowance',
    async (t) => {
      const f = await fixture(t),
        key = randomUUID();
      const result = await f.submit('Completed for replay', key),
        id = result.json().generation.id;
      for (let n = 1; n < 20; n++)
        assert.equal(
          (
            await f.app.inject({
              url: `/api/generations/${id}/events`,
              headers: f.headers,
            })
          ).statusCode,
          200,
        );
      const limited = await f.app.inject({
        url: `/api/generations/${id}/events`,
        headers: f.headers,
      });
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const stop = await f.app.inject({
        method: 'POST',
        url: `/api/generations/${id}/cancel`,
        headers: f.headers,
        payload: {},
      });
      assert.equal(stop.statusCode, 200);
      assert.equal(stop.json().generation.status, 'completed');
      for (let n = 1; n < 60; n++)
        assert.equal(
          (
            await f.app.inject({
              url: `/api/conversations/${f.conversationId}/submissions/${key}`,
              headers: f.headers,
            })
          ).statusCode,
          200,
        );
      assert.equal(
        (
          await f.app.inject({
            url: `/api/conversations/${f.conversationId}/submissions/${key}`,
            headers: f.headers,
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (await new Storage(db, config).allowance(f.user.id)).requestsUsed,
        1,
      );
    },
  );
  await t.test(
    'application close aborts an attached stalled provider and persists terminal accounting within the shutdown bound',
    async (t) => {
      const f = await fixture(t, {
        async countTokens() {
          return 100;
        },
        async *stream() {
          yield { type: 'delta', text: 'Before shutdown' };
          await new Promise<never>(() => {});
        },
      });
      const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const receipt = (await f.receipt('Shut down attached stream')).json();
      const response = await fetch(address + receipt.eventsUrl, {
        headers: f.headers,
      });
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('Before shutdown')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      const started = Date.now();
      const closing = f.app.close();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += new TextDecoder().decode(chunk.value);
        }
      } catch {
        /* Transport close may win after durable settlement. */
      }
      await closing;
      assert.ok(Date.now() - started < 5000);
      const saved = await db.generationRequest.findUniqueOrThrow({
        where: { id: receipt.generation.id },
        include: { usage: true, messages: true },
      });
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.usage?.accountingStatus, 'uncertain');
      assert.equal(
        saved.messages.find((m) => m.role === 'assistant')?.content,
        'Before shutdown',
      );
    },
  );
  await t.test(
    'real Gemini question and follow-up persist across a fresh app instance',
    { skip: process.env.QUERY_ASSISTANT_VERIFY_GEMINI !== '1' },
    async (t) => {
      loadEnv({ path: '.env', quiet: true });
      const live = parseConfig({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url,
        JWT_SIGNING_KEY: config.JWT_SIGNING_KEY,
        MAX_OUTPUT_TOKENS: '128',
        ACCOUNTING_INR_PER_USD: '100',
        PRICE_VERSION: 'live-step6-inr100-v1',
      });
      assert.ok(
        live.GEMINI_API_KEY,
        'Save GEMINI_API_KEY in backend/.env before the live check.',
      );
      const f = await fixture(t, new GeminiProvider(live), live);
      const code = `ORCHID_${randomUUID().slice(0, 8)}`;
      const first = await f.submit(
        `Remember the code ${code}. Reply only with Saved.`,
      );
      assert.equal(first.statusCode, 200);
      assert.equal(
        first.json().generation.status,
        'completed',
        'Live first answer was not complete.',
      );
      const second = await f.submit(
        'What was the code I asked you to remember? Reply only with that exact code.',
      );
      assert.equal(second.statusCode, 200);
      assert.equal(
        second.json().generation.status,
        'completed',
        'Live follow-up was not complete.',
      );
      assert.ok(
        second.json().assistantMessage.content.includes(code),
        'Live follow-up did not recall the saved synthetic code.',
      );
      assert.equal(second.json().usage.accountingStatus, 'reported');
      const fresh: FastifyInstance = buildApp(f.cfg, {
        logger: false,
        database: db,
        provider: new GeminiProvider(live),
      });
      t.after(() => fresh.close());
      const saved = await fresh.inject({
        url: `/api/conversations/${f.conversationId}/messages`,
        headers: f.headers,
      });
      assert.equal(saved.json().items.length, 4);
      console.log(
        `Live Gemini verification passed: two dispatched generations; estimated INR usage ${first.json().usage.estimatedCost.amount} + ${second.json().usage.estimatedCost.amount}. Provider invoice cost is not reported.`,
      );
    },
  );
});
