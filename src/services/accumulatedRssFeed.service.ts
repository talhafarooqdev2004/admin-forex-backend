import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ENV } from '../config/env.js';

export type AccumulatedRssNewsItem = {
    guid: string;
    timestamp: string;
    source: string;
    headline: string;
    body: string;
    original_order: number;
    source_unit_hash: string;
    published_at?: string | null;
    epoch?: number | null;
};

export type AccumulatedRssNewsResponse = {
    success: true;
    business_day: string;
    count: number;
    earliest_timestamp: string | null;
    latest_timestamp: string | null;
    financialjuice_count: number;
    fxstreet_count: number;
    items: AccumulatedRssNewsItem[];
};

type ScrapingAccumulatorModule = {
    getAccumulatedFeedForActiveBusinessDay: (options?: {
        now?: Date;
        accumulatorDir?: string;
    }) => Promise<AccumulatedRssNewsResponse>;
};

const DEFAULT_ACCUMULATOR_DIR = ENV.FOREX_SCRAPING_ACCUMULATOR_DIR
    || path.join(ENV.FOREX_SCRAPING_ROOT, 'artifacts', 'financialjuice-rss-accumulator');

let accumulatorModulePromise: Promise<ScrapingAccumulatorModule> | null = null;

async function loadAccumulatorModule(): Promise<ScrapingAccumulatorModule> {
    if (!accumulatorModulePromise) {
        const modulePath = path.join(
            ENV.FOREX_SCRAPING_ROOT,
            'src/services/financialJuiceRssAccumulator.service.js',
        );
        accumulatorModulePromise = import(pathToFileURL(modulePath).href) as Promise<ScrapingAccumulatorModule>;
    }
    return accumulatorModulePromise;
}

export async function getAccumulatedFinancialJuiceFeed(
    now: Date = new Date(),
): Promise<AccumulatedRssNewsResponse> {
    const { getAccumulatedFeedForActiveBusinessDay } = await loadAccumulatorModule();
    return getAccumulatedFeedForActiveBusinessDay({
        now,
        accumulatorDir: DEFAULT_ACCUMULATOR_DIR,
    });
}

export function formatAccumulatedRssNewsCopyText(
    businessDay: string,
    items: AccumulatedRssNewsItem[],
): string {
    const lines: string[] = [
        'FinancialJuice Accumulated Feed',
        `Business Day: ${businessDay}`,
        `Total Unique Items: ${items.length}`,
        '',
    ];
    for (const item of items) {
        const hhmmMatch = item.timestamp.match(/,\s*(\d{2}:\d{2})\s*$/);
        const hhmm = hhmmMatch?.[1] || item.timestamp;
        lines.push(`[${hhmm}] [${item.source}]`);
        lines.push(item.headline);
        if (item.body.trim()) {
            lines.push(item.body.trim());
        }
        if (item.published_at) {
            lines.push(`published_at: ${item.published_at}`);
        }
        lines.push(`guid: ${item.guid}`);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
