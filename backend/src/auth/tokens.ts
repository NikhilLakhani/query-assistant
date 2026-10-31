import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { IdSchema } from '@query-assistant/contracts';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export const SESSION_SECONDS = 8 * 3600;
export const ANONYMOUS_SECONDS = 15 * 60;
const ClaimsSchema = z.object({
  sub: z.union([IdSchema, z.literal('anonymous')]),
  jti: IdSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function equalDigest(left: string, right: string): boolean {
  return (
    left.length === right.length &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

export class Tokens {
  private readonly key: Uint8Array;
  private readonly csrfKey: Buffer;
  constructor(
    private readonly config: Config,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.JWT_SIGNING_KEY)
      throw new AppError(
        'SERVICE_NOT_READY',
        'Authentication is not configured.',
      );
    this.key = new TextEncoder().encode(config.JWT_SIGNING_KEY);
    this.csrfKey = createHmac('sha256', this.key)
      .update('query-assistant:csrf:v1')
      .digest();
  }

  csrf(sessionId: string): string {
    return createHmac('sha256', this.csrfKey)
      .update(sessionId)
      .digest('base64url');
  }

  sign(sessionId: string, userId: string | null, expiresAt: Date) {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setSubject(userId ?? 'anonymous')
      .setJti(sessionId)
      .setIssuedAt(Math.floor(this.now().getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
  }

  async verify(token: string | undefined) {
    if (!token || token.length > 4096)
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        typ: 'JWT',
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
        maxTokenAge: SESSION_SECONDS,
        clockTolerance: 0,
        currentDate: this.now(),
      });
      const claims = ClaimsSchema.parse(payload);
      if (claims.exp <= claims.iat || claims.exp - claims.iat > SESSION_SECONDS)
        throw new Error('Invalid lifetime');
      return claims;
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    }
  }
}
