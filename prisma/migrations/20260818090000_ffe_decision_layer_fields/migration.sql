ALTER TABLE "market_driver_news"
  ADD COLUMN "driver_theme" VARCHAR(120),
  ADD COLUMN "causal_theme_id" VARCHAR(160),
  ADD COLUMN "macro_event_key" VARCHAR(80),
  ADD COLUMN "geo_state" VARCHAR(20),
  ADD COLUMN "semantic_direction" VARCHAR(12),
  ADD COLUMN "semantic_strength" VARCHAR(12),
  ADD COLUMN "direct_asset_signals" JSONB,
  ADD COLUMN "transmitted_asset_signals" JSONB,
  ADD COLUMN "sign_validation_status" VARCHAR(20) NOT NULL DEFAULT 'NOT_APPLICABLE';

CREATE INDEX "market_driver_news_causal_theme_id_idx"
  ON "market_driver_news"("causal_theme_id");
CREATE INDEX "market_driver_news_macro_event_key_idx"
  ON "market_driver_news"("macro_event_key");
CREATE INDEX "market_driver_news_geo_state_idx"
  ON "market_driver_news"("geo_state");

-- Existing rows predate semantic cause fields. Keep them explicitly reconstructable instead of
-- claiming historical certainty; the audit API marks these records as reconstructed/partial.
UPDATE "market_driver_news"
SET "sign_validation_status" = 'NOT_APPLICABLE'
WHERE "sign_validation_status" IS NULL;
