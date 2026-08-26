import assert from 'node:assert/strict';
import { resolveCanonicalPrincipal } from './src/services/canonicalThemeRegistry.service.js';
import { deriveCommodityInventoryTransmission, deriveGeoRiskPremium } from './src/services/groqClassifier.service.js';
import { acceptDriverContributions, inferDriverChannel } from './src/services/ffeSemanticChannel.service.js';
import { reconstructFfeCatalystBoard } from './src/services/ffeCatalystReconstruction.service.js';

// 1. TRADE DE-ESCALATION — Country A/B tariff suspension; unrelated geo must not merge.
{
    const prior = [{
        id: 'event_trade_1', themeId: 'NORWAY_SWEDEN_TARIFF_PAUSE', relation: 'NEW_EVENT', status: 'ACTIVE',
        valid: true, independent: true, catalystEligible: true, eventType: 'GEOPOLITICAL',
        headline: 'Oslo suspends retaliatory tariffs on Stockholm industrial goods for 90 days',
        fundamentalCause: 'Bilateral trade friction eases', contributions: [{ asset: 'EUR', score: 0.25, bias: 'Bullish' }],
        supportingGuids: ['g1'], confirmationGuids: [], firstSeenAt: '2026-08-19T10:00:00+04:00', lastSeenAt: '2026-08-19T10:00:00+04:00',
    }];
    const unrelated = resolveCanonicalPrincipal({
        relation: 'HISTORICAL_COMMENTARY',
        headline: 'Berlin factory output unchanged despite regional tensions',
        themeId: 'EUROPE_INDUSTRIAL_OUTPUT',
        eventType: 'GEOPOLITICAL',
        publishedAt: '2026-08-19T10:30:00+04:00',
    }, prior);
    assert.notEqual(unrelated.principalEventId, 'event_trade_1', 'unrelated industrial headline must not merge into trade driver');

    const tradeCad = acceptDriverContributions({
        eventId: 'event_trade_cad', themeId: 'NORWAY_SWEDEN_TARIFF_PAUSE', contractFamily: null,
        status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
        headline: 'Oslo suspends retaliatory tariffs on Stockholm industrial goods',
        eventRelation: 'NEW_EVENT',
        contributions: [{ asset: 'CAD', score: 0.5, bias: 'Bullish', reason: 'Trade relief supports CAD via NAFTA-analogue channel' }],
    });
    assert.equal(tradeCad.find((c) => c.asset === 'CAD')?.score, 0.5, 'TRADE_POLICY CAD must not be stripped by commodity logic');
    assert.equal(inferDriverChannel({ headline: 'Oslo suspends retaliatory tariffs', themeId: 'TRADE', contributions: tradeCad }), 'TRADE_POLICY');
}

// 2. GEO REGIME VS COUNTING — score governs, not theme count.
assert.ok(
    deriveGeoRiskPremium({ score: 0.55, escalationCount: 1, deEscalationCount: 4, confirmed: true }),
    'one severe persistent escalation with net score 0.55 must transmit geo premium',
);
assert.equal(
    deriveGeoRiskPremium({ score: 0.25, escalationCount: 5, deEscalationCount: 0, confirmed: true }),
    null,
    'sub-elevated net score must not transmit',
);

// 3. COMMODITY INVENTORY — generic wording, no agency name required.
{
    const build = deriveCommodityInventoryTransmission({
        headline: 'National petroleum stockpile report: inventories Actual 12.5M (Forecast 8.0M, Previous 9.1M)',
    });
    assert.ok(build, 'large inventory build vs forecast must create inventory driver');
    assert.equal(build!.family, 'COMMODITY_INVENTORY_SHOCK');
    assert.ok((build!.contributions.find((c) => c.asset === 'OIL')?.score ?? 0) < 0, 'build vs forecast → bearish oil');

    const draw = deriveCommodityInventoryTransmission({
        headline: 'Crude storage levels Actual -2.1M (Forecast 0.5M, Previous 1.0M)',
    });
    assert.ok(draw);
    assert.ok((draw!.contributions.find((c) => c.asset === 'OIL')?.score ?? 0) > 0, 'draw vs forecast → bullish oil');

    assert.equal(
        deriveCommodityInventoryTransmission({ headline: 'Crude storage levels Actual 1.0M (Forecast -, Previous 1.0M)' }),
        null,
        'no forecast → no surprise driver',
    );
}

// 4. REFINERY / SUPPLY DIRECTNESS — model-validated OIL family passes channel acceptance.
{
    const watch = acceptDriverContributions({
        eventId: 'e1', contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
        headline: 'Minor smoke reported near coastal refinery; operations continue normally',
        eventRelation: 'NEW_EVENT', contributions: [{ asset: 'OIL', score: 0.5, bias: 'Bullish' }],
    });
    assert.equal(watch.length, 1, 'valid OIL_SUPPLY_SHOCK family contributions accepted by channel layer');

    const confirmed = acceptDriverContributions({
        eventId: 'e2', contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
        headline: 'Confirmed outage shuts 200kbd refinery processing unit after explosion',
        eventRelation: 'NEW_EVENT', contributions: [{ asset: 'OIL', score: 1, bias: 'Bullish' }],
    });
    assert.equal(confirmed.find((c) => c.asset === 'OIL')?.score, 1);
}

// 5. STRATEGIC ROUTE — Bab el-Mandeb (not Hormuz); restoration weakens same channel.
{
    const route = acceptDriverContributions({
        eventId: 'route1', contractFamily: 'OIL_SUPPLY_SHOCK', themeId: 'RED_SEA_ROUTE_RISK', status: 'ACTIVE',
        valid: true, independent: true, catalystEligible: true,
        headline: 'Confirmed projectile strike interrupts Bab el-Mandeb transit for crude tankers',
        eventRelation: 'NEW_EVENT', contributions: [{ asset: 'OIL', score: 1, bias: 'Bullish' }],
    });
    assert.equal(route.find((c) => c.asset === 'OIL')?.score, 1);

    const restore = acceptDriverContributions({
        eventId: 'route1', contractFamily: 'OIL_SUPPLY_SHOCK', themeId: 'RED_SEA_ROUTE_RISK', status: 'ACTIVE',
        valid: true, independent: true, catalystEligible: true,
        headline: 'Traffic through Bab el-Mandeb resumes after clearance operation',
        eventRelation: 'EVENT_UPDATE', contributions: [{ asset: 'OIL', score: -0.5, bias: 'Bearish' }],
    });
    assert.ok((restore.find((c) => c.asset === 'OIL')?.score ?? 0) < 0);
}

// 6. CENTRAL-BANK GUIDANCE — commentary zeroed via reaction relation gate.
{
    const guidance = acceptDriverContributions({
        eventId: 'cb1', contractFamily: 'RATE_YIELD_REPRICING', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
        headline: 'Norges Bank Governor signals another hike if inflation persists',
        eventType: 'CENTRAL_BANK', eventRelation: 'NEW_EVENT',
        contributions: [{ asset: 'EUR', score: 0.5, bias: 'Bullish' }],
    });
    assert.equal(guidance.find((c) => c.asset === 'EUR')?.score, 0.5);

    const commentary = acceptDriverContributions({
        eventId: 'cb2', status: 'WATCH', valid: true, independent: false, catalystEligible: false,
        headline: 'Analyst note: Norges Bank may hike', eventRelation: 'HISTORICAL_COMMENTARY',
        contributions: [{ asset: 'EUR', score: 0.5, bias: 'Bullish' }],
    });
    assert.equal(commentary.length, 0, 'commentary relation cannot board-contribute');
}

// 7. REACTION VS CAUSE — price reaction relation blocked.
assert.equal(
    acceptDriverContributions({
        eventId: 'rx1', status: 'WATCH', valid: true, independent: false, catalystEligible: false,
        eventRelation: 'PRICE_REACTION', contributions: [{ asset: 'GOLD', score: 0.5, bias: 'Bullish' }],
        headline: 'Gold rises after earlier Middle East escalation',
    }).length,
    0,
);

// 8. UNKNOWN NOVEL CAUSE — OTHER_FUNDAMENTAL channel with valid driver.
{
    const novel = acceptDriverContributions({
        eventId: 'novel1', contractFamily: 'OTHER_FUNDAMENTAL', themeId: 'RARE_EARTH_EXPORT_QUOTA', status: 'ACTIVE',
        valid: true, independent: true, catalystEligible: true, eventRelation: 'NEW_EVENT',
        headline: 'Ministry imposes new export quota on processed rare-earth magnets',
        contributions: [{ asset: 'AUD', score: 0.25, bias: 'Bearish', reason: 'Industrial input cost channel' }],
    });
    assert.equal(novel.find((c) => c.asset === 'AUD')?.score, 0.25);
}

// Board reconstruction: trade + geo premium coexist; CAD preserved.
{
    const { board } = reconstructFfeCatalystBoard([
        {
            eventId: 'trade1', themeId: 'NORWAY_SWEDEN_TARIFF', contractFamily: null, status: 'ACTIVE',
            valid: true, independent: true, catalystEligible: true, eventRelation: 'NEW_EVENT',
            headline: 'Oslo suspends retaliatory tariffs on Stockholm',
            contributions: [{ asset: 'CAD', score: 0.5, bias: 'Bullish' }, { asset: 'USD', score: -0.25, bias: 'Bearish' }],
            supportingGuids: ['t1'],
        },
    ], {
        dominantTheme: 'MIDDLE_EAST_ESCALATION', score: 0.55, band: 'Elevated', eventCount: 2,
        escalationThemes: ['MIDDLE_EAST_ESCALATION'], deEscalationThemes: ['DIPLOMACY_A', 'DIPLOMACY_B', 'DIPLOMACY_C'],
    });
    const cad = board.find((r) => r.asset === 'CAD')?.driverScore ?? 0;
    const usd = board.find((r) => r.asset === 'USD')?.driverScore ?? 0;
    assert.equal(cad, 0.5, 'CAD trade contribution survives reconstruction');
    assert.equal(usd, 0.25, 'USD gets trade -0.25 plus geo +0.5 net if geo premium active');
}

console.log('PASS — semantic generalization suite (8 categories)');
