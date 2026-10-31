import {
  AnswerResponseSchema,
  SubmitMessageResponseSchema,
  StreamEventSchema,
} from '@query-assistant/contracts';
import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import { Storage } from '../storage/store.js';
import { fromNano } from '../storage/money.js';
import { AppError } from '../errors.js';
import type { ErrorCode } from '@query-assistant/contracts';
import { abortable, providerFailure, systemInstruction } from './provider.js';
import { ProviderCooldown, ProviderHttpError } from './resilience.js';
import type { TextProvider, Turn, ProviderChunk } from './provider.js';

const failureMessages: Partial<Record<ErrorCode, string>> = {
  PROVIDER_REJECTED:
    'The model did not return a complete answer. A safety restriction or output limit may have stopped it.',
  PROVIDER_UNAVAILABLE: 'The model service could not complete this request.',
  GENERATION_TIMEOUT:
    'The request timed out. Dispatched work may still incur usage.',
  STORAGE_UNAVAILABLE:
    'Storage is temporarily unavailable. Check saved history before submitting again.',
  VALIDATION_ERROR: 'The question exceeds the configured context limit.',
};

type Event = import('zod').infer<typeof StreamEventSchema>;
type Sink = (event: Event) => Promise<void>;
type Input = {
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  content: string;
};
type Live = {
  input: Input;
  id: string;
  controller: AbortController;
  cancelled: boolean;
  requestId?: string;
  attached: boolean;
  ready: Promise<void>;
  release: () => void;
  done: Promise<void>;
  sink?: Sink;
  content: string;
};

export class Chat {
  private readonly live = new Map<string, Live>();
  private closing = false;
  readonly cooldown = new ProviderCooldown();
  get available() {
    return !this.closing && this.cooldown.available;
  }
  readonly storage: Storage;
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly provider: TextProvider,
    private readonly report: (event: {
      category: string;
      phase: string;
      generationId: string;
      requestId?: string;
      upstreamStatus?: number;
      retryAfterSeconds?: number;
    }) => void = () => {},
  ) {
    this.storage = new Storage(db, config);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Storage is unavailable. Try again later.',
      );
    }
  }

  async receipt(
    userId: string,
    conversationId: string,
    generationId: string,
    replayed: boolean,
  ) {
    const row = await this.safe(() =>
      this.db.generationRequest.findFirst({
        where: { id: generationId, userId, conversationId },
        include: {
          messages: { orderBy: { sequence: 'asc' } },
          usage: true,
          priceSnapshot: true,
        },
      }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Submission not found.');
    const userMessage = row.messages.find((m) => m.role === 'user');
    const assistantMessage = row.messages.find((m) => m.role === 'assistant');
    if (!userMessage || !assistantMessage)
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'The saved submission is incomplete.',
      );
    const message = (m: typeof userMessage) => ({
      id: m.id,
      conversationId,
      generationId: m.generationId,
      sequence: m.sequence,
      role: m.role,
      content: m.content,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    });
    return AnswerResponseSchema.parse({
      generation: {
        id: row.id,
        conversationId,
        status: row.status,
        assistantMessageId: assistantMessage.id,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      },
      userMessage: message(userMessage),
      assistantMessage: message(assistantMessage),
      replayed,
      usage: row.usage
        ? {
            inputTokens: row.usage.inputTokens,
            outputTokens: row.usage.outputTokens,
            reasoningTokens: row.usage.reasoningTokens,
            cachedInputTokens: row.usage.cachedInputTokens,
            accountingStatus: row.usage.accountingStatus,
            estimatedCost: {
              amount: fromNano(row.usage.estimatedCostNanoInr),
              currency: 'INR',
            },
            providerReportedCost:
              row.usage.providerReportedNanoUsd === null
                ? null
                : {
                    amount: fromNano(row.usage.providerReportedNanoUsd),
                    currency: 'USD',
                  },
            priceVersion: row.priceSnapshot.version,
          }
        : null,
      failure: row.errorCode
        ? {
            code: failureMessages[row.errorCode as ErrorCode]
              ? row.errorCode
              : 'PROVIDER_UNAVAILABLE',
            message:
              failureMessages[row.errorCode as ErrorCode] ??
              'The request did not complete. Check its saved status before starting another request.',
          }
        : null,
    });
  }

  async byKey(userId: string, conversationId: string, idempotencyKey: string) {
    const row = await this.safe(() =>
      this.db.generationRequest.findFirst({
        where: { userId, conversationId, idempotencyKey },
        select: { id: true },
      }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Submission not found.');
    return this.receipt(userId, conversationId, row.id, true);
  }

  private async context(
    userId: string,
    conversationId: string,
    generationId: string,
    content: string,
  ) {
    const current = await this.safe(() =>
      this.db.message.findFirst({
        where: {
          generationId,
          conversationId,
          role: 'user',
          generation: { userId },
        },
        select: { sequence: true },
      }),
    );
    if (!current) throw new AppError('NOT_FOUND', 'Submission not found.');
    // Only complete user/assistant pairs from earlier successful generations.
    // A bounded recent window prevents unbounded database reads on long chats.
    const previous = await this.safe(() =>
      this.db.message.findMany({
        where: {
          conversationId,
          role: 'assistant',
          status: 'completed',
          sequence: { lt: current.sequence },
          generation: { userId, status: 'completed' },
        },
        orderBy: { sequence: 'desc' },
        take: 20,
        include: {
          generation: {
            select: {
              messages: {
                where: { role: 'user', status: 'completed' },
                take: 1,
              },
            },
          },
        },
      }),
    );
    const pairs: Turn[][] = [];
    let bytes = Buffer.byteLength(systemInstruction + content);
    for (const assistant of previous) {
      const user = assistant.generation?.messages[0];
      if (!user || !assistant.content) continue;
      bytes +=
        Buffer.byteLength(user.content) + Buffer.byteLength(assistant.content);
      if (bytes > 64000) break;
      pairs.unshift([
        { role: 'user', text: user.content },
        { role: 'model', text: assistant.content },
      ]);
    }
    return { pairs, prompt: { role: 'user' as const, text: content } };
  }

  async submit(
    input: Input,
    authorize: () => Promise<void>,
    requestId?: string,
  ) {
    if (this.closing)
      throw new AppError('SERVICE_NOT_READY', 'The server is shutting down.');
    if (!this.cooldown.available) {
      const existing = await this.safe(() =>
        this.db.generationRequest.findFirst({
          where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
          select: { id: true },
        }),
      );
      if (!existing) this.cooldown.ensure(); // Replays still validate their fingerprint below.
    }
    const reserved = await this.storage.reserveGeneration({
      ...input,
      inputTokenBound: this.config.MAX_CONTEXT_TOKENS,
      outputTokenBound: this.config.MAX_OUTPUT_TOKENS,
    });
    const id = reserved.generation.id;
    if (!reserved.replayed) {
      if (this.live.size >= this.config.GLOBAL_MAX_ACTIVE_GENERATIONS) {
        await this.storage.cancelOwnedGeneration(input.userId, id);
        throw new AppError(
          'CONCURRENCY_LIMIT',
          'The server is busy finishing another request.',
        );
      }
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry: Live = {
        input,
        id,
        ...(requestId ? { requestId } : {}),
        controller: new AbortController(),
        cancelled: false,
        attached: false,
        ready,
        release,
        done: Promise.resolve(),
        content: '',
      };
      this.live.set(id, entry);
      // The POST starts exactly one job. Attachment only releases its initial gate.
      entry.done = this.execute(entry, authorize)
        .catch((error: unknown) => {
          this.report({
            category: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
            phase: 'finalization',
            generationId: id,
            ...(entry.requestId ? { requestId: entry.requestId } : {}),
          });
          // No fabricated terminal event if persistence failed. Recovery owns the
          // durable reservation; the client resolves the incomplete transport.
        })
        .finally(() => {
          this.live.delete(id);
        });
    }
    const receipt = await this.receipt(
      input.userId,
      input.conversationId,
      id,
      reserved.replayed,
    );
    return SubmitMessageResponseSchema.parse({
      generation: receipt.generation,
      userMessage: receipt.userMessage,
      eventsUrl: `/api/generations/${id}/events`,
      replayed: reserved.replayed,
    });
  }

  async open(
    userId: string,
    id: string,
    requestId: string,
  ): Promise<(sink: Sink) => Promise<void>> {
    const row = await this.safe(() =>
      this.db.generationRequest.findFirst({
        where: { id, userId },
        select: { conversationId: true },
      }),
    );
    if (!row?.conversationId)
      throw new AppError('NOT_FOUND', 'Generation not found.');
    const receipt = await this.receipt(userId, row.conversationId, id, true);
    if (!['reserved', 'running'].includes(receipt.generation.status)) {
      return async (sink) => {
        await this.sendResult(receipt, sink, requestId, true);
      };
    }
    const entry = this.live.get(id);
    if (!entry || entry.input.userId !== userId)
      throw new AppError(
        'CONFLICT',
        'This live stream is unavailable. Check saved history; it will not restart automatically.',
      );
    if (entry.attached)
      throw new AppError(
        'CONFLICT',
        'This generation already has a stream subscriber.',
      );
    entry.attached = true;
    entry.requestId = requestId;
    return async (sink) => {
      entry.sink = sink;
      entry.release();
      await entry.done;
    };
  }

  private async sendResult(
    receipt: Awaited<ReturnType<Chat['receipt']>>,
    sink: Sink,
    requestId: string,
    replay: boolean,
  ) {
    const generationId = receipt.generation.id;
    if (replay) {
      await sink({
        type: 'started',
        generationId,
        assistantMessageId: receipt.assistantMessage.id,
      });
      for (let i = 0; i < receipt.assistantMessage.content.length; i += 4096)
        await sink({
          type: 'delta',
          generationId,
          text: receipt.assistantMessage.content.slice(i, i + 4096),
        });
    }
    if (!receipt.usage) return; // Missing persistence is never a successful terminal.
    if (
      receipt.generation.status === 'completed' ||
      receipt.generation.status === 'cancelled'
    ) {
      await sink({
        type: receipt.generation.status,
        generationId,
        usage: receipt.usage,
      });
    } else {
      await sink({
        type: 'error',
        generationId,
        usage: receipt.usage,
        error: {
          code: receipt.failure?.code ?? 'PROVIDER_UNAVAILABLE',
          message:
            receipt.failure?.message ??
            'The generation was interrupted. Check saved history.',
          requestId,
          retryable: false,
        },
      });
    }
  }

  private async idle<T>(entry: Live, operation: Promise<T>): Promise<T> {
    const timer = setTimeout(
      () =>
        entry.controller.abort(
          new AppError(
            'GENERATION_TIMEOUT',
            'The model stream was idle for too long.',
          ),
        ),
      this.config.STREAM_IDLE_TIMEOUT_SECONDS * 1000,
    );
    try {
      return await abortable(operation, entry.controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(entry: Live, authorize: () => Promise<void>) {
    const { input, id: generationId, controller } = entry;
    const signal = controller.signal;
    const overall = setTimeout(
      () =>
        controller.abort(
          new AppError(
            'GENERATION_TIMEOUT',
            failureMessages.GENERATION_TIMEOUT!,
          ),
        ),
      this.config.GENERATION_TIMEOUT_SECONDS * 1000,
    );
    const attachment = setTimeout(() => {
      entry.cancelled = true;
      controller.abort(
        new AppError('PROVIDER_UNAVAILABLE', 'No stream client attached.'),
      );
    }, 15000);
    let final: Extract<ProviderChunk, { type: 'final' }> | undefined;
    let iterator: AsyncIterator<ProviderChunk> | undefined;
    let status: 'completed' | 'failed' | 'cancelled';
    let errorCode: string | undefined;
    let lastCheckpoint = Date.now();
    let remoteWaiting = false;
    let phase = 'attachment';
    try {
      await abortable(entry.ready, signal);
      clearTimeout(attachment);
      const initial = await this.receipt(
        input.userId,
        input.conversationId,
        generationId,
        false,
      );
      await entry.sink!({
        type: 'started',
        generationId,
        assistantMessageId: initial.assistantMessage.id,
      });
      await authorize();
      signal.throwIfAborted();
      phase = 'context';
      this.cooldown.ensure();
      const { pairs, prompt } = await this.context(
        input.userId,
        input.conversationId,
        generationId,
        input.content,
      );
      let turns = [...pairs.flat(), prompt];
      while (true) {
        signal.throwIfAborted();
        phase = 'preflight';
        remoteWaiting = true;
        const tokens = await this.idle(
          entry,
          this.provider.countTokens(turns, signal),
        );
        remoteWaiting = false;
        if (!Number.isSafeInteger(tokens) || tokens <= 0)
          throw new AppError(
            'PROVIDER_UNAVAILABLE',
            failureMessages.PROVIDER_UNAVAILABLE!,
          );
        if (tokens <= this.config.MAX_CONTEXT_TOKENS) break;
        if (!pairs.length)
          throw new AppError(
            'VALIDATION_ERROR',
            failureMessages.VALIDATION_ERROR!,
          );
        pairs.splice(0, Math.ceil(pairs.length / 2));
        turns = [...pairs.flat(), prompt];
      }
      await authorize();
      signal.throwIfAborted();
      const claim = await this.storage.markDispatched(
        input.userId,
        generationId,
      );
      if (!claim.dispatch) {
        entry.cancelled = true;
        throw new AppError('CONFLICT', 'The generation is no longer active.');
      }
      signal.throwIfAborted();
      phase = 'stream';
      iterator = this.provider.stream(turns, signal)[Symbol.asyncIterator]();
      while (true) {
        remoteWaiting = true;
        const next = await this.idle(entry, iterator.next());
        remoteWaiting = false;
        signal.throwIfAborted();
        if (next.done) break;
        if (final)
          throw new AppError(
            'PROVIDER_REJECTED',
            'The stream continued after its final outcome.',
          );
        if (next.value.type === 'final') {
          final = next.value;
          continue;
        }
        if (entry.content.length + next.value.text.length > 128000)
          throw new AppError(
            'PROVIDER_REJECTED',
            'The model exceeded the response size limit.',
          );
        entry.content += next.value.text;
        if (Date.now() - lastCheckpoint >= 1000) {
          await authorize();
          const saved = await this.storage.checkpoint(
            input.userId,
            generationId,
            entry.content,
          );
          if (!saved) {
            entry.cancelled = true;
            throw new AppError(
              'CONFLICT',
              'The generation is no longer active.',
            );
          }
          lastCheckpoint = Date.now();
        }
        for (let i = 0; i < next.value.text.length; i += 4096)
          await entry.sink!({
            type: 'delta',
            generationId,
            text: next.value.text.slice(i, i + 4096),
          });
      }
      if (!final)
        throw new AppError(
          'PROVIDER_UNAVAILABLE',
          'The stream ended without a final outcome.',
        );
      status = final.completed && entry.content.trim() ? 'completed' : 'failed';
      if (status === 'failed') errorCode = 'PROVIDER_REJECTED';
      this.cooldown.success();
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      if (remoteWaiting && !entry.cancelled) this.cooldown.failure(cause);
      this.report({
        category: entry.cancelled
          ? 'GENERATION_CANCELLED'
          : providerFailure(cause).code,
        phase,
        generationId,
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        ...(cause instanceof ProviderHttpError
          ? { upstreamStatus: cause.status }
          : {}),
        ...(this.cooldown.remaining
          ? { retryAfterSeconds: this.cooldown.remaining }
          : {}),
      });
      status = entry.cancelled ? 'cancelled' : 'failed';
      errorCode = entry.cancelled
        ? undefined
        : providerFailure(signal.aborted ? signal.reason : error).code;
      // Incomplete/aborted streams cannot treat intermediate usage as final.
      final = undefined;
      if (!signal.aborted)
        controller.abort(
          new AppError('PROVIDER_UNAVAILABLE', 'The stream ended.'),
        );
    } finally {
      clearTimeout(attachment);
      clearTimeout(overall);
      // Do not let a broken iterator keep cancellation/shutdown waiting forever.
      if (iterator?.return)
        void Promise.resolve(iterator.return()).catch(() => {});
    }
    await this.storage.settleGeneration({
      userId: input.userId,
      generationId,
      status,
      content: entry.content,
      ...(final?.usage ? { reportedUsage: final.usage } : {}),
      ...(final?.providerRequestId
        ? { providerRequestId: final.providerRequestId }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    if (entry.sink) {
      const receipt = await this.receipt(
        input.userId,
        input.conversationId,
        generationId,
        false,
      );
      await this.sendResult(receipt, entry.sink, entry.requestId!, false);
    }
  }

  disconnect(userId: string, id: string) {
    const entry = this.live.get(id);
    if (entry?.input.userId === userId) {
      entry.cancelled = true;
      entry.controller.abort(
        new AppError('PROVIDER_UNAVAILABLE', 'Generation cancelled.'),
      );
    }
  }
  async cancel(userId: string, id: string) {
    const entry = this.live.get(id);
    if (entry?.input.userId === userId) {
      this.disconnect(userId, id);
      await entry.done;
    }
    return this.storage.cancelOwnedGeneration(userId, id);
  }
  async abortUser(userId: string) {
    const entries = [...this.live.values()].filter(
      (entry) => entry.input.userId === userId,
    );
    for (const entry of entries) this.disconnect(userId, entry.id);
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
  async shutdown() {
    this.closing = true;
    const entries = [...this.live.values()];
    for (const entry of entries) this.disconnect(entry.input.userId, entry.id);
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
}
