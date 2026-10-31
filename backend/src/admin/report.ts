import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AdminUsageQuerySchema,
  AdminUsageResponseSchema,
  AdminGenerationListResponseSchema,
  GenerationStatusSchema,
} from '@query-assistant/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../storage/database.js';
import type { Config } from '../config.js';
import { dailyPeriod } from '../storage/period.js';
import { fromNano, toNano } from '../storage/money.js';
import { publicUser } from '../auth/service.js';
import { beforeDate, decodeCursor, encodeCursor } from '../auth/pagination.js';

const userSelect = {
  id: true,
  username: true,
  role: true,
  status: true,
  createdAt: true,
} as const;
type Query = z.infer<typeof AdminUsageQuerySchema>;
const money = (amount: bigint, currency: 'INR' | 'USD' = 'INR') => ({
  amount: fromNano(amount),
  currency,
});
const scopeFor = (kind: string, q: Query) =>
  `${kind}:${createHash('sha256')
    .update(JSON.stringify([q.from, q.to, q.userId, q.outcome]))
    .digest('hex')}`;
const whereFor = (q: Query): Prisma.GenerationRequestWhereInput => ({
  ...(q.from || q.to
    ? {
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lt: new Date(q.to) } : {}),
        },
      }
    : {}),
  ...(q.userId ? { userId: q.userId } : {}),
  ...(q.outcome ? { status: q.outcome } : {}),
});
// Parameterized fragments only. No prompt/message tables or provider identifiers.
const sqlWhere = (q: Query) => Prisma.sql`WHERE TRUE
  ${q.from ? Prisma.sql`AND g."createdAt" >= ${new Date(q.from)}` : Prisma.empty}
  ${q.to ? Prisma.sql`AND g."createdAt" < ${new Date(q.to)}` : Prisma.empty}
  ${q.userId ? Prisma.sql`AND g."userId" = ${q.userId}::uuid` : Prisma.empty}
  ${q.outcome ? Prisma.sql`AND g.status::text = ${q.outcome}` : Prisma.empty}`;
const aggregate = Prisma.sql`
 COUNT(*)::bigint AS requests,
 COUNT(g."dispatchedAt")::bigint AS dispatched,
 COUNT(*) FILTER (WHERE g.status IN ('reserved','running'))::bigint AS pending,
 COUNT(*) FILTER (WHERE u."generationId" IS NULL)::bigint AS missing,
 COUNT(*) FILTER (WHERE u."accountingStatus" = 'uncertain')::bigint AS uncertain,
 COUNT(*) FILTER (WHERE u."accountingStatus" = 'reported')::bigint AS reported,
 COUNT(*) FILTER (WHERE u."accountingStatus" = 'estimated')::bigint AS estimated,
 COUNT(u."providerReportedNanoUsd")::bigint AS "providerCount",
 COALESCE(SUM(u."inputTokens"),0)::bigint AS input,
 COALESCE(SUM(u."outputTokens"),0)::bigint AS output,
 COALESCE(SUM(u."cachedInputTokens"),0)::bigint AS cached,
 COALESCE(SUM(u."reasoningTokens"),0)::bigint AS reasoning,
 COALESCE(SUM(u."accountedTokens"),0)::bigint AS accounted,
 COALESCE(SUM(u."estimatedCostNanoInr"),0)::bigint AS cost,
 SUM(u."providerReportedNanoUsd")::bigint AS "providerCost",
 COUNT(g."finishedAt")::bigint AS "latencySamples",
 AVG(EXTRACT(EPOCH FROM (g."finishedAt" - g."createdAt"))*1000)::float8 AS latency,
 COUNT(*) FILTER (WHERE g.status = 'reserved')::bigint AS reserved,
 COUNT(*) FILTER (WHERE g.status = 'running')::bigint AS running,
 COUNT(*) FILTER (WHERE g.status = 'completed')::bigint AS completed,
 COUNT(*) FILTER (WHERE g.status = 'cancelled')::bigint AS cancelled,
 COUNT(*) FILTER (WHERE g.status = 'failed')::bigint AS failed,
 COUNT(*) FILTER (WHERE g.status = 'interrupted')::bigint AS interrupted`;
type Aggregate = Record<
  | 'requests'
  | 'dispatched'
  | 'pending'
  | 'missing'
  | 'uncertain'
  | 'reported'
  | 'estimated'
  | 'providerCount'
  | 'input'
  | 'output'
  | 'cached'
  | 'reasoning'
  | 'accounted'
  | 'cost'
  | 'latencySamples'
  | 'reserved'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted',
  bigint
> & { providerCost: bigint | null; latency: number | null };
const summaryDto = (a: Aggregate) => ({
  requests: Number(a.requests),
  dispatchedRequests: Number(a.dispatched),
  pendingRequests: Number(a.pending),
  missingUsageRequests: Number(a.missing),
  uncertainRequests: Number(a.uncertain),
  reportedTokenRequests: Number(a.reported),
  estimatedUsageRequests: Number(a.estimated),
  providerReportedCostRequests: Number(a.providerCount),
  inputTokens: Number(a.input),
  outputTokens: Number(a.output),
  cachedInputTokens: Number(a.cached),
  reasoningTokens: Number(a.reasoning),
  accountedTokens: Number(a.accounted),
  estimatedCost: money(a.cost),
  providerReportedCost:
    a.providerCost === null ? null : money(a.providerCost, 'USD'),
  meanLatencyMs: a.latency,
  latencySamples: Number(a.latencySamples),
  outcomes: GenerationStatusSchema.options.map((status) => ({
    status,
    count: Number(a[status]),
  })),
});

export async function usageReport(
  db: Database,
  config: Config,
  q: Query,
  now = new Date(),
) {
  const scope = scopeFor('usage', q),
    cursor = decodeCursor(q.cursor, scope);
  const period = dailyPeriod(now, config.QUOTA_RESET_TIMEZONE);
  // Every query in this response observes one MVCC snapshot; reports never hold
  // the ledger write lock or materialize every generation in Node memory.
  return db.$transaction(
    async (tx) => {
      const totals = await tx.$queryRaw<Aggregate[]>(
        Prisma.sql`SELECT ${aggregate} FROM "GenerationRequest" g LEFT JOIN "UsageRecord" u ON u."generationId" = g.id ${sqlWhere(q)}`,
      );
      const users = await tx.user.findMany({
        select: userSelect,
        where: { generations: { some: whereFor(q) }, ...beforeDate(cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = users.slice(0, q.limit),
        last = page.at(-1);
      const grouped = page.length
        ? await tx.$queryRaw<(Aggregate & { userId: string })[]>(
            Prisma.sql`SELECT g."userId", ${aggregate} FROM "GenerationRequest" g LEFT JOIN "UsageRecord" u ON u."generationId" = g.id ${sqlWhere(q)} AND g."userId" IN (${Prisma.join(page.map((u) => Prisma.sql`${u.id}::uuid`))}) GROUP BY g."userId"`,
          )
        : [];
      const budget = async (
        scope: 'global_daily' | 'global_total',
        start: Date,
        limit: string,
      ) => {
        const row = await tx.quotaPeriod.findUnique({
          where: {
            scope_ownerKey_periodStart: {
              scope,
              ownerKey: 'global',
              periodStart: start,
            },
          },
        });
        const max = toNano(limit),
          used = row?.costUsedNanoInr ?? 0n,
          reserved = row?.costReservedNanoInr ?? 0n;
        return {
          limit: money(max),
          used: money(used),
          reserved: money(reserved),
          remaining: money(max > used + reserved ? max - used - reserved : 0n),
        };
      };
      return AdminUsageResponseSchema.parse({
        summary: summaryDto(totals[0]!),
        perUser: page.map((user) => ({
          user: publicUser(user),
          usage: summaryDto(grouped.find((a) => a.userId === user.id)!),
        })),
        nextCursor:
          users.length > q.limit && last
            ? encodeCursor(scope, { id: last.id, at: last.createdAt })
            : null,
        budgetPeriodStart: period.start.toISOString(),
        budgetResetsAt: period.end.toISOString(),
        globalDailyBudget: await budget(
          'global_daily',
          period.start,
          config.GLOBAL_DAILY_COST_LIMIT_INR,
        ),
        globalTotalBudget: await budget(
          'global_total',
          new Date(0),
          config.GLOBAL_TOTAL_COST_LIMIT_INR,
        ),
        timezone: config.QUOTA_RESET_TIMEZONE,
        lastUpdatedAt: now.toISOString(),
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 10000,
    },
  );
}

export async function generationReport(db: Database, q: Query) {
  const scope = scopeFor('generations', q),
    cursor = decodeCursor(q.cursor, scope);
  const rows = await db.generationRequest.findMany({
    where: { ...whereFor(q), ...beforeDate(cursor) },
    include: { user: { select: userSelect }, usage: true, priceSnapshot: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit),
    last = page.at(-1);
  return AdminGenerationListResponseSchema.parse({
    items: page.map((g) => ({
      id: g.id,
      user: publicUser(g.user),
      status: g.status,
      createdAt: g.createdAt.toISOString(),
      dispatchedAt: g.dispatchedAt?.toISOString() ?? null,
      finishedAt: g.finishedAt?.toISOString() ?? null,
      latencyMs: g.finishedAt
        ? g.finishedAt.getTime() - g.createdAt.getTime()
        : null,
      errorCode: g.errorCode,
      accountedTokens: g.usage ? Number(g.usage.accountedTokens) : null,
      usage: g.usage
        ? {
            inputTokens: g.usage.inputTokens,
            outputTokens: g.usage.outputTokens,
            cachedInputTokens: g.usage.cachedInputTokens,
            reasoningTokens: g.usage.reasoningTokens,
            accountingStatus: g.usage.accountingStatus,
            estimatedCost: money(g.usage.estimatedCostNanoInr),
            providerReportedCost:
              g.usage.providerReportedNanoUsd === null
                ? null
                : money(g.usage.providerReportedNanoUsd, 'USD'),
            priceVersion: g.priceSnapshot.version,
          }
        : null,
      price: {
        version: g.priceSnapshot.version,
        model: g.priceSnapshot.model,
        inputUsdPerMillion: fromNano(g.priceSnapshot.inputNanoUsdPerMillion),
        outputUsdPerMillion: fromNano(g.priceSnapshot.outputNanoUsdPerMillion),
        inrPerUsd: fromNano(g.priceSnapshot.inrPerUsdNano),
      },
    })),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor(scope, { id: last.id, at: last.createdAt })
        : null,
  });
}
