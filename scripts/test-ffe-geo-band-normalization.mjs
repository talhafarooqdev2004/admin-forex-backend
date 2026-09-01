#!/usr/bin/env node
/**
 * Geo normalization compatibility: geo_score / band aliases / score-derived bands.
 * Uses captured artifacts only — no ChatGPT, RSS, or DB writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatGptRawResponse } from '../src/services/ffeChatgptResponseParser.service.js';
import { buildGptFirstSessionInputFromSnapshot } from '../src/services/ffePipelineIngest.service.js';
import { normalizeGptFirstOutput } from '../src/services/ffeGptFirstAnalysis.service.js';
import { validateGptFirstAnalysis } from '../src/services/ffeGptFirstValidation.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const ARTIFACTS = path.join(repoRoot, 'forex-scraping/artifacts/ffe-daily-runs');

function loadRun(runId) {
    const runDir = path.join(ARTIFACTS, runId);
    const captured = JSON.parse(fs.readFileSync(path.join(runDir, 'chatgpt-result.json'), 'utf8'));
    const pipeline = JSON.parse(fs.readFileSync(path.join(runDir, 'pipeline-result.json'), 'utf8'));
    return { captured, pipeline };
}

function sessionFromPipeline(pipeline, rawResponse) {
    return buildGptFirstSessionInputFromSnapshot({
        run_id: pipeline.snapshot.run_id,
        business_day: pipeline.snapshot.business_day,
        input_hash: pipeline.snapshot.input_hash,
        cutoff: pipeline.snapshot.cutoff,
        source_units: pipeline.snapshot.source_units,
        chatgpt: { raw_response: rawResponse },
    });
}

const MINIMAL_INPUT = {
    source: 'FinancialJuice',
    business_day: '2026-08-28',
    cutoff: '2026-08-28 14:37',
    items: [{ guid: '1', time: '2026-08-28 14:37', headline: 'test' }],
};

function geoIssueCodes(validation) {
    return validation.issues
        .filter((issue) => (
            issue.code === 'INVALID_GEO_BAND'
            || issue.code === 'INVALID_GEO_SCORE'
            || issue.code === 'GEO_BAND_MISMATCH'
        ))
        .map((issue) => issue.code);
}

function normalizeAndValidateGeo(rawGeo) {
    const output = normalizeGptFirstOutput({
        catalyst_board: [{ asset: 'USD', score: 0 }],
        geo: rawGeo,
        session: {
            source: 'FinancialJuice',
            business_day: MINIMAL_INPUT.business_day,
            cutoff: MINIMAL_INPUT.cutoff,
            input_count: 1,
            input_hash: 'test',
        },
        drivers: [],
        macro: [],
    }, MINIMAL_INPUT);
    const validation = validateGptFirstAnalysis(output, MINIMAL_INPUT);
    return { output, validation, geoCodes: geoIssueCodes(validation) };
}

function main() {
    const run1446 = loadRun('ffe-2026-08-28T14-46-50-325Z');
    const parsed1446 = parseChatGptRawResponse(run1446.captured.raw_response);
    assert.equal(parsed1446.ok, true, parsed1446.error || '14:46 parse failed');
    const input1446 = sessionFromPipeline(run1446.pipeline, run1446.captured.raw_response);
    const output1446 = normalizeGptFirstOutput(parsed1446.parsed, input1446);
    assert.equal(output1446.geo.score, 0.18, `14:46 geo.score expected 0.18, got ${output1446.geo.score}`);
    assert.equal(output1446.geo.band, 'LOW', `14:46 geo.band expected LOW, got ${output1446.geo.band}`);
    const validation1446 = validateGptFirstAnalysis(output1446, input1446);
    assert.deepEqual(geoIssueCodes(validation1446), [], `14:46 geo validation issues: ${geoIssueCodes(validation1446).join(', ')}`);

    const run1350 = loadRun('ffe-2026-08-28T13-50-00-049Z');
    const parsed1350 = parseChatGptRawResponse(run1350.captured.raw_response);
    assert.equal(parsed1350.ok, true, parsed1350.error || '13:50 parse failed');
    const input1350 = sessionFromPipeline(run1350.pipeline, run1350.captured.raw_response);
    const output1350 = normalizeGptFirstOutput(parsed1350.parsed, input1350);
    assert.equal(output1350.geo.score, 0.65, `13:50 geo.score expected 0.65, got ${output1350.geo.score}`);
    assert.equal(output1350.geo.band, 'ELEVATED', `13:50 geo.band expected ELEVATED, got ${output1350.geo.band}`);
    const validation1350 = validateGptFirstAnalysis(output1350, input1350);
    assert.deepEqual(geoIssueCodes(validation1350), [], `13:50 geo validation issues: ${geoIssueCodes(validation1350).join(', ')}`);

    const missing = normalizeAndValidateGeo({});
    assert.equal(missing.output.geo.band, '');
    assert.ok(missing.geoCodes.includes('INVALID_GEO_BAND'), 'missing score + missing band must FAIL');

    const invalidScore = normalizeAndValidateGeo({ score: 'not-a-number' });
    assert.equal(invalidScore.output.geo.band, '');
    assert.ok(invalidScore.geoCodes.includes('INVALID_GEO_BAND'), 'invalid non-numeric score + missing band must FAIL');

    const narrativeBand = normalizeAndValidateGeo({ band: 'TENse-but-contained' });
    assert.equal(narrativeBand.output.geo.band, '');
    assert.ok(narrativeBand.geoCodes.includes('INVALID_GEO_BAND'), 'arbitrary regime text used as band must FAIL');

    const derived = normalizeAndValidateGeo({ geo_score: 0.18 });
    assert.equal(derived.output.geo.score, 0.18);
    assert.equal(derived.output.geo.band, 'LOW');
    assert.deepEqual(derived.geoCodes, [], 'score 0.18 with derived band must PASS');

    const aliases = [
        [{ band: 'elevated', score: 0.65 }, 'ELEVATED'],
        [{ band: 'HIGH RISK', score: 0.7 }, 'HIGH'],
        [{ band: 'HIGH_RISK', score: 0.7 }, 'HIGH'],
        [{ band: 'low risk', score: 0.1 }, 'LOW'],
        [{ band: 'LOW_RISK', score: 0.1 }, 'LOW'],
        [{ band: 'watch', score: 0.3 }, 'WATCH'],
        [{ band: 'extreme risk', score: 0.9 }, 'EXTREME'],
    ];
    for (const [raw, expectedBand] of aliases) {
        const result = normalizeAndValidateGeo(raw);
        assert.equal(result.output.geo.band, expectedBand, `${raw.band} should normalize to ${expectedBand}`);
        assert.deepEqual(result.geoCodes, [], `${raw.band} alias must pass geo validation`);
    }

    console.log(JSON.stringify({
        test: 'PASS',
        artifact_14_46: { score: output1446.geo.score, band: output1446.geo.band },
        artifact_13_50: { score: output1350.geo.score, band: output1350.geo.band },
        derived_0_18: { score: derived.output.geo.score, band: derived.output.geo.band },
    }, null, 2));
}

main();
