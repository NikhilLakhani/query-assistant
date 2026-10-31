import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSse } from './sse';
const id = '550e8400-e29b-41d4-a716-446655440000';
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  accountingStatus: 'reported',
  estimatedCost: null,
  providerReportedCost: null,
  priceVersion: 'test',
};
const delta = { type: 'delta', generationId: id, text: 'नमस्ते 😄' };
const end = { type: 'completed', generationId: id, usage };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function bytes(text: string) {
  const input = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i === input.length) c.close();
      else c.enqueue(input.slice(i, ++i));
    },
  });
}
test('SSE handles one-byte Unicode, split CRLF, comments and multiline JSON', async () => {
  const events: unknown[] = [];
  await consumeSse(
    bytes(
      ': hello\r\n\r\nevent: delta\r\ndata: {\r\ndata: ' +
        JSON.stringify(delta).slice(1) +
        '\r\n\r\n' +
        frame(end),
    ),
    (e) => events.push(e),
  );
  assert.deepEqual(events, [delta, end]);
});
test('SSE rejects invalid, incomplete, mismatched, oversized and duplicate terminal events', async () => {
  for (const input of [
    frame(delta),
    'data: nope\n\n',
    'event: error\n' + frame(delta),
    frame(end) + frame(end),
    frame({ type: 'unknown' }),
    'data: ' + 'x'.repeat(1048577),
  ]) {
    await assert.rejects(
      consumeSse(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(input));
            c.close();
          },
        }),
        () => {},
      ),
    );
  }
});
test('SSE cancellation stops a waiting reader', async () => {
  const controller = new AbortController();
  const promise = consumeSse(
    new ReadableStream({}),
    () => {},
    controller.signal,
  );
  controller.abort();
  await assert.rejects(promise);
});

test('SSE rejects malformed UTF-8 rather than replacing damaged text', async () => {
  await assert.rejects(
    consumeSse(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([0xc3, 0x28]));
          c.close();
        },
      }),
      () => {},
    ),
  );
});
