-- Complete, versioned FFE Session Brain snapshots and fingerprinted synthesis locks.
-- Additive only: existing FinancialJuice and historical FXStreet evidence is preserved.
CREATE TABLE IF NOT EXISTS "market_driver_session_snapshots" (
  "id" TEXT NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "ledger_fingerprint" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'VALID',
  "as_of" TIMESTAMP(3) NOT NULL,
  "prompt_version" VARCHAR(80) NOT NULL,
  "provider" VARCHAR(30),
  "model" VARCHAR(120),
  "snapshot" JSONB NOT NULL,
  "catalyst_board" JSONB NOT NULL,
  "macro_board" JSONB NOT NULL,
  "driver_clusters" JSONB NOT NULL,
  "geo_state" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "needs_review" BOOLEAN NOT NULL DEFAULT false,
  "input_event_count" INTEGER NOT NULL DEFAULT 0,
  "input_theme_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_driver_session_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_session_snapshot_day_source_fingerprint_key"
  ON "market_driver_session_snapshots" ("day_key", "source", "ledger_fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_session_snapshot_day_source_version_key"
  ON "market_driver_session_snapshots" ("day_key", "source", "version");
CREATE INDEX IF NOT EXISTS "market_driver_session_snapshots_day_source_status_version_idx"
  ON "market_driver_session_snapshots" ("day_key", "source", "status", "version");
CREATE INDEX IF NOT EXISTS "market_driver_session_snapshots_created_at_idx"
  ON "market_driver_session_snapshots" ("created_at");

CREATE TABLE IF NOT EXISTS "market_driver_session_synthesis_jobs" (
  "id" TEXT NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "ledger_fingerprint" CHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(255) NOT NULL,
  "ingest_id" VARCHAR(100),
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "locked_at" TIMESTAMP(3),
  "worker_id" VARCHAR(120),
  "snapshot_id" VARCHAR(50),
  "error" VARCHAR(1000),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_driver_session_synthesis_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_session_synthesis_jobs_idempotency_key_key"
  ON "market_driver_session_synthesis_jobs" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_session_job_day_source_fingerprint_key"
  ON "market_driver_session_synthesis_jobs" ("day_key", "source", "ledger_fingerprint");
CREATE INDEX IF NOT EXISTS "market_driver_session_synthesis_jobs_status_locked_idx"
  ON "market_driver_session_synthesis_jobs" ("status", "locked_at");
CREATE INDEX IF NOT EXISTS "market_driver_session_synthesis_jobs_day_source_created_idx"
  ON "market_driver_session_synthesis_jobs" ("day_key", "source", "created_at");
