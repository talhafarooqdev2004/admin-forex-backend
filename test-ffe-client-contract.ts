import assert from 'node:assert/strict';
import {
    reconstructCanonicalCatalyst,
    type CanonicalDriverAuditRow,
} from './src/services/canonicalThemeRegistry.service.js';
import { calculateGeopoliticalRisk } from './src/services/geopoliticalRisk.service.js';

const asset = (name: CanonicalDriverAuditRow['contributions'][number]['asset'], score: number, role: 'DIRECT' | 'TRANSMITTED' | 'CONFIRMATION' = 'DIRECT') => ({
    asset: name, score, role, bias: score > 0 ? 'Bullish' as const : score < 0 ? 'Bearish' as const : 'Neutral' as const, reason: 'contract test',
});
const driver = (id: string, score: number, status = 'ACTIVE' as string): CanonicalDriverAuditRow => ({
    eventId: id, themeId: `theme-${id}`, eventType: 'OTHER', relation: 'NEW_EVENT', status, valid: true,
    independent: true, catalystEligible: true, fundamentalCause: 'independent cause', observedMarketReaction: null,
    transmissionReason: 'one sentence transmission', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    supportingGuids: [id], confirmationGuids: [], contributions: [asset('USD', score)], counterEvidence: [],
});

const two = reconstructCanonicalCatalyst([driver('a', 1), driver('b', 0.5)]);
assert.equal(two.get('USD')?.driverScore, 1.5, 'raw total must not clamp at +1');
assert.equal(two.get('USD')?.bullishCount, 2);

const opposing = reconstructCanonicalCatalyst([driver('a', 0.5), driver('b', -0.5)]);
assert.equal(opposing.get('USD')?.driverScore, 0, 'opposing drivers must remain visible but sum to zero');
assert.equal(opposing.get('USD')?.bullishCount, 1);
assert.equal(opposing.get('USD')?.bearishCount, 1);

const replaced = reconstructCanonicalCatalyst([driver('a', 0.5, 'REVERSED'), driver('b', 0.5)]);
assert.equal(replaced.get('USD')?.driverScore, 0.5, 'reversed event must no longer contribute');

const geo = calculateGeopoliticalRisk([
    {
        headline: 'Confirmed shipping escalation', impact: 'High', summary: null, assets: [], published_at: new Date(), created_at: new Date(),
        causal_theme_id: 'GEO_HORMUZ', geo_state: 'ESCALATION', event_severity: 0.9, event_credibility: 0.9,
        event_freshness: 1, event_persistence: 0.9, transmission_reason: 'critical route risk', current_asset_contributions: [],
    },
    {
        headline: 'Same escalation paraphrase', impact: 'High', summary: null, assets: [], published_at: new Date(), created_at: new Date(),
        causal_theme_id: 'GEO_HORMUZ', geo_state: 'ESCALATION', event_severity: 0.1, event_credibility: 0.1,
        event_freshness: 1, event_persistence: 0.1, transmission_reason: 'same route', current_asset_contributions: [],
    },
]);
assert.equal(geo.eventCount, 1, 'Geo must count one dominant canonical theme, not headlines');
assert.ok(geo.score > 0 && geo.score <= 1);
assert.equal(geo.band, geo.score <= 0.2 ? 'Low Risk' : geo.score <= 0.4 ? 'Watch' : geo.score <= 0.65 ? 'Elevated' : geo.score <= 0.85 ? 'High Risk' : 'Extreme Risk');
console.log(JSON.stringify({ eventArithmetic: 'PASS', geoDominantTheme: 'PASS', geoScore: geo.score, geoBand: geo.band }));
