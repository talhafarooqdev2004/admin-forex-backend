import assert from 'node:assert/strict';
import {
    normalizeAiClassification,
} from './src/services/groqClassifier.service.ts';
import {
    resolveCanonicalPrincipal,
    reconstructCanonicalCatalyst,
    type CanonicalEventContext,
} from './src/services/canonicalThemeRegistry.service.ts';

const principal: CanonicalEventContext = {
    id: 'event-principal',
    themeId: 'theme-route',
    relation: 'NEW_EVENT',
    status: 'ACTIVE',
    valid: true,
    independent: true,
    catalystEligible: true,
    eventType: 'OIL_SUPPLY',
    headline: 'Confirmed tanker damage disrupts Hormuz crude shipping',
    fundamentalCause: 'Confirmed tanker damage disrupts a strategic crude route',
    contributions: [{ asset: 'OIL', bias: 'Bullish', score: 1, role: 'DIRECT', reason: 'confirmed crude route disruption' }],
    supportingGuids: ['guid-principal'],
    confirmationGuids: [],
};

const same = resolveCanonicalPrincipal({
    relation: 'SAME_EVENT',
    eventDuplicateOf: 'guid-principal',
    headline: 'Tanker damage disrupts Hormuz crude shipping, sources say',
    themeId: 'theme-route',
    eventType: 'OIL_SUPPLY',
    fundamentalCause: 'Confirmed tanker damage disrupts a strategic crude route',
}, [principal]);
assert.equal(same.valid, true);
assert.equal(same.principalEventId, 'event-principal');
assert.equal(same.relation, 'SAME_EVENT');

const update = resolveCanonicalPrincipal({
    relation: 'EVENT_UPDATE',
    headline: 'Confirmed tanker damage disrupts Hormuz crude shipping, route remains blocked',
    themeId: 'theme-route',
    eventType: 'OIL_SUPPLY',
    fundamentalCause: 'Confirmed tanker damage keeps the strategic crude route blocked',
    currentContributions: principal.contributions,
}, [principal]);
assert.equal(update.valid, true);
assert.equal(update.principalEventId, 'event-principal');

const sameThemeFallback = resolveCanonicalPrincipal({
    relation: 'SAME_EVENT',
    headline: 'Sources restate the diplomatic call around the route situation',
    themeId: 'theme-route',
    eventType: 'OIL_SUPPLY',
}, [principal]);
assert.equal(sameThemeFallback.valid, true);
assert.equal(sameThemeFallback.principalEventId, 'event-principal');
assert.equal(sameThemeFallback.matchedBy, 'theme_candidate');

const reactionFallback = resolveCanonicalPrincipal({
    relation: 'PRICE_REACTION',
    headline: 'WTI crude settles higher after the earlier shipping shock',
    eventType: 'PRICE_REACTION',
}, [principal]);
assert.equal(reactionFallback.valid, true);
assert.equal(reactionFallback.principalEventId, 'event-principal');
assert.equal(reactionFallback.relation, 'PRICE_REACTION');

const nearTermDetail = resolveCanonicalPrincipal({
    relation: 'NEW_EVENT',
    headline: 'UKMTO: vessel hit during outbound transit of Strait of Hormuz',
    themeId: 'theme-route',
    eventType: 'OIL_SUPPLY',
    fundamentalCause: 'Confirmed vessel incident disrupts a strategic crude route',
    currentContributions: [{ asset: 'OIL', bias: 'Bullish', score: 0.5, role: 'DIRECT', reason: 'route disruption' }],
    publishedAt: '2026-08-18T07:11:00+04:00',
}, [{ ...principal, lastSeenAt: '2026-08-18T07:10:00+04:00' }]);
assert.equal(nearTermDetail.valid, true);
assert.equal(nearTermDetail.principalEventId, 'event-principal');
assert.equal(nearTermDetail.relation, 'EVENT_UPDATE');

const missing = resolveCanonicalPrincipal({
    relation: 'REVERSAL',
    eventDuplicateOf: 'event-does-not-exist',
    headline: 'The route is reopening',
}, [principal]);
assert.equal(missing.valid, true);
assert.equal(missing.relation, 'IRRELEVANT');
assert.equal(missing.principalEventId, null);

const independent = resolveCanonicalPrincipal({
    relation: 'NEW_EVENT',
    headline: 'RBA signals a separate policy tightening cycle',
    themeId: 'theme-rba',
    eventType: 'CENTRAL_BANK',
    fundamentalCause: 'RBA signals a separate policy tightening cycle',
}, [principal]);
assert.equal(independent.valid, true);
assert.equal(independent.relation, 'NEW_EVENT');
assert.equal(independent.principalEventId, null);

const signMismatch = normalizeAiClassification({
    category: 'DRIVER',
    impact: 'Medium',
    assets: [{ asset: 'USD', bias: 'Bearish', score: 0.5, role: 'DIRECT', reason: 'supports a stronger dollar' }],
    eventRelation: 'NEW_EVENT',
    eventType: 'RATE_REPRICING',
    fundamentalCause: 'Higher US yields support the dollar',
    transmissionReason: 'yield repricing directly supports USD',
    catalystEligible: true,
    confidence: 0.9,
}, 0);
assert(signMismatch);
assert.equal(signMismatch!.signValidationStatus, 'FAILED');
assert.equal(signMismatch!.currentAssetContributions.length, 0);

const conditional = normalizeAiClassification({
    category: 'GEOPOLITICAL',
    impact: 'High',
    assets: [{ asset: 'OIL', bias: 'Bullish', score: 1, role: 'DIRECT', reason: 'possible disruption if plans proceed' }],
    eventRelation: 'NEW_EVENT',
    eventType: 'OIL_SUPPLY',
    fundamentalCause: 'Japan mulls preparatory tanker insurance support',
    transmissionReason: 'possible shipping risk only',
    counterEvidence: ['unconfirmed preparation'],
    catalystEligible: true,
    confidence: 0.9,
}, 0);
assert(conditional);
assert.equal(conditional!.currentAssetContributions.length, 0, 'conditional preparation must remain watch/evidence-only');
assert.equal(conditional!.catalystEligible, false);

const board = reconstructCanonicalCatalyst([
    { ...principal, eventId: 'event-a', themeId: 'theme-a', relation: 'NEW_EVENT', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, fundamentalCause: null, observedMarketReaction: null, transmissionReason: null, firstSeenAt: '', lastSeenAt: '', confirmationGuids: [], counterEvidence: [] },
    { ...principal, eventId: 'event-b', themeId: 'theme-b', relation: 'NEW_EVENT', status: 'REVERSED', valid: true, independent: true, catalystEligible: true, fundamentalCause: null, observedMarketReaction: null, transmissionReason: null, firstSeenAt: '', lastSeenAt: '', confirmationGuids: [], counterEvidence: [] },
]);
assert.equal(board.get('OIL')?.driverScore, 1, 'reversed principals must not remain in active arithmetic');

console.log(JSON.stringify({ principalResolution: 'PASS', noMintOnMissingPrincipal: 'PASS', signAndConditionalGates: 'PASS', reversalArithmetic: 'PASS' }));
