import { z } from 'zod';
import { IdSchema, TimestampSchema } from '@query-assistant/contracts';
import { AppError } from '../errors.js';

const CursorSchema = z.strictObject({
  scope: z.string().max(200),
  id: IdSchema,
  at: TimestampSchema,
  sequence: z.number().int().positive().optional(),
});
export function decodeCursor(cursor: string | undefined, scope: string) {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 512) throw new Error('Too long');
    const value = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (value.scope !== scope) throw new Error('Wrong cursor scope');
    return value;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'The page cursor is invalid.');
  }
}
export function encodeCursor(
  scope: string,
  item: { id: string; at: Date; sequence?: number },
) {
  return Buffer.from(
    JSON.stringify({
      scope,
      id: item.id,
      at: item.at.toISOString(),
      ...(item.sequence !== undefined ? { sequence: item.sequence } : {}),
    }),
  ).toString('base64url');
}
export function beforeDate(cursor: ReturnType<typeof decodeCursor>) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { lt: cursor.id } },
        ],
      }
    : {};
}
