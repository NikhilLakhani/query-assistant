import { z } from 'zod';
import { ApiErrorSchema, CsrfResponseSchema } from '@query-assistant/contracts';
import { config } from './config';
import { consumeSse } from './sse';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: z.infer<typeof ApiErrorSchema> | null,
  ) {
    super(
      detail?.error.message ??
        'The service could not be reached. Please try again.',
    );
  }
}

// No implicit retry, especially after an ambiguous paid submission.
export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson(path, schema, { method: 'GET' }, signal);
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit,
  signal?: AbortSignal,
  timeout = 10000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: { Accept: 'application/json', ...init.headers },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ApiRequestError(0, null);
  }
  const body: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new ApiRequestError(
      response.status,
      parsed.success ? parsed.data : null,
    );
  }
  return schema.parse(body);
}

export async function mutateJson<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  schema: z.ZodType<T>,
  idempotencyKey?: string,
): Promise<T> {
  // Fetch a token for the CURRENT cookie, including after login/activation.
  const { csrfToken } = await getJson('/api/auth/csrf', CsrfResponseSchema);
  return requestJson(
    path,
    schema,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
    undefined,
    idempotencyKey ? 110000 : 10000,
  );
}

export async function streamAnswer(
  path: string,
  receive: (event: import('./sse').StreamEvent) => void,
  signal: AbortSignal,
) {
  if (!/^\/api\/generations\/[0-9a-f-]+\/events$/.test(path))
    throw new Error('Invalid stream URL');
  const { csrfToken } = await getJson(
    '/api/auth/csrf',
    CsrfResponseSchema,
    signal,
  );
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'X-CSRF-Token': csrfToken },
    signal: AbortSignal.any([signal, AbortSignal.timeout(110000)]),
  });
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(
      await response.json().catch(() => null),
    );
    throw new ApiRequestError(
      response.status,
      parsed.success ? parsed.data : null,
    );
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.startsWith('text/event-stream')
  )
    throw new Error('Invalid stream response');
  await consumeSse(response.body, receive, signal);
}
