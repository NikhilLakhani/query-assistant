import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

type Resolver = (hostname: string) => Promise<readonly { address: string }[]>;
const normalize = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/** Trust only the configured proxy's resolved socket addresses, never arbitrary headers. */
export class ProxyClientAddress {
  private addresses = new Set<string>();
  private expires = 0;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly hostname?: string,
    private readonly resolve: Resolver = (host) => lookup(host, { all: true }),
  ) {}
  async key(request: FastifyRequest): Promise<string> {
    if (!this.hostname) return request.ip;
    if (Date.now() >= this.expires) {
      this.pending ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const rows = await Promise.race([
            this.resolve(this.hostname!),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Proxy lookup timeout')),
                1000,
              );
            }),
          ]);
          this.addresses = new Set(rows.map((row) => normalize(row.address)));
        } catch {
          this.addresses.clear();
        } finally {
          clearTimeout(timer);
          this.expires = Date.now() + 5000;
        }
      })();
      await this.pending;
      this.pending = undefined;
    }
    if (!this.addresses.size)
      throw new AppError(
        'SERVICE_NOT_READY',
        'The authentication proxy is unavailable. Try again shortly.',
      );
    const peer = normalize(request.raw.socket.remoteAddress ?? request.ip);
    if (!this.addresses.has(peer)) return request.ip;
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !isIP(forwarded.trim()))
      throw new AppError('VALIDATION_ERROR', 'Invalid proxy client address.');
    return normalize(forwarded.trim());
  }
}
