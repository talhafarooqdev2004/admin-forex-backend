import { fetchLiveRssInspectionSnapshot } from './adminRssFeed.service.js';

export type AdminRssNewsItem = {
    guid: string;
    timestamp: string;
    source: string;
    headline: string;
    body: string;
    original_order: number;
    source_unit_hash: string;
};

export type AdminRssNewsResponse = {
    business_day: string;
    fetched_at: string | null;
    data_source: 'live' | null;
    available: boolean;
    message?: string;
    total: number;
    financialjuice_count: number;
    fxstreet_count: number;
    items: AdminRssNewsItem[];
};

type SourceUnit = {
    guid?: string;
    time?: string | null;
    source?: string;
    source_label?: string;
    headline?: string;
    body?: string;
    original_order?: number;
    source_unit_hash?: string;
};

function todayUtcDayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function isValidDayKey(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function unitBusinessDay(unit: SourceUnit): string | null {
    const match = String(unit.time || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function mapSourceUnit(unit: SourceUnit): AdminRssNewsItem {
    return {
        guid: String(unit.guid || ''),
        timestamp: String(unit.time || ''),
        source: String(unit.source_label || unit.source || 'Unknown'),
        headline: String(unit.headline || ''),
        body: String(unit.body || ''),
        original_order: Number(unit.original_order || 0),
        source_unit_hash: String(unit.source_unit_hash || ''),
    };
}

function filterUnitsByBusinessDay(units: SourceUnit[], businessDay: string): SourceUnit[] {
    return units.filter((unit) => unitBusinessDay(unit) === businessDay);
}

function countBySource(items: AdminRssNewsItem[]) {
    return {
        financialjuice_count: items.filter((row) => row.source === 'FinancialJuice').length,
        fxstreet_count: items.filter((row) => row.source === 'FXStreet').length,
    };
}

function buildUnavailableResponse(businessDay: string, message: string): AdminRssNewsResponse {
    return {
        business_day: businessDay,
        fetched_at: null,
        data_source: null,
        available: false,
        message,
        total: 0,
        financialjuice_count: 0,
        fxstreet_count: 0,
        items: [],
    };
}

export async function getAdminRssNews(businessDayInput?: string): Promise<AdminRssNewsResponse> {
    const businessDay = isValidDayKey(String(businessDayInput || '').trim())
        ? String(businessDayInput).trim()
        : todayUtcDayKey();

    let fetchedAt: string | null = null;
    let filteredUnits: SourceUnit[] = [];

    try {
        const live = await fetchLiveRssInspectionSnapshot({ logLabel: 'AdminRssNews' });
        fetchedAt = live.fetched_at;
        filteredUnits = filterUnitsByBusinessDay(live.source_units, businessDay);
    } catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        const status = (error as { status?: number }).status;
        const message = status === 429
            ? `${base}. FinancialJuice rate limit persisted after bounded retries — wait at least one minute before fetching again.`
            : base;
        return buildUnavailableResponse(
            businessDay,
            `Live RSS fetch failed: ${message}`,
        );
    }

    if (filteredUnits.length === 0) {
        return buildUnavailableResponse(
            businessDay,
            `No RSS news is available for ${businessDay}. The live feed did not contain items for this day.`,
        );
    }

    const items = filteredUnits
        .map(mapSourceUnit)
        .sort((a, b) => a.original_order - b.original_order);
    const counts = countBySource(items);

    return {
        business_day: businessDay,
        fetched_at: fetchedAt,
        data_source: 'live',
        available: true,
        total: items.length,
        financialjuice_count: counts.financialjuice_count,
        fxstreet_count: counts.fxstreet_count,
        items,
    };
}

export function formatAdminRssNewsCopyText(businessDay: string, items: AdminRssNewsItem[]): string {
    const lines: string[] = [`[${businessDay}]`, ''];
    for (const item of items) {
        const hhmmMatch = item.timestamp.match(/,\s*(\d{2}:\d{2})\s*$/);
        const hhmm = hhmmMatch?.[1] || item.timestamp;
        lines.push(`[${hhmm}] [${item.source}]`);
        lines.push(item.headline);
        if (item.body.trim()) {
            lines.push(item.body.trim());
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
