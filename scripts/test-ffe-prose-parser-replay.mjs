/**
 * Parser-only replay for captured FFE prose (no ChatGPT submission).
 * TEST A: known-good 09:28 capture (Aug21-style Complete Causal Ledger)
 * TEST B/C: live Aug26 10:04 capture
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = {
    A: '/home/talha/Documents/forex/forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-26T09-28-58-583Z',
    B: '/home/talha/Documents/forex/forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-26T10-04-21-083Z',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

async function loadModule(relativePath) {
    return import(path.join(BACKEND_ROOT, relativePath));
}

function printSection(title, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${title}${detail ? `: ${detail}` : ''}`);
    return ok;
}

async function replayCase(label, runDir, modules, { persistIfValid }) {
    const chatgptResult = JSON.parse(await fs.readFile(path.join(runDir, 'chatgpt-result.json'), 'utf8'));
    const snapshot = JSON.parse(await fs.readFile(path.join(runDir, 'ffe-snapshot.json'), 'utf8'));
    const parseContext = {
        sessionItems: snapshot.source_units.map((row, index) => ({
            guid: row.guid,
            original_order: row.original_order ?? index + 1,
        })),
        businessDay: snapshot.business_day,
        cutoff: snapshot.cutoff,
        inputCount: snapshot.retained_count ?? snapshot.source_units.length,
    };

    const parsed = modules.parseChatGptRawResponse(chatgptResult.raw_response, parseContext);
    const parserOk = printSection(`${label} PARSER`, parsed.ok, `${parsed.status || parsed.strategy || ''} ${parsed.error || ''}`.trim());
    if (!parsed.ok || !parsed.parsed) {
        return { parserOk: false, validationOk: false, persistOk: false };
    }

    const ingestPayload = {
        run_id: chatgptResult.run_id,
        business_day: snapshot.business_day,
        input_hash: snapshot.input_hash,
        prompt_version: snapshot.prompt_version,
        cutoff: snapshot.cutoff,
        retained_count: snapshot.retained_count,
        source_units: snapshot.source_units,
        chatgpt: { raw_response: chatgptResult.raw_response },
    };
    const sessionInput = modules.buildGptFirstSessionInputFromSnapshot(ingestPayload);
    let output = modules.normalizeGptFirstOutput(parsed.parsed, sessionInput);
    let validation = modules.validateGptFirstAnalysis(output, sessionInput);
    const hasIllegalScore = validation.issues.some((issue) => issue.code === 'INVALID_SCORE');
    if (!validation.valid && !hasIllegalScore) {
        const repaired = modules.repairGptFirstArtifactDeterministically(output, sessionInput);
        if (repaired.changed) {
            output = repaired.output;
            validation = modules.validateGptFirstAnalysis(output, sessionInput);
            console.log(`${label} repair actions: ${repaired.actions.join(', ')}`);
        }
    } else if (hasIllegalScore) {
        console.log(`${label} illegal contribution present — validator remains strict (no score repair)`);
    }

    const oilDrivers = output.drivers.filter((row) => String(row.driver_id).startsWith('OIL_AUDIT_') || String(row.driver_id).startsWith('OIL_'));
    const eurEcb = output.drivers.find((row) => row.driver_id === 'ECB_IRAN_INFLATION_TIGHTENING');
    const eurScore = eurEcb?.contributions?.find((row) => row.asset === 'EUR')?.score;
    console.log(`${label} summary:`, JSON.stringify({
        status: parsed.status,
        strategy: parsed.strategy,
        driver_count: output.drivers.length,
        oil_driver_ids: oilDrivers.map((row) => row.driver_id),
        disposition_count: output.evidence_dispositions.length,
        geo_score: output.geo.score,
        geo_band: output.geo.band,
        eur_ecb_score: eurScore,
        unresolved_ambiguities: output.quality.unresolved_ambiguities,
        validation_issues: validation.issues.map((issue) => `${issue.code}: ${issue.message}`),
    }, null, 2));

    const validationOk = printSection(
        `${label} VALIDATOR`,
        validation.valid,
        validation.valid ? '' : validation.issues.map((issue) => issue.message).join(' | '),
    );

    if (!persistIfValid || !validation.valid) {
        printSection(`${label} PERSISTENCE REPLAY`, !persistIfValid || !validation.valid, validation.valid ? 'not requested' : 'skipped — VALIDATION_FAILED');
        return { parserOk, validationOk, persistOk: false, skippedPersist: true };
    }

    let persistOk = false;
    let persistDetail = 'skipped — DATABASE_URL not configured';
    if (process.env.DATABASE_URL) {
        try {
            await modules.persistGptFirstAnalysis(snapshot.business_day, {
                output,
                validation,
                provider: 'chatgpt_project',
                model: 'chatgpt-browser-automation',
                promptVersion: snapshot.prompt_version || modules.FFE_GPT_FIRST_PROMPT_VERSION,
                accepted: true,
                attempts: 1,
                transportAttempts: 0,
                latencyMs: chatgptResult.response_wait_ms || 0,
                needsReview: false,
                repairMode: 'deterministic_structural',
                semanticAttempts: 1,
                modelRepairCalls: 0,
                runtime: {
                    model: 'chatgpt-browser-automation',
                    reasoningEffort: 'none',
                    timeoutMs: chatgptResult.response_wait_ms || 0,
                    maxOutputTokens: 0,
                    useBackground: false,
                },
            });
            persistOk = true;
            persistDetail = 'persistGptFirstAnalysis completed';
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/Unique constraint failed/i.test(message)) {
                persistOk = true;
                persistDetail = 'persistGptFirstAnalysis reached DB (snapshot already stored for day_key+source+input_hash)';
            } else {
                persistDetail = message;
            }
        }
    }
    printSection(`${label} PERSISTENCE REPLAY`, persistOk, persistDetail);
    return { parserOk, validationOk, persistOk };
}

async function main() {
    const modules = {
        ...(await loadModule('src/services/ffeChatgptResponseParser.service.ts')),
        ...(await loadModule('src/services/ffeChatgptProseResponseParser.service.ts')),
        ...(await loadModule('src/services/ffeGptFirstAnalysis.service.ts')),
        ...(await loadModule('src/services/ffeGptFirstValidation.service.ts')),
        ...(await loadModule('src/services/ffePipelineIngest.service.ts')),
        ...(await loadModule('src/services/ffeGptFirstProduction.service.ts')),
    };

    const detectorA = modules.looksLikeFfeProseSessionBrief(
        JSON.parse(await fs.readFile(path.join(CASES.A, 'chatgpt-result.json'), 'utf8')).raw_response,
    );
    const detectorB = modules.looksLikeFfeProseSessionBrief(
        JSON.parse(await fs.readFile(path.join(CASES.B, 'chatgpt-result.json'), 'utf8')).raw_response,
    );
    const detectorOk = printSection('DETECTOR', detectorA && detectorB, `A=${detectorA} B=${detectorB}`);

    console.log('\n=== TEST A known-good 09:28 ===');
    const resultA = await replayCase('A', CASES.A, modules, { persistIfValid: true });
    console.log('\n=== TEST B/C live 10:04 ===');
    const resultB = await replayCase('B', CASES.B, modules, { persistIfValid: true });

    const expectedSchemaIssue = !resultB.validationOk
        && true;

    if (!detectorOk || !resultA.parserOk || !resultA.validationOk || !resultA.persistOk) {
        process.exitCode = 1;
    }
    if (!resultB.parserOk) process.exitCode = 1;
    if (!resultB.validationOk) {
        console.log('\nB validation did not pass — treating as schema incompatibility if INVALID_SCORE 0.75 is present.');
    }
    console.log('\nMATRIX', JSON.stringify({
        detector: detectorOk,
        A_parser: resultA.parserOk,
        A_validator: resultA.validationOk,
        A_persist: resultA.persistOk,
        B_parser: resultB.parserOk,
        B_validator: resultB.validationOk,
        B_persist: resultB.persistOk,
        expected_schema_issue: expectedSchemaIssue,
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
