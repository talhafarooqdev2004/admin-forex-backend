import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { FFE_NEWS_SOURCE, marketDayKey } from './marketDriverBoard.service.js';
import { evaluateGeoRiskThemes, FFE_ANALYST_PROMPT_VERSION, type GeoRiskAiDecision } from './groqClassifier.service.js';
import type { GeoState } from './ffeDecisionEngine.service.js';

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
    evaluationMode: 'ai_cached' | 'no_cached_evaluation' | 'gpt_first';
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
    geo_components?: unknown;
    canonical_event_id?: string | null;
    status?: string | null;
    event_type?: string | null;
    event_strength?: string | null;
    event_severity?: number | null;
    event_credibility?: number | null;
    event_freshness?: number | null;
    event_persistence?: number | null;
    transmission_reason?: string | null;
    current_asset_contributions?: unknown;
};

export async function evaluateAndCacheGeopoliticalRisk(
    dayKey: string = marketDayKey(),
    options: { jobId?: string | null; ingestId?: string | null } = {},
): Promise<boolean> {
    const rows = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey, source: FFE_NEWS_SOURCE, duplicate_of: null, category: 'GEOPOLITICAL', causal_theme_id: { not: null } },
        orderBy: [{ published_at: 'desc' }, { created_at: 'desc' }],
        select: {
            headline: true, impact: true, summary: true, assets: true, published_at: true, created_at: true,
            causal_theme_id: true, driver_theme: true, geo_state: true, geo_components: true,
            canonical_event_id: true, event_type: true, event_strength: true,
            event_severity: true, event_credibility: true, event_freshness: true, event_persistence: true,
            transmission_reason: true, current_asset_contributions: true,
            canonicalEvent: { select: { status: true } },
        },
    });
    const byTheme = new Map<string, GeoHeadline>();
    for (const rawRow of rows) {
        const { canonicalEvent, ...row } = rawRow;
        const geoRow = { ...row, status: canonicalEvent?.status ?? null } as GeoHeadline;
        const id = String(geoRow.causal_theme_id ?? '');
        if (!id || byTheme.has(id)) continue;
        byTheme.set(id, geoRow);
    }
    if (!byTheme.size) return false;
    const fingerprint = calculateGeopoliticalRisk([...byTheme.values()]).fingerprint;
    const existing = await prisma.geopoliticalRiskEvaluation.findUnique({ where: { day_key_theme_fingerprint: { day_key: dayKey, theme_fingerprint: fingerprint } } });
    if (existing) return false;
    const decision: GeoRiskAiDecision | null = await evaluateGeoRiskThemes([...byTheme.values()].map((row) => ({
        causalThemeId: String(row.causal_theme_id ?? row.driver_theme ?? ''),
        state: String(row.geo_state ?? 'IRRELEVANT'),
        summary: String(row.summary ?? ''),
        assets: Array.isArray(row.assets) ? row.assets as any : [],
    })), options);
    if (!decision) return false;
    const components: GeopoliticalComponentBreakdown = {
        directMilitaryEscalation: decision.directMilitaryEscalation,
        energyHormuzRisk: decision.energyHormuzRisk,
        diplomaticDeterioration: decision.diplomaticDeterioration,
        regionalSpillover: decision.regionalSpillover,
        sanctionsStrategicConfrontation: decision.sanctionsStrategicConfrontation,
        deEscalationDeduction: decision.deEscalationDeduction,
    };
    const official = calculateGeopoliticalRisk([...byTheme.values()].map((row) => ({ ...row, geo_components: components })));
    const score = official.score;
    await prisma.geopoliticalRiskEvaluation.create({
        data: {
            day_key: dayKey,
            theme_fingerprint: fingerprint,
            components: components as unknown as object,
            score,
            band: official.band,
            explanation: official.explanation || decision.explanation,
            event_count: official.eventCount,
            provider: decision.provider,
            model: decision.model,
            prompt_version: FFE_ANALYST_PROMPT_VERSION,
            decision_source: 'ai_dominant_regime',
        },
    });
    return true;
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function round(n: number): number {
    return Number(clamp01(n).toFixed(2));
}

function stateFor(row: GeoHeadline): GeoState {
    const stored = String(row.geo_state ?? '').toUpperCase();
    if (stored === 'ESCALATION' || stored === 'DE_ESCALATION' || stored === 'WATCH' || stored === 'IRRELEVANT') return stored;
    return 'IRRELEVANT';
}

function themeFor(row: GeoHeadline): string {
    const stored = row.causal_theme_id ?? row.driver_theme;
    return String(stored ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9_:-]+/g, '_')
        .slice(0, 160);
}

function maxComponent(current: number, next: number): number {
    return Math.min(0.2, Math.max(current, next));
}

function componentScores(row: GeoHeadline): GeopoliticalComponentBreakdown {
    const value = row.geo_components && typeof row.geo_components === 'object'
        ? row.geo_components as Partial<GeopoliticalComponentBreakdown>
        : {};
    return {
        directMilitaryEscalation: clamp01(Number(value.directMilitaryEscalation ?? 0)),
        energyHormuzRisk: clamp01(Number(value.energyHormuzRisk ?? 0)),
        diplomaticDeterioration: clamp01(Number(value.diplomaticDeterioration ?? 0)),
        regionalSpillover: clamp01(Number(value.regionalSpillover ?? 0)),
        sanctionsStrategicConfrontation: clamp01(Number(value.sanctionsStrategicConfrontation ?? 0)),
        deEscalationDeduction: clamp01(Number(value.deEscalationDeduction ?? 0)),
    };
}

function bandFromScore(score: number): GeoRiskBand {
    if (score <= 0.20) return 'Low Risk';
    if (score <= 0.40) return 'Watch';
    if (score <= 0.65) return 'Elevated';
    if (score <= 0.85) return 'High Risk';
    return 'Extreme Risk';
}

function explanationFor(score: number, escalation: GeopoliticalTheme[], deEscalation: GeopoliticalTheme[]): string {
    if (!escalation.length && !deEscalation.length) return 'No relevant geopolitical themes were identified for this Dubai business day.';
    if (score <= 0.20 && deEscalation.length >= escalation.length) return 'Diplomatic progress or restraint keeps geopolitical risk contained.';
    if (score >= 0.86) return 'Extreme geopolitical risk: distinct escalation themes span multiple risk components.';
    if (score >= 0.71) return 'High geopolitical risk from distinct military, energy, diplomatic, regional or sanctions themes.';
    if (score >= 0.41) return 'Elevated geopolitical risk from dominant active themes; market prices are not used in this score.';
    if (score > 0.20) return 'Watch zone: geopolitical rhetoric or negotiations require monitoring without confirmed broad escalation.';
    return 'Geopolitical risk remains low relative to the unique classified themes.';
}

/**
 * Client-contract Geo method. Themes are the unit of state: the strongest credible active theme
 * establishes the regime, bounded secondary themes may adjust it, and de-escalation subtracts a
 * bounded amount. Headline count, price movement and Catalyst totals are never summed into Geo.
 */
export function calculateGeopoliticalRisk(rows: GeoHeadline[], now: Date = new Date()): GeopoliticalRiskWatchResult {
    type ThemeState = { key: string; row: GeoHeadline; state: GeoState; weight: number; components: GeopoliticalComponentBreakdown };
    const themes = new Map<string, ThemeState>();
    const metric = (value: unknown, fallback: number): number => {
        const n = Number(value);
        return Number.isFinite(n) ? clamp01(n) : fallback;
    };
    const strengthFallback = (impact: string): number => String(impact).toLowerCase() === 'high' ? 1 : String(impact).toLowerCase() === 'medium' ? 0.6 : 0.25;
    const transmissionStrength = (row: GeoHeadline): number => {
        if (row.transmission_reason && String(row.transmission_reason).trim()) return 1;
        const assets = Array.isArray(row.current_asset_contributions) ? row.current_asset_contributions as Array<{ score?: unknown }> : [];
        if (assets.some((asset) => Math.abs(Number(asset.score ?? 0)) > 0)) return 0.75;
        const components = componentScores(row);
        return Math.max(...Object.values(components).filter((value) => value > 0), 0) > 0 ? 0.6 : 0.35;
    };
    for (const row of rows) {
        if (!row.published_at) continue;
        const state = stateFor(row);
        if (state === 'IRRELEVANT' || ['RESOLVED', 'REVERSED'].includes(String(row.status ?? '').toUpperCase())) continue;
        const key = themeFor(row) || row.canonical_event_id || '';
        if (!key) continue;
        const severity = (() => {
            const n = Number(row.event_severity);
            const fallback = strengthFallback(row.impact);
            if (Number.isFinite(n) && n > 0) return clamp01(n);
            return fallback;
        })();
        const credibility = metric(row.event_credibility, 0.65);
        const freshness = metric(row.event_freshness, 1);
        const persistence = metric(row.event_persistence, severity >= 0.75 ? 0.8 : 0.5);
        // A confirmed escalation with a stated causal transmission channel is, per contract §36/§37,
        // at least "significant military/energy risk" territory and must not read as Low merely
        // because a probabilistic severity metric came back small. This floor is a regime judgment on
        // the escalation state + confirmed channel; it never reads the Catalyst arithmetic (§10 of the
        // remediation contract keeps Geo independent of the Catalyst board).
        const confirmedChannel = Boolean(row.transmission_reason && String(row.transmission_reason).trim());
        const escalationFloor = state === 'ESCALATION' && confirmedChannel ? 0.55 : 0;
        const weight = Math.max(clamp01(severity * credibility * transmissionStrength(row) * persistence), escalationFloor);
        const candidate: ThemeState = { key, row, state, weight, components: componentScores(row) };
        const previous = themes.get(key);
        if (!previous || candidate.weight > previous.weight || (candidate.weight === previous.weight && (row.published_at?.getTime() ?? 0) > (previous.row.published_at?.getTime() ?? 0))) themes.set(key, candidate);
    }

    const components: GeopoliticalComponentBreakdown = {
        directMilitaryEscalation: 0, energyHormuzRisk: 0, diplomaticDeterioration: 0,
        regionalSpillover: 0, sanctionsStrategicConfrontation: 0, deEscalationDeduction: 0,
    };
    const escalation = [...themes.values()].filter((theme) => theme.state === 'ESCALATION').sort((a, b) => b.weight - a.weight);
    const watch = [...themes.values()].filter((theme) => theme.state === 'WATCH').sort((a, b) => b.weight - a.weight);
    const deEscalation = [...themes.values()].filter((theme) => theme.state === 'DE_ESCALATION').sort((a, b) => b.weight - a.weight);
    const watchDominant = watch[0];
    const dominant = escalation[0] ?? (watchDominant ? { ...watchDominant, weight: watchDominant.weight * 0.9 } : undefined);
    for (const value of themes.values()) {
        components.directMilitaryEscalation = maxComponent(components.directMilitaryEscalation, value.components.directMilitaryEscalation);
        components.energyHormuzRisk = maxComponent(components.energyHormuzRisk, value.components.energyHormuzRisk);
        components.diplomaticDeterioration = maxComponent(components.diplomaticDeterioration, value.components.diplomaticDeterioration);
        components.regionalSpillover = maxComponent(components.regionalSpillover, value.components.regionalSpillover);
        components.sanctionsStrategicConfrontation = maxComponent(components.sanctionsStrategicConfrontation, value.components.sanctionsStrategicConfrontation);
        components.deEscalationDeduction = Math.max(components.deEscalationDeduction, value.components.deEscalationDeduction);
    }
    const secondaryAdjustment = Math.min(0.2, escalation.slice(1).reduce((sum, theme) => sum + Math.min(0.1, theme.weight * 0.2), 0));
    const deEscalationDeduction = Math.min(0.2, deEscalation.reduce((sum, theme) => sum + Math.min(0.1, theme.weight * 0.2), 0));
    const score = round((dominant?.weight ?? 0) + secondaryAdjustment - deEscalationDeduction);
    const band = bandFromScore(score);
    const fingerprint = createHash('sha256').update(JSON.stringify([...themes.values()].map((theme) => ({ key: theme.key, state: theme.state, weight: Number(theme.weight.toFixed(4)), status: theme.row.status ?? null })).sort((a, b) => a.key.localeCompare(b.key))) + '|geo-dominant-v1').digest('hex');
    const asOfCandidates = [...themes.values()].map((value) => value.row.published_at ?? value.row.created_at).filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
    const asOf = (asOfCandidates.sort((a, b) => b.getTime() - a.getTime())[0] ?? now).toISOString();
    const escalationThemes: GeopoliticalTheme[] = escalation.slice(0, 5).map((value) => ({ theme: value.key, state: value.state, headline: value.row.headline }));
    const deEscalationThemes: GeopoliticalTheme[] = deEscalation.slice(0, 3).map((value) => ({ theme: value.key, state: value.state, headline: value.row.headline }));
    return {
        score, band, status: band,
        explanation: explanationFor(score, escalationThemes, deEscalationThemes),
        eventCount: themes.size, components, escalationThemes, deEscalationThemes,
        fingerprint, asOf, evaluationMode: themes.size > 0 ? 'ai_cached' : 'no_cached_evaluation',
    };
}

function gptFirstBandToWatch(band: string, score: number): GeoRiskBand {
    const raw = String(band || '').toUpperCase().replace(/\s+/g, '_');
    if (raw.includes('EXTREME')) return 'Extreme Risk';
    if (raw.includes('HIGH')) return 'High Risk';
    if (raw.includes('ELEVATED') || raw.includes('MODERATE')) return 'Elevated';
    if (raw.includes('WATCH')) return 'Watch';
    if (raw.includes('LOW')) return 'Low Risk';
    return bandFromScore(score);
}

function gptFirstGeoToWatch(geo: {
    score?: number;
    band?: string;
    state?: string;
    dominant_theme?: string;
    transmission_reason?: string;
    escalation_evidence_notes?: string[];
    de_escalation_evidence_notes?: string[];
}, asOf: string): GeopoliticalRiskWatchResult {
    const score = Number.isFinite(Number(geo.score)) ? Number(geo.score) : 0;
    const band = gptFirstBandToWatch(String(geo.band || ''), score);
    const theme = String(geo.dominant_theme || 'geopolitical regime');
    const escalationThemes = (geo.escalation_evidence_notes ?? []).slice(0, 5).map((headline) => ({
        theme,
        state: 'ESCALATION' as GeoState,
        headline,
    }));
    const deEscalationThemes = (geo.de_escalation_evidence_notes ?? []).slice(0, 3).map((headline) => ({
        theme,
        state: 'DE_ESCALATION' as GeoState,
        headline,
    }));
    return {
        score,
        band,
        status: band,
        explanation: String(geo.transmission_reason || geo.state || '').trim()
            || explanationFor(score, escalationThemes, deEscalationThemes),
        eventCount: Math.max(1, escalationThemes.length + deEscalationThemes.length),
        components: {
            directMilitaryEscalation: 0,
            energyHormuzRisk: 0,
            diplomaticDeterioration: 0,
            regionalSpillover: 0,
            sanctionsStrategicConfrontation: 0,
            deEscalationDeduction: 0,
        },
        escalationThemes,
        deEscalationThemes,
        fingerprint: createHash('sha256').update(JSON.stringify({
            source: 'gpt_first',
            score,
            band,
            theme,
        })).digest('hex').slice(0, 16),
        asOf,
        evaluationMode: 'gpt_first',
    };
}

export async function getGeopoliticalRiskWatch(dayKey: string = marketDayKey()): Promise<GeopoliticalRiskWatchResult> {
    if (process.env.FFE_ANALYSIS_MODE !== 'hybrid') {
        try {
            const { getLatestGptFirstAnalysis } = await import('./ffeGptFirstProduction.service.js');
            const persisted = await getLatestGptFirstAnalysis(dayKey);
            if (persisted?.accepted && persisted.analysis?.geo && Number.isFinite(Number(persisted.analysis.geo.score))) {
                return gptFirstGeoToWatch(persisted.analysis.geo, persisted.persistedAt);
            }
        } catch {
            // Fall through to the legacy news-row geo path.
        }
    }
    const rows = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            source: FFE_NEWS_SOURCE,
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
            geo_components: true,
            canonical_event_id: true,
            event_type: true,
            event_strength: true,
            event_severity: true,
            event_credibility: true,
            event_freshness: true,
            event_persistence: true,
            transmission_reason: true,
            current_asset_contributions: true,
            canonicalEvent: { select: { status: true } },
        },
    });
    const geoRows = rows.map(({ canonicalEvent, ...row }) => ({ ...row, status: canonicalEvent?.status ?? null }) as GeoHeadline);
    const currentThemeFingerprint = calculateGeopoliticalRisk(geoRows).fingerprint;
    const cached = await prisma.geopoliticalRiskEvaluation.findUnique({
        where: { day_key_theme_fingerprint: { day_key: dayKey, theme_fingerprint: currentThemeFingerprint } },
    });
    if (cached) {
        const components = cached.components as unknown as GeopoliticalComponentBreakdown;
        const escalationThemes = geoRows
            .filter((row) => String(row.geo_state ?? '').toUpperCase() === 'ESCALATION' && row.causal_theme_id)
            .map((row) => ({ theme: String(row.causal_theme_id), state: 'ESCALATION' as GeoState, headline: row.headline }))
            .slice(0, 5);
        const deEscalationThemes = geoRows
            .filter((row) => String(row.geo_state ?? '').toUpperCase() === 'DE_ESCALATION' && row.causal_theme_id)
            .map((row) => ({ theme: String(row.causal_theme_id), state: 'DE_ESCALATION' as GeoState, headline: row.headline }))
            .slice(0, 3);
        return {
            score: cached.score,
            band: cached.band as GeoRiskBand,
            status: cached.band as GeoRiskBand,
            explanation: cached.explanation ?? 'AI geopolitical evaluation cached for this theme set.',
            eventCount: cached.event_count,
            components,
            escalationThemes,
            deEscalationThemes,
            fingerprint: currentThemeFingerprint,
            asOf: cached.evaluated_at.toISOString(),
            evaluationMode: 'ai_cached',
        };
    }
    return calculateGeopoliticalRisk(geoRows);
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
