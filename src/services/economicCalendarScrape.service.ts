import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.util.js';

/**
 * Economic calendar snapshot — filled by forex-scraping webhook.
 * Persisted to disk so admin restarts / deploys do not wipe the week and force
 * the dashboard into fake STATIC rows (UK O-Orders for every currency).
 */

export type EconomicCalendarEvent = {
    time: string;
    /** Dubai-local wall clock from scraper, e.g. "2026-07-14 02:00:00". */
    timestamp: string;
    currency: string;
    country: string;
    event: string;
    impact: 'Low' | 'Medium' | 'High';
    actual: string | null;
    forecast: string | null;
    previous: string | null;
    trendScore: number;
    evidenceScore: number;
    bias: 'Bullish' | 'Bearish' | 'Neutral';
    /** Investing.com DOM row id when provided (eventRowId_…). */
    id?: string | null;
};

type Snapshot = { data: EconomicCalendarEvent[]; scrapedAt: number };

const SNAPSHOT_PATH = path.join(process.cwd(), 'data', 'economic-calendar-snapshot.json');

let snapshot: Snapshot | null = null;

function isValidImpact(value: unknown): value is EconomicCalendarEvent['impact'] {
    return value === 'Low' || value === 'Medium' || value === 'High';
}

function isValidBias(value: unknown): value is EconomicCalendarEvent['bias'] {
    return value === 'Bullish' || value === 'Bearish' || value === 'Neutral';
}

function normalizeEvent(raw: unknown): EconomicCalendarEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const time = String(row.time ?? '').trim();
    const currency = String(row.currency ?? '').trim();
    const event = String(row.event ?? '').trim();
    if (!time || !currency || !event) return null;

    const impact = isValidImpact(row.impact) ? row.impact : 'Low';
    const bias = isValidBias(row.bias) ? row.bias : 'Neutral';
    const trendScore = Number(row.trendScore);
    const evidenceScore = Number(row.evidenceScore);

    return {
        time,
        timestamp: String(row.timestamp ?? '').trim(),
        currency,
        country: String(row.country ?? '').trim(),
        event,
        impact,
        actual: row.actual == null || row.actual === '' ? null : String(row.actual),
        forecast: row.forecast == null || row.forecast === '' ? null : String(row.forecast),
        previous: row.previous == null || row.previous === '' ? null : String(row.previous),
        trendScore: Number.isFinite(trendScore) ? trendScore : 0,
        evidenceScore: Number.isFinite(evidenceScore) ? evidenceScore : 0,
        bias,
        id: row.id == null || row.id === '' ? null : String(row.id),
    };
}

function persistSnapshot(next: Snapshot): void {
    try {
        fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(next), 'utf8');
    } catch (err) {
        logger.warn(
            `[EconomicCalendar] Failed to persist snapshot: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

function loadPersistedSnapshot(): Snapshot | null {
    try {
        if (!fs.existsSync(SNAPSHOT_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as {
            data?: unknown[];
            scrapedAt?: number;
        };
        if (!Array.isArray(raw?.data) || raw.data.length === 0) return null;
        const data = raw.data.map(normalizeEvent).filter((e): e is EconomicCalendarEvent => e !== null);
        if (data.length === 0) return null;
        const scrapedAt = Number.isFinite(raw.scrapedAt) ? Number(raw.scrapedAt) : Date.now();
        logger.info(`[EconomicCalendar] Restored persisted snapshot: ${data.length} event(s)`);
        return { data, scrapedAt };
    } catch (err) {
        logger.warn(
            `[EconomicCalendar] Failed to load persisted snapshot: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

// Restore on process boot so GET /economic-calendar is never empty after deploy restart.
snapshot = loadPersistedSnapshot();

function eventMergeKey(e: EconomicCalendarEvent): string {
    if (e.id) return `id:${e.id}`;
    return `${e.timestamp}|${e.currency}|${e.event}`.toLowerCase();
}

/**
 * Merge a possibly-partial scrape into the prior snapshot:
 * - Matching keys get updated (actual/forecast/previous/scores).
 * - New keys are added.
 * - Prior keys missing from a truncated scrape are kept (never wipe the week).
 */
function mergeCalendarSnapshots(
    previous: EconomicCalendarEvent[],
    incoming: EconomicCalendarEvent[],
): EconomicCalendarEvent[] {
    const map = new Map<string, EconomicCalendarEvent>();
    for (const e of previous) map.set(eventMergeKey(e), e);
    for (const e of incoming) map.set(eventMergeKey(e), e);
    return [...map.values()].sort((a, b) => {
        const ta = a.timestamp.localeCompare(b.timestamp);
        if (ta !== 0) return ta;
        const ca = a.currency.localeCompare(b.currency);
        if (ca !== 0) return ca;
        return a.event.localeCompare(b.event);
    });
}

/**
 * Replace the live snapshot with events pushed from forex-scraping.
 * Refuses to wipe a good snapshot with an empty scrape.
 * Truncated scrapes are MERGED into the prior week (update actuals + keep missing rows).
 */
export function applyEconomicCalendarSnapshot(
    events: unknown[],
    scrapedAt: number = Date.now(),
): EconomicCalendarEvent[] {
    const data = events.map(normalizeEvent).filter((e): e is EconomicCalendarEvent => e !== null);

    if (data.length === 0) {
        if (snapshot?.data?.length) {
            logger.warn(
                `[EconomicCalendar] Ignoring empty ingest — keeping existing ${snapshot.data.length} event(s)`,
            );
            return snapshot.data;
        }
        logger.warn('[EconomicCalendar] Empty ingest and no prior snapshot');
        return [];
    }

    const prev = snapshot?.data ?? [];
    const prevCount = prev.length;
    const looksTruncated = prevCount >= 40 && data.length < Math.floor(prevCount * 0.7);

    let nextData: EconomicCalendarEvent[];
    if (looksTruncated) {
        nextData = mergeCalendarSnapshots(prev, data);
        logger.warn(
            `[EconomicCalendar] Truncated ingest (${data.length} vs prior ${prevCount}) — merged → ${nextData.length} event(s)`,
        );
    } else {
        // Full / healthy scrape: still merge once so we never lose a row that briefly
        // failed to render on Investing's lazy table (union of prior + new).
        nextData = prevCount > 0 ? mergeCalendarSnapshots(prev, data) : data;
        // If the new scrape is clearly the full week (same size or larger), prefer it
        // as the authority so removed/cancelled events can disappear after a good pull.
        if (data.length >= prevCount && data.length >= 40) {
            nextData = data;
        }
        logger.info(
            `[EconomicCalendar] Applied webhook snapshot: ${nextData.length} event(s)` +
                (nextData.length !== data.length ? ` (merged from ${data.length} scraped)` : ''),
        );
    }

    snapshot = {
        data: nextData,
        scrapedAt: Number.isFinite(scrapedAt) ? scrapedAt : Date.now(),
    };
    persistSnapshot(snapshot);
    return nextData;
}

/** Last scraped snapshot, if any — instant, never triggers a scrape. */
export function getEconomicCalendarSnapshot(): Snapshot | null {
    if (!snapshot?.data?.length) {
        const restored = loadPersistedSnapshot();
        if (restored) snapshot = restored;
    }
    return snapshot;
}
