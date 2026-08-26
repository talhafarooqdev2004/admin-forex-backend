#!/usr/bin/env node
/**
 * JSON-only parser + structural validation smoke test (no ChatGPT).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseChatGptRawResponse, sanitizeJsonStringControlCharacters } from '../src/services/ffeChatgptResponseParser.service.js';
import { validateChatGptJsonStructure } from '../src/services/ffeChatgptJsonStructure.service.js';

const validJson = {
    catalyst_board: [
        { asset: 'USD', score: 0.5, bias: 'Bullish', driver_refs: ['D1'], explanation: 'test' },
        { asset: 'EUR', score: -0.25, bias: 'Bearish', driver_refs: [], explanation: 'test' },
    ],
    macro_board: [{ asset: 'USD', score: 0.25, health: 'ok', reasoning: 'test', supporting_releases: [] }],
    geo: { score: 0.42, band: 'ELEVATED', state: 'watch', dominant_theme: 'test' },
    drivers: [],
    session: { business_day: '2026-08-26', cutoff: '26/08/2026, 10:00', input_count: 1, input_hash: 'abc' },
    quality: { model_confidence: 0.8, unresolved_ambiguities: [], warnings: [] },
};

const fenced = `\`\`\`json\n${JSON.stringify(validJson)}\n\`\`\``;
const parsed = parseChatGptRawResponse(fenced);
assert.equal(parsed.ok, true, parsed.error || 'parse failed');
assert.ok(parsed.parsed?.final_board, 'catalyst_board bridged to final_board');

const structure = validateChatGptJsonStructure(parsed.parsed);
assert.equal(structure.valid, true, structure.issues.map((i) => i.message).join('; '));

const prose = 'FINAL BOARD\nUSD +0.5\nGEO\nscore 0.4';
const proseResult = parseChatGptRawResponse(prose);
assert.equal(proseResult.ok, false);
assert.match(proseResult.error || '', /CHATGPT_RESPONSE_INVALID/);

const capturedPath = '/home/talha/Documents/forex/forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-26T11-49-37-092Z/chatgpt-result.json';
const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));
const raw = captured.raw_response;
assert.throws(() => JSON.parse(raw), /Bad control character/);
const sanitized = sanitizeJsonStringControlCharacters(raw);
assert.doesNotThrow(() => JSON.parse(sanitized));
const liveParsed = parseChatGptRawResponse(raw);
assert.equal(liveParsed.ok, true, liveParsed.error || 'live capture parse failed');
assert.match(liveParsed.strategy || '', /sanitized/);
const required = [
    'business_day', 'cutoff', 'final_state', 'catalyst_board',
    'geopolitical_risk', 'oil_audit', 'gold_decomposition', 'canonical_driver_ledger',
];
for (const field of required) {
    assert.ok(liveParsed.parsed?.[field] != null, `missing ${field}`);
}
assert.ok(liveParsed.parsed?.macro_board != null || liveParsed.parsed?.macro != null, 'missing macro_board/macro');
const liveStructure = validateChatGptJsonStructure(liveParsed.parsed);
assert.equal(liveStructure.valid, true, liveStructure.issues.map((i) => i.message).join('; '));

console.log(JSON.stringify({ test: 'PASS', parser: parsed.strategy, live: liveParsed.strategy }, null, 2));
