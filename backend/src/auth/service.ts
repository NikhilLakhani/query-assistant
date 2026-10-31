import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  QuotaChangeBodySchema,
  ActivateBodySchema,
  LoginBodySchema,
  UsernameSchema,
  AccountChangeBodySchema,
  UserSchema,
  AdminReasonBodySchema,
  ResourceParamsSchema,
} from '@query-assistant/contracts';
import type { Config } from '../config.js';
import type { User as DbUser } from '../generated/prisma/client.js';
import type { Database, Transaction } from '../storage/database.js';
import { withLedgerLock } from '../storage/database.js';
import { toNano } from '../storage/money.js';
import { Storage } from '../storage/store.js';
import { AppError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  ANONYMOUS_SECONDS,
  SESSION_SECONDS,
  Tokens,
  digest,
  equalDigest,
} from './tokens.js';

export interface Identity {
  sessionId: string;
  user: DbUser | null;
  expiresAt: Date;
  csrfTokenHash: string;
}

export function publicUser(
  user: Pick<DbUser, 'id' | 'username' | 'role' | 'status' | 'createdAt'>,
) {
  return UserSchema.parse({
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  });
}

export class Auth {
  readonly tokens: Tokens;
  readonly storage: Storage;
  constructor(
    readonly db: Database,
    readonly config: Config,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.tokens = new Tokens(config, now);
    this.storage = new Storage(db, config, now);
  }

  async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError || error instanceof z.ZodError) throw error;
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Storage is unavailable. Try again later.',
      );
    }
  }

  private atomic<T>(work: (tx: Transaction) => Promise<T>) {
    return this.safe(() => withLedgerLock(this.db, work));
  }

  private async sessionInTransaction(
    tx: Transaction,
    id: string,
    requireUser = false,
    admin = false,
  ): Promise<Identity> {
    const session = await tx.session.findUnique({
      where: { id },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= this.now() ||
      (requireUser && !session.user)
    )
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    if (session.user && session.user.status !== 'active')
      throw new AppError(
        'ACCOUNT_DISABLED',
        'This account cannot access the application.',
      );
    if (admin && session.user?.role !== 'admin')
      throw new AppError('FORBIDDEN', 'Administrator access is required.');
    return {
      sessionId: session.id,
      user: session.user,
      expiresAt: session.expiresAt,
      csrfTokenHash: session.csrfTokenHash,
    };
  }

  async identify(
    cookie: string | undefined,
    requireUser = false,
    admin = false,
  ): Promise<Identity> {
    const claims = await this.tokens.verify(cookie);
    return this.safe(async () => {
      const session = await this.db.session.findUnique({
        where: { id: claims.jti },
        include: { user: true },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= this.now() ||
        (session.userId ?? 'anonymous') !== claims.sub ||
        Math.floor(session.expiresAt.getTime() / 1000) !== claims.exp ||
        (requireUser && !session.user)
      )
        throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
      if (session.user && session.user.status !== 'active')
        throw new AppError(
          'ACCOUNT_DISABLED',
          'This account cannot access the application.',
        );
      if (admin && session.user?.role !== 'admin')
        throw new AppError('FORBIDDEN', 'Administrator access is required.');
      return {
        sessionId: session.id,
        user: session.user,
        expiresAt: session.expiresAt,
        csrfTokenHash: session.csrfTokenHash,
      };
    });
  }

  private async createSession(tx: Transaction, userId: string | null) {
    const id = randomUUID();
    const csrfToken = this.tokens.csrf(id);
    const seconds = userId ? SESSION_SECONDS : ANONYMOUS_SECONDS;
    const expiresAt = new Date(
      (Math.floor(this.now().getTime() / 1000) + seconds) * 1000,
    );
    const session = await tx.session.create({
      data: {
        id,
        userId,
        csrfTokenHash: digest(csrfToken),
        expiresAt,
        createdAt: this.now(),
      },
    });
    return { session, csrfToken };
  }

  async csrf(cookie: string | undefined) {
    if (cookie) {
      try {
        const identity = await this.identify(cookie);
        return {
          csrfToken: this.tokens.csrf(identity.sessionId),
          issued: null,
        };
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error.code)
        )
          throw error;
      }
    }
    const created = await this.atomic((tx) => this.createSession(tx, null));
    const token = await this.tokens.sign(
      created.session.id,
      null,
      created.session.expiresAt,
    );
    return {
      csrfToken: created.csrfToken,
      issued: { token, expiresAt: created.session.expiresAt },
    };
  }

  checkCsrf(identity: Identity, origin: string | undefined, token: unknown) {
    if (
      origin !== this.config.FRONTEND_ORIGIN ||
      typeof token !== 'string' ||
      token.length > 256 ||
      !equalDigest(identity.csrfTokenHash, digest(token))
    ) {
      throw new AppError('CSRF_INVALID', 'Refresh the page and try again.');
    }
  }

  async requestAccess(sessionId: string, usernameInput: string) {
    const username = UsernameSchema.parse(usernameInput);
    await this.atomic(async (tx) => {
      await this.sessionInTransaction(tx, sessionId);
      if (
        await tx.user.findUnique({ where: { username }, select: { id: true } })
      )
        return;
      // Existing pending/rejected/approved requests never get silently reset.
      await tx.accessRequest.upsert({
        where: { username },
        create: { username },
        update: {},
      });
    });
  }

  private quota() {
    return {
      dailyRequests: this.config.USER_DAILY_REQUEST_LIMIT,
      dailyTokens: this.config.USER_DAILY_TOKEN_LIMIT,
      dailyCostNanoInr: toNano(this.config.USER_DAILY_COST_LIMIT_INR),
    };
  }

  async login(sessionId: string, input: z.input<typeof LoginBodySchema>) {
    const value = LoginBodySchema.parse(input);
    const candidate = await this.safe(() =>
      this.db.user.findUnique({ where: { username: value.username } }),
    );
    if (
      !(await verifyPassword(candidate?.passwordHash, value.password)) ||
      !candidate
    )
      throw new AppError(
        'INVALID_CREDENTIALS',
        'The username or password is incorrect.',
      );
    const created = await this.atomic(async (tx) => {
      await this.sessionInTransaction(tx, sessionId);
      const user = await tx.user.findUnique({ where: { id: candidate.id } });
      if (!user || user.passwordHash !== candidate.passwordHash)
        throw new AppError(
          'INVALID_CREDENTIALS',
          'The username or password is incorrect.',
        );
      if (user.status !== 'active')
        throw new AppError(
          'ACCOUNT_DISABLED',
          'This account cannot access the application.',
        );
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: this.now() },
      });
      return { user, ...(await this.createSession(tx, user.id)) };
    });
    return {
      user: publicUser(created.user),
      expiresAt: created.session.expiresAt,
      token: await this.tokens.sign(
        created.session.id,
        created.user.id,
        created.session.expiresAt,
      ),
    };
  }

  private validActivation(
    request: {
      status: string;
      activationCodeHash: string | null;
      activationExpiresAt: Date | null;
    } | null,
    code: string,
  ) {
    if (
      !request ||
      request.status !== 'approved' ||
      !request.activationCodeHash ||
      !request.activationExpiresAt ||
      request.activationExpiresAt <= this.now() ||
      !equalDigest(request.activationCodeHash, digest(code))
    ) {
      throw new AppError(
        'INVALID_ACTIVATION',
        'The activation code is invalid or expired.',
      );
    }
  }

  async activate(sessionId: string, input: z.input<typeof ActivateBodySchema>) {
    const value = ActivateBodySchema.parse(input);
    const request = await this.safe(() =>
      this.db.accessRequest.findUnique({ where: { username: value.username } }),
    );
    this.validActivation(request, value.activationCode);
    const passwordHash = await hashPassword(value.password);
    const created = await this.atomic(async (tx) => {
      await this.sessionInTransaction(tx, sessionId);
      const current = await tx.accessRequest.findUnique({
        where: { username: value.username },
      });
      this.validActivation(current, value.activationCode);
      if (await tx.user.findUnique({ where: { username: value.username } }))
        throw new AppError(
          'INVALID_ACTIVATION',
          'The activation code is invalid or expired.',
        );
      const user = await tx.user.create({
        data: {
          username: value.username,
          passwordHash,
          role: 'user',
          quota: { create: this.quota() },
        },
      });
      await tx.accessRequest.update({
        where: { id: current!.id },
        data: {
          status: 'activated',
          activationCodeHash: null,
          activationExpiresAt: null,
        },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: this.now() },
      });
      return { user, ...(await this.createSession(tx, user.id)) };
    });
    return {
      user: publicUser(created.user),
      expiresAt: created.session.expiresAt,
      token: await this.tokens.sign(
        created.session.id,
        created.user.id,
        created.session.expiresAt,
      ),
    };
  }

  async logout(sessionId: string) {
    await this.atomic(async (tx) => {
      await this.sessionInTransaction(tx, sessionId, true);
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: this.now() },
      });
    });
  }

  async approve(
    sessionId: string,
    id: string,
    body: z.input<typeof AdminReasonBodySchema>,
  ) {
    ResourceParamsSchema.parse({ id });
    const { reason } = AdminReasonBodySchema.parse(body);
    const code = randomBytes(32).toString('base64url');
    return this.atomic(async (tx) => {
      const actor = await this.sessionInTransaction(tx, sessionId, true, true);
      const request = await tx.accessRequest.findUnique({ where: { id } });
      if (!request)
        throw new AppError('NOT_FOUND', 'Access request not found.');
      if (request.status === 'activated')
        throw new AppError('CONFLICT', 'This account is already activated.');
      if (await tx.user.findUnique({ where: { username: request.username } }))
        throw new AppError('CONFLICT', 'This username is unavailable.');
      const expiresAt = new Date(this.now().getTime() + 24 * 3600000);
      const approved = await tx.accessRequest.update({
        where: { id },
        data: {
          status: 'approved',
          activationCodeHash: digest(code),
          activationExpiresAt: expiresAt,
        },
      });
      await tx.adminAuditEvent.create({
        data: {
          actorId: actor.user!.id,
          action: 'access_approved',
          reason,
          details: { accessRequestId: id },
        },
      });
      return { request: approved, activationCode: code, expiresAt };
    });
  }

  async reject(
    sessionId: string,
    id: string,
    body: z.input<typeof AdminReasonBodySchema>,
  ) {
    ResourceParamsSchema.parse({ id });
    const { reason } = AdminReasonBodySchema.parse(body);
    return this.atomic(async (tx) => {
      const actor = await this.sessionInTransaction(tx, sessionId, true, true);
      const request = await tx.accessRequest.findUnique({ where: { id } });
      if (!request)
        throw new AppError('NOT_FOUND', 'Access request not found.');
      if (request.status === 'activated')
        throw new AppError('CONFLICT', 'This account is already activated.');
      const rejected = await tx.accessRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          activationCodeHash: null,
          activationExpiresAt: null,
        },
      });
      await tx.adminAuditEvent.create({
        data: {
          actorId: actor.user!.id,
          action: 'access_rejected',
          reason,
          details: { accessRequestId: id },
        },
      });
      return rejected;
    });
  }

  async changeQuota(
    sessionId: string,
    id: string,
    input: z.input<typeof QuotaChangeBodySchema>,
  ) {
    ResourceParamsSchema.parse({ id });
    const body = QuotaChangeBodySchema.parse(input);
    return this.atomic(async (tx) => {
      const actor = await this.sessionInTransaction(tx, sessionId, true, true);
      const user = await tx.user.findUnique({
        where: { id },
        include: { quota: true },
      });
      if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
      if (user.version !== body.expectedVersion)
        throw new AppError(
          'CONFLICT',
          'This account was changed. Refresh and try again.',
        );
      const before = user.quota ?? this.quota();
      const data = {
        dailyRequests: body.dailyRequests,
        dailyTokens: body.dailyTokens,
        dailyCostNanoInr: toNano(body.dailyCostLimitInr),
      };
      await tx.userQuota.upsert({
        where: { userId: id },
        create: { userId: id, ...data },
        update: data,
      });
      const updated = await tx.user.update({
        where: { id },
        data: { version: { increment: 1 } },
        include: { quota: true },
      });
      const auditQuota = (q: typeof data) => ({
        dailyRequests: q.dailyRequests,
        dailyTokens: q.dailyTokens,
        dailyCostNanoInr: q.dailyCostNanoInr.toString(),
      });
      await tx.adminAuditEvent.create({
        data: {
          actorId: actor.user!.id,
          targetUserId: id,
          action: 'quota_changed',
          reason: body.reason,
          details: {
            before: auditQuota(before),
            after: auditQuota(data),
            version: updated.version,
          },
        },
      });
      // Existing reservations and usage remain intact, even when the new limit
      // is below spent/reserved allowance. Only subsequent admissions change.
      return updated;
    });
  }

  async changeStatus(
    sessionId: string,
    id: string,
    input: z.input<typeof AccountChangeBodySchema>,
  ) {
    ResourceParamsSchema.parse({ id });
    const body = AccountChangeBodySchema.parse(input);
    return this.atomic(async (tx) => {
      const actor = await this.sessionInTransaction(tx, sessionId, true, true);
      const user = await tx.user.findUnique({
        where: { id },
        include: { quota: true },
      });
      if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
      if (user.version !== body.expectedVersion)
        throw new AppError(
          'CONFLICT',
          'This account was changed. Refresh and try again.',
        );
      if (
        user.role === 'admin' &&
        user.status === 'active' &&
        body.status !== 'active' &&
        (await tx.user.count({ where: { role: 'admin', status: 'active' } })) <=
          1
      )
        throw new AppError(
          'CONFLICT',
          'The last active administrator must remain active.',
        );
      const updated = await tx.user.update({
        where: { id },
        data: { status: body.status, version: { increment: 1 } },
        include: { quota: true },
      });
      if (body.status !== 'active') {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: this.now() },
        });
        // No provider exists at Step 4. Step 6 also signals the active upstream
        // registry after commit; this transaction already blocks new dispatch.
        await this.storage.cancelUserGenerationsInTransaction(
          tx,
          id,
          this.now(),
        );
      }
      await tx.adminAuditEvent.create({
        data: {
          actorId: actor.user!.id,
          targetUserId: id,
          action: 'account_status_changed',
          reason: body.reason,
          details: {
            from: user.status,
            to: body.status,
            version: updated.version,
          },
        },
      });
      return updated;
    });
  }
}

/** Trusted CLI only. No HTTP route can invoke this or choose an admin role. */
export async function bootstrapAdmin(
  db: Database,
  config: Config,
  usernameInput: string,
  password: string,
) {
  const username = UsernameSchema.parse(usernameInput);
  const passwordHash = await hashPassword(password);
  return withLedgerLock(db, async (tx) => {
    if (await tx.user.count({ where: { role: 'admin' } }))
      throw new AppError(
        'CONFLICT',
        'An administrator already exists. Bootstrap is disabled.',
      );
    if (await tx.user.findUnique({ where: { username } }))
      throw new AppError('CONFLICT', 'This username is unavailable.');
    const user = await tx.user.create({
      data: {
        username,
        passwordHash,
        role: 'admin',
        quota: {
          create: {
            dailyRequests: config.USER_DAILY_REQUEST_LIMIT,
            dailyTokens: config.USER_DAILY_TOKEN_LIMIT,
            dailyCostNanoInr: toNano(config.USER_DAILY_COST_LIMIT_INR),
          },
        },
      },
    });
    await tx.adminAuditEvent.create({
      data: {
        actorId: user.id,
        targetUserId: user.id,
        action: 'admin_bootstrapped',
        reason: 'Trusted local first-admin provisioning',
        details: {},
      },
    });
    return publicUser(user);
  });
}
