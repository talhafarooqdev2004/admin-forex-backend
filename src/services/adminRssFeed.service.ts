/**
 * Production admin RSS inspection — fetches FinancialJuice RSS directly.
 * Independent from the local forex-scraping FFE ChatGPT pipeline.
 */
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../utils/logger.util.js';
import {
    FFE_PROMO_HEADLINES,
    assembleFinancialJuiceEvidenceUnit,
    chronologicalSourceUnits,
    type ChronologicalSourceUnit,
} from './ffeEvidencePreprocess.service.js';

export const FINANCIAL_JUICE_RSS_URL = 'https://www.financialjuice.com/feed.ashx?xml=RSS';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const rssParser = new XMLParser({ ignoreAttributes: false, trimValues: true });

export type AdminRssInspectionSnapshot = {
    fetched_at: string;
    feed_url: string;
    normalized_item_count: number;
    excluded: Array<{ reason: string; source: string; title: string; guid: string }>;
    source_units: ChronologicalSourceUnit[];
    financialjuice_count: number;
    fxstreet_count: number;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(value: unknown): string {
    return String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

function rssText(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return String(record['#text'] ?? record['#cdata'] ?? '').trim();
    }
    return String(value).trim();
}

export function identifyRssItemSource(raw: Record<string, unknown>): 'FinancialJuice' | 'FXStreet' | 'Unknown' {
    const title = rssText(raw.title);
    const categories = asArray(raw.category).map((c) => rssText(c)).join(' ');
    const sourceField = rssText(raw.source) || rssText(raw['dc:creator']) || rssText(raw.creator);
    const blob = `${title}\n${categories}\n${sourceField}`;

    if (/^FXStreet\s*:/i.test(title) || /^FXStreet\b/i.test(title) || /\bFXStreet\b/i.test(sourceField) || /\bFXStreet\b/i.test(categories)) {
        return 'FXStreet';
    }
    if (/^FinancialJuice\s*:/i.test(title) || /^FinancialJuice\b/i.test(title) || /\bFinancialJuice\b/i.test(sourceField)) {
        return 'FinancialJuice';
    }
    if (/\bFXStreet\b/i.test(blob) && !/\bFinancialJuice\b/i.test(blob)) {
        return 'FXStreet';
    }
    if (/\bFinancialJuice\b/i.test(blob)) {
        return 'FinancialJuice';
    }
    return 'Unknown';
}

export function stripSourcePrefix(title: string): string {
    return String(title || '')
        .replace(/^(FinancialJuice|FXStreet)\s*:\s*/i, '')
        .trim();
}

function extractGuid(raw: Record<string, unknown>): string {
    const guidField = raw.guid;
    const fromGuid = guidField && typeof guidField === 'object'
        ? String((guidField as Record<string, unknown>)['#text'] ?? '')
        : String(guidField ?? '');
    return (fromGuid || rssText(raw.link) || '').trim();
}

function formatPubDate(pubDate: string | null) {
    const parsed = pubDate ? new Date(pubDate) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    const dd = String(parsed.getUTCDate()).padStart(2, '0');
    const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = parsed.getUTCFullYear();
    const hh = String(parsed.getUTCHours()).padStart(2, '0');
    const min = String(parsed.getUTCMinutes()).padStart(2, '0');
    return {
        iso: parsed.toISOString(),
        display: `${dd}/${mm}/${yyyy}, ${hh}:${min}`,
        epoch: parsed.getTime(),
        businessDay: `${yyyy}-${mm}-${dd}`,
    };
}

export function parseRssChannelItems(xml: string): Record<string, unknown>[] {
    const parsed = rssParser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
    return asArray(parsed?.rss?.channel?.item) as Record<string, unknown>[];
}

type NormalizedRssItem = {
    index: number;
    guid: string;
    source: 'FinancialJuice' | 'FXStreet' | 'Unknown';
    source_label: string;
    title: string;
    description: string;
    pubDate: string | null;
    time: string | null;
    published_at: string | null;
    epoch: number | null;
    business_day: string | null;
};

export function normalizeRssItems(rawItems: Record<string, unknown>[]): NormalizedRssItem[] {
    return rawItems.map((raw, index) => {
        const source = identifyRssItemSource(raw);
        const titleRaw = rssText(raw.title);
        const title = stripSourcePrefix(titleRaw);
        const description = stripHtml(rssText(raw.description) || rssText(raw['content:encoded']));
        const pubDateRaw = rssText(raw.pubDate);
        const when = formatPubDate(pubDateRaw || null);
        return {
            index,
            guid: extractGuid(raw) || `rss-${index + 1}`,
            source,
            source_label: source,
            title,
            description,
            pubDate: pubDateRaw || null,
            time: when?.display || null,
            published_at: when?.iso || null,
            epoch: when?.epoch ?? null,
            business_day: when?.businessDay || null,
        };
    }).filter((item) => item.title);
}

type RetainedFeedUnit = {
    guid: string;
    time: string | null;
    published_at: string | null;
    epoch: number | null;
    source: string;
    source_label: string;
    headline: string;
    body: string;
    supporting_lines: string[];
    actual: string | null;
    forecast: string | null;
    previous: string | null;
};

export function retainNativeFeedUnits(normalizedItems: NormalizedRssItem[]) {
    const retained: RetainedFeedUnit[] = [];
    const excluded: AdminRssInspectionSnapshot['excluded'] = [];

    for (const item of normalizedItems) {
        const sourceOk = item.source === 'FinancialJuice' || item.source === 'FXStreet';
        if (!sourceOk) {
            excluded.push({ reason: 'non_feed_source', source: item.source, title: item.title, guid: item.guid });
            continue;
        }
        if (FFE_PROMO_HEADLINES.has(item.title)) {
            excluded.push({ reason: 'promo', source: item.source, title: item.title, guid: item.guid });
            continue;
        }
        const assembled = assembleFinancialJuiceEvidenceUnit([item.title, item.description].filter(Boolean));
        const headline = assembled?.headline || item.title;
        if (!headline) {
            excluded.push({ reason: 'not_news_unit', source: item.source, title: item.title, guid: item.guid });
            continue;
        }
        retained.push({
            guid: item.guid,
            time: item.time,
            published_at: item.published_at,
            epoch: item.epoch,
            source: item.source,
            source_label: item.source,
            headline,
            body: assembled?.body || '',
            supporting_lines: assembled?.supporting_lines || [],
            actual: assembled?.actual ?? null,
            forecast: assembled?.forecast ?? null,
            previous: assembled?.previous ?? null,
        });
    }

    return { retained, excluded };
}

function validateRssXml(xml: string): string {
    if (xml.includes('error code: 1015')) {
        const error = new Error('RSS fetch rate-limited (1015)') as Error & { status?: number; retryable?: boolean };
        error.status = 429;
        error.retryable = true;
        throw error;
    }
    if (/just a moment|cf-browser-verification|security verification/i.test(xml)) {
        throw new Error('RSS fetch hit Cloudflare challenge');
    }
    return xml;
}

async function performRssHttpFetch(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            },
        });

        if (res.status === 429) {
            const error = new Error('RSS fetch returned 429') as Error & { status?: number; retryable?: boolean };
            error.status = 429;
            error.retryable = true;
            throw error;
        }
        if (!res.ok) {
            throw new Error(`RSS fetch returned ${res.status}`);
        }

        return validateRssXml(await res.text());
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFinancialJuiceRssXml(
    url: string,
    { logLabel = 'AdminRssNews' }: { logLabel?: string } = {},
): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
        try {
            const xml = await performRssHttpFetch(url);
            if (attempt > 1) {
                logger.info(`[${logLabel}] RSS fetch succeeded on attempt ${attempt}/${MAX_RETRIES + 1}`);
            }
            return xml;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const retryable = (lastError as Error & { retryable?: boolean }).retryable === true
                && (lastError as Error & { status?: number }).status === 429;
            const retriesRemaining = MAX_RETRIES + 1 - attempt;

            if (!retryable || retriesRemaining <= 0) {
                logger.error(`[${logLabel}] RSS fetch failed: ${lastError.message}`);
                throw lastError;
            }

            const waitMs = BACKOFF_BASE_MS * (2 ** (attempt - 1));
            logger.warn(`[${logLabel}] HTTP 429 — retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms`);
            await sleep(waitMs);
        }
    }

    throw lastError || new Error('RSS fetch failed');
}

/** Live RSS inspection for admin tools — same normalization as FFE pipeline, no scraper dependency. */
export async function fetchLiveRssInspectionSnapshot({
    feedUrl = FINANCIAL_JUICE_RSS_URL,
    logLabel = 'AdminRssNews',
}: {
    feedUrl?: string;
    logLabel?: string;
} = {}): Promise<AdminRssInspectionSnapshot> {
    const fetchedAt = new Date().toISOString();
    const xml = await fetchFinancialJuiceRssXml(feedUrl, { logLabel });
    const rawItems = parseRssChannelItems(xml);
    const normalizedItems = normalizeRssItems(rawItems);
    const { retained, excluded } = retainNativeFeedUnits(normalizedItems);
    const dated = retained
        .filter((row) => row.epoch != null && row.time)
        .sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
    const sourceUnits = chronologicalSourceUnits(dated, { guidPrefix: 'live' });

    return {
        fetched_at: fetchedAt,
        feed_url: feedUrl,
        normalized_item_count: normalizedItems.length,
        excluded,
        source_units: sourceUnits,
        financialjuice_count: sourceUnits.filter((row) => row.source_label === 'FinancialJuice').length,
        fxstreet_count: sourceUnits.filter((row) => row.source_label === 'FXStreet').length,
    };
}
