import { GoogleGenAI, ThinkingLevel, ServiceTier } from '@google/genai';
import type {
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { headerDeadline } from './resilience.js';
import { systemInstruction } from './provider.js';
import type {
  TextProvider,
  Turn,
  ProviderAnswer,
  ReportedUsage,
  ProviderChunk,
} from './provider.js';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function normalizeUsage(
  usage?: GenerateContentResponseUsageMetadata,
): ReportedUsage | undefined {
  if (!usage) return undefined;
  const input = usage.promptTokenCount;
  const output = usage.candidatesTokenCount;
  const reasoning = usage.thoughtsTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  if (
    !count(input) ||
    !count(output) ||
    !count(reasoning) ||
    !count(cached) ||
    cached > input ||
    (usage.toolUsePromptTokenCount ?? 0) !== 0 ||
    (usage.totalTokenCount !== undefined &&
      usage.totalTokenCount !== input + output + reasoning)
  )
    return undefined;
  // generateContent candidates EXCLUDE thinking; cached input is a subset.
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedInputTokens: cached,
  };
}

export function normalizeAnswer(
  response: GenerateContentResponse,
): ProviderAnswer {
  const candidate =
    response.candidates?.length === 1 ? response.candidates[0] : undefined;
  const parts = candidate?.content?.parts ?? [];
  const textOnly = parts.every(
    (part) =>
      part.thought === true ||
      (typeof part.text === 'string' &&
        !part.functionCall &&
        !part.executableCode &&
        !part.inlineData),
  );
  const safeFinish =
    candidate?.finishReason === 'STOP' ||
    candidate?.finishReason === 'MAX_TOKENS';
  // Do not expose safety-blocked output, thought summaries, or tool requests.
  const content =
    safeFinish && textOnly
      ? parts
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('')
      : '';
  const usage = normalizeUsage(response.usageMetadata);
  const providerRequestId = response.responseId?.slice(0, 512);
  return {
    content: content.length <= 128000 ? content : '',
    completed:
      candidate?.finishReason === 'STOP' &&
      textOnly &&
      content.trim().length > 0 &&
      content.length <= 128000,
    ...(usage ? { usage } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
  };
}

export class GeminiProvider implements TextProvider {
  private readonly client: GoogleGenAI;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
  ) {
    if (!config.GEMINI_API_KEY)
      throw new AppError(
        'SERVICE_NOT_READY',
        'Configure Gemini locally before asking a question.',
      );
    this.fetcher = headerDeadline(fetcher);
    this.client = new GoogleGenAI({
      apiKey: config.GEMINI_API_KEY,
      httpOptions: {
        apiVersion: 'v1beta',
        timeout: config.GENERATION_TIMEOUT_SECONDS * 1000,
        retryOptions: { attempts: 1 },
        fetch: this.fetcher,
      },
    });
  }
  private contents(turns: Turn[]) {
    return turns.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));
  }
  async countTokens(turns: Turn[], signal: AbortSignal) {
    // SDK 2.32.0 rejects countTokens.config.systemInstruction in Developer API
    // mode. The documented REST generateContentRequest includes the exact same
    // system instruction and content as generation. Never count characters / 4.
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.config.GEMINI_MODEL}:countTokens`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.config.GEMINI_API_KEY!,
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.GENERATION_TIMEOUT_SECONDS * 1000),
        ]),
        body: JSON.stringify({
          generateContentRequest: {
            model: `models/${this.config.GEMINI_MODEL}`,
            contents: this.contents(turns),
            systemInstruction: { parts: [{ text: systemInstruction }] },
          },
        }),
      },
    );
    const result: unknown = response.ok ? await response.json() : null;
    if (
      !result ||
      typeof result !== 'object' ||
      !('totalTokens' in result) ||
      !count(result.totalTokens) ||
      result.totalTokens === 0
    )
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The model service could not validate the context size.',
      );
    return result.totalTokens;
  }
  async answer(turns: Turn[], signal: AbortSignal) {
    const result = await this.client.models.generateContent({
      model: this.config.GEMINI_MODEL,
      contents: this.contents(turns),
      config: {
        systemInstruction,
        abortSignal: signal,
        candidateCount: 1,
        maxOutputTokens: this.config.MAX_OUTPUT_TOKENS,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
          includeThoughts: false,
        },
        automaticContinuation: false,
        automaticFunctionCalling: { disable: true },
        store: false,
        serviceTier: ServiceTier.STANDARD,
        httpOptions: { retryOptions: { attempts: 1 } },
        // No tools, grounding, provider chat session, or user-selected settings.
      },
    });
    return normalizeAnswer(result);
  }
  async *stream(
    turns: Turn[],
    signal: AbortSignal,
  ): AsyncGenerator<ProviderChunk> {
    const chunks = await this.client.models.generateContentStream({
      model: this.config.GEMINI_MODEL,
      contents: this.contents(turns),
      config: {
        systemInstruction,
        abortSignal: signal,
        candidateCount: 1,
        maxOutputTokens: this.config.MAX_OUTPUT_TOKENS,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
          includeThoughts: false,
        },
        automaticContinuation: false,
        automaticFunctionCalling: { disable: true },
        store: false,
        serviceTier: ServiceTier.STANDARD,
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });
    let finish: string | undefined;
    let usage: ReportedUsage | undefined;
    let providerRequestId: string | undefined;
    let visible = false;
    for await (const chunk of chunks) {
      if (chunk.responseId) providerRequestId = chunk.responseId.slice(0, 512);
      if (chunk.usageMetadata) usage = normalizeUsage(chunk.usageMetadata);
      if (chunk.promptFeedback?.blockReason) finish = 'SAFETY';
      if (chunk.candidates && chunk.candidates.length !== 1)
        throw new AppError(
          'PROVIDER_REJECTED',
          'The model returned an unexpected response.',
        );
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      const parts = candidate?.content?.parts ?? [];
      if (
        parts.some(
          (part) =>
            !part.thought &&
            (typeof part.text !== 'string' ||
              part.functionCall ||
              part.executableCode ||
              part.inlineData),
        )
      )
        throw new AppError(
          'PROVIDER_REJECTED',
          'The model returned unsupported content.',
        );
      if (!finish || finish === 'STOP' || finish === 'MAX_TOKENS') {
        const text = parts
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
        if (text) {
          visible = true;
          yield { type: 'delta', text };
        }
      }
    }
    // EOF alone is not completion. Intermediate usage is never settled on abort.
    if (!finish)
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The model stream ended without a final outcome.',
      );
    yield {
      type: 'final',
      completed: finish === 'STOP' && visible,
      ...(usage ? { usage } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
    };
  }
}
