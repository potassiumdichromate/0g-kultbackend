-- CreateTable
CREATE TABLE "game_metadata" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "game_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battle_pass_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT,
    "seasonKey" VARCHAR(64) NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "battle_pass_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iap_purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "priceEth" TEXT NOT NULL,
    "priceWei" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT true,
    "chainId" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iap_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "gameId" TEXT,
    "eventType" VARCHAR(128) NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_metadata_gameId_key_key" ON "game_metadata"("gameId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "battle_pass_progress_userId_gameId_seasonKey_key" ON "battle_pass_progress"("userId", "gameId", "seasonKey");

-- CreateIndex
CREATE UNIQUE INDEX "iap_purchases_orderId_key" ON "iap_purchases"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "iap_purchases_orderHash_key" ON "iap_purchases"("orderHash");

-- CreateIndex
CREATE UNIQUE INDEX "iap_purchases_txHash_key" ON "iap_purchases"("txHash");

-- CreateIndex
CREATE INDEX "security_audit_log_eventType_createdAt_idx" ON "security_audit_log"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "game_metadata" ADD CONSTRAINT "game_metadata_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_pass_progress" ADD CONSTRAINT "battle_pass_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_pass_progress" ADD CONSTRAINT "battle_pass_progress_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iap_purchases" ADD CONSTRAINT "iap_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iap_purchases" ADD CONSTRAINT "iap_purchases_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
