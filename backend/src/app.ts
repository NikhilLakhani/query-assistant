import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import {
  ApiErrorSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from '@query-assistant/contracts';
import type { ErrorCode } from '@query-assistant/contracts';
import { hasServiceConfiguration } from './config.js';
import type { Config } from './config.js';
import { databaseIsReady } from './storage/database.js';
import type { Database } from './storage/database.js';
import { AppError, errorStatus } from './errors.js';
import { registerAuthRoutes } from './auth/routes.js';
import { clearSessionCookie } from './auth/cookies.js';
import { GeminiProvider } from './chat/gemini.js';
import { Chat } from './chat/service.js';
import type { TextProvider } from './chat/provider.js';

export function buildApp(
  config: Config,
  options: {
    logger?: boolean;
    database?: Database;
    provider?: TextProvider;
    logDestination?: import('node:stream').Writable;
  } = {},
) {
  const provider =
    options.provider ??
    (hasServiceConfiguration(config) ? new GeminiProvider(config) : undefined);
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 120000,
    keepAliveTimeout: 5000,
    maxRequestsPerSocket: 1000,
    forceCloseConnections: true,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            ...(options.logDestination
              ? { stream: options.logDestination }
              : {}),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'password',
                'activationCode',
                'csrfToken',
                'token',
                'passwordHash',
                'req.headers["x-csrf-token"]',
                'content',
                'DATABASE_URL',
                'GEMINI_API_KEY',
                'JWT_SIGNING_KEY',
              ],
              censor: '[REDACTED]',
            },
            serializers: {
              // Do not log URLs: query parameters may contain private values.
              req: (request) => ({ method: request.method, id: request.id }),
              res: (response) => ({ statusCode: response.statusCode }),
            },
          },
  });

  const chat =
    options.database &&
    config.JWT_SIGNING_KEY &&
    config.ACCOUNTING_INR_PER_USD &&
    provider
      ? new Chat(options.database, config, provider, (event) =>
          app.log.warn(event, 'Generation outcome'),
        )
      : undefined;

  if (chat)
    app.addHook('preClose', async () => {
      await chat.shutdown();
    });

  void app.register(cors, {
    origin: config.FRONTEND_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-ID', 'Retry-After'],
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    if (config.NODE_ENV === 'production')
      reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.get('/health/live', async (request) =>
    LivenessResponseSchema.parse({
      status: 'ok',
      requestId: request.id,
    }),
  );
  app.get('/health/ready', async (request, reply) => {
    const checks = {
      configuration: hasServiceConfiguration(config),
      database: options.database
        ? await databaseIsReady(options.database)
        : false,
      application: chat?.available ?? false,
    };
    const ready = Object.values(checks).every(Boolean);
    reply.code(ready ? 200 : 503);
    return ReadinessResponseSchema.parse({
      status: ready ? 'ready' : 'not_ready',
      checks,
      requestId: request.id,
    });
  });
  void app.register(async (scope) => {
    // Parse cookies before any route's auth/CSRF hooks run.
    await scope.register(cookie);
    registerAuthRoutes(scope, config, options.database, chat);
  });
  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return ApiErrorSchema.parse({
      error: {
        code: 'NOT_FOUND',
        message: 'This endpoint is unavailable.',
        requestId: request.id,
        retryable: false,
      },
    });
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError || error instanceof z.ZodError) {
      const code = error instanceof AppError ? error.code : 'VALIDATION_ERROR';
      const status = errorStatus[code];
      if (code === 'UNAUTHENTICATED' || code === 'ACCOUNT_DISABLED')
        clearSessionCookie(reply, config);
      const retryAfterSeconds =
        error instanceof AppError ? error.retryAfterSeconds : undefined;
      if (retryAfterSeconds !== undefined)
        reply.header('Retry-After', retryAfterSeconds);
      request.log.warn({ category: code }, 'Request rejected');
      reply.code(status);
      return ApiErrorSchema.parse({
        error: {
          code,
          message:
            error instanceof AppError
              ? error.message
              : 'Check the request format and try again.',
          requestId: request.id,
          retryable: status === 503 || status === 429,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        },
      });
    }
    const status =
      error !== null &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'The request could not be completed.';
    if (status === 400) {
      code = 'VALIDATION_ERROR';
      message = 'Check the request format and try again.';
    }
    if (status === 413) {
      code = 'PAYLOAD_TOO_LARGE';
      message = 'The request is too large.';
    }
    if (status === 415) {
      code = 'UNSUPPORTED_MEDIA_TYPE';
      message = 'Use application/json for request bodies.';
    }
    // Log only safe categories; error messages/stacks can contain secrets.
    request.log.error({ category: code }, 'Request failed');
    reply.code([400, 413, 415].includes(status) ? status : 500);
    return ApiErrorSchema.parse({
      error: { code, message, requestId: request.id, retryable: false },
    });
  });
  return app;
}
