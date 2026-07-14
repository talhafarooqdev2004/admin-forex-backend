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
    /** Raw investing.com row timestamp, e.g. "2026-07-06 07:00:00" (widget timezone). */
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

/**
 * Replace the live snapshot with events pushed from forex-scraping.
 * Refuses to wipe a good snapshot with an empty/failed scrape.
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

    // Guard against truncated scrapes wiping a full week (e.g. only Monday rows).
    const prevCount = snapshot?.data?.length ?? 0;
    if (prevCount >= 40 && data.length < Math.floor(prevCount * 0.35)) {
        logger.warn(
            `[EconomicCalendar] Ignoring truncated ingest (${data.length} vs prior ${prevCount}) — keeping existing snapshot`,
        );
        return snapshot!.data;
    }

    snapshot = {
        data,
        scrapedAt: Number.isFinite(scrapedAt) ? scrapedAt : Date.now(),
    };
    persistSnapshot(snapshot);
    logger.info(`[EconomicCalendar] Applied webhook snapshot: ${data.length} event(s)`);
    return data;
}

/** Last scraped snapshot, if any — instant, never triggers a scrape. */
export function getEconomicCalendarSnapshot(): Snapshot | null {
    if (!snapshot?.data?.length) {
        const restored = loadPersistedSnapshot();
        if (restored) snapshot = restored;
    }
    return snapshot;
}
