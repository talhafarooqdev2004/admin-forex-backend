-- Restart-safe source identity and durable per-headline checkpoints.
-- GUIDs are stable only within a feed, so the old global GUID uniqueness is replaced by
-- source_id+guid and a hashed source_key. Existing rows are considered complete because they
-- were already classified/deduplicated by the pre-checkpoint pipeline.

ALTER TABLE "market_driver_news"
    ADD COLUMN "source_id" VARCHAR(80) NOT NULL DEFAULT 'unknown',
    ADD COLUMN "source_key" VARCHAR(800),
    ADD COLUMN "content_hash" CHAR(64),
    ADD COLUMN "classification_completed" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "semantic_dedup_completed" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "semantic_dedup_started_at" TIMESTAMP(3),
    ADD COLUMN "semantic_dedup_worker_id" VARCHAR(120),
    ADD COLUMN "coverage_repair_completed" BOOLEAN NOT NULL DEFAULT true;

UPDATE "market_driver_news"
SET
    "source_key" = 'legacy:' || "id",
    "content_hash" = repeat('0', 64),
    "classification_completed" = true,
    "semantic_dedup_completed" = true,
    "coverage_repair_completed" = true
WHERE "source_key" IS NULL OR "content_hash" IS NULL;

-- The prior schema used a global guid unique index. It would incorrectly reject the same GUID
-- reused by two different feeds, so remove it before adding the source-scoped constraint.
DROP INDEX IF EXISTS "market_driver_news_guid_key";
CREATE UNIQUE INDEX "market_driver_news_source_id_guid_key"
    ON "market_driver_news"("source_id", "guid");
CREATE UNIQUE INDEX "market_driver_news_source_key_key"
    ON "market_driver_news"("source_key");
CREATE INDEX "market_driver_news_guid_idx" ON "market_driver_news"("guid");
CREATE INDEX "market_driver_news_source_id_idx" ON "market_driver_news"("source_id");
CREATE INDEX "market_driver_news_semantic_dedup_recovery_idx"
    ON "market_driver_news"("semantic_dedup_completed", "semantic_dedup_started_at");

ALTER TABLE "ai_classification_jobs"
    ADD COLUMN "operation_type" VARCHAR(40) NOT NULL DEFAULT 'classification',
    ADD COLUMN "content_hash" CHAR(64);
