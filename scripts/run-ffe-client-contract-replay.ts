import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    FFE_ANALYST_PROMPT_VERSION,
    classifyHeadlines,
    getAiEvaluationTelemetry,
    resetAiEvaluationTelemetry,
    TRACKED_ASSETS,
    type ClassifiedHeadline,
    type ClassifiedAsset,
    type ExistingCanonicalTheme,
    type ExistingTopic,
} from '../src/services/groqClassifier.service.js';
import {
    FFE_SESSION_BRAIN_PROMPT_VERSION,
    fingerprintSessionLedger,
    synthesizeFfeSessionBrain,
    type EvidenceEvent,
    type SessionBrainOutput,
    type SessionEvidenceLedger,
} from '../src/services/ffeSessionBrain.service.js';
import { resolveCanonicalPrincipal, type CanonicalDriverAuditRow, type CanonicalEventContext } from '../src/services/canonicalThemeRegistry.service.js';
import { calculateGeopoliticalRisk, type GeoHeadline, type GeoRiskBand } from '../src/services/geopoliticalRisk.service.js';
import { reconstructFfeCatalystBoard, type CatalystDriverInput } from '../src/services/ffeCatalystReconstruction.service.js';
import { ENV } from '../src/config/env.js';

type ReplayInput = { time: string; source: string; guid: string; headline: string; actual?: string; forecast?: string; previous?: string };
type DriverState = CanonicalDriverAuditRow & {
    headline: string;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    geoState: string | null;
    eventSeverity: number | null;
    eventCredibility: number | null;
    eventFreshness: number | null;
    eventPersistence: number | null;
    category: string | null;
    actual: string | null;
    previous: string | null;
};
type DecisionEntry = { row: ReplayInput; decision: ClassifiedHeadline; driver: DriverState | null; principalEventId: string | null; newEventMinted: boolean; stateChange: string; validationResult: string; resolvedRelation: string };
type ReplayCheckpoint = {
    batch: number;
    processedRows: number;
    activeDrivers: DriverState[];
    board: Array<{ asset: string; bullishCount: number; bearishCount: number; driverScore: number; driverIds: string[] }>;
    arithmeticProof: Array<{ asset: string; terms: number[]; sum: number; displayed: number; exact: boolean }>;
    geo: { dominantTheme: string | null; score: number; band: string };
    macro: { releasedRows: number; upcomingRows: number };
};

const root = path.resolve(process.cwd(), '..');
const fixturePath = process.env.FFE_REPLAY_FIXTURE_PATH
    ? path.resolve(process.env.FFE_REPLAY_FIXTURE_PATH)
    : path.join(root, 'replay-fixtures', 'financialjuice-2026-08-18-ai-replay.json');
const outDir = path.join(root, 'replay-fixtures');
const replayTag = String(process.env.FFE_REPLAY_OUTPUT_TAG ?? '').trim().replace(/[^a-z0-9_-]+/gi, '');
const outputSuffix = replayTag ? `-${replayTag}` : '';
const resultPath = path.join(outDir, `aug18-financialjuice-client-contract-replay${outputSuffix}.json`);
const checkpointPath = path.join(outDir, `aug18-financialjuice-driver-reconstruction${outputSuffix}.json`);
const summaryPath = path.join(outDir, `aug18-financialjuice-client-contract-replay${outputSuffix}.md`);
const evidenceMapPath = path.join(outDir, `aug18-financialjuice-evidence-principal-mapping${outputSuffix}.json`);
const configuredBatchSize = Number.parseInt(process.env.FFE_REPLAY_BATCH_SIZE ?? '12', 10);
const BATCH_SIZE = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0 ? configuredBatchSize : 12;

function parseDubai(value: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error(`Invalid replay timestamp: ${value}`);
    return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+04:00`;
}
function epoch(value: string): number { return Date.parse(parseDubai(value)); }
function stableId(day: string, key: string): string { return `event_${day.replace(/-/g, '')}_${createHash('sha256').update(`${day}|${key}`).digest('hex').slice(0, 28)}`; }
function asAssets(value: unknown): ClassifiedAsset[] { return Array.isArray(value) ? value as ClassifiedAsset[] : []; }
function toThemes(drivers: DriverState[]): ExistingCanonicalTheme[] {
    const themes = new Map<string, ExistingCanonicalTheme>();
    for (const driver of drivers) {
        if (!driver.themeId) continue;
        const existing = themes.get(driver.themeId);
        if (existing) {
            existing.supportingEventIds = [...new Set([...(existing.supportingEventIds ?? []), driver.eventId])];
            existing.events = [...(existing.events ?? []), toEventContext(driver)].filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index);
            continue;
        }
        themes.set(driver.themeId, {
            id: driver.themeId,
            themeKey: driver.themeId,
            label: driver.fundamentalCause ?? driver.themeId,
            summary: driver.fundamentalCause ?? '',
            status: driver.status,
            geoState: null,
            assets: driver.contributions,
            score: driver.contributions.reduce((sum, asset) => sum + asset.score, 0),
            lastUpdatedAt: driver.lastUpdatedAt,
            supportingEventIds: [driver.eventId],
            events: [toEventContext(driver)],
        });
    }
    return [...themes.values()];
}
function toEventContext(driver: DriverState): CanonicalEventContext {
    return {
        id: driver.eventId,
        themeId: driver.themeId,
        relation: driver.relation,
        status: driver.status,
        valid: driver.valid,
        independent: driver.independent,
        catalystEligible: driver.catalystEligible,
        eventType: driver.eventType,
        headline: driver.headline,
        fundamentalCause: driver.fundamentalCause,
        observedMarketReaction: driver.observedMarketReaction,
        transmissionReason: driver.transmissionReason,
        firstSeenAt: driver.firstSeenAt,
        lastSeenAt: driver.lastSeenAt,
        contributions: driver.contributions,
        supportingGuids: driver.supportingGuids,
        confirmationGuids: driver.confirmationGuids,
        counterEvidence: driver.counterEvidence,
    };
}
function makeDriver(eventId: string, themeId: string | null, row: ReplayInput, decision: ClassifiedHeadline, relation: string, previous: DriverState | null): DriverState | null {
    const reactionRelation = ['CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY'].includes(relation);
    const evidenceOnly = ['SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT'].includes(relation);
    if (evidenceOnly && !previous) return null;
    // Reaction rows confirm an existing principal — they must not demote an ACTIVE catalyst driver.
    if (reactionRelation && previous) {
        return {
            ...previous,
            relation,
            lastSeenAt: parseDubai(row.time),
            supportingGuids: [...new Set([...(previous.supportingGuids ?? []), row.guid])],
            confirmationGuids: [...new Set([...(previous.confirmationGuids ?? []), row.guid])],
            counterEvidence: [...new Set([...(previous.counterEvidence ?? []), ...(decision.counterEvidence ?? [])])],
        };
    }
    const incoming = !evidenceOnly && decision.catalystEligible && decision.signValidationStatus !== 'FAILED'
        ? asAssets(decision.currentAssetContributions ?? decision.assets).filter((asset) => asset.role !== 'CONFIRMATION' && asset.score !== 0)
        : [];
    const current = reactionRelation
        ? []
        : evidenceOnly
            ? (previous?.contributions ?? [])
            : relation === 'REVERSAL' || relation === 'DE_ESCALATION'
                ? []
                : incoming;
    const valid = reactionRelation
        ? (previous?.valid ?? false)
        : evidenceOnly
            ? (previous?.valid ?? false)
            : decision.signValidationStatus !== 'FAILED' && current.length > 0 && !['ECONOMIC', 'IRRELEVANT'].includes(decision.category);
    const independent = reactionRelation
        ? false
        : evidenceOnly
            ? (previous?.independent ?? false)
            : valid && ['NEW_EVENT', 'EVENT_UPDATE', 'STRENGTHENING_EVIDENCE', 'WEAKENING_EVIDENCE'].includes(relation);
    const catalystEligible = reactionRelation ? false : evidenceOnly ? (previous?.catalystEligible ?? false) : valid && current.length > 0;
    const status = reactionRelation
        ? 'WATCH'
        : evidenceOnly
            ? (current.length > 0 ? (previous?.status ?? 'WATCH') : 'WATCH')
            : relation === 'REVERSAL'
                ? 'REVERSED'
                : relation === 'DE_ESCALATION'
                    ? 'WATCH'
                    : current.length > 0
                        ? 'ACTIVE'
                        : 'WATCH';
    return {
        eventId, themeId, contractFamily: decision.contractTransmissionFamily ?? previous?.contractFamily ?? null, headline: row.headline, eventType: decision.eventType ?? previous?.eventType ?? null, relation, status,
        valid, independent, catalystEligible,
        fundamentalCause: decision.fundamentalCause ?? previous?.fundamentalCause ?? null, observedMarketReaction: decision.observedMarketReaction ?? previous?.observedMarketReaction ?? null,
        transmissionReason: decision.transmissionReason ?? previous?.transmissionReason ?? null, firstSeenAt: previous?.firstSeenAt ?? parseDubai(row.time), lastSeenAt: parseDubai(row.time), supportingGuids: [...new Set([...(previous?.supportingGuids ?? []), row.guid])], confirmationGuids: [...new Set([...(previous?.confirmationGuids ?? []), ...(evidenceOnly ? [row.guid] : [])])], contributions: current,
        counterEvidence: [...new Set([...(previous?.counterEvidence ?? []), ...(decision.counterEvidence ?? [])])], provider: decision.provider ?? previous?.provider ?? null, model: decision.model ?? previous?.model ?? null, promptVersion: decision.promptVersion ?? previous?.promptVersion ?? null,
        geoState: decision.geoState ?? previous?.geoState ?? null, eventSeverity: decision.eventSeverity ?? previous?.eventSeverity ?? null, eventCredibility: decision.eventCredibility ?? previous?.eventCredibility ?? null,
        eventFreshness: decision.eventFreshness ?? null, eventPersistence: decision.eventPersistence ?? null,
        category: decision.category ?? previous?.category ?? null,
        actual: row.actual ?? previous?.actual ?? null,
        previous: row.previous ?? previous?.previous ?? null,
    };
}
function toCatalystInput(driver: DriverState): CatalystDriverInput {
    return {
        eventId: driver.eventId,
        themeId: driver.themeId,
        contractFamily: driver.contractFamily ?? null,
        status: driver.status,
        valid: driver.valid,
        independent: driver.independent,
        catalystEligible: driver.catalystEligible,
        contributions: driver.contributions,
        supportingGuids: driver.supportingGuids,
        headline: driver.headline,
        eventType: driver.eventType ?? null,
        geoState: driver.geoState,
        eventRelation: driver.relation,
        category: driver.category,
        actual: driver.actual,
        previous: driver.previous,
        transmissionReason: driver.transmissionReason ?? null,
    };
}
function boardFrom(drivers: DriverState[], geo: ReturnType<typeof geoFrom>) {
    return reconstructFfeCatalystBoard(drivers.map(toCatalystInput), geo).board;
}
function makeLedger(dayKey: string, inputs: ReplayInput[], decisions: Map<string, DecisionEntry>, drivers: DriverState[], priorSnapshot: SessionBrainOutput | null): SessionEvidenceLedger {
    const events: EvidenceEvent[] = drivers.map((driver) => {
        const matched = decisions.get(driver.supportingGuids[0] ?? '');
        return {
            id: driver.eventId, guid: driver.supportingGuids[0] ?? driver.eventId, headline: matched?.row.headline ?? driver.fundamentalCause ?? driver.eventId,
            time: driver.firstSeenAt, relation: driver.relation, status: driver.status, themeId: driver.themeId, summary: driver.fundamentalCause,
            confirmation: driver.confirmationGuids.length > 0, actual: matched?.row.actual ?? null, forecast: matched?.row.forecast ?? null, previous: matched?.row.previous ?? null,
            fundamentalCause: driver.fundamentalCause, observedMarketReaction: driver.observedMarketReaction, eventType: driver.eventType,
            currentAssetContributions: driver.contributions, supportingGuids: driver.supportingGuids, confirmationGuids: driver.confirmationGuids,
        };
    });
    const macroEvidence = inputs.flatMap((row) => {
        const decision = decisions.get(row.guid)?.decision;
        return decision?.macro?.eligible ? [{ guid: row.guid, headline: row.headline, time: parseDubai(row.time), family: decision.macro.family, directionSummary: decision.macro.directionSummary, actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null }] : [];
    });
    const geopoliticalEvidence = inputs.flatMap((row) => {
        const decision = decisions.get(row.guid)?.decision;
        return decision?.geoState && decision.geoState !== 'IRRELEVANT' ? [{ guid: row.guid, headline: row.headline, time: parseDubai(row.time), state: decision.geoState, summary: decision.summary }] : [];
    });
    const confirmationEvidence = inputs.flatMap((row) => {
        const entry = decisions.get(row.guid);
        return entry && (entry.driver?.confirmationGuids.includes(row.guid) || entry.driver?.relation !== 'NEW_EVENT' || entry.validationResult !== 'PASS') ? [{ guid: row.guid, headline: row.headline, time: parseDubai(row.time), reason: entry.decision.summary || entry.driver?.relation || entry.validationResult }] : [];
    });
    return {
        dayKey, source: 'FinancialJuice', asOf: inputs.length ? parseDubai(inputs[inputs.length - 1]!.time) : new Date().toISOString(), events,
        themes: toThemes(drivers).map((theme) => ({ id: theme.id, key: theme.themeKey, label: theme.label, summary: theme.summary, status: theme.status, geoState: theme.geoState ?? null, firstSeenAt: String(theme.lastUpdatedAt ?? ''), lastUpdatedAt: String(theme.lastUpdatedAt ?? ''), supportingEventIds: theme.supportingEventIds ?? [], supportingGuids: [], candidateAssetHints: theme.assets })),
        macroEvidence, geopoliticalEvidence, confirmationEvidence, priorSnapshot,
    };
}
function geoFrom(drivers: DriverState[]): { dominantTheme: string | null; score: number; band: GeoRiskBand; eventCount: number; escalationThemes: string[]; deEscalationThemes: string[] } {
    const rows: GeoHeadline[] = drivers
        .filter((driver) => driver.eventType === 'GEOPOLITICAL' && driver.geoState && driver.geoState !== 'IRRELEVANT')
        .map((driver) => ({
            headline: driver.fundamentalCause ?? driver.eventId,
            impact: driver.eventSeverity != null && driver.eventSeverity >= 0.75 ? 'High' : driver.eventSeverity != null && driver.eventSeverity >= 0.4 ? 'Medium' : 'Low',
            summary: driver.fundamentalCause,
            assets: driver.contributions,
            published_at: new Date(driver.firstSeenAt),
            created_at: new Date(driver.lastSeenAt),
            causal_theme_id: driver.themeId,
            driver_theme: driver.themeId,
            geo_state: driver.geoState,
            canonical_event_id: driver.eventId,
            status: driver.status,
            event_type: driver.eventType,
            event_severity: driver.eventSeverity,
            event_credibility: driver.eventCredibility,
            event_freshness: driver.eventFreshness,
            event_persistence: driver.eventPersistence,
            transmission_reason: driver.transmissionReason,
            current_asset_contributions: driver.contributions,
        }));
    const result = calculateGeopoliticalRisk(rows);
    return {
        dominantTheme: result.escalationThemes[0]?.theme ?? result.deEscalationThemes[0]?.theme ?? null,
        score: result.score,
        band: result.band,
        eventCount: result.eventCount,
        escalationThemes: result.escalationThemes.map((theme) => theme.theme),
        deEscalationThemes: result.deEscalationThemes.map((theme) => theme.theme),
    };
}
type ClientReference = { asset: string; expected: string; min: number; max: number };
const CLIENT_REFERENCES: ClientReference[] = [
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
function compareClientReference(board: ReturnType<typeof boardFrom>) {
    return CLIENT_REFERENCES.map((reference) => {
        const actual = board.find((row) => row.asset === reference.asset)?.driverScore ?? 0;
        return { ...reference, actual, directionMatch: reference.min < 0 ? actual < 0 : actual > 0, rangeMatch: actual >= reference.min && actual <= reference.max };
    });
}
function cost(attempts: ReturnType<typeof getAiEvaluationTelemetry>): number {
    return attempts.reduce((sum, attempt) => {
        const openai = attempt.provider === 'openai';
        const input = Number(attempt.usage.inputTokens ?? 0); const cached = Math.min(input, Number(attempt.usage.cachedInputTokens ?? 0)); const output = Number(attempt.usage.outputTokens ?? 0);
        const inputRate = Number(openai ? ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_INPUT_PRICE_PER_MILLION); const cacheRate = Number(openai ? ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION : ENV.AI_GROQ_CACHED_INPUT_PRICE_PER_MILLION); const outputRate = Number(openai ? ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION : ENV.AI_GROQ_OUTPUT_PRICE_PER_MILLION);
        return sum + ((input - cached) * inputRate + cached * cacheRate + output * outputRate) / 1_000_000;
    }, 0);
}

async function classifyReplayBatch(
    batch: ReplayInput[],
    existingTopics: ExistingTopic[],
    existingThemes: ExistingCanonicalTheme[],
    dayKey: string,
    batchNumber: number,
): Promise<ClassifiedHeadline[]> {
    const configuredAttempts = Number.parseInt(process.env.FFE_REPLAY_CLASSIFICATION_ATTEMPTS ?? '3', 10);
    const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const classified = await classifyHeadlines(
            batch.map((row) => ({ text: row.headline, publishedAt: new Date(parseDubai(row.time)), actual: row.actual ?? null, forecast: row.forecast ?? null, previous: row.previous ?? null })),
            existingTopics,
            { operationType: 'classification', recordUsage: false, ingestId: `contract-replay:${dayKey}:batch-${batchNumber}:attempt-${attempt}`, existingThemes },
        );
        if (classified.length === batch.length) return classified;
        if (attempt < maxAttempts) {
            console.warn(`[Replay] Batch ${batchNumber} returned ${classified.length}/${batch.length}; retrying the isolated input batch (attempt ${attempt + 1}/${maxAttempts})`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    return [];
}

async function main(): Promise<void> {
    const fullFixture = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as ReplayInput[];
    const configuredMaxRows = Number.parseInt(process.env.FFE_REPLAY_MAX_ROWS ?? '0', 10);
    const fixture = Number.isFinite(configuredMaxRows) && configuredMaxRows > 0 ? fullFixture.slice(0, configuredMaxRows) : fullFixture;
    if (!fixture.length || fixture.some((row) => row.source !== 'FinancialJuice')) throw new Error('Replay must be FinancialJuice-only and non-empty');
    if (new Set(fixture.map((row) => row.guid)).size !== fixture.length) throw new Error('Replay GUIDs are not unique');
    if (fixture.some((row, index) => index > 0 && epoch(fixture[index - 1]!.time) > epoch(row.time))) throw new Error('Replay is not chronological');
    const dayKey = parseDubai(fixture[0]!.time).slice(0, 10);
    resetAiEvaluationTelemetry();
    const drivers = new Map<string, DriverState>();
    const guidToEvent = new Map<string, string>();
    const decisions = new Map<string, DecisionEntry>();
    const existingTopics: ExistingTopic[] = [];
    const checkpoints: ReplayCheckpoint[] = [];
    let priorSnapshot: SessionBrainOutput | null = null;
    for (let offset = 0; offset < fixture.length; offset += BATCH_SIZE) {
        const batch = fixture.slice(offset, offset + BATCH_SIZE);
        const classified = await classifyReplayBatch(batch, existingTopics, toThemes([...drivers.values()]), dayKey, offset / BATCH_SIZE + 1);
        if (classified.length !== batch.length) throw new Error(`Batch ${offset / BATCH_SIZE + 1} returned ${classified.length}/${batch.length}`);
        for (let index = 0; index < batch.length; index += 1) {
            const row = batch[index]!; const decision = classified.find((value) => value.index === index)!;
            const ref = decision.eventDuplicateOf ?? decision.duplicateOfExistingId ?? (decision.duplicateOfBatchIndex == null ? null : batch[decision.duplicateOfBatchIndex]?.guid ?? null);
            const themeId = decision.causalThemeId ?? decision.driverTheme ?? null;
            const contexts = [...drivers.values()].map(toEventContext);
            const resolution = resolveCanonicalPrincipal({
                relation: decision.eventRelation ?? 'NEW_EVENT',
                eventDuplicateOf: ref,
                headline: row.headline,
                themeId,
                eventType: decision.eventType,
                fundamentalCause: decision.fundamentalCause,
                currentContributions: decision.currentAssetContributions,
                publishedAt: new Date(parseDubai(row.time)),
            }, contexts);
            const target = resolution.principalEventId;
            const eventId = target ?? (resolution.relation === 'NEW_EVENT' ? stableId(dayKey, `${row.guid}|${themeId ?? 'unclassified'}`) : null);
            const previous = target ? drivers.get(target) ?? null : null;
            const next = eventId ? makeDriver(eventId, previous?.themeId ?? themeId, row, decision, resolution.relation, previous) : null;
            if (next) {
                drivers.set(eventId!, next);
                guidToEvent.set(row.guid, eventId!);
                existingTopics.unshift({ id: row.guid, text: row.headline, publishedAt: new Date(parseDubai(row.time)) });
            }
            decisions.set(row.guid, {
                row,
                decision,
                driver: next,
                principalEventId: target,
                newEventMinted: Boolean(eventId && !target),
                stateChange: next ? (previous ? `${resolution.relation}:${previous.status}->${next.status}` : 'NEW_EVENT_MINTED') : 'EVIDENCE_ONLY_NO_PRINCIPAL',
                validationResult: resolution.valid && (resolution.relation === 'NEW_EVENT' || Boolean(target)) ? 'PASS' : 'FAILED_NO_PRINCIPAL',
                resolvedRelation: resolution.relation,
            });
        }
        const ledger = makeLedger(dayKey, fixture.slice(0, offset + batch.length), decisions, [...drivers.values()], priorSnapshot);
        // The production path reviews each changed canonical fingerprint. For the expensive
        // blind replay, the default is one final reviewer call after the complete chronological
        // ledger; set FFE_REPLAY_SESSION_REVIEW_MODE=each-batch to reproduce the production call
        // cadence without changing resolver state or arithmetic.
        const reviewMode = String(process.env.FFE_REPLAY_SESSION_REVIEW_MODE ?? 'final');
        if (reviewMode === 'each-batch' || offset + batch.length === fixture.length) {
            const review = await synthesizeFfeSessionBrain(ledger, { recordUsage: false, ingestId: `contract-replay:${dayKey}:batch-${offset / BATCH_SIZE + 1}` });
            if (review) priorSnapshot = review.output;
        }
        const geoRegime = geoFrom([...drivers.values()]);
        const reconstruction = reconstructFfeCatalystBoard([...drivers.values()].map(toCatalystInput), geoRegime);
        const board = reconstruction.board;
        const collapsedDrivers = reconstruction.collapsed;
        const arithmeticProof = board.map((row) => { const terms = collapsedDrivers.flatMap((driver) => driver.contributions.filter((asset) => asset.asset === row.asset && asset.score !== 0 && asset.role !== 'CONFIRMATION').map((asset) => asset.score)); const sum = terms.reduce((a, b) => a + b, 0); return { asset: row.asset, terms, sum, displayed: row.driverScore, exact: sum === row.driverScore }; });
        const macroRows = [...decisions.values()].filter((entry) => entry.decision.macro?.eligible);
        checkpoints.push({ batch: offset / BATCH_SIZE + 1, processedRows: offset + batch.length, activeDrivers: [...drivers.values()].filter((driver) => driver.status === 'ACTIVE' && driver.valid && driver.independent && driver.catalystEligible && driver.contributions.length > 0), board, arithmeticProof, geo: geoRegime, macro: { releasedRows: macroRows.filter((entry) => entry.row.actual || entry.row.forecast || entry.row.previous).length, upcomingRows: macroRows.filter((entry) => !entry.row.actual && !entry.row.forecast && !entry.row.previous).length } });
    }
    const attempts = getAiEvaluationTelemetry();
    const usage = { aiCalls: attempts.length, successfulCalls: attempts.filter((row) => row.requestStatus === 'success').length, failedCalls: attempts.filter((row) => row.requestStatus === 'error').length, classificationCalls: attempts.filter((row) => row.operationType === 'classification').length, adjudicationCalls: attempts.filter((row) => row.operationType === 'semantic_adjudication').length, sessionReviewCalls: attempts.filter((row) => row.operationType === 'session_synthesis').length, inputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.inputTokens ?? 0), 0), cachedInputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.cachedInputTokens ?? 0), 0), outputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.outputTokens ?? 0), 0), totalTokens: attempts.reduce((sum, row) => sum + Number(row.usage.totalTokens ?? 0), 0), estimatedCostUsd: Number(cost(attempts).toFixed(8)) };
    const finalGeo = geoFrom([...drivers.values()]);
    const finalBoard = boardFrom([...drivers.values()], finalGeo);
    const finalProof = checkpoints.at(-1)?.arithmeticProof ?? [];
    const arithmeticPass = finalProof.every((row) => row.exact);
    const clientComparison = compareClientReference(finalBoard);
    const directionMatches = clientComparison.filter((row) => row.directionMatch).length;
    const rangeMatches = clientComparison.filter((row) => row.rangeMatch).length;
    const verdict = arithmeticPass && directionMatches === CLIENT_REFERENCES.length && rangeMatches === CLIENT_REFERENCES.length
        ? 'FFE 10/10 CLIENT-GPT CONTRACT VERIFIED - READY FOR FINAL DEPLOYMENT PREP'
        : arithmeticPass
            ? 'FFE CANONICAL RESOLVER STILL DIFFERS - DO NOT DEPLOY'
            : 'VALIDATION BLOCKED - DO NOT DEPLOY';
    const summary = { generatedAt: new Date().toISOString(), replayDate: dayKey, source: 'FinancialJuice', inputRows: fixture.length, chronology: `${fixture[0]!.time} through ${fixture.at(-1)!.time} Asia/Dubai`, batchSize: BATCH_SIZE, promptVersion: FFE_ANALYST_PROMPT_VERSION, model: ENV.OPENAI_CLASSIFICATION_MODEL, sessionReviewPromptVersion: FFE_SESSION_BRAIN_PROMPT_VERSION, oldDecisionsSentToAi: false, isolated: true, noProductionWrites: true, usage, uniqueCanonicalEvents: drivers.size, finalBoard, finalArithmeticProof: finalProof, arithmeticPass, reviewSnapshotStoredForAuditOnly: Boolean(priorSnapshot), clientComparison, directionMatches, rangeMatches, finalGeo, verdict };
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify({ summary, rows: [...decisions.values()].map(({ row, decision, driver, principalEventId, newEventMinted, stateChange, validationResult, resolvedRelation }) => ({ ...row, category: decision.category, impact: decision.impact, fundamentalCause: decision.fundamentalCause, observedMarketReaction: decision.observedMarketReaction, eventType: decision.eventType, aiEventRelation: decision.eventRelation, resolvedRelation, eventRelation: driver?.relation ?? resolvedRelation, evidenceOnly: !driver || ['SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT'].includes(String(decision.eventRelation)), eventStatus: driver?.status ?? 'EVIDENCE_ONLY', valid: driver?.valid ?? false, independent: driver?.independent ?? false, catalystEligible: driver?.catalystEligible ?? false, canonicalEventId: driver?.eventId ?? principalEventId, principalCanonicalEventId: principalEventId, newEventMinted, stateChange, validationResult, eventStrength: decision.eventStrength, eventSeverity: decision.eventSeverity, eventCredibility: decision.eventCredibility, eventFreshness: decision.eventFreshness, eventPersistence: decision.eventPersistence, transmissionReason: decision.transmissionReason, counterEvidence: decision.counterEvidence, supportingGuids: driver?.supportingGuids ?? [], confirmationGuids: driver?.confirmationGuids ?? [], currentAssetContributions: driver?.contributions ?? [], contributionChange: driver && !['SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT'].includes(String(resolvedRelation)) ? (driver.contributions ?? []) : [], assets: decision.assets, macro: decision.macro, geoState: decision.geoState, provider: decision.provider, model: decision.model, promptVersion: decision.promptVersion })) }, null, 2));
    await fs.writeFile(checkpointPath, JSON.stringify({ replayDate: dayKey, source: 'FinancialJuice', checkpoints, finalBoard, finalArithmeticProof: finalProof, finalGeo: summary.finalGeo, clientComparison, usage }, null, 2));
    await fs.writeFile(evidenceMapPath, JSON.stringify({ replayDate: dayKey, source: 'FinancialJuice', rows: [...decisions.values()].map(({ row, decision, driver, principalEventId, newEventMinted, stateChange, validationResult }) => ({ guid: row.guid, headline: row.headline, relation: driver?.relation ?? decision.eventRelation, aiRelation: decision.eventRelation, principalCanonicalEventId: principalEventId, canonicalEventId: driver?.eventId ?? principalEventId, newEventMinted, evidenceRole: driver?.confirmationGuids.includes(row.guid) ? 'CONFIRMATION' : driver ? 'SUPPORTING_OR_STATE_UPDATE' : 'EVIDENCE_ONLY', stateChange, contributionChange: driver?.contributions ?? [], validationResult })) }, null, 2));
    await fs.writeFile(summaryPath, ['# Aug 18 FinancialJuice FFE client-contract replay', '', `- Input rows: ${fixture.length}`, `- Chronology: ${summary.chronology}`, `- Batch size: ${BATCH_SIZE}`, `- Classification prompt version: ${summary.promptVersion}`, `- Classification model: ${summary.model}`, `- Session review prompt: ${summary.sessionReviewPromptVersion}`, `- AI calls: ${usage.aiCalls} (classification ${usage.classificationCalls}, adjudication ${usage.adjudicationCalls}, Session review ${usage.sessionReviewCalls})`, `- Estimated measured replay cost: $${usage.estimatedCostUsd}`, `- Projected 30-day cost at the same full-day volume: $${(usage.estimatedCostUsd * 30).toFixed(2)}`, `- Unique canonical events: ${drivers.size}`, `- Arithmetic proof: ${arithmeticPass ? 'PASS' : 'FAIL'}`, `- Client direction matches: ${directionMatches}/${CLIENT_REFERENCES.length}`, `- Client range matches: ${rangeMatches}/${CLIENT_REFERENCES.length}`, '', 'The Session Brain output is retained as a reviewer artifact only. The final board in this report is reconstructed from persisted-style active canonical event contributions; it is not copied from Session Brain.', '', '## Final board', '', '```json', JSON.stringify(finalBoard, null, 2), '```', '', '## Geo regime', '', '```json', JSON.stringify(summary.finalGeo, null, 2), '```', '', '## Client comparison', '', '| Asset | Client reference | Replay raw score | Direction | Range |', '|---|---|---:|:---:|:---:|', ...clientComparison.map((row) => `| ${row.asset} | ${row.expected} | ${row.actual} | ${row.directionMatch ? 'MATCH' : 'DIFF'} | ${row.rangeMatch ? 'MATCH' : 'DIFF'} |`), '', '## Verdict', '', summary.verdict, ''].join('\n'));
    console.log(JSON.stringify({ resultPath, checkpointPath, summaryPath, evidenceMapPath, usage, finalBoard, arithmeticPass, verdict: summary.verdict }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
