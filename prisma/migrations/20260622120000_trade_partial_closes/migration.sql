-- AlterTable
ALTER TABLE "trading_alerts" ADD COLUMN "accumulated_pips" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "trading_alerts" ADD COLUMN "manual_partial_closed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "trade_partial_closes" (
    "id" BIGSERIAL NOT NULL,
    "trading_alert_id" BIGINT NOT NULL,
    "tp_level" INTEGER NOT NULL,
    "pips" DECIMAL(10,2) NOT NULL,
    "exit_price" DECIMAL(10,5),
    "outcome" VARCHAR(20),
    "close_reason" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_partial_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trade_partial_closes_trading_alert_id_idx" ON "trade_partial_closes"("trading_alert_id");

-- CreateIndex
CREATE INDEX "trade_partial_closes_created_at_idx" ON "trade_partial_closes"("created_at");

-- AddForeignKey
ALTER TABLE "trade_partial_closes" ADD CONSTRAINT "trade_partial_closes_trading_alert_id_fkey" FOREIGN KEY ("trading_alert_id") REFERENCES "trading_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
