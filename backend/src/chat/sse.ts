import type { ServerResponse } from 'node:http';
import { StreamEventSchema } from '@query-assistant/contracts';
import type { z } from 'zod';
import { AppError } from '../errors.js';

export async function writeEvent(
  response: ServerResponse,
  event: z.infer<typeof StreamEventSchema>,
) {
  const value = StreamEventSchema.parse(event);
  if (response.destroyed || response.writableEnded)
    throw new AppError('PROVIDER_UNAVAILABLE', 'The stream connection closed.');
  if (
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  )
    return;
  // One awaited write at a time: no unbounded per-subscriber queue. A client
  // which stops reading cannot hold a generation slot indefinitely.
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      response.off('drain', drain);
      response.off('close', close);
      response.off('error', close);
    };
    const drain = () => {
      clear();
      resolve();
    };
    const close = () => {
      clear();
      reject(
        new AppError('PROVIDER_UNAVAILABLE', 'The stream connection closed.'),
      );
    };
    const timer = setTimeout(() => {
      clear();
      reject(
        new AppError(
          'PROVIDER_UNAVAILABLE',
          'The stream client is not reading.',
        ),
      );
    }, 5000);
    response.once('drain', drain);
    response.once('close', close);
    response.once('error', close);
  });
}
