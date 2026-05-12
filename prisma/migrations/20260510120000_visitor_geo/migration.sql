-- CreateEnum
CREATE TYPE "VisitorGeoStatus" AS ENUM ('pending', 'resolved', 'failed');

-- CreateTable
CREATE TABLE "visitor_geo" (
    "id" BIGSERIAL NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "country_code" VARCHAR(8),
    "country_name" VARCHAR(255),
    "region_name" VARCHAR(255),
    "status" "VisitorGeoStatus" NOT NULL DEFAULT 'pending',
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visitor_geo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "visitor_geo_ip_address_key" ON "visitor_geo"("ip_address");
