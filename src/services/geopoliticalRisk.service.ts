import { prisma } from '../lib/prisma.js';
import { uaeDayKey } from './marketDriverBoard.service.js';

export type GeopoliticalRiskWatchResult = {
    /** Normalized 0.00–1.00 (doc §29). */
    score: number;
    /** Band label — UI may hide this; kept for API consumers. */
    band: 'Low Risk' | 'Watch' | 'Elevated' | 'High Risk';
    explanation: string;
    /** Count of scored geopolitical headlines contributing to the gauge. */
    eventCount: number;
};

type GeoHeadline = {
    headline: string;
    impact: string;
    summary: string | null;
};

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

    if (/\b(nuclear (strike|weapon|attack)|closure of (the )?strait|strait (of )?hormuz (closed|block)|global (war|conflict)|world war)\b/.test(text)) {
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

/** Soft dedup: same topic stem within the day counts once (doc §28). */
function topicKey(headline: string): string {
    const h = headline.toLowerCase();
    if (/\bhormuz|strait\b/.test(h)) return 'hormuz';
    if (/\bceasefire|truce\b/.test(h)) return 'ceasefire';
    if (/\biran\b/.test(h) && /\b(israel|us|u\.s|strike|missile|nuclear)\b/.test(h)) return 'iran-conflict';
    if (/\bsanction/.test(h)) return 'sanctions';
    if (/\bukraine|russia\b/.test(h)) return 'ukraine';
    return h
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
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
 */
export async function getGeopoliticalRiskWatch(dayKey: string = uaeDayKey()): Promise<GeopoliticalRiskWatchResult> {
    const rows = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: 'GEOPOLITICAL',
        },
        orderBy: { created_at: 'desc' },
        select: {
            headline: true,
            impact: true,
            summary: true,
        },
    });

    const seen = new Set<string>();
    const scored: { headline: string; delta: number }[] = [];

    for (const row of rows as GeoHeadline[]) {
        const key = topicKey(row.headline);
        if (seen.has(key)) continue;
        seen.add(key);
        const delta = scoreGeoHeadlineDelta(row.headline, row.impact, row.summary);
        scored.push({ headline: row.headline, delta });
    }

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
