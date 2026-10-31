import { z } from 'zod';

export const limits = {
  promptCharacters: 8_000,
  titleCharacters: 120,
  pageSize: 100,
} as const;

export const IdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: false });
export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/)
  .transform((value) => value.toLowerCase());
export const PasswordSchema = z.string().min(12).max(128);
export const ActivationCodeSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const RoleSchema = z.enum(['user', 'admin']);
export const AccountStatusSchema = z.enum(['active', 'suspended', 'revoked']);
export const AccessRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'activated',
]);
export const GenerationStatusSchema = z.enum([
  'reserved',
  'running',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
export const FinalGenerationStatusSchema = GenerationStatusSchema.exclude([
  'reserved',
  'running',
]);
export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'ACCOUNT_DISABLED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_ACTIVATION',
  'CSRF_INVALID',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'CONCURRENCY_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'GENERATION_TIMEOUT',
  'STORAGE_UNAVAILABLE',
  'SERVICE_NOT_READY',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
]);
export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(300),
    requestId: IdSchema,
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

// Decimal strings avoid losing precision in JSON money fields. These represent
// whole currency units (e.g. "0.000125" USD), never binary floating-point totals.
export const MoneySchema = z.strictObject({
  amount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,9})?$/),
  currency: z.enum(['USD', 'INR']),
});
export const MeterSchema = z.strictObject({
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export const CostAllowanceSchema = z.strictObject({
  limit: MoneySchema,
  used: MoneySchema,
  reserved: MoneySchema,
  remaining: MoneySchema,
});
export const AllowanceSchema = z.strictObject({
  periodStart: TimestampSchema,
  resetsAt: TimestampSchema,
  resetTimezone: z.string(),
  requests: MeterSchema,
  tokens: MeterSchema,
  estimatedCost: CostAllowanceSchema,
  generationAvailable: z.boolean(),
});
export const UserSchema = z.strictObject({
  id: IdSchema,
  username: UsernameSchema,
  role: RoleSchema,
  status: AccountStatusSchema,
  createdAt: TimestampSchema,
});
export const CurrentUserResponseSchema = z.strictObject({
  user: UserSchema,
  allowance: AllowanceSchema,
});
export const AccessRequestBodySchema = z.strictObject({
  username: UsernameSchema,
});
// Same response regardless of whether the username already exists.
export const AccessRequestResponseSchema = z.strictObject({
  message: z.string(),
});
export const ActivateBodySchema = z.strictObject({
  username: UsernameSchema,
  activationCode: ActivationCodeSchema,
  password: PasswordSchema,
});
export const LoginBodySchema = z.strictObject({
  username: UsernameSchema,
  password: z.string().min(1).max(128),
});
export const SessionResponseSchema = z.strictObject({
  user: UserSchema,
  expiresAt: TimestampSchema,
});
export const CsrfResponseSchema = z.strictObject({
  csrfToken: z.string().min(32).max(256),
});

export const PaginationQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(limits.pageSize).default(30),
});
export const ResourceParamsSchema = z.strictObject({ id: IdSchema });
export const ConversationSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1).max(limits.titleCharacters),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CreateConversationBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(limits.titleCharacters).optional(),
});
export const CreateConversationResponseSchema = z.strictObject({
  conversation: ConversationSchema,
});
export const ConversationListResponseSchema = z.strictObject({
  items: z.array(ConversationSchema),
  nextCursor: z.string().nullable(),
});
export const MessageSchema = z.strictObject({
  id: IdSchema,
  conversationId: IdSchema,
  generationId: IdSchema.nullable(),
  sequence: z.number().int().positive(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum([
    'completed',
    'streaming',
    'cancelled',
    'failed',
    'interrupted',
  ]),
  createdAt: TimestampSchema,
});
export const MessageListResponseSchema = z.strictObject({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
});
export const SubmitMessageBodySchema = z.strictObject({
  content: z.string().trim().min(1).max(limits.promptCharacters),
});
export const IdempotencyHeadersSchema = z.object({
  'idempotency-key': IdSchema,
});
export const GenerationSchema = z.strictObject({
  id: IdSchema,
  conversationId: IdSchema,
  status: GenerationStatusSchema,
  assistantMessageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export const GenerationResponseSchema = z.strictObject({
  generation: GenerationSchema,
});
export const SubmitMessageResponseSchema = z.strictObject({
  generation: GenerationSchema,
  userMessage: MessageSchema,
  eventsUrl: z.string().regex(/^\/api\/generations\/[0-9a-f-]+\/events$/),
  replayed: z.boolean(),
});
export const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  accountingStatus: z.enum(['reported', 'estimated', 'uncertain']),
  estimatedCost: MoneySchema.nullable(),
  providerReportedCost: MoneySchema.nullable(),
  priceVersion: z.string(),
});
// Read-only persisted submission recovery. Primary POST uses the early receipt.
export const AnswerResponseSchema = z.strictObject({
  generation: GenerationSchema,
  userMessage: MessageSchema,
  assistantMessage: MessageSchema,
  usage: UsageSchema.nullable(),
  replayed: z.boolean(),
  failure: z
    .strictObject({
      code: ErrorCodeSchema,
      message: z.string().min(1).max(300),
    })
    .nullable(),
});
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('started'),
    generationId: IdSchema,
    assistantMessageId: IdSchema,
  }),
  z.strictObject({
    type: z.literal('delta'),
    generationId: IdSchema,
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal('completed'),
    generationId: IdSchema,
    usage: UsageSchema,
  }),
  z.strictObject({
    type: z.literal('cancelled'),
    generationId: IdSchema,
    usage: UsageSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    generationId: IdSchema,
    error: ApiErrorSchema.shape.error,
    usage: UsageSchema,
  }),
]);

export const AdminDateFilterSchema = z
  .strictObject({
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    userId: IdSchema.optional(),
    outcome: GenerationStatusSchema.optional(),
  })
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.from).getTime() < new Date(value.to).getTime(),
    {
      message: 'from must be earlier than to',
    },
  );
export const AdminPageQuerySchema = PaginationQuerySchema.extend({
  status: AccountStatusSchema.optional(),
});
export const AdminUsageQuerySchema = AdminDateFilterSchema.safeExtend(
  PaginationQuerySchema.shape,
);
export const AdminAccessRequestQuerySchema = PaginationQuerySchema.extend({
  status: AccessRequestStatusSchema.optional(),
});
export const AccessRequestSchema = z.strictObject({
  id: IdSchema,
  username: UsernameSchema,
  status: AccessRequestStatusSchema,
  createdAt: TimestampSchema,
});
export const AccessRequestListResponseSchema = z.strictObject({
  items: z.array(AccessRequestSchema),
  nextCursor: z.string().nullable(),
});
export const ApprovalResponseSchema = z.strictObject({
  request: AccessRequestSchema,
  activationCode: ActivationCodeSchema,
  expiresAt: TimestampSchema,
});
export const AdminAccessRequestResponseSchema = z.strictObject({
  request: AccessRequestSchema,
});
export const AuditReasonSchema = z.string().trim().min(1).max(300);
export const AdminReasonBodySchema = z.strictObject({
  reason: AuditReasonSchema,
});
export const AccountChangeBodySchema = z.strictObject({
  status: AccountStatusSchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: AuditReasonSchema,
});
export const UserQuotaSchema = z.strictObject({
  dailyRequests: z.number().int().min(0).max(10000),
  dailyTokens: z.number().int().min(0).max(10000000),
  dailyCostLimitInr: z
    .string()
    .max(6)
    .regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/)
    .refine(
      (value) => Number(value) <= 100,
      'Daily cost must be at most INR 100.',
    ),
});
export const QuotaChangeBodySchema = UserQuotaSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  reason: AuditReasonSchema,
});
export const AdminUserSchema = z.strictObject({
  user: UserSchema,
  quota: UserQuotaSchema,
  version: z.number().int().nonnegative(),
});
export const AdminUserResponseSchema = z.strictObject({
  account: AdminUserSchema,
});
export const AdminUserListResponseSchema = z.strictObject({
  items: z.array(AdminUserSchema),
  nextCursor: z.string().nullable(),
});
export const UsageSummarySchema = z.strictObject({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  estimatedCost: MoneySchema,
  providerReportedCost: MoneySchema.nullable(),
  uncertainRequests: z.number().int().nonnegative(),
  dispatchedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  missingUsageRequests: z.number().int().nonnegative(),
  reportedTokenRequests: z.number().int().nonnegative(),
  estimatedUsageRequests: z.number().int().nonnegative(),
  providerReportedCostRequests: z.number().int().nonnegative(),
  accountedTokens: z.number().int().nonnegative(),
  latencySamples: z.number().int().nonnegative(),
  outcomes: z.array(
    z.strictObject({
      status: GenerationStatusSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  meanLatencyMs: z.number().nonnegative().nullable(),
});
export const AdminUsageResponseSchema = z.strictObject({
  summary: UsageSummarySchema,
  perUser: z.array(
    z.strictObject({ user: UserSchema, usage: UsageSummarySchema }),
  ),
  nextCursor: z.string().nullable(),
  budgetPeriodStart: TimestampSchema,
  budgetResetsAt: TimestampSchema,
  globalDailyBudget: CostAllowanceSchema,
  globalTotalBudget: CostAllowanceSchema,
  timezone: z.string(),
  lastUpdatedAt: TimestampSchema,
});
export const AdminGenerationSchema = z.strictObject({
  id: IdSchema,
  user: UserSchema,
  status: GenerationStatusSchema,
  createdAt: TimestampSchema,
  dispatchedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  usage: UsageSchema.nullable(),
  accountedTokens: z.number().int().nonnegative().nullable(),
  price: z.strictObject({
    version: z.string(),
    model: z.string(),
    inputUsdPerMillion: z.string(),
    outputUsdPerMillion: z.string(),
    inrPerUsd: z.string(),
  }),
});
export const AdminGenerationListResponseSchema = z.strictObject({
  items: z.array(AdminGenerationSchema),
  nextCursor: z.string().nullable(),
});
export const LivenessResponseSchema = z.strictObject({
  status: z.literal('ok'),
  requestId: IdSchema,
});
export const ReadinessResponseSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({
    configuration: z.boolean(),
    database: z.boolean(),
    application: z.boolean(),
  }),
  requestId: IdSchema,
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
export type SubmitMessageBody = z.infer<typeof SubmitMessageBodySchema>;
export type SubmitMessageResponse = z.infer<typeof SubmitMessageResponseSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type Generation = z.infer<typeof GenerationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type User = z.infer<typeof UserSchema>;

// All other request/response types are derived from these exported Zod schemas
// with z.infer; there is no parallel hand-maintained interface definition.
