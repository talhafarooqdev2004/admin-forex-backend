-- Compact per-ingest counters used by the admin AI Usage dashboard. No RSS payloads/prompts.
ALTER TABLE "ai_classification_jobs"
    ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "stale_recovery_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "last_retry_at" TIMESTAMP(3),
    ADD COLUMN "last_retry_by" VARCHAR(120);

CREATE INDEX "ai_classification_jobs_retry_count_idx"
    ON "ai_classification_jobs"("retry_count", "created_at");
CREATE INDEX "ai_classification_jobs_last_error_kind_idx"
    ON "ai_classification_jobs"("last_error_kind");
CREATE INDEX "ai_classification_jobs_stale_recovery_count_idx"
    ON "ai_classification_jobs"("stale_recovery_count");

CREATE TABLE "market_driver_processing_runs" (
    "id" TEXT NOT NULL,
    "ingest_id" VARCHAR(100) NOT NULL,
    "source" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "items_fetched" INTEGER NOT NULL DEFAULT 0,
    "new_items" INTEGER NOT NULL DEFAULT 0,
    "existing_items_skipped" INTEGER NOT NULL DEFAULT 0,
    "items_enqueued" INTEGER NOT NULL DEFAULT 0,
    "items_classified" INTEGER NOT NULL DEFAULT 0,
    "exact_duplicates_skipped" INTEGER NOT NULL DEFAULT 0,
    "semantic_duplicates_found" INTEGER NOT NULL DEFAULT 0,
    "failed_items" INTEGER NOT NULL DEFAULT 0,
    "recovered_items" INTEGER NOT NULL DEFAULT 0,
    "coverage_repairs" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'processing',
    "error_category" VARCHAR(40),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_driver_processing_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_driver_processing_runs_ingest_id_key"
    ON "market_driver_processing_runs"("ingest_id");
CREATE INDEX "market_driver_processing_runs_started_at_idx"
    ON "market_driver_processing_runs"("started_at");
CREATE INDEX "market_driver_processing_runs_source_started_at_idx"
    ON "market_driver_processing_runs"("source", "started_at");
CREATE INDEX "market_driver_processing_runs_status_started_at_idx"
    ON "market_driver_processing_runs"("status", "started_at");
