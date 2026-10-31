import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdSchema,
  ResourceParamsSchema,
  SubmitMessageBodySchema,
  IdempotencyHeadersSchema,
} from '@query-assistant/contracts';
import type { Chat } from './service.js';
import { AppError } from '../errors.js';
import { AuthRateLimit } from '../auth/rate-limit.js';
import type { Config } from '../config.js';
import { writeEvent } from './sse.js';

export function registerChatRoutes(
  app: FastifyInstance,
  chat: Chat | undefined,
  hooks: {
    protect: (request: FastifyRequest) => Promise<void>;
    protectedMutation: (request: FastifyRequest) => Promise<void>;
    protectedStream: (request: FastifyRequest) => Promise<void>;
  },
  config: Config,
) {
  const limit = new AuthRateLimit(config.USER_REQUESTS_PER_MINUTE);
  const streamLimit = new AuthRateLimit(20);
  const recoveryLimit = new AuthRateLimit(60);
  const service = () => {
    if (!chat)
      throw new AppError(
        'SERVICE_NOT_READY',
        'Configure the database, signing key, Gemini key, and accounting conversion locally before asking a question.',
      );
    return chat;
  };
  app.post(
    '/api/conversations/:id/messages',
    { preHandler: hooks.protectedMutation },
    async (request, reply) => {
      const { id } = ResourceParamsSchema.parse(request.params);
      const { content } = SubmitMessageBodySchema.parse(request.body);
      const key = IdempotencyHeadersSchema.parse(request.headers)[
        'idempotency-key'
      ];
      limit.take(request.identity!.user!.id);
      const result = await service().submit(
        {
          userId: request.identity!.user!.id,
          conversationId: id,
          idempotencyKey: key,
          content,
        },
        () => hooks.protect(request),
        request.id,
      );
      reply.code(202);
      return result;
    },
  );
  app.get(
    '/api/generations/:id/events',
    { preHandler: hooks.protectedStream },
    async (request, reply) => {
      const id = ResourceParamsSchema.parse(request.params).id;
      const userId = request.identity!.user!.id;
      streamLimit.take(userId);
      const run = await service().open(userId, id, request.id);
      const disconnect = () => {
        if (!reply.raw.writableEnded) service().disconnect(userId, id);
      };
      reply.raw.once('close', disconnect);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      try {
        await run((event) => writeEvent(reply.raw, event));
      } catch {
        service().disconnect(userId, id);
      } finally {
        reply.raw.off('close', disconnect);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    },
  );
  app.get(
    '/api/conversations/:id/submissions/:key',
    { preHandler: hooks.protect },
    async (request, reply) => {
      recoveryLimit.take(request.identity!.user!.id);
      const { id, key } = z
        .strictObject({ id: IdSchema, key: IdSchema })
        .parse(request.params);
      const result = await service().byKey(request.identity!.user!.id, id, key);
      if (
        result.generation.status === 'running' ||
        result.generation.status === 'reserved'
      )
        reply.code(202);
      return result;
    },
  );
}
