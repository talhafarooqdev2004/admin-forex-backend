import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { marketDayKey } from './marketDriverBoard.service.js';
import {
    inferCausalTheme,
    inferGeoState,
    type GeoState,
} from './ffeDecisionEngine.service.js';

export type GeoRiskBand = 'Low Risk' | 'Watch' | 'Elevated' | 'High Risk' | 'Extreme Risk';

export type GeopoliticalComponentBreakdown = {
    directMilitaryEscalation: number;
    energyHormuzRisk: number;
    diplomaticDeterioration: number;
    regionalSpillover: number;
    sanctionsStrategicConfrontation: number;
    deEscalationDeduction: number;
};

export type GeopoliticalTheme = {
    theme: string;
    state: GeoState;
    headline: string;
};

export type GeopoliticalRiskWatchResult = {
    /** Code-calculated 0.00–1.00 score. */
    score: number;
    band: GeoRiskBand;
    /** Alias used by the approved prompt and future clients. */
    status: GeoRiskBand;
    explanation: string;
    /** Unique geo themes, not headline count. */
    eventCount: number;
    components: GeopoliticalComponentBreakdown;
    escalationThemes: GeopoliticalTheme[];
    deEscalationThemes: GeopoliticalTheme[];
    fingerprint: string;
    asOf: string;
    /** This implementation is deterministic and reuses persisted classification; no page AI. */
    evaluationMode: 'deterministic_reuse';
};

export type GeoHeadline = {
    headline: string;
    impact: string;
    summary: string | null;
    assets: unknown;
    published_at: Date | null;
    created_at: Date;
    causal_theme_id?: string | null;
    driver_theme?: string | null;
    geo_state?: string | null;
};

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function round(n: number): number {
    return Number(clamp01(n).toFixed(2));
}

function stateFor(row: GeoHeadline): GeoState {
    const stored = String(row.geo_state ?? '').toUpperCase();
    if (stored === 'ESCALATION' || stored === 'DE_ESCALATION' || stored === 'WATCH' || stored === 'IRRELEVANT') return stored;
    return inferGeoState(`${row.headline} ${row.summary ?? ''}`);
}

function themeFor(row: GeoHeadline): string {
    const h = `${row.headline} ${row.summary ?? ''}`.toLowerCase();
    const stored = row.causal_theme_id ?? row.driver_theme;
    // Historical rows may not have the new semantic fields.  Collapse clear
    // same-theater military paraphrases to one causal theme rather than
    // letting wording differences move the gauge after a restart.
    const fallback = /\b(iran|hormuz|strait)\b/.test(h) && /\b(missile|strike|tanker|shipping|blockade|military)\b/.test(h)
        ? 'IRAN_US_OIL_SUPPLY_RISK'
        : inferCausalTheme(`${row.headline} ${row.summary ?? ''}`, 'GEOPOLITICAL') ?? row.headline;
    return String(stored ?? fallback)
        .toUpperCase()
        .replace(/[^A-Z0-9_:-]+/g, '_')
        .slice(0, 160);
}

function maxComponent(current: number, next: number): number {
    return Math.min(0.2, Math.max(current, next));
}

function componentScores(headline: string, state: GeoState): GeopoliticalComponentBreakdown {
    const h = `${headline}`.toLowerCase();
    const military = /major active conflict|widening war|invasion|missile|drone|airstrike|confirmed attack|military strike/.test(h)
        ? 0.15
        : /military threat|ultimatum|offensive posture|troops? deployed|naval escort|military action/.test(h)
            ? 0.1
            : /warning|warns?|rhetoric/.test(h) ? 0.05 : 0;
    const energy = /hormuz (?:closure|closed|blockade|disruption)|blockade|tanker attack|shipping disruption|oil flow restricted/.test(h)
        ? 0.15
        : /hormuz|strait|shipping risk|threat to shipping|oil supply/.test(h) ? 0.1 : 0;
    const diplomacy = /talks? (?:collapse|collapsed)|negotiations? (?:collapse|collapsed|break down)|diplomacy abandoned/.test(h)
        ? 0.2
        : /ultimatum|deadline|reject(?:s|ed)? terms?|stalled negotiations?/.test(h)
            ? 0.15
            : /difficult talks?|difficult negotiations?|talks? continue/.test(h) ? 0.05 : 0;
    const spillover = /broad multinational|conflict expands?|widening|additional countries|regional attacks?/.test(h)
        ? 0.15
        : /related tension|regional spillover|neighbouring|neighboring/.test(h) ? 0.05 : 0;
    const sanctions = /severe coordinated sanctions|direct strategic confrontation/.test(h)
        ? 0.2
        : /new major sanctions?|military economic pressure/.test(h)
            ? 0.15
            : /sanctions? threat|strategic confrontation|political rhetoric/.test(h) ? 0.1 : 0;

    if (state === 'WATCH') {
        return {
            directMilitaryEscalation: Math.min(military, 0.1),
            energyHormuzRisk: Math.min(energy, 0.1),
            diplomaticDeterioration: Math.min(diplomacy, 0.1),
            regionalSpillover: Math.min(spillover, 0.1),
            sanctionsStrategicConfrontation: Math.min(sanctions, 0.1),
            deEscalationDeduction: 0,
        };
    }
    if (state === 'DE_ESCALATION') {
        const deduction = /major peace agreement|peace deal/.test(h)
            ? 0.2
            : /confirmed ceasefire|ceasefire agreement|withdrawal|route (?:re)?opened|sanctions? (?:eased|lifted|removed)/.test(h)
                ? 0.15
                : /successful negotiations?|diplomatic breakthrough|breakthrough/.test(h) ? 0.1 : 0.05;
        return {
            directMilitaryEscalation: 0,
            energyHormuzRisk: 0,
            diplomaticDeterioration: 0,
            regionalSpillover: 0,
            sanctionsStrategicConfrontation: 0,
            deEscalationDeduction: deduction,
        };
    }
    return {
        directMilitaryEscalation: military,
        energyHormuzRisk: energy,
        diplomaticDeterioration: diplomacy,
        regionalSpillover: spillover,
        sanctionsStrategicConfrontation: sanctions,
        deEscalationDeduction: 0,
    };
}

function bandFromScore(score: number): GeoRiskBand {
    if (score <= 0.25) return 'Low Risk';
    if (score <= 0.45) return 'Watch';
    if (score <= 0.7) return 'Elevated';
    if (score <= 0.85) return 'High Risk';
    return 'Extreme Risk';
}

function explanationFor(score: number, escalation: GeopoliticalTheme[], deEscalation: GeopoliticalTheme[]): string {
    if (!escalation.length && !deEscalation.length) return 'No relevant geopolitical themes were identified for this Dubai business day.';
    if (score <= 0.25 && deEscalation.length >= escalation.length) return 'Diplomatic progress or restraint keeps geopolitical risk contained.';
    if (score >= 0.86) return 'Extreme geopolitical risk: distinct escalation themes span multiple risk components.';
    if (score >= 0.71) return 'High geopolitical risk from distinct military, energy, diplomatic, regional or sanctions themes.';
    if (score >= 0.46) return 'Elevated geopolitical risk from distinct escalation themes; market prices are not used in this score.';
    if (score > 0.25) return 'Watch zone: geopolitical rhetoric or negotiations require monitoring without confirmed broad escalation.';
    return 'Geopolitical risk remains low relative to the unique classified themes.';
}

/**
 * Approved five-component method. Rows are grouped by causal theme first; duplicate wire copies
 * therefore cannot move the gauge. No currency, Gold, Oil, or Risk Mode value is an input.
 */
export function calculateGeopoliticalRisk(rows: GeoHeadline[], now: Date = new Date()): GeopoliticalRiskWatchResult {
    const themes = new Map<string, { row: GeoHeadline; state: GeoState; components: GeopoliticalComponentBreakdown }>();
    for (const row of rows) {
        // Keep the established gauge contract: only dated, non-Low, scored
        // rows can contribute.  Hidden/undated/unscored headlines remain in
        // the decision audit but cannot create risk by themselves.
        if (!row.published_at || String(row.impact).toLowerCase() === 'low') continue;
        const scoredAssets = Array.isArray(row.assets)
            ? (row.assets as Array<{ score?: unknown }>).some((asset) => Math.abs(Number(asset?.score ?? 0)) > 0)
            : false;
        if (!scoredAssets) continue;
        const state = stateFor(row);
        if (state === 'IRRELEVANT') continue;
        const key = themeFor(row);
        const components = componentScores(`${row.headline} ${row.summary ?? ''}`, state);
        const previous = themes.get(key);
        if (!previous) {
            themes.set(key, { row, state, components });
            continue;
        }
        // One causal theme remains one contribution; retain the strongest semantic update.
        const previousTotal = Object.values(previous.components).reduce((sum, value) => sum + value, 0);
        const nextTotal = Object.values(components).reduce((sum, value) => sum + value, 0);
        if (nextTotal > previousTotal || (nextTotal === previousTotal && (row.published_at?.getTime() ?? 0) > (previous.row.published_at?.getTime() ?? 0))) {
            themes.set(key, { row, state, components });
        }
    }

    const components: GeopoliticalComponentBreakdown = {
        directMilitaryEscalation: 0,
        energyHormuzRisk: 0,
        diplomaticDeterioration: 0,
        regionalSpillover: 0,
        sanctionsStrategicConfrontation: 0,
        deEscalationDeduction: 0,
    };
    const escalationThemes: GeopoliticalTheme[] = [];
    const deEscalationThemes: GeopoliticalTheme[] = [];
    for (const [theme, value] of themes) {
        components.directMilitaryEscalation = maxComponent(components.directMilitaryEscalation, value.components.directMilitaryEscalation);
        components.energyHormuzRisk = maxComponent(components.energyHormuzRisk, value.components.energyHormuzRisk);
        components.diplomaticDeterioration = maxComponent(components.diplomaticDeterioration, value.components.diplomaticDeterioration);
        components.regionalSpillover = maxComponent(components.regionalSpillover, value.components.regionalSpillover);
        components.sanctionsStrategicConfrontation = maxComponent(components.sanctionsStrategicConfrontation, value.components.sanctionsStrategicConfrontation);
        components.deEscalationDeduction = Math.min(0.2, Math.max(components.deEscalationDeduction, value.components.deEscalationDeduction));
        const item = { theme, state: value.state, headline: value.row.headline };
        if (value.state === 'DE_ESCALATION') deEscalationThemes.push(item);
        else if (value.state === 'ESCALATION') escalationThemes.push(item);
    }

    const score = round(
        components.directMilitaryEscalation +
        components.energyHormuzRisk +
        components.diplomaticDeterioration +
        components.regionalSpillover +
        components.sanctionsStrategicConfrontation -
        components.deEscalationDeduction,
    );
    const band = bandFromScore(score);
    const fingerprint = createHash('sha256')
        .update([...themes.keys()].sort().join('\n') + JSON.stringify(components))
        .digest('hex');
    const asOfCandidates = [...themes.values()]
        .map((value) => value.row.published_at ?? value.row.created_at)
        .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
    const asOf = (asOfCandidates.sort((a, b) => b.getTime() - a.getTime())[0] ?? now).toISOString();
    return {
        score,
        band,
        status: band,
        explanation: explanationFor(score, escalationThemes.slice(0, 5), deEscalationThemes.slice(0, 3)),
        eventCount: themes.size,
        components,
        escalationThemes: escalationThemes.slice(0, 5),
        deEscalationThemes: deEscalationThemes.slice(0, 3),
        fingerprint,
        asOf,
        evaluationMode: 'deterministic_reuse',
    };
}

export async function getGeopoliticalRiskWatch(dayKey: string = marketDayKey()): Promise<GeopoliticalRiskWatchResult> {
    const rows = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: 'GEOPOLITICAL',
        },
        orderBy: [{ published_at: 'desc' }, { created_at: 'desc' }],
        select: {
            headline: true,
            impact: true,
            summary: true,
            assets: true,
            published_at: true,
            created_at: true,
            causal_theme_id: true,
            driver_theme: true,
            geo_state: true,
        },
    });
    return calculateGeopoliticalRisk(rows as GeoHeadline[]);
}

/** Kept for consumers that imported the former per-headline heuristic; it now exposes the
 * first component-aware contribution and never uses market prices. */
export function scoreGeoHeadlineDelta(headline: string, impact: string, summary?: string | null): number {
    const result = calculateGeopoliticalRisk([{
        headline,
        impact,
        summary: summary ?? null,
        assets: [],
        published_at: new Date(),
        created_at: new Date(),
    }]);
    return result.score;
}
