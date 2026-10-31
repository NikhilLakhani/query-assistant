import { StreamEventSchema } from '@query-assistant/contracts';
import type { z } from 'zod';
export type StreamEvent = z.infer<typeof StreamEventSchema>;

// A byte chunk is not an event or even a complete Unicode character.
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  receive: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let data: string[] = [],
    name = '',
    size = 0,
    terminal = false;
  const frame = () => {
    if (!data.length) {
      name = '';
      size = 0;
      return;
    }
    if (terminal) throw new Error('Data after terminal event');
    const event = StreamEventSchema.parse(JSON.parse(data.join('\n')));
    if (name && name !== event.type) throw new Error('Event type mismatch');
    terminal = ['completed', 'cancelled', 'error'].includes(event.type);
    receive(event);
    data = [];
    name = '';
    size = 0;
  };
  const line = (value: string) => {
    if (!value) {
      frame();
      return;
    }
    size += value.length;
    if (size > 1048576) throw new Error('Stream frame too large');
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let text = colon < 0 ? '' : value.slice(colon + 1);
    if (text.startsWith(' ')) text = text.slice(1);
    if (field === 'data') data.push(text);
    if (field === 'event') name = text;
  };
  let pieces: string[] = [],
    lineSize = 0,
    skipLf = false;
  const segment = (value: string) => {
    lineSize += value.length;
    if (lineSize + size > 1048576 || pieces.length > 1048576)
      throw new Error('Stream frame too large');
    if (value) pieces.push(value);
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const reading = reader.read();
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error('Aborted'));
          const timer = setTimeout(
            () => reject(new Error('Stream idle timeout')),
            25000,
          );
          signal?.addEventListener('abort', abort, { once: true });
          reading.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          });
        },
      );
      let decoded = next.done
        ? decoder.decode()
        : decoder.decode(next.value, { stream: true });
      if (skipLf && decoded) {
        if (decoded[0] === '\n') decoded = decoded.slice(1);
        skipLf = false;
      }
      const separators = /\r\n|\r|\n/g;
      let start = 0,
        match: RegExpExecArray | null;
      while ((match = separators.exec(decoded))) {
        segment(decoded.slice(start, match.index));
        line(pieces.join(''));
        pieces = [];
        lineSize = 0;
        start = match.index + match[0].length;
        skipLf = match[0] === '\r' && start === decoded.length;
      }
      segment(decoded.slice(start));
      if (next.done) {
        if (lineSize || data.length || !terminal)
          throw new Error('Incomplete stream; check saved history');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
