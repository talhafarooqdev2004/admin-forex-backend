-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "PageContentType" AS ENUM ('text', 'rich_text', 'html');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('pending', 'completed', 'failed', 'refunded', 'cancelled');

-- CreateEnum
CREATE TYPE "UserSubscriptionStatus" AS ENUM ('active', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "TradingDirection" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "TradingAlertType" AS ENUM ('Swing', 'Scalp');

-- CreateEnum
CREATE TYPE "TradingAlertStatus" AS ENUM ('completed', 'open', 'stopped');

-- CreateEnum
CREATE TYPE "locales" AS ENUM ('en', 'ru', 'de', 'fr', 'zh');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "first_name" VARCHAR(255) NOT NULL,
    "last_name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password" VARCHAR(255),
    "gender" "Gender",
    "google_id" VARCHAR(255),
    "facebook_id" VARCHAR(255),
    "apple_id" VARCHAR(255),
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "phone" VARCHAR(20),
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_packages" (
    "id" BIGSERIAL NOT NULL,
    "price" DECIMAL(8,2) NOT NULL,
    "duration_hours" INTEGER NOT NULL,
    "free_trial_hours" INTEGER,
    "additional_discounts" JSONB,
    "campaigns" JSONB,
    "publish" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_package_translations" (
    "id" BIGSERIAL NOT NULL,
    "subscription_package_id" BIGINT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_package_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "educations" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "publish" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "education_translations" (
    "id" BIGSERIAL NOT NULL,
    "education_id" BIGINT NOT NULL,
    "locale" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "education_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_contents" (
    "id" BIGSERIAL NOT NULL,
    "page_identifier" VARCHAR(255) NOT NULL,
    "section_key" VARCHAR(255) NOT NULL,
    "content_type" "PageContentType" NOT NULL DEFAULT 'text',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_content_translations" (
    "id" BIGSERIAL NOT NULL,
    "page_content_id" BIGINT NOT NULL,
    "locale" VARCHAR(255) NOT NULL,
    "content_value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_content_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateways" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "credentials" JSONB,
    "settings" JSONB,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "icon" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "package_id" BIGINT NOT NULL,
    "payment_gateway_id" BIGINT NOT NULL,
    "transaction_id" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'pending',
    "gateway_response" JSONB,
    "failure_reason" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "package_id" BIGINT NOT NULL,
    "payment_transaction_id" BIGINT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "UserSubscriptionStatus" NOT NULL DEFAULT 'active',
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_pairs" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "base_currency" VARCHAR(3) NOT NULL,
    "quote_currency" VARCHAR(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currency_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dynamic_tables" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "table_metadata" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dynamic_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_rows" (
    "id" BIGSERIAL NOT NULL,
    "dynamic_table_id" BIGINT NOT NULL,
    "currency_pair_id" BIGINT,
    "row_index" INTEGER NOT NULL,
    "user_id" BIGINT,
    "row_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_columns" (
    "id" BIGSERIAL NOT NULL,
    "dynamic_table_id" BIGINT NOT NULL,
    "header" VARCHAR(255) NOT NULL,
    "key" VARCHAR(255),
    "column_index" INTEGER NOT NULL,
    "column_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_cells" (
    "id" BIGSERIAL NOT NULL,
    "table_row_id" BIGINT NOT NULL,
    "table_column_id" BIGINT NOT NULL,
    "user_id" BIGINT,
    "value" TEXT,
    "formula" TEXT,
    "data_type" VARCHAR(255) NOT NULL DEFAULT 'text',
    "cell_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_alerts" (
    "id" BIGSERIAL NOT NULL,
    "trade_id" VARCHAR(255),
    "pair" VARCHAR(255),
    "direction" "TradingDirection",
    "entry_level" DECIMAL(10,5),
    "stop_loss" DECIMAL(10,5),
    "tp1" DECIMAL(10,5),
    "tp2" DECIMAL(10,5),
    "image_path" VARCHAR(255),
    "trade_follow_up" TEXT,
    "type" "TradingAlertType",
    "result" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "TradingAlertStatus" NOT NULL DEFAULT 'open',
    "comment" TEXT,
    "date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "color_configurations" (
    "id" BIGSERIAL NOT NULL,
    "type" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "min_value" DOUBLE PRECISION NOT NULL,
    "max_value" DOUBLE PRECISION NOT NULL,
    "color" VARCHAR(255) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "color_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_mode_scores" (
    "id" BIGSERIAL NOT NULL,
    "score" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_mode_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_dashboard" (
    "id" BIGSERIAL NOT NULL,
    "currency_pair_id" BIGINT NOT NULL,
    "net_score" DECIMAL(10,2),
    "net_bias" VARCHAR(255),
    "trend_score" DECIMAL(10,2),
    "momentum_score" DECIMAL(10,2),
    "volatility_score" DECIMAL(10,2),
    "sentiment_score" DECIMAL(10,2),
    "seasonal_score" DECIMAL(10,2),
    "cot_score" DECIMAL(10,2),
    "fundamental_score" DECIMAL(10,2),
    "additional_scores" JSONB,
    "calculated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "score_dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_configs" (
    "id" BIGSERIAL NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_analyzer_cache" (
    "id" BIGSERIAL NOT NULL,
    "pair" VARCHAR(255) NOT NULL,
    "currency_pair_id" BIGINT,
    "complete_data" TEXT NOT NULL,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_analyzer_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_rules" (
    "id" SERIAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_rules_translations" (
    "id" SERIAL NOT NULL,
    "locale" "locales" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "tags" JSONB,
    "forum_rules_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_rules_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_facebook_id_key" ON "users"("facebook_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_apple_id_key" ON "users"("apple_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_subscription_package_locale" ON "subscription_package_translations"("subscription_package_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "unique_educations_locale" ON "education_translations"("education_id", "locale");

-- CreateIndex
CREATE INDEX "page_contents_page_identifier_idx" ON "page_contents"("page_identifier");

-- CreateIndex
CREATE INDEX "page_contents_section_key_idx" ON "page_contents"("section_key");

-- CreateIndex
CREATE UNIQUE INDEX "page_contents_page_identifier_section_key_key" ON "page_contents"("page_identifier", "section_key");

-- CreateIndex
CREATE UNIQUE INDEX "unique_page_content_locale" ON "page_content_translations"("page_content_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateways_name_key" ON "payment_gateways"("name");

-- CreateIndex
CREATE INDEX "payment_gateways_is_active_idx" ON "payment_gateways"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_transaction_id_key" ON "payment_transactions"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_transactions_user_id_idx" ON "payment_transactions"("user_id");

-- CreateIndex
CREATE INDEX "payment_transactions_package_id_idx" ON "payment_transactions"("package_id");

-- CreateIndex
CREATE INDEX "payment_transactions_payment_gateway_id_idx" ON "payment_transactions"("payment_gateway_id");

-- CreateIndex
CREATE INDEX "payment_transactions_status_idx" ON "payment_transactions"("status");

-- CreateIndex
CREATE INDEX "payment_transactions_transaction_id_idx" ON "payment_transactions"("transaction_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_user_id_idx" ON "user_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_package_id_idx" ON "user_subscriptions"("package_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_status_idx" ON "user_subscriptions"("status");

-- CreateIndex
CREATE INDEX "user_subscriptions_user_id_status_idx" ON "user_subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "user_subscriptions_end_date_idx" ON "user_subscriptions"("end_date");

-- CreateIndex
CREATE UNIQUE INDEX "currency_pairs_code_key" ON "currency_pairs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "dynamic_tables_identifier_key" ON "dynamic_tables"("identifier");

-- CreateIndex
CREATE INDEX "table_rows_dynamic_table_id_row_index_idx" ON "table_rows"("dynamic_table_id", "row_index");

-- CreateIndex
CREATE INDEX "table_rows_user_id_idx" ON "table_rows"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "table_rows_dynamic_table_id_row_index_user_id_key" ON "table_rows"("dynamic_table_id", "row_index", "user_id");

-- CreateIndex
CREATE INDEX "table_columns_dynamic_table_id_column_index_idx" ON "table_columns"("dynamic_table_id", "column_index");

-- CreateIndex
CREATE UNIQUE INDEX "table_columns_dynamic_table_id_column_index_key" ON "table_columns"("dynamic_table_id", "column_index");

-- CreateIndex
CREATE INDEX "table_cells_table_row_id_table_column_id_idx" ON "table_cells"("table_row_id", "table_column_id");

-- CreateIndex
CREATE INDEX "table_cells_user_id_idx" ON "table_cells"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "table_cells_table_row_id_table_column_id_user_id_key" ON "table_cells"("table_row_id", "table_column_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_alerts_trade_id_key" ON "trading_alerts"("trade_id");

-- CreateIndex
CREATE INDEX "trading_alerts_date_idx" ON "trading_alerts"("date");

-- CreateIndex
CREATE INDEX "trading_alerts_status_idx" ON "trading_alerts"("status");

-- CreateIndex
CREATE INDEX "trading_alerts_pair_idx" ON "trading_alerts"("pair");

-- CreateIndex
CREATE INDEX "color_configurations_type_is_active_idx" ON "color_configurations"("type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "score_dashboard_currency_pair_id_key" ON "score_dashboard"("currency_pair_id");

-- CreateIndex
CREATE INDEX "score_dashboard_currency_pair_id_idx" ON "score_dashboard"("currency_pair_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_configs_key_key" ON "app_configs"("key");

-- CreateIndex
CREATE INDEX "app_configs_key_idx" ON "app_configs"("key");

-- CreateIndex
CREATE UNIQUE INDEX "fx_analyzer_cache_pair_key" ON "fx_analyzer_cache"("pair");

-- CreateIndex
CREATE INDEX "fx_analyzer_cache_currency_pair_id_idx" ON "fx_analyzer_cache"("currency_pair_id");

-- CreateIndex
CREATE INDEX "fx_analyzer_cache_last_updated_idx" ON "fx_analyzer_cache"("last_updated");

-- CreateIndex
CREATE UNIQUE INDEX "unique_forum_rules_id_locale" ON "forum_rules_translations"("title", "description", "forum_rules_id", "locale");

-- AddForeignKey
ALTER TABLE "subscription_package_translations" ADD CONSTRAINT "subscription_package_translations_subscription_package_id_fkey" FOREIGN KEY ("subscription_package_id") REFERENCES "subscription_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "education_translations" ADD CONSTRAINT "education_translations_education_id_fkey" FOREIGN KEY ("education_id") REFERENCES "educations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_content_translations" ADD CONSTRAINT "page_content_translations_page_content_id_fkey" FOREIGN KEY ("page_content_id") REFERENCES "page_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "subscription_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_gateway_id_fkey" FOREIGN KEY ("payment_gateway_id") REFERENCES "payment_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "subscription_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_payment_transaction_id_fkey" FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_dynamic_table_id_fkey" FOREIGN KEY ("dynamic_table_id") REFERENCES "dynamic_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_currency_pair_id_fkey" FOREIGN KEY ("currency_pair_id") REFERENCES "currency_pairs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_columns" ADD CONSTRAINT "table_columns_dynamic_table_id_fkey" FOREIGN KEY ("dynamic_table_id") REFERENCES "dynamic_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cells" ADD CONSTRAINT "table_cells_table_row_id_fkey" FOREIGN KEY ("table_row_id") REFERENCES "table_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cells" ADD CONSTRAINT "table_cells_table_column_id_fkey" FOREIGN KEY ("table_column_id") REFERENCES "table_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cells" ADD CONSTRAINT "table_cells_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_dashboard" ADD CONSTRAINT "score_dashboard_currency_pair_id_fkey" FOREIGN KEY ("currency_pair_id") REFERENCES "currency_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_analyzer_cache" ADD CONSTRAINT "fx_analyzer_cache_currency_pair_id_fkey" FOREIGN KEY ("currency_pair_id") REFERENCES "currency_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_rules_translations" ADD CONSTRAINT "forum_rules_translations_forum_rules_id_fkey" FOREIGN KEY ("forum_rules_id") REFERENCES "forum_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
