#!/usr/bin/env node
/**
 * Regression: catalyst_board.<ASSET>.raw_catalyst_score → final_board[].score
 * Uses the actual 2026-08-28 ChatGPT JSON shape (no live ChatGPT / DB writes).
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

const EXPECTED = {
    USD: 0.05,
    EUR: 0.22,
    GBP: 0.0,
    JPY: 0.45,
    CHF: 0.08,
    CAD: -0.12,
    AUD: 0.1,
    NZD: 0.16,
    GOLD: 0.3,
    OIL: -0.22,
};

const runDir = path.join(
    repoRoot,
    'forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-28T11-11-21-255Z',
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

for (const [asset, expectedScore] of Object.entries(EXPECTED)) {
    const row = output.final_board.find((entry) => entry.asset === asset);
    assert.ok(row, `final_board missing ${asset}`);
    assert.equal(
        row.score,
        expectedScore,
        `${asset} final_board.score expected ${expectedScore}, got ${row.score}`,
    );

    const persisted = catalystBoard.find((entry) => entry.asset === asset);
    assert.ok(persisted, `catalystBoard missing ${asset}`);
    assert.equal(
        persisted.driverScore,
        expectedScore,
        `${asset} driverScore expected ${expectedScore}, got ${persisted.driverScore}`,
    );
}

// catalyst_board raw_catalyst_score must win over final_session_summary.final_board.
const usdRaw = parsed.parsed.catalyst_board?.USD;
assert.equal(usdRaw?.raw_catalyst_score, 0.05);
assert.notEqual(parsed.parsed.final_session_summary?.final_board?.USD, undefined);

console.log(JSON.stringify({
    test: 'PASS',
    business_day: pipeline.snapshot.business_day,
    input_hash: pipeline.snapshot.input_hash,
    final_board: output.final_board.map((row) => ({ asset: row.asset, score: row.score })),
    catalyst_board: catalystBoard.map((row) => ({ asset: row.asset, driverScore: row.driverScore })),
}, null, 2));
