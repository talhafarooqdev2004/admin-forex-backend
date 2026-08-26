/**
 * Pure Risk Mode source-boundary regression checks.
 * Run with: node --import tsx/esm --test test-risk-mode-regression.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeRiskModeNumericSource,
    parseRiskModeSourceValue,
    resolveRiskModeContract,
    riskModeStateFromScore,
    unavailableRiskModeContract,
} from './src/services/riskModeContract.js';

test('the old signed misread of Babypips 0-100 values reproduced Risk-Off as Neutral', () => {
    const legacyScore = Number(String('Risk-Off').replace(/[^0-9.+-]/g, ''));
    assert.ok(Number.isNaN(legacyScore));
    // Before normalization, a Babypips 26 in B13 was treated as signed +26 → NEUTRAL.
    assert.equal(riskModeStateFromScore(26), 'NEUTRAL');
    assert.deepEqual(parseRiskModeSourceValue(26), { mode: 'RISK_OFF', score: -48, sourceKind: 'numeric' });
});

test('Babypips 0-100 sheet values normalize to signed thresholds', () => {
    assert.equal(normalizeRiskModeNumericSource(-70), -70);
    assert.equal(normalizeRiskModeNumericSource(0), -100);
    assert.equal(normalizeRiskModeNumericSource(50), 0);
    assert.equal(normalizeRiskModeNumericSource(83), 66);
    assert.deepEqual(parseRiskModeSourceValue(-70), { mode: 'RISK_OFF', score: -70, sourceKind: 'numeric' });
    assert.deepEqual(parseRiskModeSourceValue(0), { mode: 'RISK_OFF', score: -100, sourceKind: 'numeric' });
    assert.deepEqual(parseRiskModeSourceValue(50), { mode: 'NEUTRAL', score: 0, sourceKind: 'numeric' });
    assert.deepEqual(parseRiskModeSourceValue(83), { mode: 'RISK_ON', score: 66, sourceKind: 'numeric' });
});

test('label source values remain states even when no numeric score is present', () => {
    assert.deepEqual(parseRiskModeSourceValue('Risk-Off'), { mode: 'RISK_OFF', score: null, sourceKind: 'label' });
    assert.deepEqual(parseRiskModeSourceValue('Risk-On'), { mode: 'RISK_ON', score: null, sourceKind: 'label' });
    assert.deepEqual(parseRiskModeSourceValue('Neutral'), { mode: 'NEUTRAL', score: null, sourceKind: 'label' });
});

test('the snapshot boundary preserves source Risk-Off over a stale DB Neutral row', () => {
    const snapshotRiskMode = resolveRiskModeContract('Risk-Off', {
        score: 26,
        updated_at: '2026-08-18T00:00:00.000Z',
    });
    assert.equal(snapshotRiskMode.mode, 'RISK_OFF');
    assert.equal(snapshotRiskMode.score, null);
    assert.equal(snapshotRiskMode.source, 'google_sheets:RISK ON/OFF 12!B13');
});

test('blank, malformed, and unrelated values are unavailable rather than zero', () => {
    assert.equal(parseRiskModeSourceValue(null), null);
    assert.equal(parseRiskModeSourceValue(''), null);
    assert.equal(parseRiskModeSourceValue('RISK ON/OFF 12'), null);
    assert.deepEqual(unavailableRiskModeContract(), {
        mode: 'NEUTRAL',
        score: null,
        updatedAt: null,
        asOf: null,
        source: 'fallback:unavailable',
    });
});
