import dotenv from 'dotenv';

dotenv.config();

const parseInteger = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, "");

const parseOriginList = (...values: Array<string | undefined>): string[] => {
    const origins = values
        .flatMap((value) => value?.split(",") ?? [])
        .map(normalizeOrigin)
        .filter(Boolean);

    return [...new Set(origins)];
};

const parseEnvBool = (value: string | undefined, fallback: boolean): boolean => {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return fallback;
};

const buildDatabaseUrl = (): string => {
    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }
    const user = encodeURIComponent(process.env.DB_USER || '');
    const password = encodeURIComponent(process.env.DB_PASSWORD || '');
    const host = process.env.DB_HOST || '127.0.0.1';
    const port = process.env.DB_PORT || '5432';
    const database = process.env.DB_NAME || '';
    return `postgresql://${user}:${password}@${host}:${port}/${database}`;
};

export const getAllowedOrigins = (): string[] => parseOriginList(
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
);

export const ENV = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 5005,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DATABASE_URL: buildDatabaseUrl(),
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
    RATE_LIMIT_WINDOW_MS: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 900000),
    RATE_LIMIT_MAX_REQUESTS: parseInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
    /** When false, Redis is not used: in-memory visitor-geo resolution, cache bypass, no worker. */
    REDIS_ENABLED: process.env.REDIS_ENABLED !== 'false' && process.env.REDIS_ENABLED !== '0',
    REDIS_HOST: process.env.REDIS_HOST || 'localhost',
    REDIS_PORT: parseInteger(process.env.REDIS_PORT, 6379),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
    SESSION_SECRET: process.env.SESSION_SECRET || 'secret',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_MODE: process.env.PAYPAL_MODE || 'sandbox',
    CACHE_API_KEY: process.env.CACHE_API_KEY,
    MAX_FILE_SIZE: parseInteger(process.env.MAX_FILE_SIZE, 10485760),
    UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: parseInteger(process.env.SMTP_PORT, 587),
    SMTP_SECURE: process.env.SMTP_SECURE === 'true',
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'forexfundamentaledge@gmail.com',
    GOOGLE_SHEETS_CREDENTIALS_PATH: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH || './google-credentials.json',
    GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID || '1bNnoOYUdUm-AFMTL0LPRqsuId1KI3eHMAF-Wz275RGg',
    RETAIL_SENTIMENT_SHEET_NAME: process.env.RETAIL_SENTIMENT_SHEET_NAME || 'RETAIL SENTIMENTS 7',
    RETAIL_SENTIMENT_SHEET_RANGE: process.env.RETAIL_SENTIMENT_SHEET_RANGE || 'A4:D31',
    /** FX Analyzer: tab "New Sheet" — row 32 header, 33–60 data; col A + W–AE (synced into `fx_technical_trends`). */
    FX_ANALYZER_TECHNICAL_TRENDS_SHEET_NAME: process.env.FX_ANALYZER_TECHNICAL_TRENDS_SHEET_NAME || 'New Sheet',
    FX_ANALYZER_TECHNICAL_TRENDS_RANGE: process.env.FX_ANALYZER_TECHNICAL_TRENDS_RANGE || 'A32:AE60',
    /** FX Analyzer: tab "MAIN SCORE BOARD…" — row 169 header, 170–197 data; cols A–I (synced into `fx_technical_levels`). */
    FX_ANALYZER_TECHNICAL_LEVELS_SHEET_NAME:
        process.env.FX_ANALYZER_TECHNICAL_LEVELS_SHEET_NAME || 'MAIN SCORE BOARD 2A CLIENT& ADMIN',
    FX_ANALYZER_TECHNICAL_LEVELS_RANGE: process.env.FX_ANALYZER_TECHNICAL_LEVELS_RANGE || 'A169:I197',
    /** Edge Tools: `Sentiment Index` tab — Currency Strength Index block (row 2 = header). */
    EDGE_SENTIMENT_INDEX_SHEET_NAME: process.env.EDGE_SENTIMENT_INDEX_SHEET_NAME || 'Sentiment Index',
    EDGE_CURRENCY_STRENGTH_INDEX_RANGE: process.env.EDGE_CURRENCY_STRENGTH_INDEX_RANGE || 'A2:J10',
    /** Same tab — Forex Pair Analysis block (row 15 = header). */
    EDGE_FOREX_PAIR_ANALYSIS_RANGE: process.env.EDGE_FOREX_PAIR_ANALYSIS_RANGE || 'A15:C43',
    /** Edge Tools: `New Sheet` — Technical Dashboard (row 1 = header). */
    EDGE_TECHNICAL_DASHBOARD_SHEET_NAME: process.env.EDGE_TECHNICAL_DASHBOARD_SHEET_NAME || 'New Sheet',
    EDGE_TECHNICAL_DASHBOARD_RANGE: process.env.EDGE_TECHNICAL_DASHBOARD_RANGE || 'A1:AK29',
    /** COT Data & Analysis — `RECENT COT DATA 4A`: Currency Pair Sentiment (row 1 = header). */
    COT_DATA_ANALYSIS_SHEET_NAME: process.env.COT_DATA_ANALYSIS_SHEET_NAME || 'RECENT COT DATA 4A',
    COT_CURRENCY_PAIR_SENTIMENT_RANGE: process.env.COT_CURRENCY_PAIR_SENTIMENT_RANGE || 'T1:AA18',
    /** Same tab — rows 24–51, all data (no header row in sheet). */
    COT_SENTIMENT_NET_SCORE_RANGE: process.env.COT_SENTIMENT_NET_SCORE_RANGE || 'A24:C51',
    /** Same tab — row 72 = header. */
    COT_RAW_DATA_RANGE: process.env.COT_RAW_DATA_RANGE || 'A72:W89',
    SCORE_DASHBOARD_SHEET_NAME: process.env.SCORE_DASHBOARD_SHEET_NAME || 'Sheet76',
    SCORE_DASHBOARD_SHEET_RANGE: process.env.SCORE_DASHBOARD_SHEET_RANGE || 'A2:J30',
    SCRAPER_WEBHOOK_SECRET: process.env.SCRAPER_WEBHOOK_SECRET || 'forex-scraper-webhook-secret',
    /**
     * When true, loopback/private client IPs are stored as resolved rows with country
     * "Local or private network" (for local testing only). Default is false in all environments:
     * only routable public IPs are recorded unless you set VISITOR_GEO_RECORD_NON_PUBLIC=true.
     */
    VISITOR_GEO_RECORD_NON_PUBLIC: parseEnvBool(process.env.VISITOR_GEO_RECORD_NON_PUBLIC, false),
};
