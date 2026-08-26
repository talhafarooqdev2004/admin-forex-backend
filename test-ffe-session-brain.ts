import assert from 'node:assert/strict';
import {
    resetAiEvaluationTelemetry,
    setAiProviderTransportOverrideForTests,
} from './src/services/groqClassifier.service.js';
import {
    FFE_SESSION_TRACKED_ASSETS,
    fingerprintSessionLedger,
    sessionBrainSchemaForTests,
    synthesizeFfeSessionBrain,
    type SessionEvidenceLedger,
} from './src/services/ffeSessionBrain.service.js';

function syntheticSnapshot() {
    return {
        schemaVersion: 'ffe-session-brain-v1.0.0',
        asOf: '2026-08-18T22:47:00+04:00',
        sessionSummary: 'Synthetic test snapshot',
        driverClusters: [{
            id: 'cluster-test', label: 'Test driver', causalExplanation: 'Test evidence only', status: 'ACTIVE', independentReason: 'Separate test event',
            supportingEventIds: ['event-test'], supportingGuids: ['guid-test'], affectedAssets: [{ asset: 'USD', score: 0.5, bias: 'Bullish', reason: 'test' }], confirmationOnlyGuids: [],
        }],
        confirmationEvidence: [],
        macroBoard: ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'].map((asset) => ({ asset, score: 0, bias: 'Neutral', factors: [] })),
        catalystBoard: [...FFE_SESSION_TRACKED_ASSETS].map((asset) => ({ asset, bullishDrivers: [], bearishDrivers: [], score: asset === 'USD' ? 0.5 : 0, bias: asset === 'USD' ? 'Bullish' : 'Neutral', factors: [], explanation: 'test', notDoubleCounted: [] })),
        geopoliticalThemes: [],
        geoComponents: { directMilitaryEscalation: 0, energyHormuzRisk: 0, diplomaticDeterioration: 0, regionalSpillover: 0, sanctionsStrategicConfrontation: 0, deEscalationDeduction: 0 },
        confidence: 0.9,
        needsReview: false,
        changeExplanation: 'test',
    };
}

const ledger: SessionEvidenceLedger = {
    dayKey: '2026-08-18', source: 'FinancialJuice', asOf: '2026-08-18T22:47:00+04:00',
    events: [{ id: 'event-test', guid: 'guid-test', headline: 'test', time: '2026-08-18T01:07:00+04:00', relation: 'NEW_EVENT', status: 'ACTIVE', themeId: 'theme-test', summary: 'test', confirmation: false, actual: null, forecast: null, previous: null }],
    themes: [], macroEvidence: [], geopoliticalEvidence: [], confirmationEvidence: [], priorSnapshot: null,
};

assert.equal((sessionBrainSchemaForTests() as { type?: string }).type, 'object');
assert.equal(fingerprintSessionLedger({ ...ledger, asOf: '2026-08-18T01:08:00+04:00' }), fingerprintSessionLedger(ledger), 'as-of must not change ledger identity');
resetAiEvaluationTelemetry();
setAiProviderTransportOverrideForTests(() => ({ parsed: syntheticSnapshot(), usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }));
try {
    const result = await synthesizeFfeSessionBrain(ledger, { recordUsage: false });
    assert.ok(result, 'synthetic Session Brain response should validate');
    assert.equal(result.output.catalystBoard.length, 10);
    assert.equal(result.output.macroBoard.length, 8);
    assert.equal(result.output.catalystBoard.find((row) => row.asset === 'USD')?.score, 0.5);
} finally {
    setAiProviderTransportOverrideForTests(null);
}
console.log('PASS — Session Brain strict schema, full-board validation, and stable ledger fingerprint.');
