import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerateContentResponse } from '@google/genai';
import { GeminiProvider, normalizeAnswer, normalizeUsage } from './gemini.js';
import { abortable, providerFailure, systemInstruction } from './provider.js';
import { parseConfig } from '../config.js';

const config = parseConfig({
  GEMINI_API_KEY: 'synthetic-test-key-not-a-credential',
});
const response = (value: object) =>
  Object.assign(new GenerateContentResponse(), value);
const usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 40,
  thoughtsTokenCount: 10,
  cachedContentTokenCount: 20,
  totalTokenCount: 150,
};

test('Gemini normalization counts visible output, thinking, and cached input once', () => {
  assert.deepEqual(normalizeUsage(usage), {
    inputTokens: 100,
    outputTokens: 40,
    reasoningTokens: 10,
    cachedInputTokens: 20,
  });
  for (const invalid of [
    {},
    { ...usage, totalTokenCount: 140 },
    { ...usage, cachedContentTokenCount: 101 },
    { ...usage, thoughtsTokenCount: -1 },
    { ...usage, promptTokenCount: NaN },
    { ...usage, toolUsePromptTokenCount: 1 },
  ]) {
    assert.equal(normalizeUsage(invalid), undefined);
  }
  assert.equal(normalizeUsage(undefined), undefined);
});

test('only finished visible text is complete; safety, tool output and truncation stay distinct', () => {
  const complete = normalizeAnswer(
    response({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'private thought', thought: true },
              { text: 'Visible answer' },
            ],
          },
        },
      ],
      usageMetadata: usage,
      responseId: 'provider-test-id',
    }),
  );
  assert.equal(complete.content, 'Visible answer');
  assert.equal(complete.completed, true);
  assert.equal(complete.providerRequestId, 'provider-test-id');
  const truncated = normalizeAnswer(
    response({
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ text: 'Partial' }] },
        },
      ],
    }),
  );
  assert.equal(truncated.completed, false);
  assert.equal(truncated.content, 'Partial');
  for (const candidate of [
    { finishReason: 'SAFETY', content: { parts: [{ text: 'blocked text' }] } },
    {
      finishReason: 'STOP',
      content: { parts: [{ functionCall: { name: 'unsafe' } }] },
    },
    { finishReason: 'STOP', content: { parts: [] } },
  ]) {
    const result = normalizeAnswer(response({ candidates: [candidate] }));
    assert.equal(result.completed, false);
    assert.equal(result.content, '');
  }
});

test('SDK transport sends only server settings and disables retry and continuation', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify(
        String(url).includes('countTokens')
          ? { totalTokens: 100 }
          : {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: { parts: [{ text: 'Test answer' }] },
                },
              ],
              usageMetadata: usage,
            },
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const provider = new GeminiProvider(config, fetcher);
  const turns = [{ role: 'user' as const, text: 'Synthetic question' }];
  const signal = new AbortController().signal;
  assert.equal(await provider.countTokens(turns, signal), 100);
  assert.equal((await provider.answer(turns, signal)).completed, true);
  assert.equal(calls.length, 2);
  assert.ok(
    JSON.stringify(calls[0]!.body.generateContentRequest).includes(
      systemInstruction,
    ),
  );
  assert.equal(calls[0]!.body.contents, undefined);
  const body = calls[1]!.body;
  assert.deepEqual(body.generationConfig, {
    candidateCount: 1,
    maxOutputTokens: 2000,
    thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false },
  });
  assert.equal(body.serviceTier, 'standard');
  assert.equal(body.store, false);
  assert.ok(JSON.stringify(body.systemInstruction).includes(systemInstruction));
  assert.equal(body.tools, undefined);
  assert.ok(calls.every((call) => !call.url.includes('synthetic-test-key')));
});

test('a failing SDK request is attempted once and private diagnostics are not exposed', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          code: 503,
          message: 'synthetic private diagnostics',
          status: 'UNAVAILABLE',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    await new GeminiProvider(config, fetcher).answer(
      [{ role: 'user', text: 'Synthetic' }],
      new AbortController().signal,
    );
    assert.fail('Expected failure');
  } catch (error) {
    assert.equal(providerFailure(error).code, 'PROVIDER_UNAVAILABLE');
    assert.ok(!providerFailure(error).message.includes('private'));
  }
  assert.equal(calls, 1);
});

test('aborted waits finish promptly even when a test provider ignores the signal', async () => {
  const controller = new AbortController();
  const wait = abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort(new Error('synthetic abort'));
  await assert.rejects(wait, /synthetic abort/);
});

test('provider continuation never starts an extra billed request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'CONTINUATION',
            content: { parts: [{ text: 'Unfinished' }] },
          },
        ],
        continuationToken: 'synthetic-continuation',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const result = await new GeminiProvider(config, fetcher).answer(
    [{ role: 'user', text: 'Synthetic' }],
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.completed, false);
});

test('SDK streaming forwards deltas, ignores thoughts, and waits for final metadata', async () => {
  let calls = 0;
  const chunks = [
    {
      candidates: [
        {
          content: {
            parts: [{ text: 'hidden', thought: true }, { text: 'Hello ' }],
          },
        },
      ],
    },
    {
      candidates: [
        { finishReason: 'STOP', content: { parts: [{ text: 'नमस्ते' }] } },
      ],
    },
    { usageMetadata: usage, responseId: 'synthetic-stream' },
  ];
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.match(String(url), /streamGenerateContent/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    assert.equal(body.store, false);
    return new Response(
      chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const events = [];
  for await (const event of new GeminiProvider(config, fetcher).stream(
    [{ role: 'user', text: 'test' }],
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((e) => e.type),
    ['delta', 'delta', 'final'],
  );
  assert.equal(events[0]?.type === 'delta' && events[0].text, 'Hello ');
  assert.equal(events[2]?.type === 'final' && events[2].completed, true);
  assert.deepEqual(
    events[2]?.type === 'final' && events[2].usage,
    normalizeUsage(usage),
  );
});

test('SDK stream EOF without a finish reason is never success', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  await assert.rejects(async () => {
    for await (const event of new GeminiProvider(config, fetcher).stream(
      [{ role: 'user', text: 'test' }],
      new AbortController().signal,
    ))
      assert.equal(event.type, 'delta');
  }, /without a final outcome/);
});

test('SSE writer waits for drain and releases listeners on drain or disconnect', async () => {
  const { EventEmitter } = await import('node:events');
  const { writeEvent } = await import('./sse.js');
  for (const outcome of ['drain', 'close']) {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: () => false,
    });
    let settled = false;
    const writing = writeEvent(
      socket as unknown as import('node:http').ServerResponse,
      {
        type: 'delta',
        generationId: '550e8400-e29b-41d4-a716-446655440000',
        text: 'partial',
      },
    );
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);
    socket.emit(outcome);
    if (outcome === 'drain') await writing;
    else await assert.rejects(writing);
    assert.equal(socket.listenerCount('drain'), 0);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(socket.listenerCount('error'), 0);
  }
});

test('provider header deadline aborts ignored fetch waits and Retry-After parsing is bounded', async () => {
  const { headerDeadline, retryAfter, ProviderHttpError } =
    await import('./resilience.js');
  let signal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<never>(() => {});
  };
  await assert.rejects(
    headerDeadline(fetcher, 10)('https://example.invalid'),
    /connection timed out/,
  );
  assert.equal(signal?.aborted, true);
  assert.equal(retryAfter('45'), 45);
  assert.equal(retryAfter('9999999'), 86400);
  assert.equal(retryAfter('garbage'), undefined);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60);
  await assert.rejects(
    headerDeadline(
      async () =>
        new Response('PRIVATE_DIAGNOSTIC', {
          status: 429,
          headers: { 'retry-after': '45' },
        }),
    )('https://example.invalid'),
    (error: unknown) =>
      error instanceof ProviderHttpError &&
      error.status === 429 &&
      error.retryAfterSeconds === 45 &&
      !error.message.includes('PRIVATE'),
  );
});
test('cooldown opens after three transient failures, honors guidance, and recovers without automatic probes', async () => {
  const { ProviderCooldown, ProviderHttpError } =
    await import('./resilience.js');
  let now = 0;
  const gate = new ProviderCooldown(() => now);
  gate.failure(new ProviderHttpError(503));
  gate.success();
  gate.failure(new ProviderHttpError(503));
  gate.failure(new ProviderHttpError(503));
  assert.equal(gate.available, true);
  gate.failure(new ProviderHttpError(401));
  assert.equal(gate.available, true);
  gate.failure(new ProviderHttpError(503));
  assert.equal(gate.available, false);
  assert.throws(() => gate.ensure(), /cooling down/);
  gate.success();
  assert.equal(gate.available, false);
  now = 30000;
  gate.ensure();
  gate.success();
  assert.equal(gate.remaining, 0);
  gate.failure(new ProviderHttpError(429, 60));
  assert.equal(gate.remaining, 60);
  now += 60000;
  gate.ensure();
  gate.success();
  assert.equal(gate.available, true);
});

test('shutdown closes admission before touching storage', async () => {
  const { Chat } = await import('./service.js');
  const chat = new Chat(
    {} as import('../storage/database.js').Database,
    config,
    {
      async countTokens() {
        throw new Error('must not run');
      },
      async *stream() {
        throw new Error('must not run');
        yield { type: 'delta' as const, text: '' };
      },
    },
  );
  await chat.shutdown();
  assert.equal(chat.available, false);
  await assert.rejects(
    chat.submit(
      { userId: '', conversationId: '', idempotencyKey: '', content: '' },
      async () => {},
    ),
    /shutting down/,
  );
});
