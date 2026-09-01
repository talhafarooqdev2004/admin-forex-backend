#!/usr/bin/env node
/**
 * Compact score-only ChatGPT JSON transport.
 * No ChatGPT submit, RSS, or DB writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatGptRawResponse } from '../src/services/ffeChatgptResponseParser.service.js';
import { validateChatGptJsonStructure } from '../src/services/ffeChatgptJsonStructure.service.js';
import { buildGptFirstSessionInputFromSnapshot } from '../src/services/ffePipelineIngest.service.js';
import { normalizeGptFirstOutput } from '../src/services/ffeGptFirstAnalysis.service.js';
import { gptFirstOutputToCatalystBoard } from '../src/services/ffeGptFirstProduction.service.js';
import {
    CATALYST_ASSETS,
    MACRO_ASSETS,
    validateChatGptRawDriverContributions,
    validateGptFirstAnalysis,
} from '../src/services/ffeGptFirstValidation.service.js';
import {
    evaluateFfeAssistantResponse,
    WAIT_ACTIONS,
    decideWaitAction,
} from '../../forex-scraping/src/utils/chatgptFfeResponseAcceptance.util.js';
import { buildFfeUserPrompt, dailyPromptContainsMethodology } from '../../forex-scraping/src/utils/ffeEvidencePreprocess.util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const ARTIFACTS = path.join(repoRoot, 'forex-scraping/artifacts/ffe-daily-runs');

const CATALYST_EXPECTED = {
    USD: 0.75,
    EUR: 0.5,
    GBP: 0.25,
    JPY: 0.25,
    CHF: 0.5,
    CAD: 0.5,
    AUD: 0.25,
    NZD: 0.75,
    GOLD: -0.75,
    OIL: 0.5,
};

const MACRO_EXPECTED = {
    USD: 0.45,
    EUR: 0.22,
    GBP: 0,
    JPY: 0.1,
    CHF: 0.08,
    CAD: -0.12,
    AUD: 0.16,
    NZD: 0.05,
};

const COMPACT = {
    business_day: '2026-08-28',
    cutoff: '2026-08-28 13:45',
    catalyst_board: CATALYST_EXPECTED,
    macro_board: MACRO_EXPECTED,
    geopolitical_risk: { score: 0.65, band: 'ELEVATED' },
};

const INCOMPLETE = {
    status: 'INCOMPLETE',
    reason: 'FULL_JSON_RESPONSE_NOT_POSSIBLE_IN_ONE_MESSAGE',
};

const MINIMAL_ITEMS = [{ guid: '1', time: '2026-08-28 13:45', headline: 'test' }];

function compactInput() {
    return buildGptFirstSessionInputFromSnapshot({
        run_id: 'compact-score-only-test',
        business_day: '2026-08-28',
        input_hash: 'test',
        cutoff: '2026-08-28 13:45',
        source_units: MINIMAL_ITEMS.map((row, index) => ({
            ...row,
            source: 'FinancialJuice',
            source_label: 'FinancialJuice',
            body: '',
            supporting_lines: [],
            actual: null,
            forecast: null,
            previous: null,
            original_order: index + 1,
            source_unit_hash: `h${index}`,
        })),
        chatgpt: { raw_response: JSON.stringify(COMPACT) },
    });
}

function main() {
    const compactText = JSON.stringify(COMPACT, null, 2);
    const compactLines = compactText.split('\n').length;
    assert.ok(compactLines <= 30, `compact JSON should stay small, got ${compactLines} lines`);

    const parsed = parseChatGptRawResponse(compactText);
    assert.equal(parsed.ok, true, parsed.error || 'compact JSON must parse');
    const structure = validateChatGptJsonStructure(parsed.parsed);
    assert.equal(structure.valid, true, structure.issues.map((i) => i.message).join('; '));

    const input = compactInput();
    const output = normalizeGptFirstOutput(parsed.parsed, input);
    const validation = validateGptFirstAnalysis(output, input);
    const geoOrArithmetic = validation.issues.filter((issue) => (
        issue.code === 'INVALID_GEO_BAND'
        || issue.code === 'INVALID_GEO_SCORE'
        || issue.code === 'GEO_BAND_MISMATCH'
        || issue.code === 'ARITHMETIC_MISMATCH'
        || issue.code === 'MISSING_ASSET'
    ));
    assert.deepEqual(geoOrArithmetic, [], geoOrArithmetic.map((i) => i.message).join('; '));
    assert.equal(validation.valid, true, validation.issues.map((i) => `${i.code}: ${i.message}`).join('; '));

    for (const asset of CATALYST_ASSETS) {
        const row = output.final_board.find((entry) => entry.asset === asset);
        assert.ok(row, `missing catalyst ${asset}`);
        assert.equal(row.score, CATALYST_EXPECTED[asset], `${asset} catalyst not preserved`);
    }
    for (const asset of MACRO_ASSETS) {
        const row = output.macro.find((entry) => entry.asset === asset);
        assert.ok(row, `missing macro ${asset}`);
        assert.equal(row.score, MACRO_EXPECTED[asset], `${asset} macro not preserved`);
    }
    assert.equal(output.geo.score, 0.65);
    assert.equal(output.geo.band, 'ELEVATED');

    const persisted = gptFirstOutputToCatalystBoard(output);
    for (const asset of CATALYST_ASSETS) {
        const row = persisted.find((entry) => entry.asset === asset);
        assert.ok(row, `persist missing ${asset}`);
        assert.equal(row.driverScore, CATALYST_EXPECTED[asset]);
    }

    const driverContract = validateChatGptRawDriverContributions(COMPACT);
    assert.equal(driverContract.valid, true, 'compact payload has no illegal individual contributions');

    const illegal = validateChatGptRawDriverContributions({
        catalyst_board: {
            USD: { active_independent_drivers: [{ contribution: 0.75 }] },
        },
    });
    assert.equal(illegal.valid, false, 'individual +0.75 must still fail');

    const incompleteEval = evaluateFfeAssistantResponse(JSON.stringify(INCOMPLETE));
    assert.equal(incompleteEval.accepted, true);
    assert.equal(incompleteEval.kind, 'incomplete_fallback_json');
    const incompleteWait = decideWaitAction({
        text: JSON.stringify(INCOMPLETE),
        generationActive: false,
        uiError: false,
        elapsedMs: 12_000,
        maxWaitMs: 1_800_000,
        stable: true,
        requireFinalFfeJson: true,
    });
    assert.equal(incompleteWait.action, WAIT_ACTIONS.FINALIZE_SUCCESS);

    const verboseDir = path.join(ARTIFACTS, 'ffe-2026-08-28T13-50-00-049Z');
    const verboseCaptured = JSON.parse(fs.readFileSync(path.join(verboseDir, 'chatgpt-result.json'), 'utf8'));
    const verbosePipeline = JSON.parse(fs.readFileSync(path.join(verboseDir, 'pipeline-result.json'), 'utf8'));
    const verboseParsed = parseChatGptRawResponse(verboseCaptured.raw_response);
    assert.equal(verboseParsed.ok, true, verboseParsed.error || '13:50 verbose JSON must remain parseable');
    const verboseInput = buildGptFirstSessionInputFromSnapshot({
        run_id: verbosePipeline.snapshot.run_id,
        business_day: verbosePipeline.snapshot.business_day,
        input_hash: verbosePipeline.snapshot.input_hash,
        cutoff: verbosePipeline.snapshot.cutoff,
        source_units: verbosePipeline.snapshot.source_units,
        chatgpt: { raw_response: verboseCaptured.raw_response },
    });
    const verboseOutput = normalizeGptFirstOutput(verboseParsed.parsed, verboseInput);
    assert.equal(verboseOutput.geo.score, 0.65);
    assert.equal(verboseOutput.geo.band, 'ELEVATED');
    const verboseDriver = validateChatGptRawDriverContributions(verboseParsed.parsed);
    assert.equal(verboseDriver.valid, true, verboseDriver.issues.map((i) => i.message).join('; '));

    const oldSize = String(verboseCaptured.raw_response || '').length;
    const newSize = compactText.length;
    assert.ok(newSize < oldSize / 10, `compact JSON should be dramatically smaller (${newSize} vs ${oldSize})`);

    const daily = buildFfeUserPrompt({
        businessDay: '2026-08-28',
        cutoff: '2026-08-28 13:45',
        items: MINIMAL_ITEMS,
    });
    assert.equal(dailyPromptContainsMethodology(daily), false);
    assert.match(daily, /^TASK SCOPE — ABSOLUTE/m);
    assert.match(daily, /Do NOT generate an image\./);
    assert.match(daily, /Do NOT use image-generation tools\./);
    assert.ok(daily.indexOf('TASK SCOPE — ABSOLUTE') < daily.indexOf('Analyze the supplied FFE news'));
    assert.match(daily, /Analyze the supplied FFE news using the existing Project methodology internally\./);
    assert.match(daily, /"catalyst_board"/);
    assert.match(daily, /"macro_board"/);
    assert.match(daily, /"geopolitical_risk"/);
    assert.match(daily, /Do NOT include/);
    assert.match(daily, /FULL_JSON_RESPONSE_NOT_POSSIBLE_IN_ONE_MESSAGE/);

    console.log(JSON.stringify({
        test: 'PASS',
        output_size: { old: oldSize, new: newSize, compact_lines: compactLines },
        compact: {
            catalyst: output.final_board.map((row) => ({ asset: row.asset, score: row.score })),
            macro: output.macro.map((row) => ({ asset: row.asset, score: row.score })),
            geo: { score: output.geo.score, band: output.geo.band },
        },
        verbose_13_50: { score: verboseOutput.geo.score, band: verboseOutput.geo.band },
    }, null, 2));
}

main();
