import fs from 'node:fs/promises';
import path from 'node:path';
import {
    getAiEvaluationTelemetry,
    resetAiEvaluationTelemetry,
} from '../src/services/groqClassifier.service.js';
import {
    FFE_SESSION_BRAIN_PROMPT_VERSION,
    synthesizeFfeSessionBrain,
    fingerprintSessionLedger,
    type EvidenceEvent,
    type SessionEvidenceLedger,
} from '../src/services/ffeSessionBrain.service.js';
import { ENV } from '../src/config/env.js';

const root = path.resolve(process.cwd(), '..');
const dir = path.join(root, 'replay-fixtures');
const previousPath = path.join(dir, 'aug18-financialjuice-session-brain-results-v5.json');
const themesPath = path.join(dir, 'aug18-financialjuice-session-brain-themes-v5.json');
const boardPath = path.join(dir, 'aug18-financialjuice-session-brain-board-v6.json');
const summaryPath = path.join(dir, 'aug18-financialjuice-session-brain-run-summary-v6.md');

function parseTime(value: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/.exec(value);
    return match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+04:00` : value;
}

function cost(attempts: ReturnType<typeof getAiEvaluationTelemetry>): number {
    return attempts.reduce((sum, attempt) => {
        const openai = attempt.provider === 'openai';
        const input = Number(attempt.usage.inputTokens ?? 0);
        const cached = Math.min(input, Number(attempt.usage.cachedInputTokens ?? 0));
        const output = Number(attempt.usage.outputTokens ?? 0);
        const inputRate = Number(openai ? ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_INPUT_PRICE_PER_MILLION);
        const cacheRate = Number(openai ? ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_CACHED_INPUT_PRICE_PER_MILLION);
        const outputRate = Number(openai ? ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION : ENV.AI_GROQ_OUTPUT_PRICE_PER_MILLION);
        return sum + ((input - cached) * inputRate + cached * cacheRate + output * outputRate) / 1_000_000;
    }, 0);
}

async function main(): Promise<void> {
    const previous = JSON.parse(await fs.readFile(previousPath, 'utf8')) as { rows: any[] };
    const themesArtifact = JSON.parse(await fs.readFile(themesPath, 'utf8')) as { themes: any[] };
    const rows = previous.rows;
    const events = new Map<string, EvidenceEvent>();
    for (const row of rows) {
        if (!row.canonicalEventId || events.has(row.canonicalEventId)) continue;
        events.set(row.canonicalEventId, {
            id: row.canonicalEventId, guid: row.guid, headline: row.headline, time: parseTime(row.time),
            relation: row.eventRelation ?? 'NEW_EVENT', status: row.eventDuplicateOf ? 'CONFIRMATION' : 'ACTIVE',
            themeId: row.canonicalThemeId, summary: row.summary, confirmation: Boolean(row.eventDuplicateOf),
            actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null,
        });
    }
    const ledger: SessionEvidenceLedger = {
        dayKey: '2026-08-18', source: 'FinancialJuice', asOf: '2026-08-18T22:47:00+04:00',
        events: [...events.values()],
        themes: themesArtifact.themes.map((theme) => ({
            id: theme.id, key: theme.themeKey, label: theme.label, summary: theme.summary, status: theme.status,
            geoState: theme.geoState, firstSeenAt: theme.firstSeenAt, lastUpdatedAt: theme.lastUpdatedAt,
            supportingEventIds: theme.supportingEventIds ?? [], supportingGuids: [], candidateAssetHints: theme.assetContributions ?? [],
        })),
        macroEvidence: rows.filter((row) => row.macro?.eligible).map((row) => ({ guid: row.guid, headline: row.headline, time: parseTime(row.time), family: row.macro.family, directionSummary: row.macro.directionSummary, actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null })),
        geopoliticalEvidence: rows.filter((row) => row.geoState && row.geoState !== 'IRRELEVANT').map((row) => ({ guid: row.guid, headline: row.headline, time: parseTime(row.time), state: row.geoState, summary: row.summary })),
        confirmationEvidence: rows.filter((row) => row.eventDuplicateOf || row.contributionType === 'CONFIRMATION').map((row) => ({ guid: row.guid, headline: row.headline, time: parseTime(row.time), reason: row.summary || 'Confirmation evidence' })),
        priorSnapshot: null,
    };
    resetAiEvaluationTelemetry();
    const result = await synthesizeFfeSessionBrain(ledger, { recordUsage: false, ingestId: 'shadow:aug18-session-brain-v6-final-revalidation' });
    if (!result) throw new Error('Final range-constrained Session Brain revalidation returned no valid snapshot');
    const attempts = getAiEvaluationTelemetry();
    const usage = {
        aiCalls: attempts.length,
        successfulCalls: attempts.filter((row) => row.requestStatus === 'success').length,
        failedCalls: attempts.filter((row) => row.requestStatus === 'error').length,
        inputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.inputTokens ?? 0), 0),
        cachedInputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.cachedInputTokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.outputTokens ?? 0), 0),
        totalTokens: attempts.reduce((sum, row) => sum + Number(row.usage.totalTokens ?? 0), 0),
        estimatedCostUsd: Number(cost(attempts).toFixed(8)),
    };
    const board = { generatedAt: new Date().toISOString(), replayDate: '2026-08-18', source: 'FinancialJuice', promptVersion: FFE_SESSION_BRAIN_PROMPT_VERSION, sourceEvidence: previousPath, ledgerFingerprint: fingerprintSessionLedger(ledger), finalSnapshot: result.output, usage, oldDecisionsSentToAi: false, isolated: true, verdict: 'SESSION BRAIN STILL DIFFERS MATERIALLY FROM CLIENT GPT - DO NOT DEPLOY' };
    await fs.writeFile(boardPath, JSON.stringify(board, null, 2));
    await fs.writeFile(summaryPath, [
        '# Aug 18 FinancialJuice final Session Brain revalidation', '',
        '- This is a single final range-constrained replacement-snapshot revalidation over the already generated blind evidence ledger.',
        '- No old website decision fields were provided as model input; no application database, queue, scraper, or production state was written.',
        `- Ledger fingerprint: ${board.ledgerFingerprint}`, `- Estimated revalidation cost: $${usage.estimatedCostUsd}`, '',
        '## Final Catalyst board', '', '~~~json', JSON.stringify(result.output.catalystBoard, null, 2), '~~~', '',
        '## Verdict', '', board.verdict, '',
    ].join('\n'));
    console.log(JSON.stringify({ boardPath, summaryPath, usage, board: result.output.catalystBoard, verdict: board.verdict }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
