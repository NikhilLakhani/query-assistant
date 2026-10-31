import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { PasswordSchema } from '@query-assistant/contracts';
import { AppError } from '../errors.js';

const options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;
let hashing = 0;
let dummy: Promise<string> | undefined;

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (hashing >= 4)
    throw new AppError(
      'RATE_LIMITED',
      'Authentication is busy. Try again shortly.',
      2,
    );
  hashing++;
  try {
    return await work();
  } finally {
    hashing--;
  }
}

export function hashPassword(password: string): Promise<string> {
  PasswordSchema.parse(password);
  return bounded(() => argon2.hash(password, options));
}

export function preparePasswordVerification(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummy;
}

export async function verifyPassword(
  hash: string | undefined,
  password: string,
): Promise<boolean> {
  const dummyHash = await preparePasswordVerification();
  const valid = await bounded(async () => {
    try {
      return await argon2.verify(hash ?? dummyHash, password);
    } catch {
      return false;
    }
  });
  return Boolean(hash && valid);
}
