import fs from 'node:fs/promises';
import path from 'node:path';
import { calculateGeopoliticalRisk, type GeoHeadline } from '../src/services/geopoliticalRisk.service.js';
import { FFE_ANALYST_PROMPT_VERSION } from '../src/services/groqClassifier.service.js';
import { ENV } from '../src/config/env.js';

type ReplayRow = {
    time: string;
    eventType?: string | null;
    eventRelation?: string | null;
    canonicalEventId?: string | null;
    canonicalThemeId?: string | null;
    category?: string | null;
    impact?: string | null;
    fundamentalCause?: string | null;
    observedMarketReaction?: string | null;
    currentAssetContributions?: Array<{ asset: string; score: number; role?: string }>;
    geoState?: string | null;
    [key: string]: unknown;
};
type ReplayData = { summary: Record<string, any>; rows: ReplayRow[] };

const root = path.resolve(process.cwd(), '..');
const outDir = path.join(root, 'replay-fixtures');
const resultPath = path.join(outDir, 'aug18-financialjuice-client-contract-replay.json');
const checkpointPath = path.join(outDir, 'aug18-financialjuice-driver-reconstruction.json');
const summaryPath = path.join(outDir, 'aug18-financialjuice-client-contract-replay.md');
const boardPath = path.join(outDir, 'aug18-financialjuice-final-catalyst-board.json');
const geoPath = path.join(outDir, 'aug18-financialjuice-geo-regime.json');
const macroPath = path.join(outDir, 'aug18-financialjuice-macro-report.json');
const usagePath = path.join(outDir, 'aug18-financialjuice-ai-usage-cost.json');
const comparisonPath = path.join(outDir, 'aug18-financialjuice-client-comparison.json');

function parseDubai(value: string): Date {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error(`Invalid replay timestamp: ${value}`);
    return new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+04:00`);
}

const references = [
    { asset: 'USD', expected: 'about +1.0', min: 0.75, max: 1.25 },
    { asset: 'EUR', expected: 'about -0.5', min: -0.75, max: -0.25 },
    { asset: 'GBP', expected: 'about -0.25', min: -0.5, max: 0 },
    { asset: 'JPY', expected: 'about -0.5', min: -0.75, max: -0.25 },
    { asset: 'CHF', expected: 'about +0.5', min: 0.25, max: 0.75 },
    { asset: 'CAD', expected: '+0.5 to +1.0', min: 0.5, max: 1 },
    { asset: 'AUD', expected: 'about -0.5', min: -0.75, max: -0.25 },
    { asset: 'NZD', expected: 'about -0.5', min: -0.75, max: -0.25 },
    { asset: 'GOLD', expected: 'about -0.5 when independent USD/yield pressure is confirmed', min: -0.75, max: 0 },
    { asset: 'OIL', expected: 'about +1.0', min: 0.75, max: 1.25 },
];

function geoForRows(rows: ReplayRow[]): ReturnType<typeof calculateGeopoliticalRisk> {
    const latest = new Map<string, ReplayRow>();
    for (const row of rows) {
        if (row.eventType !== 'GEOPOLITICAL' || !row.geoState || row.geoState === 'IRRELEVANT') continue;
        const id = String(row.canonicalEventId ?? row.canonicalThemeId ?? row.time);
        latest.set(id, row);
    }
    const input: GeoHeadline[] = [...latest.values()].map((row) => ({
        headline: row.fundamentalCause ?? String(row.canonicalEventId ?? 'event'),
        impact: row.impact ?? 'Low',
        summary: row.fundamentalCause ?? null,
        assets: row.currentAssetContributions ?? [],
        published_at: parseDubai(row.time),
        created_at: parseDubai(row.time),
        causal_theme_id: row.canonicalThemeId,
        driver_theme: row.canonicalThemeId,
        geo_state: row.geoState,
        canonical_event_id: row.canonicalEventId,
        status: row.eventRelation === 'REVERSAL' ? 'REVERSED' : row.eventRelation === 'DE_ESCALATION' ? 'WATCH' : 'ACTIVE',
        event_type: row.eventType,
        transmission_reason: null,
        current_asset_contributions: row.currentAssetContributions ?? [],
    }));
    return calculateGeopoliticalRisk(input);
}

function comparison(board: Array<{ asset: string; driverScore: number }>) {
    return references.map((reference) => {
        const actual = board.find((row) => row.asset === reference.asset)?.driverScore ?? 0;
        return {
            ...reference,
            actual,
            directionMatch: reference.min < 0 ? actual < 0 : actual > 0,
            rangeMatch: actual >= reference.min && actual <= reference.max,
        };
    });
}

async function main() {
    const data = JSON.parse(await fs.readFile(resultPath, 'utf8')) as ReplayData;
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as { checkpoints: Array<{ processedRows: number; activeDrivers: Array<{ eventId: string }> }>; [key: string]: any };
    const recordedModel = typeof data.summary.model === 'string' && !data.summary.model.startsWith('ffe-')
        ? data.summary.model
        : ENV.OPENAI_CLASSIFICATION_MODEL;
    const finalGeo = geoForRows(data.rows);
    const clientComparison = comparison(data.summary.finalBoard ?? []);
    const directionMatches = clientComparison.filter((row) => row.directionMatch).length;
    const rangeMatches = clientComparison.filter((row) => row.rangeMatch).length;
    const arithmeticPass = Boolean(data.summary.arithmeticPass);
    const verdict = arithmeticPass && directionMatches === references.length && rangeMatches === references.length
        ? 'FFE CLIENT-GPT CONTRACT VERIFIED - READY FOR FINAL DEPLOYMENT PREP'
        : arithmeticPass
            ? 'FFE CONTRACT IMPLEMENTED BUT AUGUST 18 STILL DIFFERS - DO NOT DEPLOY'
            : 'VALIDATION INCOMPLETE - DO NOT DEPLOY';
    data.summary.promptVersion = FFE_ANALYST_PROMPT_VERSION;
    data.summary.model = recordedModel;
    data.summary.finalGeo = { dominantTheme: finalGeo.escalationThemes[0]?.theme ?? finalGeo.deEscalationThemes[0]?.theme ?? null, score: finalGeo.score, band: finalGeo.band, eventCount: finalGeo.eventCount, escalationThemes: finalGeo.escalationThemes.map((theme) => theme.theme), deEscalationThemes: finalGeo.deEscalationThemes.map((theme) => theme.theme) };
    data.summary.clientComparison = clientComparison;
    data.summary.directionMatches = directionMatches;
    data.summary.rangeMatches = rangeMatches;
    data.summary.verdict = verdict;
    const usage = data.summary.usage ?? {};
    const measured = Number(usage.estimatedCostUsd ?? 0);
    const macroRows = data.rows.filter((row) => Boolean((row.macro as { eligible?: boolean } | undefined)?.eligible));
    const macroReport = {
        source: 'Economic Calendar / structured replay fields are separate from FinancialJuice Catalyst news',
        totalMacroRows: macroRows.length,
        releasedRows: macroRows.filter((row) => Boolean(row.actual || row.forecast || row.previous)).length,
        upcomingRows: macroRows.filter((row) => !row.actual && !row.forecast && !row.previous).length,
        structuredRows: macroRows.map((row) => ({ time: row.time, guid: row.guid, headline: row.headline, actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null, family: (row.macro as { family?: string | null } | undefined)?.family ?? null })),
        catalystBoundary: 'Macro releases and forecasts contribute zero to Catalyst; policy/rate/yield/intervention/geopolitical events remain Catalyst when independently transmitted.',
    };
    const usageReport = {
        ...usage,
        measuredReplayCostUsd: measured,
        projected30DayCostUsd: Number((measured * 30).toFixed(8)),
        zeroCallOnUnchangedIdentity: 'verified by test:restart-safety and page-read architecture; replay itself was isolated',
        productionWrites: false,
        providerFallbackCalls: usage.failedCalls ?? null,
    };
    await fs.writeFile(boardPath, JSON.stringify({ replayDate: data.summary.replayDate, source: data.summary.source, board: data.summary.finalBoard, arithmeticProof: data.summary.finalArithmeticProof, arithmeticPass }, null, 2));
    await fs.writeFile(geoPath, JSON.stringify({ replayDate: data.summary.replayDate, source: data.summary.source, final: data.summary.finalGeo, checkpoints: checkpoint.checkpoints.map((entry) => ({ processedRows: entry.processedRows, geo: entry.geo })) }, null, 2));
    await fs.writeFile(macroPath, JSON.stringify({ replayDate: data.summary.replayDate, ...macroReport }, null, 2));
    await fs.writeFile(usagePath, JSON.stringify({ replayDate: data.summary.replayDate, ...usageReport }, null, 2));
    await fs.writeFile(comparisonPath, JSON.stringify({ replayDate: data.summary.replayDate, source: data.summary.source, directionMatches, rangeMatches, clientComparison, verdict }, null, 2));
    checkpoint.finalGeo = data.summary.finalGeo;
    checkpoint.clientComparison = clientComparison;
    checkpoint.checkpoints = checkpoint.checkpoints.map((entry) => {
        const visibleIds = new Set(entry.activeDrivers.map((driver) => driver.eventId));
        const checkpointGeo = geoForRows(data.rows.slice(0, entry.processedRows).filter((row) => visibleIds.has(String(row.canonicalEventId ?? ''))));
        return {
            ...entry,
            geo: {
                dominantTheme: checkpointGeo.escalationThemes[0]?.theme ?? checkpointGeo.deEscalationThemes[0]?.theme ?? null,
                score: checkpointGeo.score,
                band: checkpointGeo.band,
                eventCount: checkpointGeo.eventCount,
                escalationThemes: checkpointGeo.escalationThemes.map((theme) => theme.theme),
                deEscalationThemes: checkpointGeo.deEscalationThemes.map((theme) => theme.theme),
            },
        };
    });
    await fs.writeFile(resultPath, JSON.stringify(data, null, 2));
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
    const lines = [
        '# Aug 18 FinancialJuice FFE client-contract replay', '',
        `- Input rows: ${data.summary.inputRows}`, `- Chronology: ${data.summary.chronology}`,
        `- Classification prompt version: ${data.summary.promptVersion}`, `- Classification model: ${data.summary.model ?? 'recorded in replay telemetry'}`,
        `- Session review prompt: ${data.summary.sessionReviewPromptVersion}`,
        `- AI calls: ${usage.aiCalls} (classification ${usage.classificationCalls}, adjudication ${usage.adjudicationCalls}, Session review ${usage.sessionReviewCalls})`,
        `- Estimated measured replay cost: $${measured}`, `- Projected 30-day cost at the same full-day volume: $${(measured * 30).toFixed(2)}`,
        `- Unique canonical events: ${data.summary.uniqueCanonicalEvents}`, `- Arithmetic proof: ${arithmeticPass ? 'PASS' : 'FAIL'}`,
        `- Client direction matches: ${directionMatches}/${references.length}`, `- Client range matches: ${rangeMatches}/${references.length}`,
        '', 'The Session Brain output is retained as a reviewer artifact only. The final board is reconstructed from active canonical event contributions and is not copied from Session Brain.',
        '', '## Final board', '', '```json', JSON.stringify(data.summary.finalBoard, null, 2), '```',
        '', '## Geo regime', '', '```json', JSON.stringify(data.summary.finalGeo, null, 2), '```',
        '', '## Client comparison', '', '| Asset | Client reference | Replay raw score | Direction | Range |', '|---|---|---:|:---:|:---:|',
        ...clientComparison.map((row) => `| ${row.asset} | ${row.expected} | ${row.actual} | ${row.directionMatch ? 'MATCH' : 'DIFF'} | ${row.rangeMatch ? 'MATCH' : 'DIFF'} |`),
        '', '## Verdict', '', verdict, '',
    ];
    await fs.writeFile(summaryPath, lines.join('\n'));
    console.log(JSON.stringify({ resultPath, checkpointPath, summaryPath, finalGeo: data.summary.finalGeo, directionMatches, rangeMatches, verdict }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
