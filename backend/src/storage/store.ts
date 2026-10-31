import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  IdSchema,
  SubmitMessageBodySchema,
  CreateConversationBodySchema,
  FinalGenerationStatusSchema,
} from '@query-assistant/contracts';
import type { Config } from '../config.js';
import type { Database, Transaction } from './database.js';
import { withLedgerLock } from './database.js';
import { estimateCost, toNano } from './money.js';
import { dailyPeriod } from './period.js';
import { AppError } from '../errors.js';

export class StorageError extends AppError {}

const active = ['reserved', 'running'] as const;
const ReserveSchema = z.strictObject({
  userId: IdSchema,
  conversationId: IdSchema,
  idempotencyKey: IdSchema,
  content: SubmitMessageBodySchema.shape.content,
  inputTokenBound: z.number().int().min(1).max(16000),
  outputTokenBound: z.number().int().min(1).max(2000),
});
const ReportedUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative(),
    // Visible output and reasoning are DISJOINT normalized counts. Provider
    // adapters must not supply an inclusive total as outputTokens here.
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    providerReportedNanoUsd: z.bigint().nonnegative().optional(),
  })
  .refine(
    (value) => value.cachedInputTokens <= value.inputTokens,
    'Cached input must be a subset',
  );
const SettleSchema = z.strictObject({
  userId: IdSchema,
  generationId: IdSchema,
  status: FinalGenerationStatusSchema,
  content: z.string().max(128000).optional(),
  reportedUsage: ReportedUsageSchema.optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z_]+$/)
    .max(100)
    .optional(),
  providerRequestId: z.string().min(1).max(512).optional(),
});
export type ReserveInput = z.input<typeof ReserveSchema>;
export type SettleInput = z.input<typeof SettleSchema>;

export class Storage {
  constructor(
    public readonly db: Database,
    private readonly config: Config,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async atomic<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withLedgerLock(this.db, work);
    } catch (error) {
      if (error instanceof StorageError || error instanceof z.ZodError)
        throw error;
      // Preserve database failures as a safe category; never silently continue
      // without reservations or attach raw SQL/connection errors to public errors.
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        'Storage is unavailable. Try again later.',
      );
    }
  }

  private async activeUser(tx: Transaction, userId: string) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new StorageError('UNAUTHENTICATED', 'Sign in to continue.');
    if (user.status !== 'active')
      throw new StorageError(
        'ACCOUNT_DISABLED',
        'This account cannot access the application.',
      );
    return user;
  }

  private async ownedConversation(tx: Transaction, userId: string, id: string) {
    const conversation = await tx.conversation.findUnique({
      where: { id_userId: { id, userId } },
    });
    if (!conversation)
      throw new StorageError('NOT_FOUND', 'Conversation not found.');
    return conversation;
  }

  async createConversation(
    userId: string,
    body: z.input<typeof CreateConversationBodySchema> = {},
  ) {
    IdSchema.parse(userId);
    const parsed = CreateConversationBodySchema.parse(body);
    return this.atomic(async (tx) => {
      await this.activeUser(tx, userId);
      return tx.conversation.create({
        data: { userId, title: parsed.title ?? 'New conversation' },
      });
    });
  }

  private async prices(tx: Transaction) {
    const config = this.config;
    if (!config.ACCOUNTING_INR_PER_USD)
      throw new StorageError(
        'SERVICE_NOT_READY',
        'Configure the accounting conversion before generation.',
      );
    const values = {
      inputNanoUsdPerMillion: toNano(config.MODEL_INPUT_USD_PER_MILLION),
      outputNanoUsdPerMillion: toNano(config.MODEL_OUTPUT_USD_PER_MILLION),
      inrPerUsdNano: toNano(config.ACCOUNTING_INR_PER_USD),
    };
    const price = await tx.priceSnapshot.upsert({
      where: {
        version_model: {
          version: config.PRICE_VERSION,
          model: config.GEMINI_MODEL,
        },
      },
      create: {
        version: config.PRICE_VERSION,
        model: config.GEMINI_MODEL,
        ...values,
      },
      update: {},
    });
    if (
      price.inputNanoUsdPerMillion !== values.inputNanoUsdPerMillion ||
      price.outputNanoUsdPerMillion !== values.outputNanoUsdPerMillion ||
      price.inrPerUsdNano !== values.inrPerUsdNano
    ) {
      throw new StorageError(
        'SERVICE_NOT_READY',
        'Change PRICE_VERSION when changing prices or the accounting conversion.',
      );
    }
    return price;
  }

  async reserveGeneration(input: ReserveInput) {
    const value = ReserveSchema.parse(input);
    if (
      value.content.length > this.config.MAX_PROMPT_CHARACTERS ||
      value.inputTokenBound > this.config.MAX_CONTEXT_TOKENS ||
      value.outputTokenBound > this.config.MAX_OUTPUT_TOKENS
    ) {
      throw new StorageError(
        'VALIDATION_ERROR',
        'The request exceeds configured size limits.',
      );
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([value.conversationId, value.content]))
      .digest('hex');
    return this.atomic(async (tx) => {
      const now = this.now();
      await this.activeUser(tx, value.userId);
      const existing = await tx.generationRequest.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: value.userId,
            idempotencyKey: value.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.payloadHash !== fingerprint)
          throw new StorageError(
            'CONFLICT',
            'The submission key was already used for another message.',
          );
        return { generation: existing, replayed: true };
      }
      const conversation = await this.ownedConversation(
        tx,
        value.userId,
        value.conversationId,
      );
      const quota = await tx.userQuota.upsert({
        where: { userId: value.userId },
        update: {},
        create: {
          userId: value.userId,
          dailyRequests: this.config.USER_DAILY_REQUEST_LIMIT,
          dailyTokens: this.config.USER_DAILY_TOKEN_LIMIT,
          dailyCostNanoInr: toNano(this.config.USER_DAILY_COST_LIMIT_INR),
        },
      });
      const userActive = await tx.generationRequest.count({
        where: { userId: value.userId, status: { in: [...active] } },
      });
      const globalActive = await tx.generationRequest.count({
        where: { status: { in: [...active] } },
      });
      if (
        userActive >= this.config.USER_MAX_ACTIVE_GENERATIONS ||
        globalActive >= this.config.GLOBAL_MAX_ACTIVE_GENERATIONS
      ) {
        throw new StorageError(
          'CONCURRENCY_LIMIT',
          'Another generation is active. Wait or stop it first.',
        );
      }
      const period = dailyPeriod(now, this.config.QUOTA_RESET_TIMEZONE);
      const definitions = [
        {
          scope: 'user_daily' as const,
          ownerKey: value.userId,
          userId: value.userId,
          start: period.start,
          end: period.end,
          costLimit: quota.dailyCostNanoInr,
        },
        {
          scope: 'global_daily' as const,
          ownerKey: 'global',
          userId: null,
          start: period.start,
          end: period.end,
          costLimit: toNano(this.config.GLOBAL_DAILY_COST_LIMIT_INR),
        },
        {
          scope: 'global_total' as const,
          ownerKey: 'global',
          userId: null,
          start: new Date(0),
          end: null,
          costLimit: toNano(this.config.GLOBAL_TOTAL_COST_LIMIT_INR),
        },
      ];
      const price = await this.prices(tx);
      const cost = estimateCost(
        value.inputTokenBound,
        value.outputTokenBound,
        price,
      );
      const tokens = BigInt(value.inputTokenBound + value.outputTokenBound);
      const periods = [];
      for (const definition of definitions) {
        const row = await tx.quotaPeriod.upsert({
          where: {
            scope_ownerKey_periodStart: {
              scope: definition.scope,
              ownerKey: definition.ownerKey,
              periodStart: definition.start,
            },
          },
          create: {
            scope: definition.scope,
            ownerKey: definition.ownerKey,
            userId: definition.userId,
            periodStart: definition.start,
            periodEnd: definition.end,
          },
          update: {},
        });
        if (
          row.costUsedNanoInr + row.costReservedNanoInr + cost.nanoInr >
            definition.costLimit ||
          (definition.scope === 'user_daily' &&
            (row.requestsUsed + row.requestsReserved + 1 >
              quota.dailyRequests ||
              row.tokensUsed + row.tokensReserved + tokens >
                BigInt(quota.dailyTokens)))
        )
          throw new StorageError(
            'QUOTA_EXCEEDED',
            'The available allowance cannot cover this request.',
          );
        periods.push(row);
      }
      const generation = await tx.generationRequest.create({
        data: {
          userId: value.userId,
          conversationId: value.conversationId,
          idempotencyKey: value.idempotencyKey,
          payloadHash: fingerprint,
          model: this.config.GEMINI_MODEL,
          priceSnapshotId: price.id,
          inputTokenBound: value.inputTokenBound,
          outputTokenBound: value.outputTokenBound,
          createdAt: now,
        },
      });
      await tx.quotaReservation.create({
        data: {
          generationId: generation.id,
          // Deadline plus a recovery grace period. There is no blanket refund for
          // work whose dispatch marker was committed before a process crash.
          expiresAt: new Date(
            now.getTime() +
              (this.config.GENERATION_TIMEOUT_SECONDS + 30) * 1000,
          ),
        },
      });
      for (const row of periods) {
        await tx.quotaAllocation.create({
          data: {
            generationId: generation.id,
            quotaPeriodId: row.id,
            requests: 1,
            tokens,
            costNanoInr: cost.nanoInr,
          },
        });
        await tx.quotaPeriod.update({
          where: { id: row.id },
          data: {
            requestsReserved: { increment: 1 },
            tokensReserved: { increment: tokens },
            costReservedNanoInr: { increment: cost.nanoInr },
          },
        });
      }
      await tx.message.createMany({
        data: [
          {
            conversationId: conversation.id,
            generationId: generation.id,
            sequence: conversation.nextSequence,
            role: 'user',
            status: 'completed',
            content: value.content,
            createdAt: now,
          },
          {
            conversationId: conversation.id,
            generationId: generation.id,
            sequence: conversation.nextSequence + 1,
            role: 'assistant',
            status: 'streaming',
            content: '',
            createdAt: now,
          },
        ],
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { nextSequence: { increment: 2 }, updatedAt: now },
      });
      return { generation, replayed: false };
    });
  }

  /** Claim dispatch BEFORE calling Gemini; only a true claim may call upstream. */
  async markDispatched(userId: string, generationId: string) {
    IdSchema.parse(userId);
    IdSchema.parse(generationId);
    return this.atomic(async (tx) => {
      await this.activeUser(tx, userId);
      const row = await tx.generationRequest.findFirst({
        where: { id: generationId, userId },
        include: { reservation: true },
      });
      if (!row) throw new StorageError('NOT_FOUND', 'Generation not found.');
      if (row.status !== 'reserved')
        return { generation: row, dispatch: false };
      if (!row.reservation || row.reservation.expiresAt <= this.now()) {
        throw new StorageError(
          'CONFLICT',
          'The generation reservation has expired.',
        );
      }
      const generation = await tx.generationRequest.update({
        where: { id: row.id },
        data: { status: 'running', dispatchedAt: this.now() },
      });
      return { generation, dispatch: true };
    });
  }

  async checkpoint(userId: string, generationId: string, content: string) {
    IdSchema.parse(userId);
    IdSchema.parse(generationId);
    z.string().max(128000).parse(content);
    return this.atomic(async (tx) => {
      const row = await tx.generationRequest.findFirst({
        where: { id: generationId, userId },
      });
      if (!row) throw new StorageError('NOT_FOUND', 'Generation not found.');
      if (row.status !== 'running') return false;
      await tx.message.updateMany({
        where: { generationId, role: 'assistant' },
        data: { content },
      });
      return true;
    });
  }

  private async settleInTransaction(
    tx: Transaction,
    value: z.infer<typeof SettleSchema>,
    now: Date,
  ) {
    const row = await tx.generationRequest.findFirst({
      where: { id: value.generationId, userId: value.userId },
      include: {
        priceSnapshot: true,
        usage: true,
        reservation: { include: { allocations: true } },
      },
    });
    if (!row) throw new StorageError('NOT_FOUND', 'Generation not found.');
    if (row.usage) return { generation: row, usage: row.usage, settled: false };
    if (!row.reservation || row.reservation.settledAt)
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        'The generation ledger is inconsistent.',
      );
    const dispatched = row.dispatchedAt !== null;
    if (!dispatched && value.status === 'completed')
      throw new StorageError(
        'CONFLICT',
        'An undispatched generation cannot complete.',
      );
    const usage = dispatched ? value.reportedUsage : undefined;
    const uncertain = dispatched && !usage;
    const billedInput =
      usage?.inputTokens ?? (uncertain ? row.inputTokenBound : 0);
    const billedOutput = usage
      ? usage.outputTokens + usage.reasoningTokens
      : uncertain
        ? row.outputTokenBound
        : 0;
    const cost = estimateCost(billedInput, billedOutput, row.priceSnapshot);
    const tokens = BigInt(billedInput + billedOutput);
    const storedUsage = await tx.usageRecord.create({
      data: {
        generationId: row.id,
        inputTokens: uncertain ? null : billedInput,
        outputTokens: uncertain ? null : (usage?.outputTokens ?? 0),
        reasoningTokens: uncertain ? null : (usage?.reasoningTokens ?? 0),
        cachedInputTokens: uncertain ? null : (usage?.cachedInputTokens ?? 0),
        accountedTokens: tokens,
        estimatedCostNanoUsd: cost.nanoUsd,
        estimatedCostNanoInr: cost.nanoInr,
        providerReportedNanoUsd: usage?.providerReportedNanoUsd ?? null,
        accountingStatus: uncertain
          ? 'uncertain'
          : usage
            ? 'reported'
            : 'estimated',
        createdAt: now,
      },
    });
    for (const allocation of row.reservation.allocations) {
      await tx.quotaPeriod.update({
        where: { id: allocation.quotaPeriodId },
        data: {
          requestsReserved: { decrement: allocation.requests },
          tokensReserved: { decrement: allocation.tokens },
          costReservedNanoInr: { decrement: allocation.costNanoInr },
          requestsUsed: { increment: dispatched ? 1 : 0 },
          tokensUsed: { increment: tokens },
          costUsedNanoInr: { increment: cost.nanoInr },
        },
      });
    }
    await tx.quotaReservation.update({
      where: { generationId: row.id },
      data: { settledAt: now },
    });
    await tx.message.updateMany({
      where: { generationId: row.id, role: 'assistant' },
      data: {
        status: value.status,
        ...(value.content !== undefined ? { content: value.content } : {}),
      },
    });
    const generation = await tx.generationRequest.update({
      where: { id: row.id },
      data: {
        status: value.status,
        finishedAt: now,
        errorCode: value.errorCode ?? null,
        ...(value.providerRequestId
          ? { providerRequestId: value.providerRequestId }
          : {}),
      },
    });
    if (row.conversationId)
      await tx.conversation.update({
        where: { id: row.conversationId },
        data: { updatedAt: now },
      });
    return { generation, usage: storedUsage, settled: true };
  }

  async settleGeneration(input: SettleInput) {
    const value = SettleSchema.parse(input);
    return this.atomic((tx) => this.settleInTransaction(tx, value, this.now()));
  }

  async cancelOwnedGeneration(userId: string, generationId: string) {
    IdSchema.parse(userId);
    IdSchema.parse(generationId);
    return this.atomic(async (tx) => {
      await this.activeUser(tx, userId);
      return this.settleInTransaction(
        tx,
        { userId, generationId, status: 'cancelled' },
        this.now(),
      );
    });
  }

  /** Caller must hold withLedgerLock; used by trusted account-status changes. */
  async cancelUserGenerationsInTransaction(
    tx: Transaction,
    userId: string,
    now: Date,
  ) {
    const rows = await tx.generationRequest.findMany({
      where: { userId, status: { in: [...active] } },
    });
    for (const row of rows) {
      await this.settleInTransaction(
        tx,
        { userId, generationId: row.id, status: 'cancelled' },
        now,
      );
    }
  }

  async recoverExpired(batchSize = 50) {
    z.number().int().min(1).max(100).parse(batchSize);
    // One short transaction per recovery item; never one long batch transaction.
    let count = 0;
    for (; count < batchSize; count++) {
      const recovered = await this.atomic(async (tx) => {
        const now = this.now();
        const stale = await tx.quotaReservation.findFirst({
          where: { settledAt: null, expiresAt: { lte: now } },
          orderBy: [{ expiresAt: 'asc' }, { generationId: 'asc' }],
          include: { generation: true },
        });
        if (!stale) return false;
        await this.settleInTransaction(
          tx,
          {
            userId: stale.generation.userId,
            generationId: stale.generationId,
            status: 'interrupted',
            errorCode: 'PROCESS_INTERRUPTED',
          },
          now,
        );
        return true;
      });
      if (!recovered) break;
    }
    return count;
  }

  async deleteConversation(userId: string, conversationId: string) {
    IdSchema.parse(userId);
    IdSchema.parse(conversationId);
    return this.atomic(async (tx) => {
      await this.activeUser(tx, userId);
      await this.ownedConversation(tx, userId, conversationId);
      const pending = await tx.generationRequest.count({
        where: { conversationId, status: { in: [...active] } },
      });
      if (pending)
        throw new StorageError(
          'CONFLICT',
          'Stop the active generation before deleting this chat.',
        );
      // Delete content first, detach accounting second, then remove conversation.
      // Generation/usage/reservation rows survive with no retained plaintext chat.
      await tx.message.deleteMany({ where: { conversationId } });
      await tx.generationRequest.updateMany({
        where: { conversationId, userId },
        data: { conversationId: null },
      });
      await tx.conversation.delete({ where: { id: conversationId } });
    });
  }

  async allowance(userId: string) {
    IdSchema.parse(userId);
    return this.atomic(async (tx) => {
      await this.activeUser(tx, userId);
      const period = dailyPeriod(this.now(), this.config.QUOTA_RESET_TIMEZONE);
      const row = await tx.quotaPeriod.findUnique({
        where: {
          scope_ownerKey_periodStart: {
            scope: 'user_daily',
            ownerKey: userId,
            periodStart: period.start,
          },
        },
      });
      const quota = await tx.userQuota.findUnique({ where: { userId } });
      return {
        period,
        limits: quota ?? {
          dailyRequests: this.config.USER_DAILY_REQUEST_LIMIT,
          dailyTokens: this.config.USER_DAILY_TOKEN_LIMIT,
          dailyCostNanoInr: toNano(this.config.USER_DAILY_COST_LIMIT_INR),
        },
        requestsUsed: row?.requestsUsed ?? 0,
        requestsReserved: row?.requestsReserved ?? 0,
        tokensUsed: row?.tokensUsed ?? 0n,
        tokensReserved: row?.tokensReserved ?? 0n,
        costUsedNanoInr: row?.costUsedNanoInr ?? 0n,
        costReservedNanoInr: row?.costReservedNanoInr ?? 0n,
      };
    });
  }
}
