/**
 * Prompt-only validation for score-contract hard constraint (no ChatGPT submission).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

const REQUIRED = [
    'CONTRIBUTION SCORE CONTRACT — HARD CONSTRAINT',
    'the ONLY legal values are:',
    '-1, -0.5, -0.25, 0, +0.25, +0.5, +1',
    'Continuous -1.00 to +1.00 values are allowed ONLY for aggregate board/decomposition/regime totals',
    'Every individual driver contribution must use ONLY {-1, -0.5, -0.25, 0, +0.25, +0.5, +1}',
    'Specifically FORBIDDEN on individual contributions: +0.75, -0.75',
    'EVENT-STAGE REPLACEMENT (critical)',
    'NEW_EVENT → CONFIRMATION → STRENGTHENING',
    'Do NOT output EUR = +0.75',
    'EUR contribution = +0.50',
    'EUR contribution = +1.00',
    'final_board totals MAY sum multiple independent ACTIVE drivers',
    'An individual driver contribution must NEVER be +0.75',
    'Before output, for EVERY driver contribution perform this hard self-check',
];

async function main() {
    const { buildGptFirstSystemPrompt, FFE_GPT_FIRST_PROMPT_VERSION } = await import(
        path.join(BACKEND_ROOT, 'src/services/ffeGptFirstPrompt.service.ts')
    );
    const { ALLOWED_SCORES } = await import(
        path.join(BACKEND_ROOT, 'src/services/ffeGptFirstValidation.service.ts')
    );

    const prompt = buildGptFirstSystemPrompt();
    assert.equal(
        FFE_GPT_FIRST_PROMPT_VERSION,
        'ffe-gpt-first-v2.9.3-aggregate-driver-distinction',
        'prompt version must be bumped for aggregate vs driver distinction',
    );

    for (const needle of REQUIRED) {
        assert.ok(prompt.includes(needle), `missing prompt section: ${needle}`);
    }

    assert.equal(ALLOWED_SCORES.size, 7, 'validator ALLOWED_SCORES must remain seven values');
    assert.ok(!ALLOWED_SCORES.has(0.75), 'validator must not accept 0.75');
    assert.ok(!ALLOWED_SCORES.has(-0.75), 'validator must not accept -0.75');

    const fixtureDir = path.resolve(BACKEND_ROOT, '../docs/exact-prompts');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'PROMPT-VERSION.txt'), `${FFE_GPT_FIRST_PROMPT_VERSION}\n`, 'utf8');
    await fs.writeFile(
        path.join(fixtureDir, `CURRENT-SYSTEM-PROMPT-${FFE_GPT_FIRST_PROMPT_VERSION}.txt`),
        `${prompt}\n`,
        'utf8',
    );

    console.log(JSON.stringify({
        test: 'PASS',
        prompt_version: FFE_GPT_FIRST_PROMPT_VERSION,
        prompt_length: prompt.length,
        validator_allowed_scores: [...ALLOWED_SCORES].sort((a, b) => a - b),
        fixture: path.join(fixtureDir, `CURRENT-SYSTEM-PROMPT-${FFE_GPT_FIRST_PROMPT_VERSION}.txt`),
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
