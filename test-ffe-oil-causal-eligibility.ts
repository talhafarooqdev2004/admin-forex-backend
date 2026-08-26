import assert from 'node:assert/strict';
import {
    assessOilCausalEligibility,
    applyOilCausalEligibility,
    HORMUZ_THEME,
    stripOilChannelContributions,
} from './src/services/oilCausalEligibility.service.js';
import { collapseCanonicalDrivers, collapseGroupKey } from './src/services/canonicalThemeRegistry.service.js';

const oilContrib = [
    { asset: 'OIL' as const, bias: 'Bullish' as const, score: 1 },
    { asset: 'CAD' as const, bias: 'Bullish' as const, score: 1 },
    { asset: 'JPY' as const, bias: 'Bearish' as const, score: -0.5 },
    { asset: 'EUR' as const, bias: 'Bearish' as const, score: -0.25 },
];

// Confirmed Hormuz operational shock qualifies.
{
    const a = assessOilCausalEligibility({
        headline: 'UKMTO: vessel hit by unknown projectile during outbound transit of Strait of Hormuz',
        themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        eventRelation: 'EVENT_UPDATE',
        status: 'ACTIVE',
    });
    assert.equal(a.eligible, true);
    assert.equal(a.hormuzCluster, true);
    assert.equal(a.collapseTheme, HORMUZ_THEME);
}

// Hormuz diplomacy updates the same cluster — not a separate driver.
{
    const a = assessOilCausalEligibility({
        headline: 'Turkish foreign minister on efforts to open Strait of Hormuz, continue U.S.-Iran ceasefire in call with Iranian counterpart',
        themeId: 'GEO_TURKEY_US_MIDDLE_EAST_TALKS',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        eventRelation: 'NEW_EVENT',
        status: 'ACTIVE',
    });
    assert.equal(a.eligible, true);
    assert.equal(a.hormuzCluster, true);
    assert.equal(a.collapseTheme, HORMUZ_THEME);
}

// Generic Turkey–US diplomacy without Hormuz/crude channel → OIL 0.
{
    const stripped = applyOilCausalEligibility({
        headline: 'UAE President and Trump discuss region in a phone call - WAM.',
        themeId: 'Turkey–US high-level talks on Middle East conflicts and defense cooperation',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        eventRelation: 'EVENT_UPDATE',
        status: 'ACTIVE',
        contributions: [...oilContrib],
    });
    assert.equal(stripped.contributions.find((c) => c.asset === 'OIL')?.score ?? 0, 0);
    assert.equal(stripped.contributions.length, 0);
}

// Conditional reinsurance mulls → no active oil.
assert.equal(
    assessOilCausalEligibility({
        headline: 'Japan mulls support for reinsurance on oil tankers - Sources',
        themeId: 'Tanker risk/reinsurance consideration',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    }).eligible,
    false,
);

// Commentary → no oil.
assert.equal(
    assessOilCausalEligibility({
        headline: 'Deutsche Bank: Middle East Stalemate Pushes Oil and Long-End Yields Higher - FJElite',
        eventType: 'COMMENTARY',
        eventRelation: 'HISTORICAL_COMMENTARY',
        status: 'ACTIVE',
    }).eligible,
    false,
);

// Hormuz traffic restoration — boats transiting the strait.
{
    const a = assessOilCausalEligibility({
        headline: 'Trump: We had a lot of boats come through Hormuz last night.',
        themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    });
    assert.equal(a.eligible, true);
    assert.equal(a.channel, 'RESTORATION');
}

// Marine traffic missile threat qualifies as a route shock.
{
    const a = assessOilCausalEligibility({
        headline: "UAE's Defense Ministry: The 2 ballistic missiles launched from Iran were targeting marine traffic.",
        themeId: 'OIL_SUPPLY_SHOCK_ROUTE_SHIPPING_THREAT',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    });
    assert.equal(a.eligible, true);
    assert.equal(a.channel, 'SHIPPING_ROUTE');
}

assert.equal(
    assessOilCausalEligibility({
        headline: "Warehouse of Russia's Wildberries struck in drone attack on Moscow region: governor",
        themeId: 'GEO_KURSK_NK_TROOPS_ESCALATION',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    }).eligible,
    false,
);

// Dubai missile alert → no direct crude channel.
assert.equal(
    assessOilCausalEligibility({
        headline: 'Dubai residents get UAE missile threat alert.',
        themeId: 'GEO_UAE_MISSILE_ATTACK_UNCONFIRMED',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    }).eligible,
    false,
);

// Confirmed refinery/supply attack may form a separate direct cause.
{
    const a = assessOilCausalEligibility({
        headline: "Russia: Hit fuel tanks at Ukraine's port of Odesa - IFX",
        themeId: 'RUSSIA_UKRAINE_OPERATIONAL_STRIKE_RISK',
        contractFamily: 'OIL_SUPPLY_SHOCK',
        status: 'ACTIVE',
    });
    assert.equal(a.eligible, true);
    assert.equal(a.channel, 'SUPPLY_DISRUPTION');
    assert.notEqual(a.collapseTheme, HORMUZ_THEME);
}

// Two Hormuz-normalized events collapse to one driver.
const hormuzA = applyOilCausalEligibility({
    eventId: 'h1', headline: 'UKMTO: report received of incident in Strait of Hormuz', themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION',
    contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: [...oilContrib],
});
const hormuzB = applyOilCausalEligibility({
    eventId: 'h2', headline: 'Qatar foreign ministry spokesperson: Mediators are waiting for Oman and Iran', themeId: 'GEO_QATAR_US_IRAN',
    contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true,
    contributions: [{ asset: 'OIL', bias: 'Bearish', score: -0.5 }, { asset: 'CAD', bias: 'Bearish', score: -0.5 }],
});
assert.equal(hormuzA.themeId, HORMUZ_THEME);
assert.equal(hormuzB.themeId, HORMUZ_THEME);
assert.equal(collapseGroupKey(hormuzA), collapseGroupKey(hormuzB));
const collapsed = collapseCanonicalDrivers([hormuzA, hormuzB]);
assert.equal(collapsed.length, 1, 'Hormuz operational + diplomacy updates collapse to one oil driver');
assert.equal(collapsed[0]!.contributions.find((c) => c.asset === 'OIL')!.score, 1, 'net bullish Hormuz route wins at magnitude 1');

assert.equal(stripOilChannelContributions(oilContrib).length, 0);

console.log('PASS — oil causal eligibility gates direct crude channels and merges Hormuz diplomacy into one route driver.');
