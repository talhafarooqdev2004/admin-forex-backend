-- CreateTable
CREATE TABLE "market_driver_day_archive" (
    "id" TEXT NOT NULL,
    "day_key" VARCHAR(10) NOT NULL,
    "catalyst_board" JSONB NOT NULL,
    "headline_count" INTEGER NOT NULL DEFAULT 0,
    "relevant_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "irrelevant_count" INTEGER NOT NULL DEFAULT 0,
    "finalized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_driver_day_archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_driver_day_archive_day_key_key" ON "market_driver_day_archive"("day_key");
