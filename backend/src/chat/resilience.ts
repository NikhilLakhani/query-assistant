import { AppError } from '../errors.js';
import { abortable } from './provider.js';

export class ProviderHttpError extends AppError {
  constructor(
    public readonly status: number,
    retryAfter?: number,
  ) {
    super(
      'PROVIDER_UNAVAILABLE',
      'The model service is temporarily unavailable. Check saved history before submitting again.',
      retryAfter,
    );
  }
}
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : (Date.parse(value) - now) / 1000;
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.min(86400, Math.ceil(seconds));
}

// Deadline to response headers, including DNS/TCP/TLS. Stream reads have their
// separate idle and total deadlines. The same wrapper is used by SDK and REST.
export function headerDeadline(
  fetcher: typeof fetch,
  milliseconds = 10000,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(init?.signal ? [init.signal] : []),
    ]);
    const timer = setTimeout(
      () =>
        controller.abort(
          new AppError('GENERATION_TIMEOUT', 'The model connection timed out.'),
        ),
      milliseconds,
    );
    try {
      const response = await abortable(
        fetcher(input, { ...init, signal }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ProviderHttpError(
          response.status,
          retryAfter(response.headers.get('retry-after')),
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Single-instance cooldown, no automatic probes or retries. */
export class ProviderCooldown {
  private failures = 0;
  private until = 0;
  constructor(private readonly now = () => Date.now()) {}
  get available() {
    return this.now() >= this.until;
  }
  get remaining() {
    return Math.max(0, Math.ceil((this.until - this.now()) / 1000));
  }
  ensure() {
    if (!this.available)
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The model service is cooling down. Check saved history and try later.',
        this.remaining,
      );
  }
  success() {
    // A previously dispatched request cannot close an already-open cooldown.
    if (this.available) {
      this.failures = 0;
      this.until = 0;
    }
  }
  failure(error: unknown) {
    const transient =
      error instanceof ProviderHttpError
        ? error.status === 429 || error.status >= 500
        : !(error instanceof AppError) ||
          ['PROVIDER_UNAVAILABLE', 'GENERATION_TIMEOUT'].includes(error.code);
    if (!transient) return;
    if (this.available && this.until) {
      this.failures = 0;
      this.until = 0;
    }
    this.failures++;
    const guidance =
      error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined;
    if (this.failures >= 3 || guidance) {
      this.until = Math.max(
        this.until,
        this.now() + Math.max(30, guidance ?? 0) * 1000,
      );
      this.failures = 0;
    }
  }
}
