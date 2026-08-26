-- Additive FFE client-contract state. Existing rows remain untouched and nullable.
ALTER TABLE "market_driver_news"
  ADD COLUMN IF NOT EXISTS "event_type" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "observed_market_reaction" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "event_strength" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "event_severity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "event_credibility" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "event_freshness" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "event_persistence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "transmission_reason" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "counter_evidence" JSONB,
  ADD COLUMN IF NOT EXISTS "current_asset_contributions" JSONB,
  ADD COLUMN IF NOT EXISTS "supporting_guid_ids" JSONB,
  ADD COLUMN IF NOT EXISTS "confirmation_only" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "macro_actual" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "macro_forecast" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "macro_previous" VARCHAR(120);

ALTER TABLE "market_driver_canonical_events"
  ADD COLUMN IF NOT EXISTS "event_type" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "fundamental_cause" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "observed_market_reaction" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "event_strength" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "severity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "credibility" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "freshness" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "persistence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "geo_state" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "transmission_reason" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "affected_assets" JSONB,
  ADD COLUMN IF NOT EXISTS "current_asset_contributions" JSONB,
  ADD COLUMN IF NOT EXISTS "counter_evidence" JSONB,
  ADD COLUMN IF NOT EXISTS "supporting_guid_ids" JSONB,
  ADD COLUMN IF NOT EXISTS "confirmation_guid_ids" JSONB,
  ADD COLUMN IF NOT EXISTS "update_history" JSONB,
  ADD COLUMN IF NOT EXISTS "catalyst_eligible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "independent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "valid" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "model" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "prompt_version" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "decision_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "market_driver_canonical_events_active_arithmetic_idx"
  ON "market_driver_canonical_events" ("day_key", "status", "valid", "independent");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_events_day_event_type_idx"
  ON "market_driver_canonical_events" ("day_key", "event_type");
CREATE INDEX IF NOT EXISTS "market_driver_news_event_type_idx"
  ON "market_driver_news" ("day_key", "event_type");
