import { logger } from '../utils/logger.util.js';

/**
 * In-memory economic calendar snapshot.
 * Scraping runs in forex-scraping and is pushed here via webhook
 * POST /api/v1/webhooks/economic-calendar/ingest.
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

/** Replace the live snapshot with events pushed from forex-scraping. */
export function applyEconomicCalendarSnapshot(
    events: unknown[],
    scrapedAt: number = Date.now(),
): EconomicCalendarEvent[] {
    const data = events.map(normalizeEvent).filter((e): e is EconomicCalendarEvent => e !== null);
    snapshot = {
        data,
        scrapedAt: Number.isFinite(scrapedAt) ? scrapedAt : Date.now(),
    };
    logger.info(`[EconomicCalendar] Applied webhook snapshot: ${data.length} event(s)`);
    return data;
}

/** Last scraped snapshot, if any — instant, never triggers a scrape. */
export function getEconomicCalendarSnapshot(): Snapshot | null {
    return snapshot;
}
