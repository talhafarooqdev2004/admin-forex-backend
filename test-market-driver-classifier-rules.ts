import assert from 'node:assert/strict';
import {
    CATALYST_CURRENCIES,
    isBoardVisibleClassification,
    likelySameEvent,
    sanitizeClassification,
    type ClassifiedAsset,
    type NewsCategory,
    type NewsImpact,
} from './src/services/groqClassifier.service.ts';
import {
    aggregateUniqueCausalThemes,
    inferGeoState,
    isEconomicReleaseHeadline,
} from './src/services/ffeDecisionEngine.service.ts';
import { calculateGeopoliticalRisk } from './src/services/geopoliticalRisk.service.ts';

const DRIFT = {
    category: 'IRRELEVANT' as NewsCategory,
    impact: 'Low' as NewsImpact,
    assets: [] as ClassifiedAsset[],
    summary: '',
};

function classify(headline: string, input = DRIFT) {
    return sanitizeClassification(headline, input);
}

function scoreOf(result: ReturnType<typeof classify>, asset: string) {
    return result.assets.find((row) => row.asset === asset)?.score;
}

function assertScore(headline: string, asset: string, expected: number) {
    const result = classify(headline);
    assert.equal(scoreOf(result, asset), expected, headline);
    assert.equal(isBoardVisibleClassification(result), expected !== 0, headline);
    for (const row of result.assets) assert.ok(CATALYST_CURRENCIES.includes(row.asset as never));
}

console.log('=== FFE deterministic decision-layer rules ===');

// Cause-first sign validation.
assertScore('United States Dollar Index weakens as traders push back Fed rate hike bets', 'USD', -0.5);
assertScore('Fed signals rates may remain higher for longer', 'USD', 0.5);
assertScore('Japanese Yen: Intervention risks cap losses against US Dollar – OCBC', 'JPY', 0.25);

// Economic evidence remains persisted Macro-only, never Catalyst-visible.
const economic = classify('US CPI Actual 3.1% Forecast 3.0% Previous 2.9%');
assert.equal(isEconomicReleaseHeadline('US CPI Actual 3.1% Forecast 3.0% Previous 2.9%'), true);
assert.equal(economic.category, 'ECONOMIC');
assert.equal(economic.assets.length, 0);
assert.equal(isBoardVisibleClassification(economic), false);
assert.equal(classify('China Retail Sales Actual 0.6% Forecast 1.5% Previous 1.0%').category, 'ECONOMIC');

// Direct commodity transmission and broad risk mapping are separate decisions.
const geo = classify('Confirmed missile strikes disrupt Hormuz shipping and trigger broad risk-off flows');
assert.equal(geo.category, 'GEOPOLITICAL');
assert.equal(scoreOf(geo, 'OIL'), 0.75);
assert.equal(scoreOf(geo, 'GOLD'), 0.5);
assert.equal(scoreOf(geo, 'USD'), 0.5);
assert.equal(scoreOf(geo, 'CHF'), 0.5);
assert.equal(scoreOf(geo, 'AUD'), -0.5);
assert.equal(scoreOf(geo, 'NZD'), -0.5);

const deEscalation = classify('Hormuz shipping reopens after a confirmed ceasefire agreement');
assert.equal(deEscalation.category, 'GEOPOLITICAL');
assert.equal(scoreOf(deEscalation, 'OIL'), -0.25);
assert.equal(scoreOf(deEscalation, 'GOLD'), -0.25);
assert.equal(scoreOf(deEscalation, 'USD'), undefined);
assert.equal(inferGeoState('Officials meet for difficult Iran talks without an agreement'), 'WATCH');
assert.equal(classify('Officials meet for difficult Iran talks without an agreement').category, 'GEOPOLITICAL');

// General causal families and collision safety: same theme is not an event duplicate.
assert.equal(likelySameEvent('China Retail Sales Actual 0.6% Forecast 1.5%', 'China Industrial Output Actual 4.5% Forecast 5.0%'), false);
const aggregates = aggregateUniqueCausalThemes([
    { headline: 'Fed hike bets fall', causalThemeId: 'FED_DOVISH_REPRICING', assets: [{ asset: 'USD', bias: 'Bearish', score: -0.5 }] },
    { headline: 'Treasury yields fall', causalThemeId: 'US_YIELD_REPRICING', assets: [{ asset: 'USD', bias: 'Bearish', score: -0.25 }] },
    { headline: 'Same Fed wire copy', causalThemeId: 'FED_DOVISH_REPRICING', assets: [{ asset: 'USD', bias: 'Bearish', score: -0.5 }] },
]);
assert.deepEqual(aggregates.get('USD'), {
    bullishCount: 0,
    bearishCount: 2,
    driverScore: -0.75,
    themes: ['FED_DOVISH_REPRICING', 'US_YIELD_REPRICING'],
});

// Geo risk uses a dominant canonical theme with bounded metrics, never headline count/prices.
const geoResult = calculateGeopoliticalRisk([
    { headline: 'Missile strike threatens Hormuz shipping', impact: 'High', summary: null, assets: [{ asset: 'OIL', score: 1 }], published_at: new Date('2026-08-17T10:00:00Z'), created_at: new Date('2026-08-17T10:00:00Z'), causal_theme_id: 'HORMUZ_SUPPLY_RISK', geo_state: 'ESCALATION', geo_components: { energyHormuzRisk: 0.1 } },
    { headline: 'Same Hormuz incident reported by another wire', impact: 'High', summary: null, assets: [{ asset: 'OIL', score: 1 }], published_at: new Date('2026-08-17T10:01:00Z'), created_at: new Date('2026-08-17T10:01:00Z'), causal_theme_id: 'HORMUZ_SUPPLY_RISK', geo_state: 'ESCALATION', geo_components: { energyHormuzRisk: 0.1 } },
]);
assert.equal(geoResult.eventCount, 1);
assert.equal(geoResult.components.energyHormuzRisk, 0.1);
assert.equal(geoResult.score, 0.31);
assert.equal(geoResult.band, 'Watch');

console.log('All FFE deterministic decision-layer checks passed.');
