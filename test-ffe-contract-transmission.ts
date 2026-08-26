import assert from 'node:assert/strict';
import {
    deriveContractTransmission,
    deriveGeoRiskPremium,
    deriveYieldRepricingDriver,
    TRACKED_ASSETS,
    type ClassifiedAsset,
} from './src/services/groqClassifier.service.js';
import { reconstructCanonicalCatalyst } from './src/services/canonicalThemeRegistry.service.js';

/**
 * Proves the deterministic FFE contract-transmission layer is correct and reconstructable
 * independent of the probabilistic classifier. The model only classifies the fundamental cause
 * family / geo state / confirmed-vs-conditional; application code applies the contract transmission
 * table (client contract §12–§24) and the board reconstructs exactly.
 */

const map = (assets: ClassifiedAsset[] | undefined) => {
    const m = new Map<string, number>();
    for (const a of assets ?? []) m.set(a.asset, a.score);
    return m;
};

// (1) Confirmed crude supply / strategic-route disruption (Hormuz vessel hit + casualty).
const oil = deriveContractTransmission({
    category: 'GEOPOLITICAL',
    eventType: 'GEOPOLITICAL',
    geoState: 'ESCALATION',
    headline: 'UKMTO: vessel hit by projectile during outbound Strait of Hormuz transit causing engine room damage and crew casualty; tanker route disruption',
    evidenceText: 'confirmed operational crude shipping-route disruption in the strait of hormuz',
    conditional: false,
    directShock: true,
    modelAssets: [],
});
assert.ok(oil, 'confirmed crude-route disruption must produce an OIL supply driver');
assert.equal(oil!.family, 'OIL_SUPPLY_SHOCK');
{
    const m = map(oil!.contributions);
    assert.equal(m.get('OIL'), 1, 'major confirmed route disruption → OIL +1');
    assert.equal(m.get('CAD'), 1, 'sustained oil shock → CAD +1');
    assert.equal(m.get('JPY'), -0.5, 'oil importer channel → JPY -0.5');
    assert.equal(m.get('EUR'), -0.25, 'oil importer/growth channel → EUR -0.25');
    assert.ok(!m.has('USD'), 'oil supply driver does not directly score USD');
}

// (2) Systemic geopolitical escalation is scored ONCE at regime level (§24, §35), never per headline
//     (a per-headline geo currency contribution let the oil branch shadow it and inverted the sign).
const perHeadlineGeo = deriveContractTransmission({
    category: 'GEOPOLITICAL',
    eventType: 'GEOPOLITICAL',
    geoState: 'ESCALATION',
    headline: 'Confirmed missile strikes and air defence interception across the Gulf; systemic Middle-East military escalation',
    evidenceText: 'confirmed systemic regional military escalation',
    conditional: false,
    directShock: true,
    modelAssets: [],
});
assert.equal(perHeadlineGeo, null, 'systemic geo currency must NOT be scored per headline; it is a regime-level driver');

const geo = deriveGeoRiskPremium({ score: 0.75, escalationCount: 4, deEscalationCount: 1, confirmed: true });
assert.ok(geo, 'confirmed escalation-dominant HIGH-risk regime must produce the geo risk-premium driver');
assert.equal(geo!.family, 'GEO_RISK_PREMIUM');
{
    const m = map(geo!.contributions);
    assert.equal(m.get('USD'), 0.5, 'systemic geo regime → USD +0.5');
    assert.equal(m.get('CHF'), 0.5, 'systemic geo regime → CHF +0.5');
    assert.equal(m.get('EUR'), -0.25, 'systemic geo regime → EUR -0.25');
    assert.equal(m.get('GBP'), -0.25, 'systemic geo regime → GBP -0.25');
    assert.equal(m.get('AUD'), -0.5, 'systemic geo regime → AUD -0.5');
    assert.equal(m.get('NZD'), -0.5, 'systemic geo regime → NZD -0.5');
    assert.ok(!m.has('CAD'), 'CAD receives no independent geopolitical score');
    assert.ok(!m.has('JPY'), 'JPY receives no automatic geo haven score');
}

// A sub-elevated regime (score < 0.41) carries no currency premium.
assert.equal(deriveGeoRiskPremium({ score: 0.3, escalationCount: 1, deEscalationCount: 0, confirmed: true }), null, 'sub-elevated regime (score < 0.41) → no geo premium');
// Regime score already embeds de-escalation deductions — count-majority must not block premium.
assert.ok(deriveGeoRiskPremium({ score: 0.55, escalationCount: 1, deEscalationCount: 3, confirmed: true }), 'elevated net regime score transmits even when de-esc count exceeds esc count');

// (3) Confirmed US-yield / Fed hawkish repricing.
const yld = deriveContractTransmission({
    category: 'DRIVER',
    eventType: 'YIELD_REPRICING',
    geoState: 'IRRELEVANT',
    headline: 'US Treasury yields reprice sharply higher as the Fed signals higher-for-longer; hawkish repricing',
    evidenceText: 'us treasury real yields repriced higher, hawkish fed',
    conditional: false,
    directShock: true,
    modelAssets: [{ asset: 'USD', bias: 'Bullish', score: 0.5 }],
});
assert.ok(yld, 'confirmed US-yield repricing must produce a rate driver');
assert.equal(yld!.family, 'RATE_YIELD_REPRICING');
{
    const m = map(yld!.contributions);
    assert.equal(m.get('USD'), 0.5, 'hawkish US repricing → USD +0.5');
    assert.equal(m.get('GOLD'), -0.5, 'higher US real yields → GOLD -0.5');
}

// (3b) US / long-end yield-repricing driver derived only from accepted ACTIVE canonical evidence.
{
    assert.equal(
        deriveYieldRepricingDriver([
            { headline: 'Deutsche Bank: Middle East Stalemate Pushes Oil and Long-End Yields Higher - FJElite', eventType: 'COMMENTARY', category: 'DRIVER', eventRelation: 'HISTORICAL_COMMENTARY', status: 'ACTIVE', valid: true, catalystEligible: true },
            { headline: 'Secured overnight financing rate: 3.66% August 17th vs 3.62% August 14th', category: 'ECONOMIC', eventRelation: 'IRRELEVANT', status: 'EVIDENCE_ONLY', valid: false, catalystEligible: false },
        ]),
        null,
        'commentary + SOFR alone must not create the US yield driver',
    );

    const confirmed = deriveYieldRepricingDriver([
        {
            headline: 'US Treasury yields reprice sharply higher as the Fed signals higher-for-longer; hawkish repricing',
            eventType: 'YIELD_REPRICING',
            category: 'DRIVER',
            contractFamily: 'RATE_YIELD_REPRICING',
            eventRelation: 'NEW_EVENT',
            status: 'ACTIVE',
            valid: true,
            catalystEligible: true,
            eventId: 'event_yield_1',
        },
    ]);
    assert.ok(confirmed, 'accepted canonical US yield repricing must produce a yield driver');
    assert.equal(confirmed!.family, 'RATE_YIELD_REPRICING');
    assert.equal(confirmed!.direction, 'HAWKISH');
    const m = map(confirmed!.contributions);
    assert.equal(m.get('USD'), 0.5, 'yields higher → USD +0.5');
    assert.equal(m.get('GOLD'), -0.5, 'yields higher → GOLD -0.5');

    assert.equal(deriveYieldRepricingDriver([{ headline: 'UK 10 Yr Gilt Yield Actual 5.155% (Forecast -, Previous 5.04%)', eventType: 'MACRO_RELEASE', category: 'ECONOMIC', eventRelation: 'MACRO_RELEASE', status: 'ACTIVE', valid: true, catalystEligible: true }]), null, 'a lone gilt print does not create the US yield driver');
    assert.equal(deriveYieldRepricingDriver([{ headline: 'Fed Interest Rate Probabilities', eventRelation: 'FORECAST_UPCOMING', category: 'DRIVER', status: 'ACTIVE', valid: true, catalystEligible: true }]), null, 'probability table is not a confirmed yield repricing');
    const lower = deriveYieldRepricingDriver([{
        headline: 'US Treasury real yields fall sharply as Fed signals cuts; long-end yields lower',
        eventType: 'YIELD_REPRICING',
        category: 'DRIVER',
        contractFamily: 'RATE_YIELD_REPRICING',
        eventRelation: 'NEW_EVENT',
        status: 'ACTIVE',
        valid: true,
        catalystEligible: true,
    }]);
    assert.ok(lower);
    assert.equal(lower!.direction, 'DOVISH');
    assert.equal(map(lower!.contributions).get('USD'), -0.5, 'yields lower → USD -0.5');
    assert.equal(map(lower!.contributions).get('GOLD'), 0.5, 'yields lower → GOLD +0.5');
}

// (4) Conditional/preparatory evidence ("mulls / sources") must NOT get a strong contract driver.
const conditional = deriveContractTransmission({
    category: 'GEOPOLITICAL',
    eventType: 'GEOPOLITICAL',
    geoState: 'WATCH',
    headline: 'Japan mulls support for reinsurance on oil tankers - Sources',
    evidenceText: 'japan mulls tanker reinsurance support; attributed to sources, not confirmed',
    conditional: true,
    directShock: false,
    modelAssets: [],
});
assert.equal(conditional, null, 'conditional "mulls/sources" evidence must not synthesize a contract driver');

// (5) Full decomposition reconstructs the client acceptance board exactly.
const drivers = [
    { eventId: 'e_oil', themeId: 'OIL_SUPPLY_SHOCK', contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: oil!.contributions },
    { eventId: 'e_geo', themeId: 'GEO_RISK_PREMIUM', contractFamily: 'GEO_RISK_PREMIUM', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: geo!.contributions },
    { eventId: 'e_yld', themeId: 'RATE_YIELD_REPRICING', contractFamily: 'RATE_YIELD_REPRICING', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: yld!.contributions },
];
const board = reconstructCanonicalCatalyst(drivers);
const score = (asset: string) => board.get(asset as (typeof TRACKED_ASSETS)[number])?.driverScore ?? 0;
const expected: Record<string, number> = {
    USD: 1.0, EUR: -0.5, GBP: -0.25, JPY: -0.5, CHF: 0.5, CAD: 1.0, AUD: -0.5, NZD: -0.5, GOLD: -0.5, OIL: 1.0,
};
for (const [asset, want] of Object.entries(expected)) {
    assert.equal(score(asset), want, `reconstructed ${asset} must equal client-methodology ${want}, got ${score(asset)}`);
}

console.log('PASS — deterministic contract transmission reconstructs the client acceptance board from three canonical drivers, and conditional evidence is gated.');
