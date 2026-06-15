-- AlterTable
ALTER TABLE "trading_alerts" ADD COLUMN     "breakeven_done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_tsl_sl" DECIMAL(10,5),
ADD COLUMN     "max_tp_hit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tsl_active" BOOLEAN NOT NULL DEFAULT false;
