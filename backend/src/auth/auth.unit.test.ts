import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SignJWT } from 'jose';
import { parseConfig } from '../config.js';
import { Tokens } from './tokens.js';
import { hashPassword, verifyPassword } from './password.js';
import { AppError } from '../errors.js';
import { AuthRateLimit } from './rate-limit.js';
import { encodeCursor, decodeCursor } from './pagination.js';

const config = parseConfig({
  JWT_SIGNING_KEY: 'synthetic-test-signing-material-never-a-real-key',
});
const now = new Date('2026-10-30T12:00:00Z');
const tokens = new Tokens(config, () => now);
const key = new TextEncoder().encode(config.JWT_SIGNING_KEY);

test('JWT verification rejects missing, malformed, expired, wrong-key/issuer/audience/algorithm tokens', async () => {
  const subject = randomUUID(),
    session = randomUUID();
  const valid = await tokens.sign(
    session,
    subject,
    new Date(now.getTime() + 3600000),
  );
  assert.equal((await tokens.verify(valid)).sub, subject);
  const make = (
    options: {
      alg?: string;
      issuer?: string;
      audience?: string;
      expiry?: number;
      signingKey?: Uint8Array;
      missingExpiry?: boolean;
    } = {},
  ) => {
    let jwt = new SignJWT({})
      .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
      .setSubject(subject)
      .setJti(session)
      .setIssuer(options.issuer ?? config.JWT_ISSUER)
      .setAudience(options.audience ?? config.JWT_AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000));
    if (!options.missingExpiry)
      jwt = jwt.setExpirationTime(
        options.expiry ?? Math.floor(now.getTime() / 1000) + 3600,
      );
    return jwt.sign(options.signingKey ?? key);
  };
  for (const bad of [
    undefined,
    'not-a-jwt',
    await make({ issuer: 'wrong' }),
    await make({ audience: 'wrong' }),
    await make({ expiry: Math.floor(now.getTime() / 1000) - 1 }),
    await make({
      signingKey: new TextEncoder().encode(
        'another-synthetic-test-signing-key-material',
      ),
    }),
    await make({ alg: 'HS384' }),
    await make({ missingExpiry: true }),
    await make({ expiry: Math.floor(now.getTime() / 1000) + 86400 }),
  ]) {
    await assert.rejects(
      tokens.verify(bad),
      (error) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
    );
  }
});
test('Argon2id uses salted hashes and verifies exact untrimmed passwords', async () => {
  const password = ' synthetic-test-only-password ';
  const a = await hashPassword(password),
    b = await hashPassword(password);
  assert.ok(a.startsWith('$argon2id$'));
  assert.notEqual(a, b);
  assert.ok(!a.includes(password));
  assert.equal(await verifyPassword(a, password), true);
  assert.equal(await verifyPassword(a, password.trim()), false);
  assert.equal(await verifyPassword(undefined, password), false);
});
test('auth burst limits are bounded and expire; malformed and wrong-scope cursors fail', () => {
  const limiter = new AuthRateLimit();
  for (let i = 0; i < 30; i++) limiter.take('local-test', 0);
  assert.throws(
    () => limiter.take('local-test', 1),
    (error) => error instanceof AppError && error.code === 'RATE_LIMITED',
  );
  limiter.take('local-test', 60000);
  const cursor = encodeCursor('test', { id: randomUUID(), at: now });
  assert.equal(decodeCursor(cursor, 'test')?.scope, 'test');
  assert.throws(() => decodeCursor(cursor, 'another-scope'));
  assert.throws(() => decodeCursor('not-json', 'test'));
});
