/*
  Warnings:

  - The `type` column on the `trading_alerts` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "trading_alerts" ADD COLUMN     "breakeven_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "close_reason" VARCHAR(40),
ADD COLUMN     "direction_type" VARCHAR(20),
ADD COLUMN     "exit_price" DECIMAL(10,5),
ADD COLUMN     "outcome" VARCHAR(20),
ADD COLUMN     "pips" DECIMAL(10,2),
ADD COLUMN     "risk" VARCHAR(20),
ADD COLUMN     "session" VARCHAR(20),
ADD COLUMN     "tp3" DECIMAL(10,5),
ADD COLUMN     "tsl_enabled" BOOLEAN NOT NULL DEFAULT false,
DROP COLUMN "type",
ADD COLUMN     "type" VARCHAR(20);
