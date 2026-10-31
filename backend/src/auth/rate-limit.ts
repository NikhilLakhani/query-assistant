import { AppError } from '../errors.js';

/** Single-process protection for public auth routes; durable quotas live in DB. */
export class AuthRateLimit {
  private buckets = new Map<string, { count: number; expires: number }>();
  constructor(private readonly max = 30) {}
  take(ip: string, now = Date.now()) {
    let bucket = this.buckets.get(ip);
    if (!bucket || bucket.expires <= now) {
      this.buckets.delete(ip);
      if (this.buckets.size >= 10000) {
        for (const [key, value] of this.buckets)
          if (value.expires <= now) this.buckets.delete(key);
        if (this.buckets.size >= 10000)
          throw new AppError(
            'RATE_LIMITED',
            'The service is busy. Try again shortly.',
            60,
          );
      }
      bucket = { count: 0, expires: now + 60000 };
      this.buckets.set(ip, bucket);
    }
    if (bucket.count >= this.max)
      throw new AppError(
        'RATE_LIMITED',
        'Too many attempts. Try again shortly.',
        Math.max(1, Math.ceil((bucket.expires - now) / 1000)),
      );
    bucket.count++;
  }
}
