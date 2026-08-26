import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
    FFE_EVENT_RELATIONS,
    eventFingerprint,
    likelySameEvent,
    type ClassifiedAsset,
    type ExistingCanonicalEvent,
    type FfeEventRelation,
    type TrackedAsset,
} from './groqClassifier.service.js';

export const CANONICAL_THEME_ACTIONS = [
    'JOIN_EXISTING_THEME',
    'UPDATE_EXISTING_THEME',
    'REVERSE_EXISTING_THEME',
    'CREATE_NEW_THEME',
    'CONTEXT_ONLY',
    'MACRO_ONLY',
    'IRRELEVANT',
] as const;

export type CanonicalThemeAction = (typeof CANONICAL_THEME_ACTIONS)[number];
export type CanonicalThemeStatus = 'ACTIVE' | 'WATCH' | 'RESOLVED' | 'REVERSED';
export type CanonicalGeoState = 'ESCALATION' | 'DE_ESCALATION' | 'WATCH' | 'IRRELEVANT';

export type CanonicalThemeContext = {
    id: string;
    dayKey: string;
    themeKey: string;
    label: string;
    summary: string;
    themeType: string;
    status: CanonicalThemeStatus;
    geoState: CanonicalGeoState | null;
    assetContributions: ClassifiedAsset[];
    confidence: number;
    firstSeenAt: string;
    lastUpdatedAt: string;
    latestVersion: number;
    supportingEventIds: string[];
    events?: CanonicalEventContext[];
};

export type CanonicalThemeDecision = {
    action: CanonicalThemeAction;
    themeId: string | null;
    themeKey: string | null;
    label: string | null;
    summary: string | null;
    reason: string | null;
    status: CanonicalThemeStatus;
    geoState: CanonicalGeoState | null;
    /** The provider's event relation is retained for event-state and arithmetic validation. */
    eventRelation?: FfeEventRelation | null;
    assetContributions: ClassifiedAsset[];
    confidence: number;
};

export type CanonicalEventResult = {
    eventId: string | null;
    themeId: string | null;
    themeAction: CanonicalThemeAction;
    themeStatus: CanonicalThemeStatus | null;
    relation?: FfeEventRelation;
    principalEventId?: string | null;
    evidenceOnly?: boolean;
    valid?: boolean;
    independent?: boolean;
    catalystEligible?: boolean;
    currentAssetContributions?: ClassifiedAsset[];
    resolutionReason?: string;
};

export type CanonicalDriverState = {
    eventType?: string | null;
    fundamentalCause?: string | null;
    observedMarketReaction?: string | null;
    eventStrength?: string | null;
    severity?: number | null;
    credibility?: number | null;
    freshness?: number | null;
    persistence?: number | null;
    geoState?: string | null;
    transmissionReason?: string | null;
    affectedAssets?: ClassifiedAsset[];
    currentAssetContributions?: ClassifiedAsset[];
    counterEvidence?: string[];
    supportingGuidIds?: string[];
    confirmationGuidIds?: string[];
    catalystEligible?: boolean;
    independent?: boolean;
    valid?: boolean;
    provider?: string | null;
    model?: string | null;
    promptVersion?: string | null;
};

export type CanonicalEventContext = ExistingCanonicalEvent & {
    dayKey?: string;
};

export type CanonicalPrincipalResolution = {
    relation: FfeEventRelation;
    principalEventId: string | null;
    matchedBy: 'explicit_id' | 'source_guid' | 'signature' | 'semantic_fingerprint' | 'semantic_similarity' | 'theme_candidate' | 'new_event' | 'missing_principal';
    valid: boolean;
    reason: string;
};

const EVIDENCE_ONLY_RELATIONS = new Set<FfeEventRelation>([
    'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE',
    'FORECAST_UPCOMING', 'IRRELEVANT', 'SAME_EVENT',
]);

const MUTATING_RELATIONS = new Set<FfeEventRelation>([
    'EVENT_UPDATE', 'STRENGTHENING_EVIDENCE', 'WEAKENING_EVIDENCE', 'REVERSAL', 'DE_ESCALATION',
]);

function eventWords(value: unknown): Set<string> {
    return new Set(String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
        .filter((token) => token.length > 3 && !new Set(['this', 'that', 'with', 'from', 'after', 'about', 'says', 'said', 'will', 'into', 'over', 'have', 'been']).has(token)));
}

function wordOverlap(a: unknown, b: unknown): number {
    const left = eventWords(a);
    const right = eventWords(b);
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    return intersection / Math.max(left.size, right.size);
}

function eventCandidateScore(input: {
    headline: string;
    normalizedSignature?: string | null;
    themeId?: string | null;
    eventType?: string | null;
    fundamentalCause?: string | null;
    publishedAt?: Date | string | null;
}, event: CanonicalEventContext): number {
    let score = 0;
    if (input.normalizedSignature && event.normalizedSignature && input.normalizedSignature === event.normalizedSignature) score += 140;
    const inputFingerprint = eventFingerprint(input.headline);
    const eventFp = eventFingerprint(event.headline);
    if (inputFingerprint && eventFp && inputFingerprint === eventFp) score += 100;
    if (likelySameEvent(input.headline, event.headline)) score += 45;
    if (input.themeId && event.themeId && input.themeId === event.themeId) score += 20;
    if (input.eventType && event.eventType && input.eventType === event.eventType) score += 15;
    if (input.currentContributions?.some((asset) => asset.score !== 0 && eventSupportsAsset(event, asset.asset))) score += 15;
    score += Math.round(wordOverlap(input.fundamentalCause ?? input.headline, event.fundamentalCause ?? event.headline) * 35);
    const incoming = input.publishedAt ? new Date(String(input.publishedAt)).getTime() : NaN;
    const previous = event.lastSeenAt ? new Date(String(event.lastSeenAt)).getTime() : NaN;
    if (Number.isFinite(incoming) && Number.isFinite(previous)) {
        const hours = Math.abs(incoming - previous) / 3_600_000;
        // Time is a tie-breaker, not a candidate window. The resolver scans the full current-day
        // state, so a principal cannot disappear merely because it is older than a shortlist.
        score += Math.max(0, 8 - Math.min(8, hours / 6));
    }
    return score;
}

function headlineAssetHints(headline: string): Set<string> {
    const text = headline.toLowerCase();
    const hints = new Set<string>();
    if (/\b(?:wti|brent|crude|oil|tanker|tankers|hormuz|strait|shipping|refiner(?:y|ies)|opec)\b/.test(text)) hints.add('OIL');
    if (/\b(?:gold|xau|bullion)\b/.test(text)) hints.add('GOLD');
    for (const asset of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']) {
        const names: Record<string, string> = { USD: 'dollar|usd', EUR: 'euro|eur', GBP: 'pound|sterling|gbp', JPY: 'yen|jpy', CHF: 'swiss franc|chf', CAD: 'canadian dollar|cad', AUD: 'australian dollar|aud', NZD: 'new zealand dollar|nzd' };
        if (new RegExp(`\\b(?:${names[asset]})\\b`, 'i').test(text)) hints.add(asset);
    }
    return hints;
}

function eventSupportsAsset(event: CanonicalEventContext, asset: string): boolean {
    if (event.contributions?.some((contribution) => contribution.asset === asset && contribution.score !== 0)) return true;
    // Evidence-only reactions can arrive after the principal has temporarily moved to WATCH
    // (and therefore has no current non-zero contribution).  Keep the principal discoverable
    // from its persisted event/cause text without treating the reaction as a new driver.
    const text = `${event.headline ?? ''} ${event.fundamentalCause ?? ''}`;
    return headlineAssetHints(text).has(asset);
}

function findExplicitPrincipal(reference: string | null | undefined, events: CanonicalEventContext[]): { event: CanonicalEventContext; matchedBy: 'explicit_id' | 'source_guid' } | null {
    const token = String(reference ?? '').trim();
    if (!token) return null;
    const byId = events.find((event) => event.id === token);
    if (byId) return { event: byId, matchedBy: 'explicit_id' };
    const byGuid = events.find((event) => event.sourceGuid === token || event.supportingGuids?.includes(token));
    return byGuid ? { event: byGuid, matchedBy: 'source_guid' } : null;
}

/**
 * Resolve an AI relation against the full chronological canonical event ledger. This function is
 * deliberately pure so the replay and the database writer enforce the same invariant:
 * only NEW_EVENT may mint an identity; every other relation must mutate/attach to a principal.
 */
export function resolveCanonicalPrincipal(input: {
    relation: string;
    eventDuplicateOf?: string | null;
    headline: string;
    normalizedSignature?: string | null;
    themeId?: string | null;
    eventType?: string | null;
    fundamentalCause?: string | null;
    currentContributions?: ClassifiedAsset[];
    publishedAt?: Date | string | null;
}, events: CanonicalEventContext[]): CanonicalPrincipalResolution {
    const requested = normalizeEventRelation(input.relation);
    const explicit = findExplicitPrincipal(input.eventDuplicateOf, events);
    if (explicit) {
        return {
            relation: requested === 'NEW_EVENT' ? 'SAME_EVENT' : requested,
            principalEventId: explicit.event.id,
            matchedBy: explicit.matchedBy,
            valid: true,
            reason: requested === 'NEW_EVENT' ? 'NEW_EVENT carried an explicit existing principal; normalized to SAME_EVENT.' : 'AI supplied an existing canonical principal.',
        };
    }
    // The AI supplied an explicit principal id/GUID that does not exist in the ledger. Rather than
    // leaving a dangling reference, fall through to semantic candidate matching and, failing that, the
    // relation reconciliation below (mint a first-occurrence NEW_EVENT for a fresh cause, otherwise
    // downgrade to principal-free context). This keeps event identity self-consistent.

    const candidates = events
        .filter((event) => event.status !== 'RESOLVED' || requested === 'REVERSAL' || requested === 'DE_ESCALATION')
        .map((event) => ({ event, score: eventCandidateScore(input, event) }))
        .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    const semanticThreshold = requested === 'NEW_EVENT' ? 85 : 45;
    if (best && best.score >= semanticThreshold && (!second || best.score - second.score >= 8 || best.score >= 120)) {
        const relation = requested === 'NEW_EVENT'
            ? (input.currentContributions?.some((asset) => asset.score !== 0) ? 'EVENT_UPDATE' : 'SAME_EVENT')
            : requested;
        return {
            relation,
            principalEventId: best.event.id,
            matchedBy: best.score >= 100 ? 'semantic_fingerprint' : best.score >= 140 ? 'signature' : 'semantic_similarity',
            valid: true,
            reason: `Resolved against existing principal with semantic score ${best.score}.`,
        };
    }

    // A first alert and its near-immediate operational detail often use different wire
    // vocabulary (for example, an incident report followed by a casualty/detail line). If the
    // model proposes NEW_EVENT but the full state shows the same canonical theme, event type,
    // transmission asset, and a short chronological gap, treat it as an update instead of
    // minting a second occurrence. This is deliberately narrower than the evidence fallback and
    // still requires a semantic/actor overlap score; independent events in the same theme remain
    // separate.
    if (requested === 'NEW_EVENT' && best) {
        const incomingAt = input.publishedAt ? new Date(String(input.publishedAt)).getTime() : NaN;
        const previousAt = best.event.lastSeenAt ? new Date(String(best.event.lastSeenAt)).getTime() : NaN;
        const hours = Number.isFinite(incomingAt) && Number.isFinite(previousAt) ? Math.abs(incomingAt - previousAt) / 3_600_000 : Infinity;
        const sameThemeAndType = Boolean(input.themeId && best.event.themeId === input.themeId && input.eventType && best.event.eventType === input.eventType);
        const closeSemanticDetail = best.score >= 45 && hours <= 3 && (likelySameEvent(input.headline, best.event.headline) || wordOverlap(input.headline, best.event.headline) >= 0.08);
        if (sameThemeAndType && closeSemanticDetail) {
            return {
                relation: input.currentContributions?.some((asset) => asset.score !== 0) ? 'EVENT_UPDATE' : 'SAME_EVENT',
                principalEventId: best.event.id,
                matchedBy: 'semantic_similarity',
                valid: true,
                reason: `Near-term same-theme/type evidence resolved to the existing principal with semantic score ${best.score}.`,
            };
        }
    }

    // Evidence relations still need a real principal. If the model has supplied a non-NEW
    // relation but the high-precision fingerprint is absent, prefer a same-theme principal
    // (or a directly asset-compatible current event for a reaction/commentary) over creating a
    // fake new event. This is a generic semantic fallback: it never runs for NEW_EVENT,
    // MACRO_RELEASE, or IRRELEVANT and it never creates an identity.
    if (requested !== 'NEW_EVENT' && requested !== 'MACRO_RELEASE' && requested !== 'IRRELEVANT') {
        const commentaryOnly = requested === 'HISTORICAL_COMMENTARY';
        const sameTheme = input.themeId
            ? candidates.filter(({ event }) => event.themeId === input.themeId)
            : [];
        const hints = headlineAssetHints(input.headline);
        const assetCompatible = hints.size
            ? candidates.filter(({ event }) => [...hints].some((asset) => eventSupportsAsset(event, asset)))
            : [];
        const semanticEvidence = candidates.filter(({ event, score }) => {
            const sameType = Boolean(input.eventType && event.eventType && input.eventType === event.eventType);
            const closeText = likelySameEvent(input.headline, event.headline)
                || wordOverlap(input.headline, event.headline) >= 0.1;
            const incomingAt = input.publishedAt ? new Date(String(input.publishedAt)).getTime() : NaN;
            const previousAt = event.lastSeenAt ? new Date(String(event.lastSeenAt)).getTime() : NaN;
            const withinDay = Number.isFinite(incomingAt) && Number.isFinite(previousAt)
                ? Math.abs(incomingAt - previousAt) <= 24 * 3_600_000
                : false;
            return score >= 20 && ((sameType && closeText) || (sameType && withinDay && score >= 15));
        });
        const fallbackPool = commentaryOnly
            ? sameTheme
            : sameTheme.length
                ? sameTheme
                : assetCompatible.length
                    ? assetCompatible
                    : semanticEvidence;
        const fallback = fallbackPool[0]?.event;
        if (fallback) {
            return {
                relation: requested,
                principalEventId: fallback.id,
                matchedBy: sameTheme.length ? 'theme_candidate' : assetCompatible.length ? 'semantic_similarity' : 'semantic_similarity',
                valid: true,
                reason: `Attached non-NEW evidence to the best current principal (${sameTheme.length ? 'same canonical theme' : 'asset-compatible reaction context'}); no identity was minted.`,
            };
        }
    }

    if (requested !== 'NEW_EVENT') {
        // A relation that points at a prior tracked event (SAME_EVENT, EVENT_UPDATE, evidence,
        // reaction, reversal, de-escalation) is meaningless once no principal can be resolved.
        // Rather than leaving a dangling reference, reconcile it: if the headline carries a fresh
        // independent contribution it becomes a first-occurrence NEW_EVENT; otherwise it is inert
        // context and is downgraded to IRRELEVANT (principal-free, zero contribution). Forward- and
        // backward-looking classifications (FORECAST_UPCOMING for a not-yet-occurred event,
        // HISTORICAL_COMMENTARY / MACRO_RELEASE) never reference a tracked principal and collapse to
        // principal-free context in the same way.
        const carriesFreshCause = requested !== 'PRICE_REACTION'
            && requested !== 'CONFIRMATION'
            && requested !== 'FORECAST_UPCOMING'
            && requested !== 'HISTORICAL_COMMENTARY'
            && Boolean(input.currentContributions?.some((asset) => asset.score !== 0));
        if (carriesFreshCause) {
            return { relation: 'NEW_EVENT', principalEventId: null, matchedBy: 'new_event', valid: true, reason: `${requested} had no resolvable principal but introduced a fresh independent cause; reconciled to a first-occurrence NEW_EVENT.` };
        }
        return { relation: 'IRRELEVANT', principalEventId: null, matchedBy: 'missing_principal', valid: true, reason: `${requested} had no resolvable principal and no independent contribution; downgraded to principal-free context.` };
    }
    return { relation: 'NEW_EVENT', principalEventId: null, matchedBy: 'new_event', valid: true, reason: 'No existing event met the generic same-occurrence threshold; minting one independent event.' };
}

// Contract scores are discrete per-driver contributions. A raw total may exceed
// +/-1, but an individual persisted contribution may not use +/-0.75.
const ALLOWED_SCORES = new Set([-1, -0.5, -0.25, 0, 0.25, 0.5, 1]);
const TRACKED = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'GOLD', 'OIL']);

function stableHash(value: string, length = 24): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function normalizeThemeKey(value: unknown): string {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
        .slice(0, 160) || 'unclassified-driver';
}

/** Internal IDs are generated by code; the model may only propose a human-readable key/label. */
export function buildCanonicalThemeId(dayKey: string, themeKey: string, themeType = 'DRIVER'): string {
    return `theme_${dayKey.replace(/[^0-9]/g, '')}_${stableHash(`${dayKey}|${themeType}|${normalizeThemeKey(themeKey)}`, 28)}`;
}

export function buildCanonicalEventId(dayKey: string, eventKey: string): string {
    return `event_${dayKey.replace(/[^0-9]/g, '')}_${stableHash(`${dayKey}|${eventKey}`, 28)}`;
}

function normalizeScore(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const bounded = Math.max(-1, Math.min(1, n));
    return [...ALLOWED_SCORES].reduce((best, candidate) =>
        Math.abs(candidate - bounded) < Math.abs(best - bounded) ? candidate : best, 0);
}

function normalizeAssets(value: unknown): ClassifiedAsset[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const row = raw as Record<string, unknown>;
        const asset = String(row.asset ?? '').toUpperCase() as TrackedAsset;
        if (!asset || !TRACKED.has(asset) || seen.has(asset)) return [];
        seen.add(asset);
        const score = normalizeScore(row.score);
        const role = String(row.role ?? 'DIRECT').toUpperCase() as ClassifiedAsset['role'];
        return [{
            asset,
            score: role === 'CONFIRMATION' ? 0 : score,
            bias: score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Neutral',
            role: ['DIRECT', 'TRANSMITTED', 'CONFIRMATION'].includes(role ?? '') ? role : 'DIRECT',
            reason: String(row.reason ?? '').slice(0, 500),
        } as ClassifiedAsset];
    });
}

function isAllowedScore(value: unknown): boolean {
    const score = Number(value);
    return Number.isFinite(score) && ALLOWED_SCORES.has(score);
}

function normalizeGeoState(value: unknown): CanonicalGeoState | null {
    const token = String(value ?? '').toUpperCase();
    return ['ESCALATION', 'DE_ESCALATION', 'WATCH', 'IRRELEVANT'].includes(token)
        ? token as CanonicalGeoState
        : null;
}

function normalizeEventRelation(value: unknown): FfeEventRelation {
    const token = String(value ?? '').toUpperCase();
    return FFE_EVENT_RELATIONS.includes(token as FfeEventRelation) ? token as FfeEventRelation : 'NEW_EVENT';
}

function mergeThemeAssets(
    previous: ClassifiedAsset[] | undefined,
    next: ClassifiedAsset[],
    action: CanonicalThemeAction,
    confirmationOnly: boolean,
): ClassifiedAsset[] {
    if (!previous?.length) return next;
    if (confirmationOnly) return previous;
    // A JOIN is a new event in an existing causal cluster, not permission to add a
    // second score for the same theme. Preserve the strongest same-sign evidence and
    // allow an explicit opposite-sign update to replace it.
    if (action === 'JOIN_EXISTING_THEME') {
        const byAsset = new Map(previous.map((asset) => [asset.asset, asset]));
        for (const asset of next) {
            if (asset.role === 'CONFIRMATION' || asset.score === 0) continue;
            const old = byAsset.get(asset.asset);
            if (!old || Math.sign(old.score) !== Math.sign(asset.score) || Math.abs(asset.score) > Math.abs(old.score)) {
                byAsset.set(asset.asset, asset);
            }
        }
        return [...byAsset.values()];
    }
    return next;
}

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function parseJsonAssets(value: unknown): ClassifiedAsset[] {
    return normalizeAssets(value);
}

function actionFromLegacy(value: unknown): CanonicalThemeAction {
    const token = String(value ?? '').toUpperCase();
    if (token === 'JOIN' || token === 'UPDATE') return token === 'JOIN' ? 'JOIN_EXISTING_THEME' : 'UPDATE_EXISTING_THEME';
    if (token === 'NEW_OPPOSING_THEME') return 'CREATE_NEW_THEME';
    if (token === 'CREATE') return 'CREATE_NEW_THEME';
    return 'CONTEXT_ONLY';
}

/** Validate a model reference against the compact active-theme context. */
export function resolveCanonicalThemeDecision(
    raw: Partial<CanonicalThemeDecision> & { legacyAction?: unknown },
    activeThemes: CanonicalThemeContext[],
): CanonicalThemeDecision {
    const requestedAction = raw.action ?? actionFromLegacy(raw.legacyAction);
    const action = CANONICAL_THEME_ACTIONS.includes(requestedAction as CanonicalThemeAction)
        ? requestedAction as CanonicalThemeAction
        : 'CONTEXT_ONLY';
    const requestedId = raw.themeId ? String(raw.themeId) : null;
    const existing = requestedId ? activeThemes.find((theme) => theme.id === requestedId) : undefined;
    const needsExisting = action === 'JOIN_EXISTING_THEME' || action === 'UPDATE_EXISTING_THEME' || action === 'REVERSE_EXISTING_THEME';
    const resolvedAction = needsExisting && !existing ? 'CREATE_NEW_THEME' : action;
    const label = String(raw.label ?? raw.themeKey ?? existing?.label ?? '').slice(0, 180) || null;
    const summary = String(raw.summary ?? existing?.summary ?? '').slice(0, 1000) || null;
    const themeKey = normalizeThemeKey(raw.themeKey ?? existing?.themeKey ?? label ?? summary);
    return {
        action: resolvedAction,
        themeId: existing?.id ?? (resolvedAction === 'CREATE_NEW_THEME' ? null : requestedId),
        themeKey,
        label,
        summary,
        reason: raw.reason == null ? null : String(raw.reason).slice(0, 1000),
        status: raw.status === 'REVERSED' || resolvedAction === 'REVERSE_EXISTING_THEME'
            ? 'REVERSED'
            : raw.status === 'RESOLVED' ? 'RESOLVED' : raw.status === 'WATCH' ? 'WATCH' : 'ACTIVE',
        geoState: normalizeGeoState(raw.geoState ?? existing?.geoState),
        eventRelation: raw.eventRelation == null ? null : normalizeEventRelation(raw.eventRelation),
        assetContributions: normalizeAssets(raw.assetContributions),
        confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    };
}

export function inMemoryThemeContext(dayKey: string): CanonicalThemeContext[] {
    return [];
}

/** Small deterministic registry used by isolated replay/test runs without touching the DB. */
export class InMemoryCanonicalThemeRegistry {
    private readonly themes = new Map<string, CanonicalThemeContext>();
    constructor(private readonly dayKey: string) {}

    list(): CanonicalThemeContext[] {
        return [...this.themes.values()].filter((theme) => theme.status !== 'RESOLVED');
    }

    apply(raw: Partial<CanonicalThemeDecision> & { legacyAction?: unknown }): CanonicalEventResult {
        const decision = resolveCanonicalThemeDecision(raw, this.list());
        if (['CONTEXT_ONLY', 'MACRO_ONLY', 'IRRELEVANT'].includes(decision.action)) {
            return { eventId: null, themeId: null, themeAction: decision.action, themeStatus: null };
        }
        const themeId = decision.themeId ?? buildCanonicalThemeId(this.dayKey, decision.themeKey ?? 'unclassified-driver');
        const previous = this.themes.get(themeId);
        const confirmationOnly = decision.eventRelation === 'SAME_EVENT'
            || decision.eventRelation === 'EVENT_UPDATE'
            || String(decision.eventRelation) === 'CONTEXT_ONLY'
            || (decision.assetContributions.length > 0
                && decision.assetContributions.every((asset) => asset.role === 'CONFIRMATION' || asset.score === 0));
        const nextAssets: ClassifiedAsset[] = decision.action === 'REVERSE_EXISTING_THEME'
            ? (decision.assetContributions.length ? decision.assetContributions : (previous?.assetContributions ?? []).map((a) => ({ ...a, score: -a.score, bias: (a.score > 0 ? 'Bearish' : a.score < 0 ? 'Bullish' : 'Neutral') as ClassifiedAsset['bias'] })))
            : mergeThemeAssets(previous?.assetContributions, decision.assetContributions, decision.action, confirmationOnly);
        const current: CanonicalThemeContext = {
            id: themeId,
            dayKey: this.dayKey,
            themeKey: decision.themeKey ?? previous?.themeKey ?? 'unclassified-driver',
            label: decision.label ?? previous?.label ?? 'Unclassified driver',
            summary: decision.summary ?? previous?.summary ?? '',
            themeType: 'DRIVER',
            status: decision.status,
            geoState: decision.geoState ?? previous?.geoState ?? null,
            assetContributions: nextAssets.length ? nextAssets : previous?.assetContributions ?? [],
            confidence: decision.confidence,
            firstSeenAt: previous?.firstSeenAt ?? new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            latestVersion: (previous?.latestVersion ?? 0) + 1,
            supportingEventIds: previous?.supportingEventIds ?? [],
        };
        this.themes.set(themeId, current);
        const eventId = buildCanonicalEventId(this.dayKey, `${themeId}|${current.latestVersion}`);
        current.supportingEventIds = [...new Set([...current.supportingEventIds, eventId])];
        return { eventId, themeId, themeAction: decision.action, themeStatus: current.status };
    }
}

function sourceScopedThemeWhere(dayKey: string, source?: string): Prisma.MarketDriverCanonicalThemeWhereInput {
    if (!source) return { day_key: dayKey, status: { in: ['ACTIVE', 'WATCH', 'REVERSED'] } };
    // A mixed-source legacy theme is not a valid current FFE context. Requiring every linked
    // headline to be from the authoritative source prevents historical rows from influencing
    // future classification/Catalyst state without deleting those rows.
    return {
        day_key: dayKey,
        status: { in: ['ACTIVE', 'WATCH', 'REVERSED'] },
        headlines: { some: { source }, every: { source } },
    };
}

export async function loadCanonicalThemes(dayKey: string, source?: string): Promise<CanonicalThemeContext[]> {
    const rows = await prisma.marketDriverCanonicalTheme.findMany({
        where: sourceScopedThemeWhere(dayKey, source),
        orderBy: { last_updated_at: 'desc' },
    });
    const events = await loadCanonicalEventContexts(dayKey, source);
    return rows.map((row) => ({
        id: row.id,
        dayKey: row.day_key,
        themeKey: row.theme_key,
        label: row.label,
        summary: row.summary,
        themeType: row.theme_type,
        status: row.status as CanonicalThemeStatus,
        geoState: normalizeGeoState(row.geo_state),
        assetContributions: parseJsonAssets(row.asset_contributions),
        confidence: row.confidence,
        firstSeenAt: row.first_seen_at.toISOString(),
        lastUpdatedAt: row.last_updated_at.toISOString(),
        latestVersion: row.latest_version,
        supportingEventIds: Array.isArray(row.supporting_event_ids) ? row.supporting_event_ids.map(String) : [],
        events: events.filter((event) => event.themeId === row.id),
    }));
}

/** Full current-day event ledger supplied to the semantic resolver. It intentionally includes
 * WATCH/REVERSED/RESOLVED rows so a later update or reversal can find its historical principal. */
export async function loadCanonicalEventContexts(dayKey: string, source?: string): Promise<CanonicalEventContext[]> {
    const rows = await prisma.marketDriverCanonicalEvent.findMany({
        where: {
            day_key: dayKey,
            ...(source ? { headlines: { some: { source } } } : {}),
        },
        orderBy: [{ first_seen_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
        id: row.id,
        dayKey: row.day_key,
        themeId: row.canonical_theme_id,
        relation: row.relation,
        status: row.status,
        valid: row.valid,
        independent: row.independent,
        catalystEligible: row.catalyst_eligible,
        eventType: row.event_type,
        headline: row.headline,
        fundamentalCause: row.fundamental_cause,
        observedMarketReaction: row.observed_market_reaction,
        transmissionReason: row.transmission_reason,
        normalizedSignature: row.normalized_signature,
        sourceGuid: row.source_guid,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        contributions: parseJsonAssets(row.current_asset_contributions),
        supportingGuids: Array.isArray(row.supporting_guid_ids) ? row.supporting_guid_ids.map(String) : [],
        confirmationGuids: Array.isArray(row.confirmation_guid_ids) ? row.confirmation_guid_ids.map(String) : [],
        counterEvidence: Array.isArray(row.counter_evidence) ? row.counter_evidence.map(String) : [],
    }));
}

export async function persistCanonicalDecision(input: {
    dayKey: string;
    sourceId: string;
    guid: string;
    headlineId: string;
    headline: string;
    normalizedSignature: string;
    publishedAt: Date;
    eventRelation: string;
    eventDuplicateOf?: string | null;
    legacyThemeAction?: unknown;
    themeDecision?: Partial<CanonicalThemeDecision>;
    activeThemes: CanonicalThemeContext[];
    directAssets: ClassifiedAsset[];
    transmittedAssets: ClassifiedAsset[];
    causalThemeId?: string | null;
    driverTheme?: string | null;
    canonicalEvents?: CanonicalEventContext[];
    summary?: string | null;
    confidence?: number;
    geoState?: CanonicalGeoState | string | null;
    category?: string | null;
    driverState?: CanonicalDriverState;
}): Promise<CanonicalEventResult> {
    // Canonical Catalyst themes are never created for scheduled Macro or irrelevant rows,
    // even if a provider accidentally returns CREATE_NEW_THEME for one of them.
    if (['ECONOMIC', 'IRRELEVANT'].includes(String(input.category ?? '').toUpperCase())) {
        return {
            eventId: null,
            themeId: null,
            themeAction: String(input.category).toUpperCase() === 'ECONOMIC' ? 'MACRO_ONLY' : 'IRRELEVANT',
            themeStatus: null,
            relation: String(input.category).toUpperCase() === 'ECONOMIC' ? 'MACRO_RELEASE' : 'IRRELEVANT',
            evidenceOnly: true,
            valid: false,
            independent: false,
            catalystEligible: false,
            currentAssetContributions: [],
            resolutionReason: 'Macro/irrelevant evidence is retained on the source row and never mints a Catalyst event.',
        };
    }
    const relation = normalizeEventRelation(input.eventRelation);
    const inferred: Partial<CanonicalThemeDecision> = input.themeDecision
        ? {
            ...input.themeDecision,
            geoState: normalizeGeoState(input.themeDecision.geoState ?? input.geoState),
            eventRelation: input.themeDecision.eventRelation ?? relation,
        }
        : {
        action: actionFromLegacy(input.legacyThemeAction),
        themeId: null,
        themeKey: input.causalThemeId ?? input.driverTheme ?? null,
        label: input.causalThemeId ?? input.driverTheme ?? null,
        summary: input.summary ?? null,
        reason: null,
        status: 'ACTIVE' as const,
        geoState: normalizeGeoState(input.geoState),
        eventRelation: relation,
        assetContributions: [...input.directAssets, ...input.transmittedAssets],
        confidence: input.confidence ?? 0,
    };
    const decision = resolveCanonicalThemeDecision(inferred, input.activeThemes);
    const existingEvents = input.canonicalEvents ?? input.activeThemes.flatMap((theme) => theme.events ?? []);
    const principalResolution = resolveCanonicalPrincipal({
        relation,
        eventDuplicateOf: input.eventDuplicateOf,
        headline: input.headline,
        normalizedSignature: input.normalizedSignature,
        themeId: decision.themeId ?? input.causalThemeId ?? input.driverTheme,
        eventType: input.driverState?.eventType,
        fundamentalCause: input.driverState?.fundamentalCause ?? input.summary,
        currentContributions: input.driverState?.currentAssetContributions ?? [...input.directAssets, ...input.transmittedAssets],
        publishedAt: input.publishedAt,
    }, existingEvents);
    const effectiveRelation = principalResolution.relation;
    if (!principalResolution.valid || (effectiveRelation !== 'NEW_EVENT' && !principalResolution.principalEventId)) {
        return {
            eventId: null,
            themeId: decision.themeId ?? null,
            themeAction: decision.action,
            themeStatus: 'WATCH',
            relation: effectiveRelation,
            principalEventId: null,
            evidenceOnly: true,
            valid: false,
            independent: false,
            catalystEligible: false,
            currentAssetContributions: [],
            resolutionReason: principalResolution.reason,
        };
    }
    if (['CONTEXT_ONLY', 'MACRO_ONLY', 'IRRELEVANT'].includes(decision.action)) {
        const contextRef = principalResolution.principalEventId;
        if (contextRef && !['ECONOMIC', 'IRRELEVANT'].includes(String(input.category ?? '').toUpperCase())) {
            const contextRow = await prisma.marketDriverNews.findFirst({
                where: { source_id: input.sourceId, OR: [{ id: contextRef }, { canonical_event_id: contextRef }, { guid: contextRef }] },
                select: { canonical_event_id: true },
            }).catch(() => null);
            const contextEventId = contextRow?.canonical_event_id ?? (contextRef.startsWith('event_') ? contextRef : null);
            if (contextEventId) {
                const existingEvent = await prisma.marketDriverCanonicalEvent.findUnique({ where: { id: contextEventId }, select: { supporting_headline_ids: true, supporting_guid_ids: true, confirmation_guid_ids: true, update_history: true, canonical_theme_id: true } }).catch(() => null);
                if (existingEvent) {
                    const headlineIds = [...new Set([...(Array.isArray(existingEvent.supporting_headline_ids) ? existingEvent.supporting_headline_ids.map(String) : []), input.headlineId])];
                    const guids = [...new Set([...(Array.isArray(existingEvent.supporting_guid_ids) ? existingEvent.supporting_guid_ids.map(String) : []), input.guid])];
                    const confirmations = [...new Set([...(Array.isArray(existingEvent.confirmation_guid_ids) ? existingEvent.confirmation_guid_ids.map(String) : []), input.guid])];
                    const history = [...(Array.isArray(existingEvent.update_history) ? existingEvent.update_history : []), { at: new Date().toISOString(), relation: effectiveRelation, status: 'ACTIVE', headlineId: input.headlineId, guid: input.guid, confirmation: true }].slice(-100);
                    await prisma.marketDriverCanonicalEvent.update({ where: { id: contextEventId }, data: { last_seen_at: new Date(), relation: effectiveRelation, supporting_headline_ids: asJson(headlineIds), supporting_guid_ids: asJson(guids), confirmation_guid_ids: asJson(confirmations), update_history: asJson(history) } });
                    return { eventId: contextEventId, themeId: existingEvent.canonical_theme_id, themeAction: decision.action, themeStatus: 'ACTIVE', relation: effectiveRelation, principalEventId: contextEventId, evidenceOnly: true, valid: true, independent: false, catalystEligible: false, currentAssetContributions: [], resolutionReason: principalResolution.reason };
                }
            }
        }
        return { eventId: null, themeId: null, themeAction: decision.action, themeStatus: null, relation: effectiveRelation, evidenceOnly: true, valid: false, independent: false, catalystEligible: false, currentAssetContributions: [], resolutionReason: principalResolution.reason };
    }
    const targetEventId = principalResolution.principalEventId;
    const principalEvent = targetEventId ? existingEvents.find((event) => event.id === targetEventId) : undefined;
    const themeId = principalEvent?.themeId ?? decision.themeId ?? buildCanonicalThemeId(input.dayKey, decision.themeKey ?? 'unclassified-driver');
    const existing = input.activeThemes.find((theme) => theme.id === themeId);
    const eventKey = targetEventId || `${input.sourceId}|${input.guid}|${effectiveRelation}|${input.normalizedSignature}`;
    const eventId = targetEventId ?? buildCanonicalEventId(input.dayKey, eventKey);
    const now = new Date();
    const contributions = decision.assetContributions.length
        ? decision.assetContributions
        : [...input.directAssets, ...input.transmittedAssets];
    const driverState = input.driverState ?? {};
    const suppliedCurrent = driverState.currentAssetContributions
        ? normalizeAssets(driverState.currentAssetContributions)
        : normalizeAssets(contributions);
    const zeroRelation = ['SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT'].includes(effectiveRelation);
    const confirmationOnly = zeroRelation
        || (Boolean(input.eventDuplicateOf) && effectiveRelation === 'NEW_EVENT')
        || (contributions.length > 0 && contributions.every((asset) => asset.role === 'CONFIRMATION' || asset.score === 0));
    const nextAssets: ClassifiedAsset[] = decision.action === 'REVERSE_EXISTING_THEME'
        ? (contributions.length ? contributions : (existing?.assetContributions ?? []).map((asset) => ({ ...asset, score: -asset.score, bias: (asset.score > 0 ? 'Bearish' : asset.score < 0 ? 'Bullish' : 'Neutral') as ClassifiedAsset['bias'] })))
        : confirmationOnly && existing
            ? existing.assetContributions
            : mergeThemeAssets(existing?.assetContributions, contributions, decision.action, confirmationOnly);
    const allScoresValid = suppliedCurrent.every((asset) => asset.role === 'CONFIRMATION' || isAllowedScore(asset.score));
    const incomingContributions = suppliedCurrent.filter((asset) => asset.role !== 'CONFIRMATION' && asset.score !== 0);
    const currentAssetContributions = zeroRelation
        ? (principalEvent?.contributions ?? [])
        : effectiveRelation === 'REVERSAL' || effectiveRelation === 'DE_ESCALATION' || driverState.catalystEligible === false || !allScoresValid
            ? []
            : incomingContributions;
    const valid = zeroRelation && principalEvent
        ? (principalEvent.valid ?? true)
        : driverState.valid !== false
            && !['ECONOMIC', 'IRRELEVANT'].includes(String(input.category ?? '').toUpperCase())
            && allScoresValid
            && currentAssetContributions.length > 0;
    const independent = zeroRelation && principalEvent
        ? (principalEvent.independent ?? true)
        : driverState.independent !== false && !confirmationOnly && valid;
    const catalystEligible = zeroRelation && principalEvent
        ? (principalEvent.catalystEligible ?? currentAssetContributions.length > 0)
        : driverState.catalystEligible !== false && currentAssetContributions.length > 0 && valid;
    const status = zeroRelation && principalEvent
        ? principalEvent.status as CanonicalThemeStatus
        : effectiveRelation === 'REVERSAL' || effectiveRelation === 'DE_ESCALATION'
            ? (effectiveRelation === 'REVERSAL' ? 'REVERSED' : 'WATCH')
            : (currentAssetContributions.length > 0 ? 'ACTIVE' : decision.status);
    const updateHistoryEntry = {
        at: now.toISOString(),
        relation: effectiveRelation,
        status,
        headlineId: input.headlineId,
        guid: input.guid,
        cause: driverState.fundamentalCause ?? input.summary ?? null,
        observedReaction: driverState.observedMarketReaction ?? null,
        contributions: currentAssetContributions,
        reason: driverState.transmissionReason ?? decision.reason ?? null,
    };

    await prisma.$transaction(async (tx) => {
        await tx.marketDriverCanonicalTheme.upsert({
            where: { id: themeId },
            create: {
                id: themeId,
                day_key: input.dayKey,
                theme_key: decision.themeKey ?? 'unclassified-driver',
                label: decision.label ?? decision.themeKey ?? 'Unclassified driver',
                summary: decision.summary ?? input.summary ?? '',
                theme_type: 'DRIVER',
                status,
                geo_state: decision.geoState,
                direct_evidence: asJson(input.directAssets),
                asset_contributions: asJson(nextAssets),
                confidence: decision.confidence,
                first_seen_at: input.publishedAt,
                last_updated_at: now,
                latest_version: 1,
                supporting_event_ids: asJson([eventId]),
                supporting_headline_ids: asJson([input.headlineId]),
            },
            update: {
                label: decision.label ?? undefined,
                summary: decision.summary ?? undefined,
                status,
                geo_state: decision.geoState ?? undefined,
                direct_evidence: asJson(input.directAssets),
                asset_contributions: asJson(nextAssets),
                confidence: decision.confidence,
                last_updated_at: now,
                latest_version: { increment: 1 },
                supporting_event_ids: asJson([...new Set([...(existing?.supportingEventIds ?? []), eventId])]),
                supporting_headline_ids: asJson([input.headlineId]),
            },
        });
        const theme = await tx.marketDriverCanonicalTheme.findUniqueOrThrow({ where: { id: themeId }, select: { latest_version: true } });
        await tx.marketDriverCanonicalThemeRevision.create({
            data: {
                theme_id: themeId,
                version: theme.latest_version,
                action: decision.action,
                status,
                summary: decision.summary ?? input.summary ?? '',
                geo_state: decision.geoState,
                asset_contributions: asJson(nextAssets),
                confidence: decision.confidence,
                reason: decision.reason,
                headline_ids: asJson([input.headlineId]),
                event_ids: asJson([eventId]),
            },
        });
        const priorEvent = await tx.marketDriverCanonicalEvent.findUnique({
            where: { id: eventId },
            select: { supporting_headline_ids: true, supporting_guid_ids: true, confirmation_guid_ids: true, update_history: true },
        });
        const priorHeadlineIds = Array.isArray(priorEvent?.supporting_headline_ids) ? priorEvent.supporting_headline_ids.map(String) : [];
        const priorGuidIds = Array.isArray(priorEvent?.supporting_guid_ids) ? priorEvent.supporting_guid_ids.map(String) : [];
        const priorConfirmationGuids = Array.isArray(priorEvent?.confirmation_guid_ids) ? priorEvent.confirmation_guid_ids.map(String) : [];
        const priorHistory = Array.isArray(priorEvent?.update_history) ? priorEvent.update_history : [];
        const nextGuidIds = [...new Set([...priorGuidIds, input.guid, ...(driverState.supportingGuidIds ?? [])])];
        const nextConfirmationGuids = confirmationOnly
            ? [...new Set([...priorConfirmationGuids, input.guid, ...(driverState.confirmationGuidIds ?? [])])]
            : priorConfirmationGuids;
        const nextHistory = [...priorHistory, updateHistoryEntry].slice(-100);
        await tx.marketDriverCanonicalEvent.upsert({
            where: { id: eventId },
            create: {
                id: eventId,
                day_key: input.dayKey,
                source_id: input.sourceId,
                source_guid: input.guid,
                normalized_signature: input.normalizedSignature,
                headline: input.headline,
                relation: effectiveRelation,
                status,
                canonical_theme_id: themeId,
                event_type: driverState.eventType ?? null,
                fundamental_cause: driverState.fundamentalCause ?? input.summary ?? null,
                observed_market_reaction: driverState.observedMarketReaction ?? null,
                event_strength: driverState.eventStrength ?? null,
                severity: driverState.severity ?? null,
                credibility: driverState.credibility ?? decision.confidence,
                freshness: driverState.freshness ?? null,
                persistence: driverState.persistence ?? null,
                geo_state: driverState.geoState ?? decision.geoState,
                transmission_reason: driverState.transmissionReason ?? null,
                affected_assets: asJson(driverState.affectedAssets ?? [...input.directAssets, ...input.transmittedAssets]),
                current_asset_contributions: asJson(currentAssetContributions),
                counter_evidence: asJson(driverState.counterEvidence ?? []),
                supporting_guid_ids: asJson(nextGuidIds),
                confirmation_guid_ids: asJson(nextConfirmationGuids),
                update_history: asJson(nextHistory),
                catalyst_eligible: catalystEligible,
                independent,
                valid,
                provider: driverState.provider ?? null,
                model: driverState.model ?? null,
                prompt_version: driverState.promptVersion ?? null,
                decision_at: now,
                first_seen_at: input.publishedAt,
                last_seen_at: now,
                supporting_headline_ids: asJson([...new Set([input.headlineId])]),
            },
            update: {
                relation: effectiveRelation,
                status,
                canonical_theme_id: themeId,
                event_type: driverState.eventType ?? undefined,
                fundamental_cause: driverState.fundamentalCause ?? undefined,
                observed_market_reaction: driverState.observedMarketReaction ?? undefined,
                event_strength: driverState.eventStrength ?? undefined,
                severity: driverState.severity ?? undefined,
                credibility: driverState.credibility ?? undefined,
                freshness: driverState.freshness ?? undefined,
                persistence: driverState.persistence ?? undefined,
                geo_state: driverState.geoState ?? decision.geoState ?? undefined,
                transmission_reason: driverState.transmissionReason ?? undefined,
                affected_assets: driverState.affectedAssets ? asJson(driverState.affectedAssets) : undefined,
                current_asset_contributions: asJson(currentAssetContributions),
                counter_evidence: driverState.counterEvidence ? asJson(driverState.counterEvidence) : undefined,
                supporting_guid_ids: asJson(nextGuidIds),
                confirmation_guid_ids: asJson(nextConfirmationGuids),
                update_history: asJson(nextHistory),
                catalyst_eligible: catalystEligible,
                independent,
                valid,
                provider: driverState.provider ?? undefined,
                model: driverState.model ?? undefined,
                prompt_version: driverState.promptVersion ?? undefined,
                decision_at: now,
                last_seen_at: now,
                supporting_headline_ids: asJson([...new Set([...priorHeadlineIds, input.headlineId])]),
            },
        });
        // Theme state is a projection of its current canonical events, never a second additive
        // score ledger. Recompute it after the principal mutation so confirmations and reversals
        // cannot leave stale headline-level contributions behind.
        const themeEvents = await tx.marketDriverCanonicalEvent.findMany({
            where: { canonical_theme_id: themeId },
            select: { id: true, status: true, valid: true, independent: true, catalyst_eligible: true, current_asset_contributions: true, supporting_headline_ids: true },
        });
        const aggregate = new Map<string, ClassifiedAsset>();
        const supportingEvents = new Set<string>();
        const supportingHeadlines = new Set<string>();
        let hasActiveContribution = false;
        for (const event of themeEvents) {
            supportingEvents.add(event.id);
            for (const headlineId of Array.isArray(event.supporting_headline_ids) ? event.supporting_headline_ids.map(String) : []) supportingHeadlines.add(headlineId);
            if (event.status !== 'ACTIVE' || !event.valid || !event.independent || !event.catalyst_eligible) continue;
            const contributions = parseJsonAssets(event.current_asset_contributions);
            if (contributions.length) hasActiveContribution = true;
            for (const contribution of contributions) {
                const previous = aggregate.get(contribution.asset);
                aggregate.set(contribution.asset, previous
                    ? { ...previous, score: previous.score + contribution.score, bias: previous.score + contribution.score > 0 ? 'Bullish' : previous.score + contribution.score < 0 ? 'Bearish' : 'Neutral' }
                    : { ...contribution });
            }
        }
        await tx.marketDriverCanonicalTheme.update({
            where: { id: themeId },
            data: {
                asset_contributions: asJson([...aggregate.values()]),
                supporting_event_ids: asJson([...supportingEvents]),
                supporting_headline_ids: asJson([...supportingHeadlines]),
                status: hasActiveContribution ? 'ACTIVE' : status,
                last_updated_at: now,
            },
        });
    });
    return { eventId, themeId, themeAction: decision.action, themeStatus: status, relation: effectiveRelation, principalEventId: targetEventId, evidenceOnly: false, valid, independent, catalystEligible, currentAssetContributions, resolutionReason: principalResolution.reason };
}

export async function getCanonicalThemeBoard(dayKey: string, source?: string): Promise<Map<TrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }> | null> {
    const themes = await prisma.marketDriverCanonicalTheme.findMany({
        where: source
            ? { day_key: dayKey, status: 'ACTIVE', headlines: { some: { source }, every: { source } } }
            : { day_key: dayKey, status: 'ACTIVE' },
        orderBy: { last_updated_at: 'asc' },
    });
    if (!themes.length) return null;
    const output = new Map<TrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }>();
    for (const theme of themes) {
        for (const asset of parseJsonAssets(theme.asset_contributions)) {
            if (!asset.score || asset.role === 'CONFIRMATION') continue;
            const row = output.get(asset.asset) ?? { bullishCount: 0, bearishCount: 0, driverScore: 0, themes: [] };
            if (asset.score > 0) row.bullishCount += 1;
            if (asset.score < 0) row.bearishCount += 1;
            row.driverScore += asset.score;
            row.themes.push(theme.id);
            output.set(asset.asset, row);
        }
    }
    return output.size ? output : null;
}

export type CanonicalDriverAuditRow = {
    eventId: string;
    themeId: string | null;
    /** Deterministic contract-transmission family used to collapse fragmented drivers to one unique cause. */
    contractFamily?: string | null;
    eventType: string | null;
    relation: string;
    status: string;
    valid: boolean;
    independent: boolean;
    catalystEligible: boolean;
    fundamentalCause: string | null;
    observedMarketReaction: string | null;
    transmissionReason: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    supportingGuids: string[];
    confirmationGuids: string[];
    contributions: ClassifiedAsset[];
    counterEvidence: string[];
};

type CollapsibleDriver = Pick<CanonicalDriverAuditRow, 'eventId' | 'themeId' | 'contractFamily' | 'status' | 'valid' | 'independent' | 'catalystEligible' | 'contributions'>;

/** Collapse key: OIL_SUPPLY_SHOCK fragments only within the same causal theme, not across the whole family. */
export function collapseGroupKey(event: CollapsibleDriver): string {
    const family = event.contractFamily?.trim() ?? '';
    const theme = event.themeId?.trim() ?? '';
    if ((family === 'OIL_SUPPLY_SHOCK' || family === 'COMMODITY_INVENTORY_SHOCK') && theme && !isGenericThemeKey(theme)) return `${family}::${theme}`;
    if (family) return family;
    if (theme && !isGenericThemeKey(theme)) return theme;
    return event.eventId;
}

function isGenericThemeKey(themeId: string): boolean {
    const key = themeId.trim().toUpperCase();
    return key === 'NONE' || key === 'IRRELEVANT' || key === 'UNCLASSIFIED' || key === '.' || key.length <= 1;
}

/**
 * A "unique causal driver" (client contract §30) is a single fundamental cause, not a single
 * headline. Newswires fragment one cause (e.g. a Hormuz crude-route disruption) across many
 * separate canonical events within the SAME theme. Summing every fragment multiplies the score.
 * OIL_SUPPLY_SHOCK is scoped by causal theme so diplomacy, unrelated attacks, and commentary
 * cannot net into one oil direction merely by sharing the broad contract family label.
 */
export function collapseCanonicalDrivers(
    rows: Array<CollapsibleDriver>,
): Array<{ key: string; representativeEventId: string; themeId: string | null; contributions: ClassifiedAsset[]; memberEventIds: string[] }> {
    type Agg = { net: number; magnitude: number; sample: ClassifiedAsset };
    const groups = new Map<string, { representativeEventId: string; themeId: string | null; byAsset: Map<string, Agg>; memberEventIds: string[] }>();
    for (const event of rows) {
        if (event.status !== 'ACTIVE' || !event.valid || !event.independent || !event.catalystEligible) continue;
        const key = collapseGroupKey(event);
        const group = groups.get(key) ?? { representativeEventId: event.eventId, themeId: event.themeId ?? null, byAsset: new Map<string, Agg>(), memberEventIds: [] };
        group.memberEventIds.push(event.eventId);
        for (const asset of event.contributions) {
            if (!asset.score || asset.role === 'CONFIRMATION') continue;
            const agg = group.byAsset.get(asset.asset) ?? { net: 0, magnitude: 0, sample: asset };
            agg.net += asset.score;
            if (Math.abs(asset.score) > agg.magnitude) { agg.magnitude = Math.abs(asset.score); agg.sample = asset; }
            group.byAsset.set(asset.asset, agg);
        }
        groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
        const contributions: ClassifiedAsset[] = [];
        for (const [assetName, agg] of group.byAsset.entries()) {
            // One unique causal driver contributes ONE discrete value per asset. When members agree
            // in sign we take the strongest expression of the cause; when opposing sub-events exist
            // (escalation vs de-escalation of the SAME family) the net direction wins at the standard
            // magnitude, and a perfect cancellation drops the asset. This keeps a fragmented cause
            // from multiplying while still honouring which way the single cause actually points.
            const direction = agg.net > 0 ? 1 : agg.net < 0 ? -1 : 0;
            if (direction === 0) continue;
            const score = direction * agg.magnitude;
            contributions.push({ ...agg.sample, asset: assetName as ClassifiedAsset['asset'], score, bias: score > 0 ? 'Bullish' : 'Bearish' });
        }
        return {
            key,
            representativeEventId: group.representativeEventId,
            themeId: group.themeId,
            contributions,
            memberEventIds: group.memberEventIds,
        };
    });
}

export function reconstructCanonicalCatalyst(
    rows: Array<CollapsibleDriver>,
): Map<TrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }> {
    const output = new Map<TrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }>();
    for (const driver of collapseCanonicalDrivers(rows)) {
        for (const asset of driver.contributions) {
            if (!asset.score || asset.role === 'CONFIRMATION') continue;
            const row = output.get(asset.asset) ?? { bullishCount: 0, bearishCount: 0, driverScore: 0, themes: [] };
            if (asset.score > 0) row.bullishCount += 1;
            if (asset.score < 0) row.bearishCount += 1;
            row.driverScore += asset.score;
            row.themes.push(driver.themeId ? `${driver.themeId}:${driver.representativeEventId}` : driver.representativeEventId);
            output.set(asset.asset, row);
        }
    }
    return output;
}

/** Official Catalyst arithmetic: one current contribution per active canonical event. */
export async function getCanonicalEventBoard(
    dayKey: string,
    source?: string,
): Promise<Map<TrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }> | null> {
    const events = await prisma.marketDriverCanonicalEvent.findMany({
        where: {
            day_key: dayKey,
            status: 'ACTIVE',
            valid: true,
            independent: true,
            catalyst_eligible: true,
            ...(source ? { headlines: { some: { source } } } : {}),
        },
        orderBy: [{ first_seen_at: 'asc' }, { id: 'asc' }],
        select: { id: true, canonical_theme_id: true, current_asset_contributions: true },
    });
    if (!events.length) return null;
    const output = reconstructCanonicalCatalyst(events.map((event) => ({
        eventId: event.id,
        themeId: event.canonical_theme_id,
        status: 'ACTIVE',
        valid: true,
        independent: true,
        catalystEligible: true,
        contributions: parseJsonAssets(event.current_asset_contributions),
    })));
    return output.size ? output : null;
}

/** Full reconstruction rows used by the admin audit/export and replay validation. */
export async function getCanonicalDriverAudit(dayKey: string, source?: string): Promise<CanonicalDriverAuditRow[]> {
    const events = await prisma.marketDriverCanonicalEvent.findMany({
        where: {
            day_key: dayKey,
            ...(source ? { headlines: { some: { source } } } : {}),
        },
        orderBy: [{ first_seen_at: 'asc' }, { id: 'asc' }],
    });
    return events.map((event) => ({
        eventId: event.id,
        themeId: event.canonical_theme_id,
        eventType: event.event_type,
        relation: event.relation,
        status: event.status,
        valid: event.valid,
        independent: event.independent,
        catalystEligible: event.catalyst_eligible,
        fundamentalCause: event.fundamental_cause,
        observedMarketReaction: event.observed_market_reaction,
        transmissionReason: event.transmission_reason,
        firstSeenAt: event.first_seen_at.toISOString(),
        lastSeenAt: event.last_seen_at.toISOString(),
        supportingGuids: Array.isArray(event.supporting_guid_ids) ? event.supporting_guid_ids.map(String) : [],
        confirmationGuids: Array.isArray(event.confirmation_guid_ids) ? event.confirmation_guid_ids.map(String) : [],
        contributions: parseJsonAssets(event.current_asset_contributions),
        counterEvidence: Array.isArray(event.counter_evidence) ? event.counter_evidence.map(String) : [],
    }));
}
