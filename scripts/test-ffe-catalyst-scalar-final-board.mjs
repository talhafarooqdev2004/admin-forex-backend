#!/usr/bin/env node
/**
 * Regression: scalar final_board must not zero catalyst when catalyst_board exists.
 * Uses ffe-2026-08-28T12-50-00-047Z (no live ChatGPT / DB writes).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatGptRawResponse } from '../src/services/ffeChatgptResponseParser.service.js';
import { buildGptFirstSessionInputFromSnapshot } from '../src/services/ffePipelineIngest.service.js';
import { normalizeGptFirstOutput } from '../src/services/ffeGptFirstAnalysis.service.js';
import { gptFirstOutputToCatalystBoard } from '../src/services/ffeGptFirstProduction.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const EXPECTED_CATALYST = {
    USD: 0,
    EUR: 0.25,
    GBP: 0,
    JPY: 0.5,
    CHF: 0.5,
    CAD: 0.25,
    AUD: 0.25,
    NZD: 0.5,
    GOLD: 0.25,
    OIL: 0.5,
};

const EXPECTED_FINAL_BOARD_AGGREGATES = {
    USD: 0,
    EUR: 0.45,
    GBP: 0,
    JPY: 0.8,
    CHF: 0.7,
    CAD: 0.65,
    AUD: 0.25,
    NZD: 0.5,
    GOLD: 0.25,
    OIL: 0.5,
};

const runDir = path.join(
    repoRoot,
    'forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-28T12-50-00-047Z',
);
const captured = JSON.parse(fs.readFileSync(path.join(runDir, 'chatgpt-result.json'), 'utf8'));
const pipeline = JSON.parse(fs.readFileSync(path.join(runDir, 'pipeline-result.json'), 'utf8'));

const parsed = parseChatGptRawResponse(captured.raw_response);
assert.equal(parsed.ok, true, parsed.error || 'parse failed');

const input = buildGptFirstSessionInputFromSnapshot({
    run_id: pipeline.snapshot.run_id,
    business_day: pipeline.snapshot.business_day,
    input_hash: pipeline.snapshot.input_hash,
    cutoff: pipeline.snapshot.cutoff,
    source_units: pipeline.snapshot.source_units,
    chatgpt: { raw_response: captured.raw_response },
});

const output = normalizeGptFirstOutput(parsed.parsed, input);
const catalystBoard = gptFirstOutputToCatalystBoard(output);

for (const [asset, expectedScore] of Object.entries(EXPECTED_CATALYST)) {
    const row = output.final_board.find((entry) => entry.asset === asset);
    assert.ok(row, `final_board missing ${asset}`);
    assert.equal(
        row.score,
        expectedScore,
        `${asset} normalized catalyst score expected ${expectedScore}, got ${row.score}`,
    );

    const persisted = catalystBoard.find((entry) => entry.asset === asset);
    assert.ok(persisted, `catalystBoard missing ${asset}`);
    assert.equal(
        persisted.driverScore,
        expectedScore,
        `${asset} driverScore expected ${expectedScore}, got ${persisted.driverScore}`,
    );

    const aggregate = parsed.parsed.final_board?.[asset];
    assert.equal(
        aggregate,
        EXPECTED_FINAL_BOARD_AGGREGATES[asset],
        `${asset} raw final_board aggregate fixture drift`,
    );
    if (expectedScore !== aggregate) {
        assert.notEqual(
            persisted.driverScore,
            aggregate,
            `${asset} driverScore must not use final_board aggregate ${aggregate}`,
        );
    }
}

assert.notEqual(
    catalystBoard.every((row) => row.driverScore === 0),
    true,
    'catalyst board must not be all zero',
);

console.log(JSON.stringify({
    test: 'PASS',
    business_day: pipeline.snapshot.business_day,
    input_hash: pipeline.snapshot.input_hash,
    catalyst_board: catalystBoard.map((row) => ({ asset: row.asset, driverScore: row.driverScore })),
    raw_final_board_aggregates: EXPECTED_FINAL_BOARD_AGGREGATES,
}, null, 2));
