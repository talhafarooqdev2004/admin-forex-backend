import assert from 'node:assert/strict';
import {
    collapseCanonicalDrivers,
    reconstructCanonicalCatalyst,
    resolveCanonicalPrincipal,
    type CanonicalDriverAuditRow,
    type CanonicalEventContext,
} from './src/services/canonicalThemeRegistry.service.js';
import { deriveContractTransmission, deriveGeoRiskPremium, TRACKED_ASSETS } from './src/services/groqClassifier.service.js';

/**
 * Proves the r10 over-count defect is fixed: newswires fragment ONE fundamental cause across many
 * canonical events, and the board must count each unique causal driver exactly once (client
 * contract §30), taking the strongest contribution — never summing every fragment.
 */

const active = (over: Partial<CanonicalDriverAuditRow>): CanonicalDriverAuditRow => ({
    eventId: 'e', themeId: null, contractFamily: null, eventType: null, relation: 'NEW_EVENT',
    status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
    fundamentalCause: null, observedMarketReaction: null, transmissionReason: null,
    firstSeenAt: '', lastSeenAt: '', supportingGuids: [], confirmationGuids: [],
    contributions: [], counterEvidence: [], ...over,
});

const oil = deriveContractTransmission({
    category: 'GEOPOLITICAL', eventType: 'GEOPOLITICAL', geoState: 'ESCALATION',
    headline: 'UKMTO: vessel hit by projectile during outbound Strait of Hormuz transit causing engine room damage and crew casualty; tanker route disruption',
    evidenceText: 'confirmed operational crude shipping-route disruption in the strait of hormuz',
    conditional: false, directShock: true, modelAssets: [],
})!;

// Twelve separately-minted Hormuz oil-shock events (different eventIds but the SAME causal theme)
// fragment the wire; they must collapse to one unique driver.
const fragments = Array.from({ length: 12 }, (_, i) => active({
    eventId: `event_oil_${i}`,
    themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION',
    contractFamily: oil.family,
    contributions: oil.contributions,
}));

const collapsed = collapseCanonicalDrivers(fragments);
assert.equal(collapsed.length, 1, `twelve fragments of one family must collapse to one unique driver, got ${collapsed.length}`);

const board = reconstructCanonicalCatalyst(fragments);
const score = (a: string) => board.get(a as (typeof TRACKED_ASSETS)[number])?.driverScore ?? 0;
assert.equal(score('OIL'), 1, `fragmented oil shock must count once → OIL +1, got ${score('OIL')}`);
assert.equal(score('CAD'), 1, `fragmented oil shock must count once → CAD +1, got ${score('CAD')}`);
assert.equal(score('JPY'), -0.5, `fragmented oil shock → JPY -0.5, got ${score('JPY')}`);

// Distinct causal families remain independent and are summed separately.
const geo = deriveGeoRiskPremium({ score: 0.75, escalationCount: 4, deEscalationCount: 1, confirmed: true })!;
const mixed = [
    ...fragments,
    active({ eventId: 'event_geo_1', themeId: 'GEO_A', contractFamily: geo.family, contributions: geo.contributions }),
    active({ eventId: 'event_geo_2', themeId: 'GEO_B', contractFamily: geo.family, contributions: geo.contributions }),
];
const mixedCollapsed = collapseCanonicalDrivers(mixed);
assert.equal(mixedCollapsed.length, 2, `two distinct families (oil + geo) must remain two unique drivers, got ${mixedCollapsed.length}`);
const mb = reconstructCanonicalCatalyst(mixed);
assert.equal(mb.get('USD')?.driverScore ?? 0, 0.5, 'systemic geo counted once → USD +0.5');
assert.equal(mb.get('CHF')?.driverScore ?? 0, 0.5, 'systemic geo counted once → CHF +0.5');
assert.equal(mb.get('OIL')?.driverScore ?? 0, 1, 'oil family still counted once alongside geo → OIL +1');

// Strongest-magnitude wins within a theme (a "major" +1 and a "moderate" +0.5 oil event → +1).
const strongestWins = collapseCanonicalDrivers([
    active({ eventId: 'e_major', themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION', contractFamily: 'OIL_SUPPLY_SHOCK', contributions: [{ asset: 'OIL', bias: 'Bullish', score: 1 }] }),
    active({ eventId: 'e_moderate', themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION', contractFamily: 'OIL_SUPPLY_SHOCK', contributions: [{ asset: 'OIL', bias: 'Bullish', score: 0.5 }] }),
]);
assert.equal(strongestWins.length, 1);
assert.equal(strongestWins[0]!.contributions.find((c) => c.asset === 'OIL')!.score, 1, 'strongest contribution wins within a theme');

// Distinct oil themes with the same contract family label must NOT collapse together.
const distinctOilThemes = collapseCanonicalDrivers([
    active({ eventId: 'hormuz', themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION', contractFamily: 'OIL_SUPPLY_SHOCK', contributions: [{ asset: 'OIL', bias: 'Bullish', score: 1 }] }),
    active({ eventId: 'diplomacy', themeId: 'GEO_TURKEY_US_MIDDLE_EAST_TALKS', contractFamily: 'OIL_SUPPLY_SHOCK', contributions: [{ asset: 'OIL', bias: 'Bearish', score: -0.5 }] }),
]);
assert.equal(distinctOilThemes.length, 2, 'different oil causal themes stay separate even under OIL_SUPPLY_SHOCK');

// Opposing sub-events of the SAME family net to the dominant direction (escalation-heavy day):
// three confirmed escalations vs one de-escalation → the single geo driver stays haven-positive.
const escalationVector = geo.contributions;
const deescVector = escalationVector.map((c) => ({ ...c, score: -c.score, bias: (-c.score > 0 ? 'Bullish' : 'Bearish') as 'Bullish' | 'Bearish' }));
const netDay = collapseCanonicalDrivers([
    active({ eventId: 'esc_1', contractFamily: 'GEO_SYSTEMIC_ESCALATION', contributions: escalationVector }),
    active({ eventId: 'esc_2', contractFamily: 'GEO_SYSTEMIC_ESCALATION', contributions: escalationVector }),
    active({ eventId: 'esc_3', contractFamily: 'GEO_SYSTEMIC_ESCALATION', contributions: escalationVector }),
    active({ eventId: 'deesc_1', contractFamily: 'GEO_SYSTEMIC_ESCALATION', contributions: deescVector }),
]);
assert.equal(netDay.length, 1, 'escalation + de-escalation of one family stays one unique driver');
{
    const m = new Map(netDay[0]!.contributions.map((c) => [c.asset, c.score]));
    assert.equal(m.get('USD'), 0.5, 'escalation-dominant day nets USD +0.5 (haven bid), not flipped by mediation');
    assert.equal(m.get('CHF'), 0.5, 'escalation-dominant day nets CHF +0.5');
    assert.equal(m.get('AUD'), -0.5, 'escalation-dominant day nets AUD -0.5');
}

// Resolver reconciliation: a prior-referencing relation with no principal never dangles.
const noEvents: CanonicalEventContext[] = [];
const eventUpdateFreshCause = resolveCanonicalPrincipal({
    relation: 'EVENT_UPDATE', headline: 'Fresh independent development with market impact',
    currentContributions: [{ asset: 'USD', bias: 'Bullish', score: 0.5 }],
}, noEvents);
assert.equal(eventUpdateFreshCause.relation, 'NEW_EVENT', 'EVENT_UPDATE with fresh cause and no principal reconciles to NEW_EVENT');
assert.equal(eventUpdateFreshCause.valid, true);

const forecastNoPrincipal = resolveCanonicalPrincipal({
    relation: 'FORECAST_UPCOMING', headline: 'Fed Interest Rate Probabilities', currentContributions: [],
}, noEvents);
assert.equal(forecastNoPrincipal.relation, 'IRRELEVANT', 'FORECAST_UPCOMING with no principal downgrades to principal-free context');
assert.equal(forecastNoPrincipal.principalEventId, null);
assert.equal(forecastNoPrincipal.valid, true, 'downgraded context is a valid resolution, not a dangling violation');

console.log('PASS — fragmented same-family drivers collapse to one unique causal driver, distinct families stay independent, and dangling relations reconcile without violating principal integrity.');
