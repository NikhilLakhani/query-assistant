import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA timezone');
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
}, 'Use an HTTP(S) origin without a path or trailing slash');
const secret = z
  .string()
  .min(1)
  .refine(
    (value) => !/REPLACE|CHANGE_ME/i.test(value),
    'Replace placeholder locally',
  );
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,9})?$/);

export const ConfigSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: positiveInteger.max(65535).default(3001),
    TRUSTED_PROXY_HOST: z
      .string()
      .max(253)
      .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)?$/)
      .default(''),
    FRONTEND_ORIGIN: origin.default('http://localhost:5173'),
    DISPLAY_TIMEZONE: timezone.default('Asia/Kolkata'),
    QUOTA_RESET_TIMEZONE: timezone.default('Asia/Kolkata'),
    DATABASE_URL: z
      .url()
      .refine(
        (value) => /^postgres(ql)?:\/\//.test(value) && !/REPLACE/i.test(value),
        'Configure PostgreSQL connection locally',
      )
      .optional(),
    GEMINI_API_KEY: secret.optional(),
    GEMINI_MODEL: z
      .string()
      .max(100)
      .regex(/^gemini-[a-zA-Z0-9._-]+$/)
      .default('gemini-3.5-flash-lite'),
    JWT_SIGNING_KEY: secret
      .refine(
        (value) => Buffer.byteLength(value) >= 32,
        'Use at least 32 random bytes',
      )
      .optional(),
    JWT_ISSUER: z.string().min(1).default('query-assistant'),
    JWT_AUDIENCE: z.string().min(1).default('query-assistant-web'),
    ACCOUNTING_INR_PER_USD: decimal
      .refine((value) => Number(value) > 0)
      .optional(),
    MODEL_INPUT_USD_PER_MILLION: decimal.default('0.30'),
    MODEL_OUTPUT_USD_PER_MILLION: decimal.default('2.50'),
    PRICE_VERSION: z.string().min(1).default('2026-10-30'),
    USER_DAILY_REQUEST_LIMIT: positiveInteger.default(10),
    USER_DAILY_TOKEN_LIMIT: positiveInteger.default(100000),
    USER_DAILY_COST_LIMIT_INR: decimal.default('100'),
    GLOBAL_DAILY_COST_LIMIT_INR: decimal.default('500'),
    GLOBAL_TOTAL_COST_LIMIT_INR: decimal.default('1000'),
    USER_REQUESTS_PER_MINUTE: positiveInteger.default(6),
    USER_MAX_ACTIVE_GENERATIONS: positiveInteger.default(1),
    GLOBAL_MAX_ACTIVE_GENERATIONS: positiveInteger.default(4),
    MAX_PROMPT_CHARACTERS: positiveInteger.max(8000).default(8000),
    MAX_CONTEXT_TOKENS: positiveInteger.max(16000).default(16000),
    MAX_OUTPUT_TOKENS: positiveInteger.max(2000).default(2000),
    GENERATION_TIMEOUT_SECONDS: positiveInteger.max(90).default(90),
    STREAM_IDLE_TIMEOUT_SECONDS: positiveInteger.max(20).default(20),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production') {
      for (const field of [
        'DATABASE_URL',
        'GEMINI_API_KEY',
        'JWT_SIGNING_KEY',
        'ACCOUNTING_INR_PER_USD',
      ] as const) {
        if (!value[field])
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'Required in production',
          });
      }
      if (!value.FRONTEND_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_ORIGIN'],
          message: 'HTTPS required in production',
        });
      }
    }
    if (value.STREAM_IDLE_TIMEOUT_SECONDS > value.GENERATION_TIMEOUT_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['STREAM_IDLE_TIMEOUT_SECONDS'],
        message: 'Must not exceed overall timeout',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigurationError extends Error {}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  // Error messages never interpolate supplied values, including credentials.
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new ConfigurationError(
      `Invalid backend configuration: ${fields.join(', ')}. See backend/.env.example.`,
    );
  }
  return result.data;
}

export function hasServiceConfiguration(config: Config): boolean {
  return Boolean(
    config.DATABASE_URL &&
    config.GEMINI_API_KEY &&
    config.JWT_SIGNING_KEY &&
    config.ACCOUNTING_INR_PER_USD,
  );
}
