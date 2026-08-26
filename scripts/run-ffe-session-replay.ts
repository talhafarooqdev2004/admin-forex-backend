import fs from 'node:fs/promises';
import path from 'node:path';
import {
    classifyHeadlines,
    getAiEvaluationTelemetry,
    resetAiEvaluationTelemetry,
    TRACKED_ASSETS,
    type ClassifiedHeadline,
    type ExistingCanonicalTheme,
    type ExistingTopic,
} from '../src/services/groqClassifier.service.js';
import {
    InMemoryCanonicalThemeRegistry,
    type CanonicalThemeContext,
} from '../src/services/canonicalThemeRegistry.service.js';
import {
    FFE_SESSION_BRAIN_PROMPT_VERSION,
    fingerprintSessionLedger,
    synthesizeFfeSessionBrain,
    type EvidenceEvent,
    type SessionBrainOutput,
    type SessionEvidenceLedger,
} from '../src/services/ffeSessionBrain.service.js';
import { ENV } from '../src/config/env.js';

type ReplayInput = {
    time: string;
    source: string;
    guid: string;
    headline: string;
    actual?: string;
    forecast?: string;
    previous?: string;
};

type ReplayRow = ReplayInput & {
    index: number;
    batch: number;
    category: ClassifiedHeadline['category'];
    impact: ClassifiedHeadline['impact'];
    summary: string;
    fundamentalCause: string | null;
    eventRelation: ClassifiedHeadline['eventRelation'] | null;
    eventDuplicateOf: string | null;
    canonicalThemeId: string | null;
    canonicalEventId: string | null;
    macro: NonNullable<ClassifiedHeadline['macro']>;
    geoState: string | null;
    assets: ClassifiedHeadline['assets'];
    contributionType: 'MACRO_ONLY' | 'INDEPENDENT' | 'THEME_UPDATE' | 'CONFIRMATION' | 'CONTEXT_ONLY' | 'DUPLICATE' | 'IRRELEVANT';
};

const root = path.resolve(process.cwd(), '..');
const fixturePath = path.join(root, 'replay-fixtures', 'financialjuice-2026-08-18-ai-replay.json');
const outDir = path.join(root, 'replay-fixtures');
const resultsPath = path.join(outDir, 'aug18-financialjuice-session-brain-results-v5.json');
const boardPath = path.join(outDir, 'aug18-financialjuice-session-brain-board-v5.json');
const themesPath = path.join(outDir, 'aug18-financialjuice-session-brain-themes-v5.json');
const summaryPath = path.join(outDir, 'aug18-financialjuice-session-brain-run-summary-v5.md');
const comparisonPath = path.join(outDir, 'aug18-financialjuice-session-brain-client-comparison-v5.md');
const BATCH_SIZE = 12;

function parseDubaiIso(value: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error(`Invalid replay timestamp: ${value}`);
    return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+04:00`;
}

function epoch(value: string): number { return Date.parse(parseDubaiIso(value)); }

function toExistingThemes(themes: CanonicalThemeContext[]): ExistingCanonicalTheme[] {
    return themes.map((theme) => ({
        id: theme.id,
        themeKey: theme.themeKey,
        label: theme.label,
        summary: theme.summary,
        status: theme.status,
        geoState: theme.geoState,
        assets: theme.assetContributions,
        score: theme.assetContributions.reduce((sum, row) => sum + row.score, 0),
        lastUpdatedAt: theme.lastUpdatedAt,
    }));
}

function toContributionType(row: ClassifiedHeadline, duplicate: string | null, canonicalAction: string): ReplayRow['contributionType'] {
    if (duplicate) return 'DUPLICATE';
    if (row.category === 'ECONOMIC' || row.macro?.eligible || canonicalAction === 'MACRO_ONLY') return 'MACRO_ONLY';
    if (row.category === 'IRRELEVANT' || canonicalAction === 'IRRELEVANT') return 'IRRELEVANT';
    const scored = row.assets.some((asset) => asset.role !== 'CONFIRMATION' && asset.score !== 0);
    if (canonicalAction === 'CONTEXT_ONLY' || row.eventRelation === 'CONTEXT_ONLY' || !scored) return 'CONTEXT_ONLY';
    if (canonicalAction === 'UPDATE_EXISTING_THEME' || canonicalAction === 'REVERSE_EXISTING_THEME') return 'THEME_UPDATE';
    if (row.eventRelation === 'SAME_EVENT' || row.eventRelation === 'EVENT_UPDATE' || canonicalAction === 'JOIN_EXISTING_THEME') return 'CONFIRMATION';
    return 'INDEPENDENT';
}

function ledgerFromRows(
    dayKey: string,
    rows: ReplayRow[],
    registry: InMemoryCanonicalThemeRegistry,
    priorSnapshot: SessionBrainOutput | null,
): SessionEvidenceLedger {
    const eventById = new Map<string, EvidenceEvent>();
    for (const row of rows) {
        if (!row.canonicalEventId) continue;
        const event: EvidenceEvent = {
            id: row.canonicalEventId,
            guid: row.guid,
            headline: row.headline,
            time: parseDubaiIso(row.time),
            relation: row.eventRelation ?? 'NEW_EVENT',
            status: row.eventDuplicateOf ? 'CONFIRMATION' : 'ACTIVE',
            themeId: row.canonicalThemeId,
            summary: row.summary,
            confirmation: Boolean(row.eventDuplicateOf) || ['SAME_EVENT', 'EVENT_UPDATE', 'CONTEXT_ONLY'].includes(String(row.eventRelation)),
            actual: row.actual ?? null,
            forecast: row.forecast ?? null,
            previous: row.previous ?? null,
        };
        eventById.set(row.canonicalEventId, event);
    }
    const events = [...eventById.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const eventToGuid = new Map(events.map((event) => [event.id, event.guid]));
    const themes = registry.list().map((theme) => ({
        id: theme.id,
        key: theme.themeKey,
        label: theme.label,
        summary: theme.summary,
        status: theme.status,
        geoState: theme.geoState,
        firstSeenAt: theme.firstSeenAt,
        lastUpdatedAt: theme.lastUpdatedAt,
        supportingEventIds: theme.supportingEventIds,
        supportingGuids: theme.supportingEventIds.map((id) => eventToGuid.get(id)).filter((guid): guid is string => Boolean(guid)),
        candidateAssetHints: theme.assetContributions,
    }));
    const macroEvidence = rows.filter((row) => row.macro.eligible).map((row) => ({
        guid: row.guid, headline: row.headline, time: parseDubaiIso(row.time), family: row.macro.family,
        directionSummary: row.macro.directionSummary, actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null,
    }));
    const geopoliticalEvidence = rows.filter((row) => row.geoState && row.geoState !== 'IRRELEVANT').map((row) => ({
        guid: row.guid, headline: row.headline, time: parseDubaiIso(row.time), state: row.geoState, summary: row.summary,
    }));
    const confirmationEvidence = rows.filter((row) => row.contributionType === 'CONFIRMATION' || row.contributionType === 'DUPLICATE' || row.eventRelation === 'CONTEXT_ONLY').map((row) => ({
        guid: row.guid, headline: row.headline, time: parseDubaiIso(row.time), reason: row.summary || row.eventRelation || row.contributionType,
    }));
    return {
        dayKey,
        source: 'FinancialJuice',
        asOf: rows.length ? parseDubaiIso(rows[rows.length - 1]!.time) : new Date().toISOString(),
        events,
        themes,
        macroEvidence,
        geopoliticalEvidence,
        confirmationEvidence,
        priorSnapshot,
    };
}

function cost(attempts: ReturnType<typeof getAiEvaluationTelemetry>): number {
    return attempts.reduce((sum, attempt) => {
        const openai = attempt.provider === 'openai';
        const inputRate = Number(openai ? ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_INPUT_PRICE_PER_MILLION);
        const cacheRate = Number(openai ? ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_CACHED_INPUT_PRICE_PER_MILLION);
        const outputRate = Number(openai ? ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION : ENV.AI_GROQ_OUTPUT_PRICE_PER_MILLION);
        const input = Number(attempt.usage.inputTokens ?? 0);
        const cached = Math.min(input, Number(attempt.usage.cachedInputTokens ?? 0));
        const output = Number(attempt.usage.outputTokens ?? 0);
        return sum + ((input - cached) * inputRate + cached * cacheRate + output * outputRate) / 1_000_000;
    }, 0);
}

function direction(score: number): 'bullish' | 'bearish' | 'neutral' {
    return score > 0.1 ? 'bullish' : score < -0.1 ? 'bearish' : 'neutral';
}

const CLIENT_CATALYST_EXPECTED: Record<string, { direction: string; min: number; max: number; note: string }> = {
    USD: { direction: 'bullish', min: 0.75, max: 1.25, note: 'Geopolitics + US-yield repricing; DXY reaction is confirmation.' },
    EUR: { direction: 'bearish', min: -0.75, max: -0.25, note: 'Geopolitical/oil drag; ZEW is Macro, not a Catalyst driver.' },
    GBP: { direction: 'bearish', min: -0.5, max: -0.25, note: 'Geopolitical drag; UK jobs remain Macro.' },
    JPY: { direction: 'bearish', min: -0.75, max: -0.5, note: 'Oil/import and yield pressure; no unconfirmed haven bonus.' },
    CHF: { direction: 'bullish', min: 0.5, max: 0.5, note: 'One geopolitical safe-haven component.' },
    CAD: { direction: 'bullish', min: 0.5, max: 1, note: 'One oil-to-CAD causal chain.' },
    AUD: { direction: 'bearish', min: -0.75, max: -0.5, note: 'Geopolitics plus China drag; Westpac Macro is separate.' },
    NZD: { direction: 'bearish', min: -0.75, max: -0.5, note: 'Geopolitics plus China/dairy evidence; reactions are confirmation.' },
    GOLD: { direction: 'bearish', min: -0.5, max: 0, note: 'USD/yield pressure; gold price reactions are confirmation.' },
    OIL: { direction: 'bullish', min: 0.75, max: 1, note: 'One confirmed crude/supply causal chain.' },
};

async function main(): Promise<void> {
    await fs.mkdir(outDir, { recursive: true });
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as ReplayInput[];
    if (fixture.length !== 195) throw new Error(`Expected 195 rows, got ${fixture.length}`);
    if (fixture.some((row) => row.source !== 'FinancialJuice')) throw new Error('Non-FinancialJuice input');
    if (new Set(fixture.map((row) => row.guid)).size !== fixture.length) throw new Error('Duplicate GUID in fixture');
    if (fixture.some((row, index) => index > 0 && epoch(fixture[index - 1]!.time) > epoch(row.time))) throw new Error('Fixture is not chronological');

    resetAiEvaluationTelemetry();
    const registry = new InMemoryCanonicalThemeRegistry('2026-08-18');
    const rows: ReplayRow[] = [];
    let existingTopics: ExistingTopic[] = [];
    let priorSnapshot: SessionBrainOutput | null = null;
    const checkpoints: Array<{ batch: number; rows: number; fingerprint: string; synthesisChanged: boolean; snapshot: SessionBrainOutput | null; error: string | null }> = [];

    for (let offset = 0; offset < fixture.length; offset += BATCH_SIZE) {
        const batch = fixture.slice(offset, offset + BATCH_SIZE);
        const classified = await classifyHeadlines(
            batch.map((item) => ({ text: item.headline, publishedAt: new Date(parseDubaiIso(item.time)) })),
            existingTopics,
            {
                operationType: 'classification',
                recordUsage: false,
                ingestId: 'shadow:aug18-session-brain-v5',
                existingThemes: toExistingThemes(registry.list()),
            },
        );
        if (classified.length !== batch.length) throw new Error(`Batch ${Math.floor(offset / BATCH_SIZE) + 1} returned ${classified.length}/${batch.length}`);
        const byIndex = new Map(classified.map((row) => [row.index, row]));
        for (let local = 0; local < batch.length; local += 1) {
            const input = batch[local]!;
            const decision = byIndex.get(local)!;
            const duplicateRef = decision.eventDuplicateOf
                ?? (decision.duplicateOfBatchIndex == null ? decision.duplicateOfExistingId : batch[decision.duplicateOfBatchIndex]?.guid ?? null);
            const themeResult = ['ECONOMIC', 'IRRELEVANT'].includes(decision.category)
                ? { eventId: null, themeId: null, themeAction: decision.category === 'ECONOMIC' ? 'MACRO_ONLY' : 'IRRELEVANT' }
                : registry.apply({
                    action: decision.themeDecision?.action,
                    themeId: decision.themeDecision?.themeId ?? null,
                    themeKey: decision.themeDecision?.themeKey ?? decision.causalThemeId ?? null,
                    label: decision.themeDecision?.label ?? decision.driverTheme ?? null,
                    summary: decision.themeDecision?.summary ?? decision.causalThemeSummary ?? decision.summary,
                    reason: decision.themeDecision?.reason ?? decision.reason ?? null,
                    status: decision.themeDecision?.status ?? 'ACTIVE',
                    geoState: decision.geoState ?? null,
                    eventRelation: decision.eventRelation ?? null,
                    assetContributions: decision.themeDecision?.assetContributions ?? decision.assets,
                    confidence: decision.confidence ?? 0,
                });
            rows.push({
                ...input,
                index: offset + local,
                batch: Math.floor(offset / BATCH_SIZE) + 1,
                category: decision.category,
                impact: decision.impact,
                summary: decision.summary,
                fundamentalCause: decision.fundamentalCause ?? null,
                eventRelation: decision.eventRelation ?? null,
                eventDuplicateOf: duplicateRef,
                canonicalThemeId: themeResult.themeId,
                canonicalEventId: themeResult.eventId,
                macro: decision.macro ?? { eligible: false, family: null, directionSummary: null, assetScores: [] },
                geoState: decision.geoState ?? null,
                assets: decision.assets,
                contributionType: toContributionType(decision, duplicateRef, themeResult.themeAction),
            });
        }
        for (const row of rows.slice(-batch.length)) {
            if (!row.eventDuplicateOf) existingTopics = [{ id: row.guid, text: row.headline, publishedAt: new Date(parseDubaiIso(row.time)) }, ...existingTopics].slice(0, 50);
        }

        const ledger = ledgerFromRows('2026-08-18', rows, registry, priorSnapshot);
        const fingerprint = fingerprintSessionLedger(ledger);
        const result = await synthesizeFfeSessionBrain(ledger, { recordUsage: false, ingestId: `shadow:aug18-session-brain-v5:batch-${Math.floor(offset / BATCH_SIZE) + 1}` });
        if (result) priorSnapshot = result.output;
        checkpoints.push({
            batch: Math.floor(offset / BATCH_SIZE) + 1,
            rows: rows.length,
            fingerprint,
            synthesisChanged: Boolean(result),
            snapshot: result?.output ?? priorSnapshot,
            error: result ? null : 'Session Brain returned no valid snapshot',
        });
        console.log(JSON.stringify({ event: 'ffe_session_brain_checkpoint', batch: checkpoints.at(-1)!.batch, rows: rows.length, themes: registry.list().length, synthesis: Boolean(result) }));
    }

    const attempts = getAiEvaluationTelemetry();
    const usage = {
        aiCalls: attempts.length,
        successfulCalls: attempts.filter((row) => row.requestStatus === 'success').length,
        failedCalls: attempts.filter((row) => row.requestStatus === 'error').length,
        evidenceOrganizerCalls: attempts.filter((row) => ['classification', 'semantic_adjudication'].includes(row.operationType)).length,
        sessionBrainCalls: attempts.filter((row) => row.operationType === 'session_synthesis').length,
        reviewerCalls: attempts.filter((row) => row.operationType === 'session_review').length,
        cachedInputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.cachedInputTokens ?? 0), 0),
        inputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.outputTokens ?? 0), 0),
        reasoningTokens: attempts.reduce((sum, row) => sum + Number(row.usage.reasoningTokens ?? 0), 0),
        totalTokens: attempts.reduce((sum, row) => sum + Number(row.usage.totalTokens ?? 0), 0),
        estimatedCostUsd: Number(cost(attempts).toFixed(8)),
        pricingUsed: {
            openaiInputPerMillion: ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION,
            openaiCachedInputPerMillion: ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
            openaiOutputPerMillion: ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION,
        },
    };
    const finalSnapshot = priorSnapshot;
    const directionAgreement = finalSnapshot
        ? finalSnapshot.catalystBoard.map((row) => {
            const expected = CLIENT_CATALYST_EXPECTED[row.asset]!;
            const actual = direction(row.score);
            return { asset: row.asset, clientExpected: expected.direction, sessionDirection: actual, sessionScore: row.score, min: expected.min, max: expected.max, scoreInRange: row.score >= expected.min && row.score <= expected.max, agreement: actual === expected.direction && row.score >= expected.min && row.score <= expected.max ? 'MATCH' : 'MATERIAL_MISMATCH', note: expected.note };
        })
        : [];
    const matchCount = directionAgreement.filter((row) => row.agreement === 'MATCH').length;
    const acceptance = {
        sourceFinancialJuiceOnly: fixture.every((row) => row.source === 'FinancialJuice'),
        finalTenAssetDirectionAgreement: `${matchCount}/10`,
        finalTenAssetDirectionAgreementPassed: matchCount === 10,
        sessionBrainProduced: Boolean(finalSnapshot),
        noOldWebsiteDecisionsSentToAi: true,
        chronology: '01:07 through 22:47 Asia/Dubai',
        replayIsolated: true,
    };
    const verdict = !finalSnapshot
        ? 'VALIDATION INCOMPLETE - DO NOT DEPLOY'
        : matchCount === 10
            ? 'CLIENT-GPT-STYLE FFE SESSION BRAIN VERIFIED - READY FOR FINAL DEPLOYMENT PREP'
            : 'SESSION BRAIN STILL DIFFERS MATERIALLY FROM CLIENT GPT - DO NOT DEPLOY';

    const summary = {
        generatedAt: new Date().toISOString(), replayDate: '2026-08-18', inputFixture: fixturePath,
        inputRows: fixture.length, source: 'FinancialJuice', chronology: acceptance.chronology,
        promptVersion: FFE_SESSION_BRAIN_PROMPT_VERSION, batchSize: BATCH_SIZE,
        oldDecisionsSentToAi: false, isolated: true, checkpoints, uniqueCanonicalThemes: registry.list().length,
        uniqueCanonicalEvents: new Set(rows.map((row) => row.canonicalEventId).filter(Boolean)).size,
        categories: rows.reduce<Record<string, number>>((counts, row) => { counts[row.category] = (counts[row.category] ?? 0) + 1; return counts; }, {}),
        contributionTypes: rows.reduce<Record<string, number>>((counts, row) => { counts[row.contributionType] = (counts[row.contributionType] ?? 0) + 1; return counts; }, {}),
        usage, acceptance, directionAgreement, finalSnapshot, verdict,
        artifacts: { resultsPath, boardPath, themesPath, summaryPath, comparisonPath },
    };
    await fs.writeFile(resultsPath, JSON.stringify({ ...summary, rows }, null, 2));
    await fs.writeFile(boardPath, JSON.stringify({ generatedAt: summary.generatedAt, replayDate: summary.replayDate, promptVersion: FFE_SESSION_BRAIN_PROMPT_VERSION, finalSnapshot, directionAgreement, acceptance, usage, verdict }, null, 2));
    await fs.writeFile(themesPath, JSON.stringify({ generatedAt: summary.generatedAt, replayDate: summary.replayDate, themes: registry.list(), eventCount: summary.uniqueCanonicalEvents }, null, 2));
    await fs.writeFile(comparisonPath, [
        '# Aug 18 FinancialJuice Session Brain client comparison', '',
        'The Session Brain received only the clean FinancialJuice replay and the chronological canonical evidence ledger. The old website classification, scores, themes, geo labels, duplicate decisions, and reasons were not sent as input.', '',
        `- Rows replayed: ${fixture.length}`, `- Session checkpoints: ${checkpoints.length}`, `- Evidence organizer calls: ${usage.evidenceOrganizerCalls}`, `- Session Brain calls: ${usage.sessionBrainCalls}`, `- Estimated cost: $${usage.estimatedCostUsd}`, '',
        '| Asset | Client direction | Session direction | Session score | Expected range | Result |', '| --- | --- | --- | ---: | ---: | --- |',
        ...directionAgreement.map((row) => `| ${row.asset} | ${row.clientExpected} | ${row.sessionDirection} | ${row.sessionScore} | ${row.min} to ${row.max} | ${row.agreement} |`), '',
        '## Methodology checks', '',
        '- Macro releases stay in the Macro board and do not become independent Catalyst drivers.',
        '- Reaction/settlement headlines are retained as confirmation evidence and do not add a second driver.',
        '- Hormuz/Oil/CAD and USD safe-haven chains are represented as causal clusters, not headline counts.',
        '- The final Catalyst board is the Session Brain replacement snapshot; code does not sum theme scores.', '',
        `## Verdict`, '', verdict, '',
    ].join('\n'));
    await fs.writeFile(summaryPath, [
        '# Aug 18 FinancialJuice Global Session Brain replay summary', '',
        `- Status: isolated chronological replay; no application database, queue, archive, scraper, or production state was written.`,
        `- Input fixture: ${fixturePath}`, `- Rows: ${fixture.length}`, `- Chronology: ${acceptance.chronology}`,
        `- Prompt version: ${FFE_SESSION_BRAIN_PROMPT_VERSION}`, `- Checkpoints: ${checkpoints.length}`,
        '', '## Usage and cost', '', '~~~json', JSON.stringify(usage, null, 2), '~~~',
        '', `- 30-day same-volume projection: $${(usage.estimatedCostUsd * 30).toFixed(4)}. This is a measured replay extrapolation, not a billing guarantee; unchanged ledger fingerprints produce zero Session Brain calls.`,
        '', '## Acceptance gates', '', '~~~json', JSON.stringify(acceptance, null, 2), '~~~',
        '', '## Final board', '', '~~~json', JSON.stringify(finalSnapshot, null, 2), '~~~',
        '', '## Verdict', '', verdict, '',
    ].join('\n'));
    console.log(JSON.stringify({ event: 'ffe_session_brain_replay_complete', ...summary }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});
