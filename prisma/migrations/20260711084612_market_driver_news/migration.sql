-- CreateTable
CREATE TABLE "market_driver_news" (
    "id" TEXT NOT NULL,
    "guid" VARCHAR(500) NOT NULL,
    "normalized" VARCHAR(500) NOT NULL,
    "day_key" VARCHAR(10) NOT NULL,
    "headline" VARCHAR(1000) NOT NULL,
    "source" VARCHAR(255),
    "category" VARCHAR(20) NOT NULL,
    "impact" VARCHAR(10) NOT NULL,
    "summary" VARCHAR(500),
    "assets" JSONB NOT NULL,
    "duplicate_of" VARCHAR(50),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_driver_news_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_driver_news_guid_key" ON "market_driver_news"("guid");

-- CreateIndex
CREATE INDEX "market_driver_news_day_key_idx" ON "market_driver_news"("day_key");

-- CreateIndex
CREATE INDEX "market_driver_news_category_idx" ON "market_driver_news"("category");
