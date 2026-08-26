ALTER TABLE "market_driver_news"
  ADD COLUMN IF NOT EXISTS "fundamental_cause" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "event_relation" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "event_duplicate_of" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "causal_theme_summary" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "theme_action" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "catalyst_eligible" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "needs_review" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "decision_source" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "prompt_version" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "semantic_decided_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "macro_eligible" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "macro_family" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "macro_direction_summary" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "macro_asset_scores" JSONB,
  ADD COLUMN IF NOT EXISTS "decision_reason" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "structural_validation_status" VARCHAR(20);
ALTER TABLE "market_driver_news"
  ADD COLUMN IF NOT EXISTS "geo_components" JSONB;

CREATE INDEX IF NOT EXISTS "market_driver_news_event_relation_idx"
  ON "market_driver_news" ("event_relation");
CREATE INDEX IF NOT EXISTS "market_driver_news_causal_theme_id_catalyst_eligible_idx"
  ON "market_driver_news" ("causal_theme_id", "catalyst_eligible");
CREATE INDEX IF NOT EXISTS "market_driver_news_needs_review_classification_completed_idx"
  ON "market_driver_news" ("needs_review", "classification_completed");

CREATE TABLE IF NOT EXISTS "geopolitical_risk_evaluations" (
  "id" TEXT NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "theme_fingerprint" CHAR(64) NOT NULL,
  "components" JSONB NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "band" VARCHAR(20) NOT NULL,
  "explanation" VARCHAR(1000),
  "event_count" INTEGER NOT NULL DEFAULT 0,
  "provider" VARCHAR(30),
  "model" VARCHAR(120),
  "prompt_version" VARCHAR(80),
  "decision_source" VARCHAR(24) NOT NULL DEFAULT 'ai',
  "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "geopolitical_risk_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "geo_risk_day_theme_fingerprint_key"
  ON "geopolitical_risk_evaluations" ("day_key", "theme_fingerprint");
CREATE INDEX IF NOT EXISTS "geopolitical_risk_evaluations_day_key_evaluated_at_idx"
  ON "geopolitical_risk_evaluations" ("day_key", "evaluated_at");
