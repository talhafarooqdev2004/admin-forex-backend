import { prisma } from '../lib/prisma.js';
import { uaeDayKey } from './marketDriverBoard.service.js';

export type GeopoliticalRiskWatchResult = {
    /** Normalized 0.00–1.00 (doc §29). */
    score: number;
    /** Band label — UI may hide this; kept for API consumers. */
    band: 'Low Risk' | 'Watch' | 'Elevated' | 'High Risk';
    explanation: string;
    /** Count of distinct geopolitical events contributing to the gauge (after §28 dedup). */
    eventCount: number;
};

export type GeoHeadline = {
    headline: string;
    impact: string;
    summary: string | null;
    assets: unknown;
    published_at: Date | null;
    created_at: Date;
};

const TRACKED_GEO_ASSETS = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'GOLD', 'OIL']);

function hasScoredTrackedAsset(assets: unknown): boolean {
    if (!Array.isArray(assets)) return false;
    return assets.some((asset) => {
        if (!asset || typeof asset !== 'object') return false;
        const row = asset as Record<string, unknown>;
        return TRACKED_GEO_ASSETS.has(String(row.asset ?? '').toUpperCase()) && Number(row.score) !== 0;
    });
}

/**
 * Doc §29 severity deltas for AI-classified GEOPOLITICAL headlines.
 * Positive = more risk; negative = de-escalation.
 */
export function scoreGeoHeadlineDelta(headline: string, impact: string, summary?: string | null): number {
    const text = `${headline} ${summary ?? ''}`.toLowerCase();

    const deEsc =
        /\b(ceasefire|truce|peace agreement|peace deal|de-escalat|diplomacy|diplomatic talks|talks remain|negotiations? progress|sanctions? (lift|remov|eas)|restraint|deconflict)\b/.test(
            text,
        ) && !/\b(collapse|fail|denied|unfounded|break(s|ing)? down|violat)\b/.test(text);

    if (deEsc) {
        if (/\b(peace agreement|peace deal|sanctions? (lift|remov))\b/.test(text)) return -0.3;
        if (/\b(ceasefire|truce)\b/.test(text)) return -0.2;
        return -0.1;
    }

    if (
        /\b(nuclear (strike|weapon|attack)|closure of (the )?strait|strait (of )?hormuz (closed|block)|global (war|conflict)|world war)\b/.test(
            text,
        )
    ) {
        return 0.4;
    }

    if (
        /\b(military (strike|attack|options?)|missile|airstrike|carriers?|invasion|mobilization|energy infrastructure|pipeline (attack|hit)|shipping (halt|suspend)|blockade)\b/.test(
            text,
        )
    ) {
        return impact === 'High' ? 0.3 : 0.2;
    }

    if (/\b(hormuz|strait|oil.?supply|sanction|escalat|conflict|war|attack|strike|nuclear talk|instability)\b/.test(text)) {
        if (impact === 'High') return 0.2;
        if (impact === 'Medium') return 0.1;
        return 0.05;
    }

    if (impact === 'High') return 0.1;
    if (impact === 'Medium') return 0.05;
    return 0.05;
}

function bandFromScore(score: number): GeopoliticalRiskWatchResult['band'] {
    // Doc §29: 0.00–0.24 Low, 0.25–0.49 Watch, 0.50–0.74 Elevated, 0.75–1.00 High
    if (score <= 0.24) return 'Low Risk';
    if (score <= 0.49) return 'Watch';
    if (score <= 0.74) return 'Elevated';
    return 'High Risk';
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/**
 * Doc §28 — same geopolitical theater/event counted once.
 * Wire paraphrases about Iran / Hormuz / shipping the same day must not each add a full delta.
 */
function topicKey(headline: string): string {
    const h = headline.toLowerCase();

    // One Middle-East escalation pool (Iran / Hormuz / Strait / shipping attacks).
    const iran = /\b(iran|iranian|tehran)\b/.test(h);
    if (
        /\b(hormuz|strait)\b/.test(h) ||
        (iran &&
            /\b(israel|us|u\.s|usa|strike|missile|nuclear|shipping|tanker|oil|military|deal|agreement|ceasefire|truce|sites?)\b/.test(
                h,
            )) ||
        (/\b(shipping|tanker)\b/.test(h) && /\b(iran|iranian|hormuz|strait|attack)\b/.test(h))
    ) {
        return 'me-escalation';
    }

    if (/\bceasefire|truce\b/.test(h) && !iran) return 'ceasefire-other';
    if (/\bsanction/.test(h) && !iran) return 'sanctions';
    if (/\bukraine|russia\b/.test(h)) return 'ukraine';
    if (/\bgaza|hamas|hezbollah\b/.test(h)) return 'levant';

    return h
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
}

function eventTime(row: GeoHeadline): Date {
    return row.published_at ?? row.created_at;
}

function buildExplanation(items: { headline: string; delta: number }[], score: number): string {
    if (!items.length) {
        return 'No active geopolitical headlines in today’s news pool.';
    }
    const escalations = items.filter((i) => i.delta > 0).length;
    const deEsc = items.filter((i) => i.delta < 0).length;
    if (score < 0.25 && deEsc >= escalations) {
        return 'De-escalation dominates. Active talks and restraint keep geopolitical risk contained.';
    }
    if (score >= 0.75) {
        return 'Severe geopolitical pressure. Escalation headlines dominate today’s news flow.';
    }
    if (score >= 0.5) {
        return 'Elevated geopolitical risk from ongoing conflict and energy-route headlines.';
    }
    if (score >= 0.25) {
        return 'Watch zone — mixed escalation and diplomatic signals in geopolitical headlines.';
    }
    return 'Geopolitical risk remains low relative to today’s classified headlines.';
}

/**
 * Aggregate today’s AI-classified GEOPOLITICAL headlines into a 0–1 Risk Watch score (doc §27–§29).
 *
 * Stability rule: if today’s unique geo events don’t change, the score must not drift.
 * (Earlier bug: the same 06:00 wire copy was classified in pieces across the day, so the
 * needle moved at 18:30 even though no new/deleted headlines existed.)
 *
 * - §28: one delta per event theater (not per paraphrase / restatement)
 * - Within a theater, keep the strongest signal only
 */
export function calculateGeopoliticalRisk(rows: GeoHeadline[]): GeopoliticalRiskWatchResult {
    /** Per theater: keep the largest-magnitude contribution. */
    const byTopic = new Map<string, { headline: string; delta: number; at: number }>();

    for (const row of rows) {
        if (!row.published_at || !['High', 'Medium'].includes(row.impact) || !hasScoredTrackedAsset(row.assets)) {
            continue;
        }
        const key = topicKey(row.headline);
        const delta = scoreGeoHeadlineDelta(row.headline, row.impact, row.summary);
        const at = eventTime(row).getTime();

        const prev = byTopic.get(key);
        if (!prev) {
            byTopic.set(key, { headline: row.headline, delta, at });
            continue;
        }

        // Prefer stronger |signal|; on tie prefer newer publish time (material update).
        if (Math.abs(delta) > Math.abs(prev.delta) || (Math.abs(delta) === Math.abs(prev.delta) && at > prev.at)) {
            byTopic.set(key, { headline: row.headline, delta, at });
        }
    }

    const scored = [...byTopic.values()].map(({ headline, delta }) => ({ headline, delta }));
    const raw = scored.reduce((sum, s) => sum + s.delta, 0);
    const score = Number(clamp01(raw).toFixed(2));
    const band = bandFromScore(score);

    return {
        score,
        band,
        explanation: buildExplanation(scored, score),
        eventCount: scored.length,
    };
}

export async function getGeopoliticalRiskWatch(dayKey: string = uaeDayKey()): Promise<GeopoliticalRiskWatchResult> {
    const rows = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: 'GEOPOLITICAL',
            impact: { in: ['High', 'Medium'] },
            published_at: { not: null },
        },
        orderBy: [{ published_at: 'desc' }, { created_at: 'desc' }],
        select: {
            headline: true,
            impact: true,
            summary: true,
            assets: true,
            published_at: true,
            created_at: true,
        },
    });

    return calculateGeopoliticalRisk(rows as GeoHeadline[]);
}
