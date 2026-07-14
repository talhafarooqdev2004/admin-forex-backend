-- AlterTable
ALTER TABLE "market_driver_news" ADD COLUMN     "board_locked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "market_driver_news_day_key_board_locked_idx" ON "market_driver_news"("day_key", "board_locked");

-- Backfill: lock every row that is CURRENTLY board-visible so nothing on-screen disappears
-- when display switches to board_locked. Visible = non-duplicate DRIVER/GEOPOLITICAL,
-- High/Medium impact, non-empty assets (matches isBoardVisibleClassification). Applies to all
-- day_keys so Historical Analysis boards stay populated too.
UPDATE "market_driver_news"
SET "board_locked" = true
WHERE "duplicate_of" IS NULL
  AND "category" IN ('DRIVER', 'GEOPOLITICAL')
  AND "impact" IN ('High', 'Medium')
  AND jsonb_typeof("assets") = 'array'
  AND jsonb_array_length("assets") > 0;
