-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended', 'revoked');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'activated');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('reserved', 'running', 'completed', 'cancelled', 'failed', 'interrupted');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('completed', 'streaming', 'cancelled', 'failed', 'interrupted');

-- CreateEnum
CREATE TYPE "AccountingStatus" AS ENUM ('reported', 'estimated', 'uncertain');

-- CreateEnum
CREATE TYPE "QuotaScope" AS ENUM ('user_daily', 'global_daily', 'global_total');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserQuota" (
    "userId" UUID NOT NULL,
    "dailyRequests" INTEGER NOT NULL,
    "dailyTokens" INTEGER NOT NULL,
    "dailyCostNanoInr" BIGINT NOT NULL,

    CONSTRAINT "UserQuota_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "csrfTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'pending',
    "activationCodeHash" TEXT,
    "activationExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL DEFAULT 'New conversation',
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "generationId" UUID,
    "sequence" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" "MessageStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" UUID NOT NULL,
    "version" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "inputNanoUsdPerMillion" BIGINT NOT NULL,
    "outputNanoUsdPerMillion" BIGINT NOT NULL,
    "inrPerUsdNano" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conversationId" UUID,
    "idempotencyKey" UUID NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'gemini',
    "model" VARCHAR(100) NOT NULL,
    "providerRequestId" TEXT,
    "status" "GenerationStatus" NOT NULL DEFAULT 'reserved',
    "priceSnapshotId" UUID NOT NULL,
    "inputTokenBound" INTEGER NOT NULL,
    "outputTokenBound" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "errorCode" VARCHAR(100),

    CONSTRAINT "GenerationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "generationId" UUID NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "accountedTokens" BIGINT NOT NULL,
    "estimatedCostNanoUsd" BIGINT NOT NULL,
    "estimatedCostNanoInr" BIGINT NOT NULL,
    "providerReportedNanoUsd" BIGINT,
    "accountingStatus" "AccountingStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("generationId")
);

-- CreateTable
CREATE TABLE "QuotaPeriod" (
    "id" UUID NOT NULL,
    "scope" "QuotaScope" NOT NULL,
    "ownerKey" VARCHAR(36) NOT NULL,
    "userId" UUID,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3),
    "requestsUsed" INTEGER NOT NULL DEFAULT 0,
    "requestsReserved" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" BIGINT NOT NULL DEFAULT 0,
    "tokensReserved" BIGINT NOT NULL DEFAULT 0,
    "costUsedNanoInr" BIGINT NOT NULL DEFAULT 0,
    "costReservedNanoInr" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "QuotaPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotaReservation" (
    "generationId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "QuotaReservation_pkey" PRIMARY KEY ("generationId")
);

-- CreateTable
CREATE TABLE "QuotaAllocation" (
    "generationId" UUID NOT NULL,
    "quotaPeriodId" UUID NOT NULL,
    "requests" INTEGER NOT NULL,
    "tokens" BIGINT NOT NULL,
    "costNanoInr" BIGINT NOT NULL,

    CONSTRAINT "QuotaAllocation_pkey" PRIMARY KEY ("generationId","quotaPeriodId")
);

-- CreateTable
CREATE TABLE "LedgerLock" (
    "id" VARCHAR(30) NOT NULL,

    CONSTRAINT "LedgerLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "targetUserId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequest_username_key" ON "AccessRequest"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequest_activationCodeHash_key" ON "AccessRequest"("activationCodeHash");

-- CreateIndex
CREATE INDEX "AccessRequest_status_createdAt_id_idx" ON "AccessRequest"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Conversation_userId_updatedAt_id_idx" ON "Conversation"("userId", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_id_userId_key" ON "Conversation"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_generationId_role_key" ON "Message"("generationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "PriceSnapshot_version_model_key" ON "PriceSnapshot"("version", "model");

-- CreateIndex
CREATE INDEX "GenerationRequest_userId_createdAt_id_idx" ON "GenerationRequest"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "GenerationRequest_status_createdAt_idx" ON "GenerationRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRequest_userId_idempotencyKey_key" ON "GenerationRequest"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRequest_id_conversationId_key" ON "GenerationRequest"("id", "conversationId");

-- CreateIndex
CREATE INDEX "QuotaPeriod_userId_periodStart_idx" ON "QuotaPeriod"("userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "QuotaPeriod_scope_ownerKey_periodStart_key" ON "QuotaPeriod"("scope", "ownerKey", "periodStart");

-- CreateIndex
CREATE INDEX "QuotaReservation_settledAt_expiresAt_idx" ON "QuotaReservation"("settledAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_createdAt_id_idx" ON "AdminAuditEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_targetUserId_createdAt_idx" ON "AdminAuditEvent"("targetUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_generationId_conversationId_fkey" FOREIGN KEY ("generationId", "conversationId") REFERENCES "GenerationRequest"("id", "conversationId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "GenerationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "GenerationRequest_conversationId_userId_fkey" FOREIGN KEY ("conversationId", "userId") REFERENCES "Conversation"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "GenerationRequest_priceSnapshotId_fkey" FOREIGN KEY ("priceSnapshotId") REFERENCES "PriceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "GenerationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotaPeriod" ADD CONSTRAINT "QuotaPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotaReservation" ADD CONSTRAINT "QuotaReservation_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "GenerationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotaAllocation" ADD CONSTRAINT "QuotaAllocation_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "QuotaReservation"("generationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotaAllocation" ADD CONSTRAINT "QuotaAllocation_quotaPeriodId_fkey" FOREIGN KEY ("quotaPeriodId") REFERENCES "QuotaPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditEvent" ADD CONSTRAINT "AdminAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditEvent" ADD CONSTRAINT "AdminAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
