/**
 * Production-safe FinancialJuice RSS fetch with 429 retry/backoff and minimum interval.
 * Mirrors forex-scraping/src/utils/financialJuiceRssFetch.util.js for admin-backend callers.
 */
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let lastFinancialJuiceRssFetchAt = 0;
let activeFetch: { url: string; promise: Promise<string> } | null = null;

type RssFetchError = Error & {
    stage?: string;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number | null;
};

export type FinancialJuiceRssFetchOptions = {
    maxRetries?: number;
    minIntervalMs?: number;
    backoffBaseMs?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    userAgent?: string;
    logLabel?: string;
    nowFn?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
    if (headerValue == null || headerValue === '') return null;
    const trimmed = String(headerValue).trim();
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }
    return null;
}

export function computeExponentialBackoffMs(attempt: number, baseMs: number): number {
    const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 2000;
    const exponent = Math.max(0, attempt - 1);
    return Math.round(base * (2 ** exponent));
}

function validateRssXml(xml: string): string {
    if (xml.includes('error code: 1015')) {
        const error = new Error('RSS fetch rate-limited (1015)') as RssFetchError;
        error.stage = 'RSS_FETCH';
        error.status = 429;
        error.retryable = true;
        throw error;
    }
    if (/just a moment|cf-browser-verification|security verification/i.test(xml)) {
        const error = new Error('RSS fetch hit Cloudflare challenge') as RssFetchError;
        error.stage = 'RSS_FETCH';
        error.retryable = false;
        throw error;
    }
    return xml;
}

async function performRssHttpFetch(
    url: string,
    {
        fetchImpl,
        userAgent,
        timeoutMs,
    }: {
        fetchImpl: typeof fetch;
        userAgent: string;
        timeoutMs: number;
    },
): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': userAgent,
                Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            },
        });

        if (res.status === 429) {
            const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
            const error = new Error('RSS fetch returned 429') as RssFetchError;
            error.stage = 'RSS_FETCH';
            error.status = 429;
            error.retryable = true;
            error.retryAfterMs = retryAfterMs;
            throw error;
        }

        if (!res.ok) {
            const error = new Error(`RSS fetch returned ${res.status}`) as RssFetchError;
            error.stage = 'RSS_FETCH';
            error.status = res.status;
            error.retryable = false;
            throw error;
        }

        const xml = await res.text();
        return validateRssXml(xml);
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFinancialJuiceRssXmlOnce(
    url: string,
    options: Required<Pick<FinancialJuiceRssFetchOptions, 'maxRetries' | 'minIntervalMs' | 'backoffBaseMs' | 'timeoutMs' | 'fetchImpl' | 'userAgent' | 'logLabel' | 'nowFn' | 'sleepFn'>>,
): Promise<string> {
    const {
        maxRetries,
        minIntervalMs,
        backoffBaseMs,
        timeoutMs,
        fetchImpl,
        userAgent,
        logLabel,
        nowFn,
        sleepFn,
    } = options;

    const now = nowFn();
    if (lastFinancialJuiceRssFetchAt > 0) {
        const elapsed = now - lastFinancialJuiceRssFetchAt;
        if (elapsed < minIntervalMs) {
            const waitMs = minIntervalMs - elapsed;
            logger.info(`[${logLabel}] Minimum RSS interval — waiting ${waitMs}ms before fetch`);
            await sleepFn(waitMs);
        }
    }

    let lastError: RssFetchError | null = null;
    const totalAttempts = maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
            const xml = await performRssHttpFetch(url, { fetchImpl, userAgent, timeoutMs });
            lastFinancialJuiceRssFetchAt = nowFn();
            if (attempt > 1) {
                logger.info(`[${logLabel}] RSS fetch succeeded on attempt ${attempt}/${totalAttempts}`);
            }
            return xml;
        } catch (error) {
            lastError = error as RssFetchError;
            const retryable = Boolean(lastError.retryable) && lastError.status === 429;
            const retriesRemaining = totalAttempts - attempt;

            if (!retryable || retriesRemaining <= 0) {
                lastError.stage = lastError.stage || 'RSS_FETCH';
                logger.error(
                    `[${logLabel}] RSS fetch failed after ${attempt}/${totalAttempts} attempt(s): ${lastError.message}`,
                );
                throw lastError;
            }

            const waitMs = lastError.retryAfterMs ?? computeExponentialBackoffMs(attempt, backoffBaseMs);
            logger.warn(
                `[${logLabel}] HTTP 429 — retry ${attempt}/${maxRetries} in ${waitMs}ms`
                + (lastError.retryAfterMs != null ? ' (Retry-After)' : ' (exponential backoff)'),
            );
            await sleepFn(waitMs);
        }
    }

    const error = lastError || new Error('RSS fetch failed');
    error.stage = 'RSS_FETCH';
    throw error;
}

/**
 * Fetch FinancialJuice RSS XML with minimum interval, bounded 429 retry/backoff,
 * and in-flight deduplication for concurrent callers on the same URL.
 */
export async function fetchFinancialJuiceRssXml(
    url: string,
    {
        maxRetries = ENV.FJ_RSS_MAX_RETRIES,
        minIntervalMs = ENV.FJ_RSS_MIN_INTERVAL_MS,
        backoffBaseMs = ENV.FJ_RSS_BACKOFF_BASE_MS,
        timeoutMs = ENV.FJ_RSS_FETCH_TIMEOUT_MS,
        fetchImpl = fetch,
        userAgent = DEFAULT_USER_AGENT,
        logLabel = 'AdminRssNews',
        nowFn = () => Date.now(),
        sleepFn = sleep,
    }: FinancialJuiceRssFetchOptions = {},
): Promise<string> {
    if (activeFetch?.url === url) {
        return activeFetch.promise;
    }

    const promise = fetchFinancialJuiceRssXmlOnce(url, {
        maxRetries,
        minIntervalMs,
        backoffBaseMs,
        timeoutMs,
        fetchImpl,
        userAgent,
        logLabel,
        nowFn,
        sleepFn,
    });

    activeFetch = { url, promise };
    try {
        return await promise;
    } finally {
        if (activeFetch?.promise === promise) {
            activeFetch = null;
        }
    }
}

/** Test-only reset of minimum-interval gate and in-flight dedupe. */
export function resetFinancialJuiceRssFetchStateForTests(): void {
    lastFinancialJuiceRssFetchAt = 0;
    activeFetch = null;
}
