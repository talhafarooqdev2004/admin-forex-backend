ALTER TABLE "market_driver_news"
  ADD COLUMN "final_decision_code" VARCHAR(60),
  ADD COLUMN "final_decision_reason" VARCHAR(1000),
  ADD COLUMN "secondary_reasons" JSONB,
  ADD COLUMN "decision_ingest_id" VARCHAR(100),
  ADD COLUMN "classification_job_id" VARCHAR(50),
  ADD COLUMN "classification_provider" VARCHAR(30),
  ADD COLUMN "classification_model" VARCHAR(120);

CREATE INDEX "market_driver_news_day_key_final_decision_code_idx"
  ON "market_driver_news"("day_key", "final_decision_code");
