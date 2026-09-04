import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.util.js';
import {
    marketBusinessDayKey,
    previousMarketBusinessDayKey,
} from '../utils/marketBusinessDay.util.js';
import type { AccumulatedRssNewsItem } from './accumulatedRssFeed.service.js';

const STATE_VERSION = 1;

export type AccumulatedRssSyncPayload = {
    business_day: string;
    count?: number;
    earliest_timestamp?: string | null;
    latest_timestamp?: string | null;
    financialjuice_count?: number;
    fxstreet_count?: number;
    items: AccumulatedRssNewsItem[];
};

type DayBucket = {
    business_day: string;
    items: Record<string, AccumulatedRssNewsItem>;
    first_synced_at: string | null;
    last_synced_at: string | null;
};

type PersistedState = {
    version: number;
    days: Record<string, DayBucket>;
    updated_at: string | null;
};

function resolveStatePath(): string {
    return process.env.ACCUMULATED_RSS_STATE_PATH
        || path.join(process.cwd(), 'data', 'financialjuice-accumulated-rss', 'state.json');
}

function emptyState(): PersistedState {
    return {
        version: STATE_VERSION,
        days: {},
        updated_at: null,
    };
}

function dayBucket(dayKey: string): DayBucket {
    return {
        business_day: dayKey,
        items: {},
        first_synced_at: null,
        last_synced_at: null,
    };
}

function retainedBusinessDayKeys(now: Date = new Date()): Set<string> {
    return new Set([
        marketBusinessDayKey(now),
        previousMarketBusinessDayKey(now),
    ]);
}

function expireOldDays(state: PersistedState, now: Date = new Date()): void {
    const keep = retainedBusinessDayKeys(now);
    for (const dayKey of Object.keys(state.days)) {
        if (!keep.has(dayKey)) {
            delete state.days[dayKey];
        }
    }
}

export function itemIdentity(item: AccumulatedRssNewsItem): string | null {
    const guid = String(item?.guid || '').trim();
    if (guid) return `guid:${guid}`;
    const hash = String(item?.source_unit_hash || '').trim();
    if (hash) return `hash:${hash}`;
    return null;
}

function normalizeItem(raw: unknown): AccumulatedRssNewsItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const guid = String(row.guid || '').trim();
    const headline = String(row.headline || '').trim();
    const timestamp = String(row.timestamp || '').trim();
    if (!guid || !headline || !timestamp) return null;

    const source = String(row.source || 'FinancialJuice').trim() || 'FinancialJuice';
    const originalOrder = Number(row.original_order);
    const sourceUnitHash = String(row.source_unit_hash || '').trim();
    const epochRaw = row.epoch;
    const epoch = epochRaw == null || epochRaw === ''
        ? null
        : Number(epochRaw);

    return {
        guid,
        timestamp,
        source,
        headline,
        body: String(row.body || ''),
        original_order: Number.isFinite(originalOrder) ? originalOrder : 0,
        source_unit_hash: sourceUnitHash,
        published_at: row.published_at == null || row.published_at === ''
            ? null
            : String(row.published_at),
        epoch: Number.isFinite(epoch) ? epoch : null,
    };
}

function sortItemsChronologically(items: AccumulatedRssNewsItem[]): AccumulatedRssNewsItem[] {
    return [...items].sort((a, b) => {
        const ae = a.epoch ?? 0;
        const be = b.epoch ?? 0;
        if (ae !== be) return ae - be;
        return String(a.guid).localeCompare(String(b.guid));
    });
}

function computeDayStats(items: AccumulatedRssNewsItem[]) {
    const sorted = sortItemsChronologically(items);
    const earliest = sorted[0] ?? null;
    const latest = sorted[sorted.length - 1] ?? null;

    return {
        count: sorted.length,
        earliest_timestamp: earliest?.published_at || earliest?.timestamp || null,
        latest_timestamp: latest?.published_at || latest?.timestamp || null,
        financialjuice_count: sorted.filter((row) => row.source === 'FinancialJuice').length,
        fxstreet_count: sorted.filter((row) => row.source === 'FXStreet').length,
        items: sorted,
    };
}

function loadPersistedState(): PersistedState {
    const statePath = resolveStatePath();
    try {
        if (!fs.existsSync(statePath)) return emptyState();
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PersistedState;
        if (!raw || typeof raw !== 'object' || !raw.days) return emptyState();
        return raw;
    } catch (err) {
        logger.warn(
            `[AccumulatedRss] Failed to load persisted state: ${err instanceof Error ? err.message : String(err)}`,
        );
        return emptyState();
    }
}

function persistState(state: PersistedState): void {
    const statePath = resolveStatePath();
    try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(tmpPath, statePath);
    } catch (err) {
        logger.warn(
            `[AccumulatedRss] Failed to persist state: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
    }
}

function mergeItemsIntoDay(
    bucket: DayBucket,
    incoming: AccumulatedRssNewsItem[],
    syncedAt: string,
): number {
    let added = 0;
    for (const item of incoming) {
        const identity = itemIdentity(item);
        if (!identity || bucket.items[identity]) continue;
        bucket.items[identity] = item;
        added += 1;
    }
    if (added > 0 || !bucket.first_synced_at) {
        bucket.first_synced_at = bucket.first_synced_at || syncedAt;
    }
    bucket.last_synced_at = syncedAt;
    return added;
}

let cachedState: PersistedState | null = null;

function getState(): PersistedState {
    if (!cachedState) {
        cachedState = loadPersistedState();
    }
    return cachedState;
}

/** Test helper — reset in-memory cache and optionally delete persisted file. */
export function resetAccumulatedRssPersistState(options: { deleteFile?: boolean } = {}): void {
    cachedState = null;
    if (options.deleteFile) {
        const statePath = resolveStatePath();
        try {
            if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
        } catch {
            // ignore
        }
    }
}

export function applyAccumulatedRssSync(
    payload: AccumulatedRssSyncPayload,
    now: Date = new Date(),
): {
    business_day: string;
    count: number;
    added: number;
    earliest_timestamp: string | null;
    latest_timestamp: string | null;
    financialjuice_count: number;
    fxstreet_count: number;
} {
    const businessDay = String(payload?.business_day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
        throw new Error('business_day must be YYYY-MM-DD');
    }

    const incomingItems = (Array.isArray(payload.items) ? payload.items : [])
        .map(normalizeItem)
        .filter((item): item is AccumulatedRssNewsItem => item !== null);

    const syncedAt = now.toISOString();
    const current = getState();
    const state: PersistedState = {
        ...current,
        version: STATE_VERSION,
        days: { ...current.days },
        updated_at: syncedAt,
    };

    expireOldDays(state, now);

    const existingBucket = state.days[businessDay];
    const bucket: DayBucket = existingBucket
        ? { ...existingBucket, items: { ...existingBucket.items } }
        : dayBucket(businessDay);

    const added = mergeItemsIntoDay(bucket, incomingItems, syncedAt);
    state.days[businessDay] = bucket;

    const stats = computeDayStats(Object.values(bucket.items));
    cachedState = state;
    persistState(state);

    logger.info(
        `[AccumulatedRss] Synced day=${businessDay} incoming=${incomingItems.length}`
        + ` added=${added} total=${stats.count}`,
    );

    return {
        business_day: businessDay,
        count: stats.count,
        added,
        earliest_timestamp: stats.earliest_timestamp,
        latest_timestamp: stats.latest_timestamp,
        financialjuice_count: stats.financialjuice_count,
        fxstreet_count: stats.fxstreet_count,
    };
}

export function getPersistedAccumulatedFeedForActiveBusinessDay(
    now: Date = new Date(),
): {
    success: true;
    business_day: string;
    count: number;
    earliest_timestamp: string | null;
    latest_timestamp: string | null;
    financialjuice_count: number;
    fxstreet_count: number;
    items: AccumulatedRssNewsItem[];
} {
    const businessDay = marketBusinessDayKey(now);
    const state = getState();
    const bucket = state.days[businessDay];
    if (!bucket) {
        return {
            success: true,
            business_day: businessDay,
            count: 0,
            earliest_timestamp: null,
            latest_timestamp: null,
            financialjuice_count: 0,
            fxstreet_count: 0,
            items: [],
        };
    }

    const stats = computeDayStats(Object.values(bucket.items));
    return {
        success: true,
        business_day: businessDay,
        count: stats.count,
        earliest_timestamp: stats.earliest_timestamp,
        latest_timestamp: stats.latest_timestamp,
        financialjuice_count: stats.financialjuice_count,
        fxstreet_count: stats.fxstreet_count,
        items: stats.items,
    };
}
