import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AdminUsageQuerySchema,
  QuotaChangeBodySchema,
  AccessRequestBodySchema,
  AccessRequestResponseSchema,
  ActivateBodySchema,
  LoginBodySchema,
  SessionResponseSchema,
  CsrfResponseSchema,
  CurrentUserResponseSchema,
  ResourceParamsSchema,
  PaginationQuerySchema,
  CreateConversationBodySchema,
  CreateConversationResponseSchema,
  ConversationListResponseSchema,
  MessageListResponseSchema,
  GenerationResponseSchema,
  AdminAccessRequestQuerySchema,
  AccessRequestListResponseSchema,
  ApprovalResponseSchema,
  AdminAccessRequestResponseSchema,
  AdminReasonBodySchema,
  AdminPageQuerySchema,
  AdminUserListResponseSchema,
  AccountChangeBodySchema,
  AdminUserResponseSchema,
} from '@query-assistant/contracts';
import { usageReport, generationReport } from '../admin/report.js';
import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import { fromNano } from '../storage/money.js';
import { AppError } from '../errors.js';
import { Auth, publicUser } from './service.js';
import type { Identity } from './service.js';
import { cookieName, setSessionCookie, clearSessionCookie } from './cookies.js';
import { preparePasswordVerification } from './password.js';
import { AuthRateLimit } from './rate-limit.js';
import { ProxyClientAddress } from './proxy-client.js';
import { decodeCursor, encodeCursor, beforeDate } from './pagination.js';
import type { User as DbUser, UserQuota } from '../generated/prisma/client.js';
import type { Chat } from '../chat/service.js';
import { registerChatRoutes } from '../chat/routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity | null;
  }
}
const EmptyBody = z.strictObject({}).optional();
const conversationDto = (row: {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const accessDto = (row: {
  id: string;
  username: string;
  status: string;
  createdAt: Date;
}) => ({
  id: row.id,
  username: row.username,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  config: Config,
  database?: Database,
  chat?: Chat,
) {
  const auth =
    database && config.JWT_SIGNING_KEY ? new Auth(database, config) : undefined;
  const limit = new AuthRateLimit();
  const clientAddress = new ProxyClientAddress(
    config.TRUSTED_PROXY_HOST || undefined,
  );
  const cancelLimit = new AuthRateLimit(30);
  app.decorateRequest('identity', null);
  if (auth)
    app.addHook('onReady', async () => {
      await preparePasswordVerification();
    });
  const service = () => {
    if (!auth)
      throw new AppError(
        'SERVICE_NOT_READY',
        'Configure the database and signing key before signing in.',
      );
    return auth;
  };
  const cookie = (request: FastifyRequest) =>
    request.cookies[cookieName(config)];
  const identity = (request: FastifyRequest) => {
    if (!request.identity)
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    return request.identity;
  };
  const protect = async (request: FastifyRequest) => {
    request.identity = await service().identify(cookie(request), true);
  };
  const csrf = async (request: FastifyRequest) => {
    request.identity ??= await service().identify(cookie(request));
    service().checkCsrf(
      identity(request),
      request.headers.origin,
      request.headers['x-csrf-token'],
    );
  };
  const protectedMutation = async (request: FastifyRequest) => {
    await protect(request);
    await csrf(request);
  };
  const protectedStream = async (request: FastifyRequest) => {
    await protect(request);
    // Same-origin browser GETs omit Origin. Fetch Metadata is browser-controlled,
    // and only the configured public Host may use this stream-only fallback.
    // An explicitly wrong/null Origin never falls back. CSRF remains mandatory.
    const origin =
      request.headers.origin ??
      (request.headers['sec-fetch-site'] === 'same-origin' &&
      request.headers.host === new URL(config.FRONTEND_ORIGIN).host
        ? config.FRONTEND_ORIGIN
        : undefined);
    service().checkCsrf(
      identity(request),
      origin,
      request.headers['x-csrf-token'],
    );
  };
  const adminProtect = async (request: FastifyRequest) => {
    request.identity = await service().identify(cookie(request), true, true);
  };
  const authThrottle = async (request: FastifyRequest) => {
    limit.take(await clientAddress.key(request));
  };
  // Use declared route metadata: security cannot depend on incoming URL spelling.
  app.addHook('onRoute', (route) => {
    const handlers = route.onRequest
      ? Array.isArray(route.onRequest)
        ? [...route.onRequest]
        : [route.onRequest]
      : [];
    if (route.url.startsWith('/api/admin/') && !handlers.includes(adminProtect))
      handlers.unshift(adminProtect);
    if (
      (route.url.startsWith('/api/auth/') ||
        route.url === '/api/access-requests') &&
      !handlers.includes(authThrottle)
    )
      handlers.unshift(authThrottle);
    route.onRequest = handlers;
  });
  app.addHook('preValidation', async (request) => {
    const path = request.routeOptions.url ?? '';
    const paginated =
      request.method === 'GET' &&
      ([
        '/api/conversations',
        '/api/admin/access-requests',
        '/api/admin/users',
        '/api/admin/usage',
        '/api/admin/generations',
      ].includes(path) ||
        /^\/api\/conversations\/[^/]+\/messages$/.test(path));
    if (!paginated) z.strictObject({}).parse(request.query);
    if (
      request.body !== undefined &&
      request.headers['content-type']?.split(';')[0]?.trim() !==
        'application/json'
    ) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Use application/json for request bodies.',
      );
    }
  });
  const safe = <T>(work: (db: Database) => Promise<T>) =>
    service().safe(() => work(service().db));
  const adminUserDto = (user: DbUser & { quota: UserQuota | null }) => ({
    user: publicUser(user),
    version: user.version,
    quota: {
      dailyRequests:
        user.quota?.dailyRequests ?? config.USER_DAILY_REQUEST_LIMIT,
      dailyTokens: user.quota?.dailyTokens ?? config.USER_DAILY_TOKEN_LIMIT,
      dailyCostLimitInr: user.quota
        ? fromNano(user.quota.dailyCostNanoInr)
        : config.USER_DAILY_COST_LIMIT_INR,
    },
  });

  app.get('/api/auth/csrf', async (request, reply) => {
    if (
      request.headers.origin &&
      request.headers.origin !== config.FRONTEND_ORIGIN
    )
      throw new AppError('CSRF_INVALID', 'This origin is not permitted.');
    const result = await service().csrf(cookie(request));
    if (result.issued)
      setSessionCookie(
        reply,
        config,
        result.issued.token,
        result.issued.expiresAt,
      );
    return CsrfResponseSchema.parse({ csrfToken: result.csrfToken });
  });
  app.post(
    '/api/access-requests',
    { preHandler: csrf },
    async (request, reply) => {
      const body = AccessRequestBodySchema.parse(request.body);
      await service().requestAccess(identity(request).sessionId, body.username);
      reply.code(202);
      return AccessRequestResponseSchema.parse({
        message:
          'If eligible, your access request will be reviewed by an administrator.',
      });
    },
  );
  app.post('/api/auth/login', { preHandler: csrf }, async (request, reply) => {
    const result = await service().login(
      identity(request).sessionId,
      LoginBodySchema.parse(request.body),
    );
    setSessionCookie(reply, config, result.token, result.expiresAt);
    return SessionResponseSchema.parse({
      user: result.user,
      expiresAt: result.expiresAt.toISOString(),
    });
  });
  app.post(
    '/api/auth/activate',
    { preHandler: csrf },
    async (request, reply) => {
      const result = await service().activate(
        identity(request).sessionId,
        ActivateBodySchema.parse(request.body),
      );
      setSessionCookie(reply, config, result.token, result.expiresAt);
      reply.code(201);
      return SessionResponseSchema.parse({
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );
  app.post(
    '/api/auth/logout',
    { preHandler: protectedMutation },
    async (request, reply) => {
      EmptyBody.parse(request.body);
      await service().logout(identity(request).sessionId);
      clearSessionCookie(reply, config);
      reply.code(204).send();
    },
  );
  app.get('/api/me', { preHandler: protect }, async (request) => {
    const user = identity(request).user!;
    const value = await service().storage.allowance(user.id);
    const remaining = (limit: bigint, used: bigint, reserved: bigint) =>
      limit > used + reserved ? limit - used - reserved : 0n;
    const used = value.costUsedNanoInr,
      reserved = value.costReservedNanoInr,
      max = value.limits.dailyCostNanoInr;
    const money = (amount: bigint) => ({
      amount: fromNano(amount),
      currency: 'INR' as const,
    });
    return CurrentUserResponseSchema.parse({
      user: publicUser(user),
      allowance: {
        periodStart: value.period.start.toISOString(),
        resetsAt: value.period.end.toISOString(),
        resetTimezone: config.QUOTA_RESET_TIMEZONE,
        requests: {
          limit: value.limits.dailyRequests,
          used: value.requestsUsed,
          reserved: value.requestsReserved,
          remaining: Number(
            remaining(
              BigInt(value.limits.dailyRequests),
              BigInt(value.requestsUsed),
              BigInt(value.requestsReserved),
            ),
          ),
        },
        tokens: {
          limit: value.limits.dailyTokens,
          used: Number(value.tokensUsed),
          reserved: Number(value.tokensReserved),
          remaining: Number(
            remaining(
              BigInt(value.limits.dailyTokens),
              value.tokensUsed,
              value.tokensReserved,
            ),
          ),
        },
        estimatedCost: {
          limit: money(max),
          used: money(used),
          reserved: money(reserved),
          remaining: money(remaining(max, used, reserved)),
        },
        generationAvailable: chat?.available ?? false,
      },
    });
  });

  registerChatRoutes(
    app,
    chat,
    { protect, protectedMutation, protectedStream },
    config,
  );

  app.post(
    '/api/conversations',
    { preHandler: protectedMutation },
    async (request, reply) => {
      const row = await service().storage.createConversation(
        identity(request).user!.id,
        CreateConversationBodySchema.parse(request.body),
      );
      reply.code(201);
      return CreateConversationResponseSchema.parse({
        conversation: conversationDto(row),
      });
    },
  );
  app.get('/api/conversations', { preHandler: protect }, async (request) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = identity(request).user!.id;
    const scope = `conversations:${userId}`;
    const cursor = decodeCursor(query.cursor, scope);
    const rows = await safe((db) =>
      db.conversation.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: new Date(cursor.at) } },
                  { updatedAt: new Date(cursor.at), id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const items = rows.slice(0, query.limit),
      last = items.at(-1);
    return ConversationListResponseSchema.parse({
      items: items.map(conversationDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(scope, { id: last.id, at: last.updatedAt })
          : null,
    });
  });
  const ownedConversation = async (request: FastifyRequest) => {
    const { id } = ResourceParamsSchema.parse(request.params);
    const row = await safe((db) =>
      db.conversation.findUnique({
        where: { id_userId: { id, userId: identity(request).user!.id } },
      }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Conversation not found.');
    return row;
  };
  app.get(
    '/api/conversations/:id',
    { preHandler: protect },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return CreateConversationResponseSchema.parse({
        conversation: conversationDto(await ownedConversation(request)),
      });
    },
  );
  app.get(
    '/api/conversations/:id/messages',
    { preHandler: protect },
    async (request) => {
      const conversation = await ownedConversation(request);
      const query = PaginationQuerySchema.parse(request.query);
      const scope = `messages:${conversation.id}:${identity(request).user!.id}`;
      const cursor = decodeCursor(query.cursor, scope);
      if (cursor && cursor.sequence === undefined)
        throw new AppError('VALIDATION_ERROR', 'The page cursor is invalid.');
      const rows = await safe((db) =>
        db.message.findMany({
          where: {
            conversationId: conversation.id,
            ...(cursor ? { sequence: { lt: cursor.sequence! } } : {}),
          },
          orderBy: { sequence: 'desc' },
          take: query.limit + 1,
        }),
      );
      const items = rows.slice(0, query.limit),
        oldest = items.at(-1);
      return MessageListResponseSchema.parse({
        items: items.reverse().map((row) => ({
          id: row.id,
          conversationId: row.conversationId,
          generationId: row.generationId,
          sequence: row.sequence,
          role: row.role,
          content: row.content,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > query.limit && oldest
            ? encodeCursor(scope, {
                id: oldest.id,
                at: oldest.createdAt,
                sequence: oldest.sequence,
              })
            : null,
      });
    },
  );
  app.delete(
    '/api/conversations/:id',
    { preHandler: protectedMutation },
    async (request, reply) => {
      EmptyBody.parse(request.body);
      await service().storage.deleteConversation(
        identity(request).user!.id,
        ResourceParamsSchema.parse(request.params).id,
      );
      reply.code(204).send();
    },
  );
  const generationDto = async (id: string, userId: string) => {
    const row = await safe((db) =>
      db.generationRequest.findFirst({
        where: { id, userId },
        include: {
          messages: { where: { role: 'assistant' }, select: { id: true } },
        },
      }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Generation not found.');
    // A deleted conversation has no URL-addressable chat result.
    if (!row.conversationId)
      throw new AppError('NOT_FOUND', 'Generation not found.');
    return GenerationResponseSchema.parse({
      generation: {
        id: row.id,
        conversationId: row.conversationId,
        status: row.status,
        assistantMessageId: row.messages[0]?.id ?? null,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      },
    });
  };
  app.get('/api/generations/:id', { preHandler: protect }, async (request) => {
    z.strictObject({}).parse(request.query);
    return generationDto(
      ResourceParamsSchema.parse(request.params).id,
      identity(request).user!.id,
    );
  });
  app.post(
    '/api/generations/:id/cancel',
    { preHandler: protectedMutation },
    async (request) => {
      EmptyBody.parse(request.body);
      const id = ResourceParamsSchema.parse(request.params).id;
      const userId = identity(request).user!.id;
      cancelLimit.take(userId);
      if (chat) await chat.cancel(userId, id);
      else await service().storage.cancelOwnedGeneration(userId, id);
      return generationDto(id, userId);
    },
  );

  app.get('/api/admin/usage', async (request) =>
    safe((db) =>
      usageReport(db, config, AdminUsageQuerySchema.parse(request.query)),
    ),
  );
  app.get('/api/admin/generations', async (request) =>
    safe((db) =>
      generationReport(db, AdminUsageQuerySchema.parse(request.query)),
    ),
  );
  app.patch(
    '/api/admin/users/:id/quota',
    { preHandler: csrf },
    async (request) => {
      const user = await service().changeQuota(
        identity(request).sessionId,
        ResourceParamsSchema.parse(request.params).id,
        QuotaChangeBodySchema.parse(request.body),
      );
      return AdminUserResponseSchema.parse({ account: adminUserDto(user) });
    },
  );
  app.get('/api/admin/access-requests', async (request) => {
    const query = AdminAccessRequestQuerySchema.parse(request.query);
    const scope = `access:${query.status ?? 'all'}`;
    const rows = await safe((db) =>
      db.accessRequest.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...beforeDate(decodeCursor(query.cursor, scope)),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const items = rows.slice(0, query.limit),
      last = items.at(-1);
    return AccessRequestListResponseSchema.parse({
      items: items.map(accessDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(scope, { id: last.id, at: last.createdAt })
          : null,
    });
  });
  app.post(
    '/api/admin/access-requests/:id/approve',
    { preHandler: csrf },
    async (request) => {
      const result = await service().approve(
        identity(request).sessionId,
        ResourceParamsSchema.parse(request.params).id,
        AdminReasonBodySchema.parse(request.body),
      );
      return ApprovalResponseSchema.parse({
        request: accessDto(result.request),
        activationCode: result.activationCode,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );
  app.post(
    '/api/admin/access-requests/:id/reject',
    { preHandler: csrf },
    async (request) => {
      const row = await service().reject(
        identity(request).sessionId,
        ResourceParamsSchema.parse(request.params).id,
        AdminReasonBodySchema.parse(request.body),
      );
      return AdminAccessRequestResponseSchema.parse({
        request: accessDto(row),
      });
    },
  );
  app.get('/api/admin/users', async (request) => {
    const query = AdminPageQuerySchema.parse(request.query);
    const scope = `users:${query.status ?? 'all'}`;
    const rows = await safe((db) =>
      db.user.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...beforeDate(decodeCursor(query.cursor, scope)),
        },
        include: { quota: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const items = rows.slice(0, query.limit),
      last = items.at(-1);
    return AdminUserListResponseSchema.parse({
      items: items.map(adminUserDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(scope, { id: last.id, at: last.createdAt })
          : null,
    });
  });
  app.patch(
    '/api/admin/users/:id/status',
    { preHandler: csrf },
    async (request) => {
      const user = await service().changeStatus(
        identity(request).sessionId,
        ResourceParamsSchema.parse(request.params).id,
        AccountChangeBodySchema.parse(request.body),
      );
      if (user.status !== 'active') await chat?.abortUser(user.id);
      return AdminUserResponseSchema.parse({ account: adminUserDto(user) });
    },
  );
}
