-- Prisma does not model CHECK constraints; keep these invariants in migrations.
ALTER TABLE "User" ADD CONSTRAINT "User_username_normalized"
  CHECK ("username" ~ '^[a-z0-9_]{3,32}$');
ALTER TABLE "User" ADD CONSTRAINT "User_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_nonnegative"
  CHECK ("dailyRequests" >= 0 AND "dailyTokens" >= 0 AND "dailyCostNanoInr" >= 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sequence_positive" CHECK ("nextSequence" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "Message_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "Message_content_bound" CHECK (char_length("content") <= 128000);
ALTER TABLE "Message" ADD CONSTRAINT "Message_user_complete"
  CHECK ("role" <> 'user' OR ("status" = 'completed' AND char_length(btrim("content")) > 0));
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_valid_amounts"
  CHECK ("inputNanoUsdPerMillion" >= 0 AND "outputNanoUsdPerMillion" >= 0 AND "inrPerUsdNano" > 0);
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "Generation_bounds"
  CHECK ("inputTokenBound" > 0 AND "inputTokenBound" <= 16000 AND "outputTokenBound" > 0 AND "outputTokenBound" <= 2000);
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "Generation_provider" CHECK ("provider" = 'gemini');
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "Generation_terminal_time"
  CHECK (("status" IN ('reserved', 'running') AND "finishedAt" IS NULL)
    OR ("status" NOT IN ('reserved', 'running') AND "finishedAt" IS NOT NULL));
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "Generation_dispatch_marker"
  CHECK ("status" <> 'running' OR "dispatchedAt" IS NOT NULL);
ALTER TABLE "QuotaPeriod" ADD CONSTRAINT "QuotaPeriod_nonnegative"
  CHECK ("requestsUsed" >= 0 AND "requestsReserved" >= 0 AND "tokensUsed" >= 0
    AND "tokensReserved" >= 0 AND "costUsedNanoInr" >= 0 AND "costReservedNanoInr" >= 0);
ALTER TABLE "QuotaPeriod" ADD CONSTRAINT "QuotaPeriod_scope_owner"
  CHECK (("scope" = 'user_daily' AND "userId" IS NOT NULL AND "ownerKey" = "userId"::text)
    OR ("scope" <> 'user_daily' AND "userId" IS NULL AND "ownerKey" = 'global'));
ALTER TABLE "QuotaPeriod" ADD CONSTRAINT "QuotaPeriod_window"
  CHECK (("scope" = 'global_total' AND "periodEnd" IS NULL AND "periodStart" = '1970-01-01T00:00:00Z'::timestamptz)
    OR ("scope" <> 'global_total' AND "periodEnd" IS NOT NULL AND "periodEnd" > "periodStart"));
ALTER TABLE "QuotaAllocation" ADD CONSTRAINT "QuotaAllocation_nonnegative"
  CHECK ("requests" = 1 AND "tokens" >= 0 AND "costNanoInr" >= 0);
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_nonnegative"
  CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0 AND "cachedInputTokens" >= 0
    AND "reasoningTokens" >= 0 AND "accountedTokens" >= 0 AND "estimatedCostNanoUsd" >= 0
    AND "estimatedCostNanoInr" >= 0 AND "providerReportedNanoUsd" >= 0);
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_cached_subset"
  CHECK ("cachedInputTokens" IS NULL OR "inputTokens" IS NULL OR "cachedInputTokens" <= "inputTokens");
INSERT INTO "LedgerLock" ("id") VALUES ('global');
