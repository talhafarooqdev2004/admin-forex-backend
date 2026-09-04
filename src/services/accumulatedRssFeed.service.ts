import {
    applyAccumulatedRssSync,
    getPersistedAccumulatedFeedForActiveBusinessDay,
    type AccumulatedRssSyncPayload,
} from './accumulatedRssPersist.service.js';

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

export async function getAccumulatedFinancialJuiceFeed(
    now: Date = new Date(),
): Promise<AccumulatedRssNewsResponse> {
    return getPersistedAccumulatedFeedForActiveBusinessDay(now);
}

export function syncAccumulatedFinancialJuiceFeed(
    payload: AccumulatedRssSyncPayload,
    now: Date = new Date(),
) {
    return applyAccumulatedRssSync(payload, now);
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
