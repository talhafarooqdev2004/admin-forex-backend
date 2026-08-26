-- Durable canonical event/theme registries. Existing headline rows are preserved and remain
-- nullable so this migration never rewrites or reclassifies historical data.
ALTER TABLE "market_driver_news"
  ADD COLUMN IF NOT EXISTS "canonical_event_id" VARCHAR(140),
  ADD COLUMN IF NOT EXISTS "canonical_theme_id" VARCHAR(140);

CREATE INDEX IF NOT EXISTS "market_driver_news_canonical_event_id_idx"
  ON "market_driver_news" ("canonical_event_id");
CREATE INDEX IF NOT EXISTS "market_driver_news_canonical_theme_id_idx"
  ON "market_driver_news" ("canonical_theme_id");

CREATE TABLE IF NOT EXISTS "market_driver_canonical_events" (
  "id" VARCHAR(140) NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "source_id" VARCHAR(80) NOT NULL,
  "source_guid" VARCHAR(500) NOT NULL,
  "normalized_signature" CHAR(64) NOT NULL,
  "headline" VARCHAR(1000) NOT NULL,
  "relation" VARCHAR(20) NOT NULL DEFAULT 'NEW_EVENT',
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "canonical_theme_id" VARCHAR(140),
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supporting_headline_ids" JSONB,
  "metadata" JSONB,
  CONSTRAINT "market_driver_canonical_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_canonical_event_source_guid_key"
  ON "market_driver_canonical_events" ("source_id", "source_guid");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_events_day_status_idx"
  ON "market_driver_canonical_events" ("day_key", "status");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_events_theme_idx"
  ON "market_driver_canonical_events" ("canonical_theme_id");

CREATE TABLE IF NOT EXISTS "market_driver_canonical_themes" (
  "id" VARCHAR(140) NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "theme_key" VARCHAR(180) NOT NULL,
  "label" VARCHAR(180) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "theme_type" VARCHAR(30) NOT NULL DEFAULT 'DRIVER',
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "geo_state" VARCHAR(20),
  "direct_evidence" JSONB,
  "asset_contributions" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latest_version" INTEGER NOT NULL DEFAULT 1,
  "supporting_event_ids" JSONB,
  "supporting_headline_ids" JSONB,
  CONSTRAINT "market_driver_canonical_themes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_canonical_theme_key"
  ON "market_driver_canonical_themes" ("day_key", "theme_key", "theme_type");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_themes_day_status_idx"
  ON "market_driver_canonical_themes" ("day_key", "status");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_themes_day_updated_idx"
  ON "market_driver_canonical_themes" ("day_key", "last_updated_at");

CREATE TABLE IF NOT EXISTS "market_driver_canonical_theme_revisions" (
  "id" TEXT NOT NULL,
  "theme_id" VARCHAR(140) NOT NULL,
  "version" INTEGER NOT NULL,
  "action" VARCHAR(30) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "geo_state" VARCHAR(20),
  "asset_contributions" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reason" VARCHAR(1000),
  "headline_ids" JSONB,
  "event_ids" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_driver_canonical_theme_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "market_driver_canonical_theme_revisions_theme_id_fkey"
    FOREIGN KEY ("theme_id") REFERENCES "market_driver_canonical_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_driver_canonical_theme_revision_version_key"
  ON "market_driver_canonical_theme_revisions" ("theme_id", "version");
CREATE INDEX IF NOT EXISTS "market_driver_canonical_theme_revisions_theme_created_idx"
  ON "market_driver_canonical_theme_revisions" ("theme_id", "created_at");

ALTER TABLE "market_driver_news"
  DROP CONSTRAINT IF EXISTS "market_driver_news_canonical_event_id_fkey",
  ADD CONSTRAINT "market_driver_news_canonical_event_id_fkey"
    FOREIGN KEY ("canonical_event_id") REFERENCES "market_driver_canonical_events"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "market_driver_news_canonical_theme_id_fkey",
  ADD CONSTRAINT "market_driver_news_canonical_theme_id_fkey"
    FOREIGN KEY ("canonical_theme_id") REFERENCES "market_driver_canonical_themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
