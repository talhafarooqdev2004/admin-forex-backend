import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    collapseCanonicalDrivers,
    collapseGroupKey,
} from './src/services/canonicalThemeRegistry.service.js';
import {
    deriveGeoRiskPremium,
    deriveYieldRepricingDriver,
} from './src/services/groqClassifier.service.js';
import { reconstructFfeCatalystBoard, type CatalystDriverInput } from './src/services/ffeCatalystReconstruction.service.js';

const root = path.resolve(process.cwd(), '..');

type CheckpointDriver = {
    eventId: string;
    themeId: string | null;
    contractFamily: string | null;
    headline: string;
    eventType: string | null;
    relation: string;
    status: string;
    valid: boolean;
    independent: boolean;
    catalystEligible: boolean;
    contributions: CatalystDriverInput['contributions'];
    supportingGuids: string[];
    geoState?: string | null;
};

type ReplayRow = {
    guid: string;
    headline: string;
    category?: string | null;
    eventRelation?: string | null;
    actual?: string | null;
    previous?: string | null;
    geoState?: string | null;
};

function loadArtifact(tag: 'nano-r13' | 'nano-r14') {
    const replay = JSON.parse(fs.readFileSync(path.join(root, 'replay-fixtures', `aug18-financialjuice-client-contract-replay-${tag}.json`), 'utf8')) as { rows: ReplayRow[] };
    const recon = JSON.parse(fs.readFileSync(path.join(root, 'replay-fixtures', `aug18-financialjuice-driver-reconstruction-${tag}.json`), 'utf8')) as {
        finalGeo: { dominantTheme: string | null; score: number; band: string; eventCount: number; escalationThemes: string[]; deEscalationThemes: string[] };
        checkpoints: Array<{ activeDrivers: CheckpointDriver[] }>;
    };
    const rowsByGuid = new Map(replay.rows.map((row) => [row.guid, row]));
    const drivers: CatalystDriverInput[] = (recon.checkpoints.at(-1)?.activeDrivers ?? []).map((driver) => {
        const anchor = rowsByGuid.get(driver.supportingGuids.at(-1) ?? '') ?? rowsByGuid.get(driver.supportingGuids[0] ?? '');
        return {
            eventId: driver.eventId,
            themeId: driver.themeId,
            contractFamily: driver.contractFamily,
            status: driver.status,
            valid: driver.valid,
            independent: driver.independent,
            catalystEligible: driver.catalystEligible,
            contributions: driver.contributions,
            supportingGuids: driver.supportingGuids,
            headline: driver.headline,
            eventType: driver.eventType,
            geoState: driver.geoState ?? anchor?.geoState ?? null,
            eventRelation: driver.relation,
            category: anchor?.category ?? null,
            actual: anchor?.actual ?? null,
            previous: anchor?.previous ?? null,
        };
    });
    return { drivers, geo: recon.finalGeo, replayPath: path.join(root, 'replay-fixtures', `aug18-financialjuice-client-contract-replay-${tag}.json`) };
}

// Unit gates on the proven defects.
assert.equal(
    deriveYieldRepricingDriver([
        { headline: 'Secured overnight financing rate: 3.66% August 17th vs 3.62% August 14th', category: 'ECONOMIC', eventRelation: 'IRRELEVANT', status: 'EVIDENCE_ONLY', valid: false, catalystEligible: false },
        { headline: 'Deutsche Bank: Middle East Stalemate Pushes Oil and Long-End Yields Higher - FJElite', eventType: 'COMMENTARY', eventRelation: 'HISTORICAL_COMMENTARY', status: 'ACTIVE', valid: true, catalystEligible: true },
    ]),
    null,
    'R13/R14 SOFR + bank commentary must not activate yield driver',
);

const oilThemeA = { eventId: 'a', themeId: 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION', contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: [{ asset: 'OIL' as const, bias: 'Bullish' as const, score: 1 }] };
const oilThemeB = { eventId: 'b', themeId: 'GEO_TURKEY_US_MIDDLE_EAST_TALKS', contractFamily: 'OIL_SUPPLY_SHOCK', status: 'ACTIVE', valid: true, independent: true, catalystEligible: true, contributions: [{ asset: 'OIL' as const, bias: 'Bearish' as const, score: -0.5 }] };
assert.notEqual(collapseGroupKey(oilThemeA), collapseGroupKey(oilThemeB), 'oil themes must not share a collapse bucket');
assert.equal(collapseCanonicalDrivers([oilThemeA, oilThemeB]).length, 2, 'distinct oil themes remain separate collapsed drivers');

const geo = deriveGeoRiskPremium({
    score: 0.75,
    escalationCount: 3,
    deEscalationCount: 1,
    confirmed: true,
    supportingThemes: ['GEO_HORMUZ_MIDDLE_EAST_ESCALATION'],
    supportingEventIds: ['event_hormuz'],
    supportingGuids: ['9725182'],
});
assert.ok(geo?.provenance.supportingGuids.includes('9725182'), 'geo premium must persist supporting GUID provenance');

for (const tag of ['nano-r13', 'nano-r14'] as const) {
    const { drivers, geo } = loadArtifact(tag);
    const { board, collapsed, yieldDriver, geoPremium } = reconstructFfeCatalystBoard(drivers, geo);

    assert.equal(yieldDriver, null, `${tag}: yield driver must not activate from frozen artifact evidence`);

    const oilDrivers = collapsed.filter((driver) =>
        driver.key.startsWith('OIL_SUPPLY_SHOCK') || driver.key.startsWith('COMMODITY_INVENTORY_SHOCK'));
    assert.ok(oilDrivers.length <= 4, `${tag}: at most a few direct commodity causes, got ${oilDrivers.length}`);
    for (const oil of oilDrivers) {
        const themes = new Set(oil.key.includes('::') ? [oil.key.split('::')[1]] : [oil.themeId]);
        assert.equal(themes.size, 1, `${tag}: each collapsed oil driver must represent one causal theme`);
    }
    if (tag === 'nano-r14') {
        const hormuz = oilDrivers.find((driver) => driver.key.includes('HORMUZ') || driver.themeId?.includes('HORMUZ'));
        assert.ok(hormuz, 'R14 must retain a Hormuz route oil driver');
        assert.ok(!oilDrivers.some((driver) => /Turkey–US high-level talks|GEO_TURKEY_US_MIDDLE_EAST_TALKS|GEO_KURSK|Dubai|commentary/i.test(driver.themeId ?? driver.key)), 'R14 must not have independent indirect oil drivers');
    }

    assert.ok(geoPremium, `${tag}: geo premium must remain active`);
    assert.ok(geoPremium!.provenance.supportingGuids.length > 0, `${tag}: geo premium must record supporting GUIDs`);
    assert.equal(
        collapsed.find((driver) =>
            driver.key !== 'GEO_RISK_PREMIUM'
            && !driver.key.startsWith('OIL_SUPPLY_SHOCK')
            && !driver.key.startsWith('COMMODITY_INVENTORY_SHOCK')
            && !driver.key.startsWith('RATE_YIELD_REPRICING')
            && driver.contributions.some((asset) => asset.asset === 'EUR' || asset.asset === 'GBP')),
        undefined,
        `${tag}: generic EUR/GBP rhetoric must not double-count when geo premium is active`,
    );

    const score = (asset: string) => board.find((row) => row.asset === asset)?.driverScore ?? 0;
    assert.equal(score('USD'), 0.5, `${tag}: USD should be geo-only without yield driver`);
    assert.equal(score('GOLD'), 0, `${tag}: GOLD should be zero without yield driver`);
    assert.ok(score('OIL') > 0, `${tag}: operational oil themes should remain net bullish on Aug 18`);
}

console.log(JSON.stringify({ passed: true, artifacts: ['nano-r13', 'nano-r14'] }, null, 2));
