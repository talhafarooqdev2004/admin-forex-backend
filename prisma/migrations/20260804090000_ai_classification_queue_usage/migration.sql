-- Durable Market Driver AI jobs. Payloads are public RSS data only; secrets remain in env.
CREATE TABLE "ai_classification_jobs" (
    "id" TEXT NOT NULL,
    "job_type" VARCHAR(40) NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "ingest_id" VARCHAR(100),
    "headline_ids" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "provider" VARCHAR(30),
    "model" VARCHAR(120),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "next_retry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "worker_id" VARCHAR(120),
    "last_error_code" VARCHAR(40),
    "last_error_kind" VARCHAR(40),
    "last_error" VARCHAR(1000),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_classification_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_classification_jobs_idempotency_key_key"
    ON "ai_classification_jobs"("idempotency_key");
CREATE INDEX "ai_classification_jobs_status_next_retry_at_idx"
    ON "ai_classification_jobs"("status", "next_retry_at");
CREATE INDEX "ai_classification_jobs_status_locked_at_idx"
    ON "ai_classification_jobs"("status", "locked_at");
CREATE INDEX "ai_classification_jobs_job_type_created_at_idx"
    ON "ai_classification_jobs"("job_type", "created_at");

CREATE TABLE "ai_usage_records" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "ingest_id" VARCHAR(100),
    "operation_type" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "input_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "total_tokens" INTEGER,
    "usage_available" BOOLEAN NOT NULL DEFAULT false,
    "estimated_input_cost" DECIMAL(20,10),
    "estimated_cached_cost" DECIMAL(20,10),
    "estimated_output_cost" DECIMAL(20,10),
    "estimated_total_cost" DECIMAL(20,10),
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "request_status" VARCHAR(20) NOT NULL,
    "request_id" VARCHAR(255),
    "latency_ms" INTEGER,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "is_retry" BOOLEAN NOT NULL DEFAULT false,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "error_kind" VARCHAR(40),
    "error_message" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_usage_records_job_id_fkey"
        FOREIGN KEY ("job_id") REFERENCES "ai_classification_jobs"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ai_usage_records_created_at_idx" ON "ai_usage_records"("created_at");
CREATE INDEX "ai_usage_records_provider_model_operation_created_at_idx"
    ON "ai_usage_records"("provider", "model", "operation_type", "created_at");
CREATE INDEX "ai_usage_records_operation_created_at_idx"
    ON "ai_usage_records"("operation_type", "created_at");
CREATE INDEX "ai_usage_records_status_created_at_idx"
    ON "ai_usage_records"("request_status", "created_at");
CREATE INDEX "ai_usage_records_job_id_idx" ON "ai_usage_records"("job_id");
