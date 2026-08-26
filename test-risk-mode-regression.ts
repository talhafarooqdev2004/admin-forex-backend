/**
 * Pure Risk Mode source-boundary regression checks.
 * Run with: node --import tsx/esm --test test-risk-mode-regression.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseRiskModeSourceValue,
    resolveRiskModeContract,
    riskModeStateFromScore,
    unavailableRiskModeContract,
} from './src/services/riskModeContract.js';

test('the old label-to-number path reproduces Risk-Off -> Neutral', () => {
    const legacyScore = Number(String('Risk-Off').replace(/[^0-9.+-]/g, ''));
    assert.ok(Number.isNaN(legacyScore));
    // The pre-fix reader then fell back to a stale numeric DB row (26), which
    // is exactly how the valid source state became Neutral in the snapshot.
    assert.equal(riskModeStateFromScore(26), 'NEUTRAL');
});

test('numeric source values produce canonical Risk-Off, Neutral, and Risk-On states', () => {
    assert.deepEqual(parseRiskModeSourceValue(-70), { mode: 'RISK_OFF', score: -70, sourceKind: 'numeric' });
    assert.deepEqual(parseRiskModeSourceValue(0), { mode: 'NEUTRAL', score: 0, sourceKind: 'numeric' });
    assert.deepEqual(parseRiskModeSourceValue(80), { mode: 'RISK_ON', score: 80, sourceKind: 'numeric' });
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
