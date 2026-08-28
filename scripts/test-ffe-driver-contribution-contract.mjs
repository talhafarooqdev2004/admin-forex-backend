#!/usr/bin/env node
/**
 * Regression: individual driver contributions must be discrete seven-value contract.
 * Aggregate board/decomposition/regime totals may remain continuous.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatGptRawResponse } from '../src/services/ffeChatgptResponseParser.service.js';
import {
    isAllowedIndividualDriverContribution,
    validateChatGptRawDriverContributions,
} from '../src/services/ffeGptFirstValidation.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const LEGAL = [0, 0.25, 0.5, 1, -0.25, -0.5, -1];
const ILLEGAL = [0.03, 0.06, 0.1, 0.14, 0.15, 0.16, 0.2, 0.35, -0.02, -0.08, -0.12, -0.15, -0.2, 0.75, -0.75];

for (const value of LEGAL) {
    assert.equal(
        isAllowedIndividualDriverContribution(value),
        true,
        `expected legal contribution ${value}`,
    );
}

for (const value of ILLEGAL) {
    assert.equal(
        isAllowedIndividualDriverContribution(value),
        false,
        `expected illegal contribution ${value}`,
    );
}

const aggregatePayload = {
    catalyst_board: {
        USD: {
            raw_catalyst_score: 0.05,
            active_independent_drivers: [{ contribution: 0.25 }],
        },
        EUR: {
            raw_catalyst_score: 0.22,
            active_independent_drivers: [{ contribution: -0.5 }],
        },
        JPY: {
            raw_catalyst_score: 0.45,
            active_independent_drivers: [{ contribution: 0 }],
        },
    },
    final_session_summary: {
        final_board: { USD: 0.05, EUR: 0.22, JPY: 0.68 },
    },
    macro_board: {
        USD: { macro_score: 0.45 },
        EUR: { macro_score: -0.22 },
    },
    geopolitical_risk: { score: 0.68 },
    gold_decomposition: {
        net_score: 0.22,
        channels: [{ channel: 'real_yield', score: 0.25 }],
    },
    oil_aggregate_state: {
        net_score: -0.22,
        downstream_transmission: {
            CAD: { magnitude: -0.25 },
            JPY: { contribution: 0.5 },
        },
    },
    canonical_driver_ledger: [{
        driver_id: 'D1',
        contribution_per_asset: { USD: 0.25, EUR: -0.25 },
    }],
    oil_audit: [{ magnitude: 1 }],
};

const aggregateValidation = validateChatGptRawDriverContributions(aggregatePayload);
assert.equal(aggregateValidation.valid, true, aggregateValidation.issues.map((row) => row.message).join('; '));

const illegalDriverPayload = {
    ...aggregatePayload,
    catalyst_board: {
        USD: {
            raw_catalyst_score: 0.05,
            active_independent_drivers: [{ contribution: 0.35 }],
        },
    },
};
const illegalValidation = validateChatGptRawDriverContributions(illegalDriverPayload);
assert.equal(illegalValidation.valid, false);
assert.ok(
    illegalValidation.issues.some((row) => row.code === 'ILLEGAL_DRIVER_CONTRIBUTION'),
    'expected ILLEGAL_DRIVER_CONTRIBUTION for 0.35',
);

const badArtifactPath = path.join(
    repoRoot,
    'forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-28T11-11-21-255Z/chatgpt-result.json',
);
const captured = JSON.parse(fs.readFileSync(badArtifactPath, 'utf8'));
const parsed = parseChatGptRawResponse(captured.raw_response);
assert.equal(parsed.ok, true, parsed.error || 'parse failed');

const replayValidation = validateChatGptRawDriverContributions(parsed.parsed);
assert.equal(replayValidation.valid, false, 'bad 2026-08-28 artifact must fail driver contribution validation');
assert.ok(replayValidation.issues.length > 0, 'expected validation issues');
assert.ok(
    replayValidation.issues.some((row) => row.code === 'ILLEGAL_DRIVER_CONTRIBUTION'),
    'expected ILLEGAL_DRIVER_CONTRIBUTION issues in bad artifact',
);

console.log(JSON.stringify({
    test: 'PASS',
    legal_values: LEGAL,
    illegal_values_rejected: ILLEGAL.length,
    aggregate_continuous_pass: true,
    bad_artifact_replay: {
        business_day: '2026-08-28',
        validation_valid: replayValidation.valid,
        issue_count: replayValidation.issues.length,
        sample_issues: replayValidation.issues.slice(0, 5),
        persistence_blocked: true,
    },
}, null, 2));
