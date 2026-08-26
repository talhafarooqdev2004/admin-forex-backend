import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

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
    data_source: 'live' | 'snapshot' | null;
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

const SCRAPER_ROOT = path.resolve(process.cwd(), '../forex-scraping');
const SCRAPER_SNAPSHOT_MODULE = path.join(SCRAPER_ROOT, 'src/services/ffeRssSnapshot.service.js');
const FFE_DAILY_RUNS_DIR = path.join(SCRAPER_ROOT, 'artifacts/ffe-daily-runs');

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

async function fetchLiveInspectionSnapshot() {
    const moduleUrl = pathToFileURL(SCRAPER_SNAPSHOT_MODULE).href;
    const rssModule = await import(moduleUrl) as {
        fetchLiveRssInspectionSnapshot: (options?: { logLabel?: string }) => Promise<{
            fetched_at: string;
            source_units: SourceUnit[];
            financialjuice_count: number;
            fxstreet_count: number;
        }>;
    };
    return rssModule.fetchLiveRssInspectionSnapshot({ logLabel: 'AdminRssNews' });
}

async function loadLocalSnapshotForBusinessDay(businessDay: string) {
    let entries: string[] = [];
    try {
        entries = await fs.readdir(FFE_DAILY_RUNS_DIR);
    } catch {
        return null;
    }

    let best: { snapshot: Record<string, unknown>; sortKey: string } | null = null;

    for (const entry of entries) {
        const snapshotPath = path.join(FFE_DAILY_RUNS_DIR, entry, 'ffe-snapshot.json');
        try {
            const raw = await fs.readFile(snapshotPath, 'utf8');
            const snapshot = JSON.parse(raw) as Record<string, unknown>;
            if (snapshot.business_day !== businessDay) continue;
            const sortKey = String(snapshot.created_at || (snapshot.raw as { fetched_at?: string } | undefined)?.fetched_at || entry);
            if (!best || sortKey > best.sortKey) {
                best = { snapshot, sortKey };
            }
        } catch {
            // skip unreadable runs
        }
    }

    return best?.snapshot ?? null;
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
    let dataSource: 'live' | 'snapshot' | null = null;
    let filteredUnits: SourceUnit[] = [];

    try {
        const live = await fetchLiveInspectionSnapshot();
        fetchedAt = live.fetched_at;
        dataSource = 'live';
        filteredUnits = filterUnitsByBusinessDay(live.source_units, businessDay);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const snapshot = await loadLocalSnapshotForBusinessDay(businessDay);
        if (snapshot && Array.isArray(snapshot.source_units)) {
            filteredUnits = filterUnitsByBusinessDay(snapshot.source_units as SourceUnit[], businessDay);
            if (filteredUnits.length > 0) {
                fetchedAt = String(
                    (snapshot.raw as { fetched_at?: string } | undefined)?.fetched_at
                    || snapshot.created_at
                    || null,
                );
                dataSource = 'snapshot';
            }
        }
        if (filteredUnits.length === 0) {
            return buildUnavailableResponse(
                businessDay,
                `Live RSS fetch failed: ${message}`,
            );
        }
    }

    if (filteredUnits.length === 0) {
        const snapshot = await loadLocalSnapshotForBusinessDay(businessDay);
        if (snapshot && Array.isArray(snapshot.source_units)) {
            filteredUnits = filterUnitsByBusinessDay(snapshot.source_units as SourceUnit[], businessDay);
            if (filteredUnits.length > 0) {
                fetchedAt = String(
                    (snapshot.raw as { fetched_at?: string } | undefined)?.fetched_at
                    || snapshot.created_at
                    || fetchedAt,
                );
                dataSource = 'snapshot';
            }
        }
    }

    if (filteredUnits.length === 0) {
        return buildUnavailableResponse(
            businessDay,
            `No RSS news is available for ${businessDay}. The live feed did not contain items for this day and no local snapshot was found.`,
        );
    }

    const items = filteredUnits
        .map(mapSourceUnit)
        .sort((a, b) => a.original_order - b.original_order);
    const counts = countBySource(items);

    return {
        business_day: businessDay,
        fetched_at: fetchedAt,
        data_source: dataSource,
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
