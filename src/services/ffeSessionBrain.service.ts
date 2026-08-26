import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { getEconomicCalendarSnapshot } from './economicCalendarScrape.service.js';
import {
    requestStructuredJson,
    TRACKED_ASSETS,
    type ClassifiedAsset,
    type JsonSchema,
    type ProviderResponse,
} from './groqClassifier.service.js';

/** Versioned session review contract. The model returns a review/resolution projection; the
 * official Catalyst board is reconstructed from persisted canonical-event contributions. */
export const FFE_SESSION_BRAIN_PROMPT_VERSION = 'ffe-session-brain-v1.2.0-event-reviewer';
export const FFE_SESSION_BRAIN_SOURCE = 'FinancialJuice';
export const FFE_SESSION_TRACKED_ASSETS = [...TRACKED_ASSETS] as const;

export type SessionAsset = {
    asset: string;
    score: number;
    bias: 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
    reason: string;
};

export type SessionDriverCluster = {
    id: string;
    label: string;
    causalExplanation: string;
    status: 'ACTIVE' | 'RESOLVED' | 'REVERSED' | 'WATCH';
    independentReason: string;
    supportingEventIds: string[];
    supportingGuids: string[];
    affectedAssets: SessionAsset[];
    confirmationOnlyGuids: string[];
};

export type SessionMacroRow = {
    asset: string;
    score: number;
    bias: 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
    factors: Array<{ eventId: string; score: number; reason: string }>;
};

export type SessionCatalystRow = {
    asset: string;
    bullishDrivers: string[];
    bearishDrivers: string[];
    score: number;
    bias: 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
    factors: string[];
    explanation: string;
    notDoubleCounted: string[];
};

export type SessionGeoTheme = {
    id: string;
    state: 'ESCALATION' | 'DE_ESCALATION' | 'WATCH' | 'IRRELEVANT';
    summary: string;
    componentEvidence: string[];
};

export type SessionBrainOutput = {
    schemaVersion: string;
    asOf: string;
    sessionSummary: string;
    driverClusters: SessionDriverCluster[];
    confirmationEvidence: Array<{ guid: string; reason: string }>;
    macroBoard: SessionMacroRow[];
    catalystBoard: SessionCatalystRow[];
    geopoliticalThemes: SessionGeoTheme[];
    geoComponents: {
        directMilitaryEscalation: number;
        energyHormuzRisk: number;
        diplomaticDeterioration: number;
        regionalSpillover: number;
        sanctionsStrategicConfrontation: number;
        deEscalationDeduction: number;
    };
    confidence: number;
    needsReview: boolean;
    changeExplanation: string;
};

export type EvidenceEvent = {
    id: string;
    guid: string;
    headline: string;
    time: string;
    relation: string;
    status: string;
    themeId: string | null;
    summary: string | null;
    confirmation: boolean;
    actual: string | null;
    forecast: string | null;
    previous: string | null;
    fundamentalCause?: string | null;
    observedMarketReaction?: string | null;
    eventType?: string | null;
    currentAssetContributions?: ClassifiedAsset[];
    supportingGuids?: string[];
    confirmationGuids?: string[];
};

export type EvidenceTheme = {
    id: string;
    key: string;
    label: string;
    summary: string;
    status: string;
    geoState: string | null;
    firstSeenAt: string;
    lastUpdatedAt: string;
    supportingEventIds: string[];
    supportingGuids: string[];
    /** Candidate hints are evidence metadata only; official Catalyst arithmetic is code-owned. */
    candidateAssetHints: ClassifiedAsset[];
};

export type SessionEvidenceLedger = {
    dayKey: string;
    source: string;
    asOf: string;
    events: EvidenceEvent[];
    themes: EvidenceTheme[];
    macroEvidence: Array<{
        guid: string;
        headline: string;
        time: string;
        family: string | null;
        directionSummary: string | null;
        actual: string | null;
        forecast: string | null;
        previous: string | null;
    }>;
    geopoliticalEvidence: Array<{ guid: string; headline: string; time: string; state: string | null; summary: string | null }>;
    confirmationEvidence: Array<{ guid: string; headline: string; time: string; reason: string }>;
    priorSnapshot: SessionBrainOutput | null;
};

type JsonObject = Record<string, unknown>;

const SCORE_VALUES = new Set([-2, -1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2]);
const CATALYST_ASSETS = new Set<string>(FFE_SESSION_TRACKED_ASSETS);
const MACRO_ASSETS = new Set<string>(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF']);

const ASSET_SCHEMA: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        asset: { type: 'string', enum: [...FFE_SESSION_TRACKED_ASSETS] },
        score: { type: 'number', minimum: -1, maximum: 1 },
        bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Mixed'] },
        reason: { type: 'string' },
    },
    required: ['asset', 'score', 'bias', 'reason'],
};

const SESSION_BRAIN_SCHEMA: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        schemaVersion: { type: 'string' },
        asOf: { type: 'string' },
        sessionSummary: { type: 'string' },
        driverClusters: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string' }, label: { type: 'string' }, causalExplanation: { type: 'string' },
                    status: { type: 'string', enum: ['ACTIVE', 'RESOLVED', 'REVERSED', 'WATCH'] },
                    independentReason: { type: 'string' },
                    supportingEventIds: { type: 'array', items: { type: 'string' } },
                    supportingGuids: { type: 'array', items: { type: 'string' } },
                    affectedAssets: { type: 'array', items: ASSET_SCHEMA },
                    confirmationOnlyGuids: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'label', 'causalExplanation', 'status', 'independentReason', 'supportingEventIds', 'supportingGuids', 'affectedAssets', 'confirmationOnlyGuids'],
            },
        },
        confirmationEvidence: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: { guid: { type: 'string' }, reason: { type: 'string' } },
                required: ['guid', 'reason'],
            },
        },
        macroBoard: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                    asset: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'] },
                    score: { type: 'number', minimum: -1, maximum: 1 },
                    bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Mixed'] },
                    factors: {
                        type: 'array', items: {
                            type: 'object', additionalProperties: false,
                            properties: { eventId: { type: 'string' }, score: { type: 'number', minimum: -1, maximum: 1 }, reason: { type: 'string' } },
                            required: ['eventId', 'score', 'reason'],
                        },
                    },
                },
                required: ['asset', 'score', 'bias', 'factors'],
            },
        },
        catalystBoard: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                    asset: { type: 'string', enum: [...FFE_SESSION_TRACKED_ASSETS] },
                    bullishDrivers: { type: 'array', items: { type: 'string' } },
                    bearishDrivers: { type: 'array', items: { type: 'string' } },
                    score: { type: 'number', minimum: -1, maximum: 1 },
                    bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Mixed'] },
                    factors: { type: 'array', items: { type: 'string' } },
                    explanation: { type: 'string' },
                    notDoubleCounted: { type: 'array', items: { type: 'string' } },
                },
                required: ['asset', 'bullishDrivers', 'bearishDrivers', 'score', 'bias', 'factors', 'explanation', 'notDoubleCounted'],
            },
        },
        geopoliticalThemes: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string' }, state: { type: 'string', enum: ['ESCALATION', 'DE_ESCALATION', 'WATCH', 'IRRELEVANT'] },
                    summary: { type: 'string' }, componentEvidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'state', 'summary', 'componentEvidence'],
            },
        },
        geoComponents: {
            type: 'object', additionalProperties: false,
            properties: {
                directMilitaryEscalation: { type: 'number', minimum: 0, maximum: 0.2 },
                energyHormuzRisk: { type: 'number', minimum: 0, maximum: 0.2 },
                diplomaticDeterioration: { type: 'number', minimum: 0, maximum: 0.2 },
                regionalSpillover: { type: 'number', minimum: 0, maximum: 0.2 },
                sanctionsStrategicConfrontation: { type: 'number', minimum: 0, maximum: 0.2 },
                deEscalationDeduction: { type: 'number', minimum: 0, maximum: 0.2 },
            },
            required: ['directMilitaryEscalation', 'energyHormuzRisk', 'diplomaticDeterioration', 'regionalSpillover', 'sanctionsStrategicConfrontation', 'deEscalationDeduction'],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        needsReview: { type: 'boolean' },
        changeExplanation: { type: 'string' },
    },
    required: ['schemaVersion', 'asOf', 'sessionSummary', 'driverClusters', 'confirmationEvidence', 'macroBoard', 'catalystBoard', 'geopoliticalThemes', 'geoComponents', 'confidence', 'needsReview', 'changeExplanation'],
};

function text(value: unknown, max = 1200): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bounded(value: unknown, min: number, max: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
}

function quantizeScore(value: unknown, min = -2, max = 2): number {
    const boundedValue = bounded(value, min, max);
    const candidates = [...SCORE_VALUES].filter((candidate) => candidate >= min && candidate <= max);
    return candidates.reduce((best, candidate) => Math.abs(candidate - boundedValue) < Math.abs(best - boundedValue) ? candidate : best, 0);
}

function normalizedBias(score: number, raw: unknown): SessionAsset['bias'] {
    if (score > 0.1) return 'Bullish';
    if (score < -0.1) return 'Bearish';
    const candidate = String(raw ?? 'Neutral') as SessionAsset['bias'];
    return ['Neutral', 'Mixed'].includes(candidate) ? candidate : 'Neutral';
}

function normalizeAsset(raw: unknown, allowed: Set<string> = CATALYST_ASSETS): SessionAsset | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as JsonObject;
    const asset = text(row.asset, 12).toUpperCase();
    if (!allowed.has(asset)) return null;
    const score = quantizeScore(row.score, -1, 1);
    return { asset, score, bias: normalizedBias(score, row.bias), reason: text(row.reason, 1000) };
}

function normalizeOutput(raw: JsonObject, ledger: SessionEvidenceLedger): SessionBrainOutput {
    const eventIds = new Set(ledger.events.map((event) => event.id));
    const guids = new Set(ledger.events.map((event) => event.guid));
    const clusters: SessionDriverCluster[] = [];
    const seenClusterIds = new Set<string>();
    for (const value of Array.isArray(raw.driverClusters) ? raw.driverClusters : []) {
        if (!value || typeof value !== 'object') continue;
        const row = value as JsonObject;
        const id = text(row.id, 160) || `cluster_${clusters.length + 1}`;
        if (seenClusterIds.has(id)) continue;
        seenClusterIds.add(id);
        const affected = Array.isArray(row.affectedAssets)
            ? row.affectedAssets.map((asset) => normalizeAsset(asset)).filter((asset): asset is SessionAsset => Boolean(asset))
            : [];
        clusters.push({
            id, label: text(row.label, 180), causalExplanation: text(row.causalExplanation),
            status: ['ACTIVE', 'RESOLVED', 'REVERSED', 'WATCH'].includes(String(row.status)) ? String(row.status) as SessionDriverCluster['status'] : 'WATCH',
            independentReason: text(row.independentReason),
            supportingEventIds: Array.isArray(row.supportingEventIds) ? row.supportingEventIds.map(String).filter((id) => eventIds.has(id)) : [],
            supportingGuids: Array.isArray(row.supportingGuids) ? row.supportingGuids.map(String).filter((guid) => guids.has(guid)) : [],
            affectedAssets: affected,
            confirmationOnlyGuids: Array.isArray(row.confirmationOnlyGuids) ? row.confirmationOnlyGuids.map(String).filter((guid) => guids.has(guid)) : [],
        });
    }

    const macroByAsset = new Map<string, SessionMacroRow>();
    for (const value of Array.isArray(raw.macroBoard) ? raw.macroBoard : []) {
        if (!value || typeof value !== 'object') continue;
        const row = value as JsonObject;
        const asset = text(row.asset, 12).toUpperCase();
        if (!MACRO_ASSETS.has(asset) || macroByAsset.has(asset)) continue;
        const score = quantizeScore(row.score, -1, 1);
        const factors = Array.isArray(row.factors) ? row.factors.flatMap((factor) => {
            if (!factor || typeof factor !== 'object') return [];
            const item = factor as JsonObject;
            return [{ eventId: text(item.eventId, 160), score: quantizeScore(item.score), reason: text(item.reason, 1000) }];
        }) : [];
        macroByAsset.set(asset, { asset, score, bias: normalizedBias(score, row.bias), factors });
    }
    const macroBoard = [...MACRO_ASSETS].map((asset) => macroByAsset.get(asset) ?? ({ asset, score: 0, bias: 'Neutral', factors: [] } as SessionMacroRow));

    const catalystByAsset = new Map<string, SessionCatalystRow>();
    for (const value of Array.isArray(raw.catalystBoard) ? raw.catalystBoard : []) {
        if (!value || typeof value !== 'object') continue;
        const row = value as JsonObject;
        const asset = text(row.asset, 12).toUpperCase();
        if (!CATALYST_ASSETS.has(asset) || catalystByAsset.has(asset)) continue;
        const score = quantizeScore(row.score, -1, 1);
        catalystByAsset.set(asset, {
            asset,
            bullishDrivers: Array.isArray(row.bullishDrivers) ? row.bullishDrivers.map(String).slice(0, 32) : [],
            bearishDrivers: Array.isArray(row.bearishDrivers) ? row.bearishDrivers.map(String).slice(0, 32) : [],
            score,
            bias: normalizedBias(score, row.bias),
            factors: Array.isArray(row.factors) ? row.factors.map(String).slice(0, 32) : [],
            explanation: text(row.explanation),
            notDoubleCounted: Array.isArray(row.notDoubleCounted) ? row.notDoubleCounted.map(String).slice(0, 32) : [],
        });
    }
    const catalystBoard: SessionCatalystRow[] = [...FFE_SESSION_TRACKED_ASSETS].map((asset) => catalystByAsset.get(asset) ?? ({
        asset, bullishDrivers: [], bearishDrivers: [], score: 0, bias: 'Neutral' as const, factors: [], explanation: '', notDoubleCounted: [],
    }));

    const geoRaw = (raw.geoComponents && typeof raw.geoComponents === 'object') ? raw.geoComponents as JsonObject : {};
    const geoComponents = {
        directMilitaryEscalation: bounded(geoRaw.directMilitaryEscalation, 0, 0.2),
        energyHormuzRisk: bounded(geoRaw.energyHormuzRisk, 0, 0.2),
        diplomaticDeterioration: bounded(geoRaw.diplomaticDeterioration, 0, 0.2),
        regionalSpillover: bounded(geoRaw.regionalSpillover, 0, 0.2),
        sanctionsStrategicConfrontation: bounded(geoRaw.sanctionsStrategicConfrontation, 0, 0.2),
        deEscalationDeduction: bounded(geoRaw.deEscalationDeduction, 0, 0.2),
    };
    const geoThemes = Array.isArray(raw.geopoliticalThemes) ? raw.geopoliticalThemes.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const row = value as JsonObject;
        const state = String(row.state);
        if (!['ESCALATION', 'DE_ESCALATION', 'WATCH', 'IRRELEVANT'].includes(state)) return [];
        return [{ id: text(row.id, 160), state: state as SessionGeoTheme['state'], summary: text(row.summary), componentEvidence: Array.isArray(row.componentEvidence) ? row.componentEvidence.map(String).slice(0, 32) : [] }];
    }) : [];

    // The normalizer is deliberately conservative: malformed provider data never becomes a
    // partially persisted board. Missing required assets are completed as neutral rows so the
    // snapshot still has the fixed FFE contract; the caller marks needsReview below.
    const missingAssets = catalystBoard.length !== FFE_SESSION_TRACKED_ASSETS.length || macroBoard.length !== MACRO_ASSETS.size;
    return {
        schemaVersion: text(raw.schemaVersion, 80) || FFE_SESSION_BRAIN_PROMPT_VERSION,
        asOf: text(raw.asOf, 80) || ledger.asOf,
        sessionSummary: text(raw.sessionSummary),
        driverClusters: clusters,
        confirmationEvidence: Array.isArray(raw.confirmationEvidence) ? raw.confirmationEvidence.flatMap((value) => {
            if (!value || typeof value !== 'object') return [];
            const row = value as JsonObject;
            const guid = text(row.guid, 500);
            return guid && guids.has(guid) ? [{ guid, reason: text(row.reason, 1000) }] : [];
        }) : [],
        macroBoard,
        catalystBoard,
        geopoliticalThemes: geoThemes,
        geoComponents,
        confidence: bounded(raw.confidence, 0, 1),
        needsReview: Boolean(raw.needsReview) || missingAssets,
        changeExplanation: text(raw.changeExplanation),
    };
}

function validateOutput(output: SessionBrainOutput, ledger: SessionEvidenceLedger): boolean {
    if (output.catalystBoard.length !== FFE_SESSION_TRACKED_ASSETS.length || output.macroBoard.length !== MACRO_ASSETS.size) return false;
    if (new Set(output.catalystBoard.map((row) => row.asset)).size !== FFE_SESSION_TRACKED_ASSETS.length) return false;
    if (new Set(output.macroBoard.map((row) => row.asset)).size !== MACRO_ASSETS.size) return false;
    const eventIds = new Set(ledger.events.map((event) => event.id));
    return output.driverClusters.every((cluster) => cluster.supportingEventIds.every((id) => eventIds.has(id)));
}

function validateRawBoardShape(value: JsonObject): boolean {
    const catalyst = Array.isArray(value.catalystBoard) ? value.catalystBoard : [];
    const macro = Array.isArray(value.macroBoard) ? value.macroBoard : [];
    const catalystAssets = catalyst.map((row) => row && typeof row === 'object' ? text((row as JsonObject).asset, 12).toUpperCase() : '');
    const macroAssets = macro.map((row) => row && typeof row === 'object' ? text((row as JsonObject).asset, 12).toUpperCase() : '');
    return catalyst.length === FFE_SESSION_TRACKED_ASSETS.length
        && new Set(catalystAssets).size === FFE_SESSION_TRACKED_ASSETS.length
        && FFE_SESSION_TRACKED_ASSETS.every((asset) => catalystAssets.includes(asset))
        && macro.length === MACRO_ASSETS.size
        && new Set(macroAssets).size === MACRO_ASSETS.size
        && [...MACRO_ASSETS].every((asset) => macroAssets.includes(asset));
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const row = value as JsonObject;
        return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

export function fingerprintSessionLedger(ledger: SessionEvidenceLedger): string {
    const canonical = { ...ledger, asOf: undefined, priorSnapshot: undefined };
    return createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function ledgerPrompt(ledger: SessionEvidenceLedger): string {
    const prior = ledger.priorSnapshot
        ? `\nPRIOR SESSION SNAPSHOT (continuity context only; recompute every score from evidence):\n${JSON.stringify(ledger.priorSnapshot)}`
        : '\nPRIOR SESSION SNAPSHOT: none';
    return [
        `Dubai business day: ${ledger.dayKey}`,
        `As-of: ${ledger.asOf}`,
        'Authoritative FFE news source: FinancialJuice. Economic Calendar evidence is a separate structured source.',
        'The following is a compact evidence ledger. Raw rows remain available by GUID for audit.',
        'Candidate asset hints and old snapshots are not scores and must not be summed. Return the complete replacement review snapshot.',
        'Events:', JSON.stringify(ledger.events),
        'Canonical causal themes:', JSON.stringify(ledger.themes),
        'Macro release evidence:', JSON.stringify(ledger.macroEvidence),
        'Geopolitical evidence:', JSON.stringify(ledger.geopoliticalEvidence),
        'Confirmation/context evidence:', JSON.stringify(ledger.confirmationEvidence),
        prior,
    ].join('\n');
}

const SESSION_SYSTEM_PROMPT = `You are the Global FFE Session Brain reviewer/resolver for Forex Fundamental Edge.
Review one complete Dubai business day and return a replacement review snapshot, never a delta.
The canonical event ledger and deterministic application arithmetic are authoritative. You may
merge duplicates, attach confirmations, strengthen/weaken/reverse/resolve events, correct causal
transmission and identify which drivers remain active, but you must not invent a free-standing final
Catalyst score or replace the persisted event-contribution sum. Any catalystBoard values are a
non-authoritative review projection and are ignored by the official Catalyst API.

Reason like the client's GPT: identify unique underlying causal drivers first; separate scheduled
Macro evidence from Market Catalyst; retain opposing causes; treat price moves, settlements,
analyst commentary, and transmitted asset reactions as confirmation unless they introduce a new
fundamental cause; and explain why each driver is independent. Do not count Hormuz -> Oil -> CAD,
or geopolitics -> safe-haven USD -> DXY, as multiple drivers. UK jobs and German ZEW stay Macro.
Do not infer a global oil shock from a local incident. JPY haven impact requires confirmed haven
behavior. Geo and Risk Mode are independent systems.

The ledger contains all current canonical evidence and raw GUID references. Candidate asset hints
are explainability metadata only. Old website scores/labels are never evidence. A prior snapshot
is continuity context only; recompute it rather than incrementing it.

Approved FFE methodology calibration (apply to the evidence, not as headline-counting rules):
- Scheduled CPI/GDP/employment/PMI/retail/ZEW releases belong in Macro only. Their scores must
  never be copied into Catalyst. A later FX reaction to a release is confirmation.
- When the complete ledger confirms a meaningful Middle-East/Hormuz escalation (for example a
  vessel projectile/damage/casualty, missile escalation, or explicit closure/persistence risk),
  treat that as one confirmed geopolitical causal cluster. Its bounded Catalyst transmission is
  USD +0.50, CHF +0.50, AUD -0.50, NZD -0.50, EUR -0.25, GBP -0.25. JPY receives no automatic
  haven score without confirmed JPY haven behavior. Later reopening, settlement, or DXY lines
  are counter-evidence/confirmation and cap or revise the same cluster; they do not erase a
  confirmed incident or create another cluster.
- A confirmed crude-supply/route disruption is one separate Oil cluster: OIL +1.00, CAD +0.50
  to +1.00, JPY -0.50, EUR -0.25 when the evidence supports those channels. “CAD supported by
  oil” and WTI/Brent price lines confirm that cluster and score zero again.
- An independent US-yield/rate-repricing cause may add USD +0.50 once. DXY/USD reaction lines
  confirm it. Gold falls caused by USD/yields are confirmation, not a new Gold driver.
- Preserve opposing evidence, but do not let a generic “uncertain/no explicit transmission”
  disclaimer neutralize a confirmed channel that the ledger directly proves. Explain any cap or
  reversal explicitly in the board.

Return strict JSON matching the supplied schema. Include exactly all 10 Catalyst assets (USD, EUR,
GBP, JPY, CHF, CAD, AUD, NZD, GOLD, OIL) and all eight Macro currencies. Every review score
must be a bounded quarter-step in [-1,1], but it is advisory only; code computes the official raw
totals from ACTIVE, VALID, UNIQUE, INDEPENDENT canonical event contributions and does not clamp
those totals. Every driver reference must be stable and explainable.
Use confirmationOnlyGuids and notDoubleCounted to show what was intentionally excluded from totals.
Use the approved bounded Geo component inputs; code performs the official dominant-theme Geo
calculation separately. Never derive Risk Mode from this output.`;

export async function synthesizeFfeSessionBrain(
    ledger: SessionEvidenceLedger,
    options: { jobId?: string | null; ingestId?: string | null; recordUsage?: boolean } = {},
): Promise<{ output: SessionBrainOutput; provider: string; model: string } | null> {
    const response = await requestStructuredJson(SESSION_SYSTEM_PROMPT, ledgerPrompt(ledger), {
        operationType: 'session_synthesis',
        jobId: options.jobId,
        ingestId: options.ingestId,
        schema: SESSION_BRAIN_SCHEMA,
        schemaName: 'ffe_session_brain_snapshot',
        // A complete 10-asset board includes driver references, explanations and the explicit
        // non-double-counted evidence list. Reserve enough output for the replacement snapshot;
        // truncation would be indistinguishable from a malformed semantic decision.
        maxOutputTokens: Math.max(8000, Math.min(16_000, 2_400 + ledger.themes.length * 240)),
        recordUsage: options.recordUsage,
        validate: (value) => {
            if (!validateRawBoardShape(value)) return false;
            const candidate = normalizeOutput(value, ledger);
            return validateOutput(candidate, ledger);
        },
    });
    if (!response) return null;
    const output = normalizeOutput(response.parsed, ledger);
    if (!validateOutput(output, ledger)) return null;
    return { output, provider: response.provider, model: response.model };
}

function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

export async function loadFfeSessionEvidenceLedger(dayKey: string, asOf = new Date()): Promise<SessionEvidenceLedger> {
    const [news, canonicalEvents, themes, previous] = await Promise.all([
        prisma.marketDriverNews.findMany({
            where: { day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE },
            orderBy: [{ published_at: 'asc' }, { id: 'asc' }],
            select: {
                id: true, guid: true, headline: true, published_at: true, event_relation: true,
                event_duplicate_of: true, canonical_event_id: true, canonical_theme_id: true,
                causal_theme_summary: true, macro_eligible: true, macro_family: true,
                macro_direction_summary: true, macro_asset_scores: true, geo_state: true,
                macro_actual: true, macro_forecast: true, macro_previous: true,
                fundamental_cause: true, observed_market_reaction: true, event_type: true,
                current_asset_contributions: true, supporting_guid_ids: true, confirmation_only: true,
            },
        }),
        prisma.marketDriverCanonicalEvent.findMany({
            where: { day_key: dayKey, headlines: { some: { source: FFE_SESSION_BRAIN_SOURCE } } },
            orderBy: [{ first_seen_at: 'asc' }, { id: 'asc' }],
            select: {
                id: true, source_guid: true, headline: true, relation: true, status: true,
                canonical_theme_id: true, first_seen_at: true, last_seen_at: true,
                event_type: true, fundamental_cause: true, observed_market_reaction: true,
                current_asset_contributions: true, supporting_guid_ids: true, confirmation_guid_ids: true,
            },
        }).catch(() => []),
        prisma.marketDriverCanonicalTheme.findMany({
            where: { day_key: dayKey, headlines: { some: { source: FFE_SESSION_BRAIN_SOURCE }, every: { source: FFE_SESSION_BRAIN_SOURCE } } },
            orderBy: { last_updated_at: 'asc' },
            select: {
                id: true, theme_key: true, label: true, summary: true, status: true, geo_state: true,
                first_seen_at: true, last_updated_at: true, supporting_event_ids: true, supporting_headline_ids: true,
                asset_contributions: true,
            },
        }),
        prisma.marketDriverSessionSnapshot.findFirst({ where: { day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE, status: 'VALID' }, orderBy: { version: 'desc' }, select: { snapshot: true } }).catch(() => null),
    ]);
    const calendar = getEconomicCalendarSnapshot()?.data ?? [];
    const macroValuesFor = (row: (typeof news)[number]): { actual: string | null; forecast: string | null; previous: string | null } => {
        const direct = { actual: row.macro_actual ?? null, forecast: row.macro_forecast ?? null, previous: row.macro_previous ?? null };
        if (direct.actual || direct.forecast || direct.previous) return direct;
        const headline = row.headline.toLowerCase();
        const numeric = (label: string): string | null => {
            const match = headline.match(new RegExp(`${label}\\s*[:=]?\\s*(-?\\d+(?:[.,]\\d+)?%?)`, 'i'));
            return match?.[1] ?? null;
        };
        const extracted = { actual: numeric('actual'), forecast: numeric('forecast'), previous: numeric('previous') };
        if (extracted.actual || extracted.forecast || extracted.previous) return extracted;
        const tokens = new Set(headline.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((token) => token.length > 3));
        const match = calendar
            .map((event) => ({ event, overlap: event.event.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3).filter((token) => tokens.has(token)).length }))
            .sort((a, b) => b.overlap - a.overlap)[0];
        return match && match.overlap >= 2
            ? { actual: match.event.actual, forecast: match.event.forecast, previous: match.event.previous }
            : direct;
    };
    const newsByEvent = new Map<string, typeof news[number][]>();
    for (const row of news) {
        if (!row.canonical_event_id) continue;
        const list = newsByEvent.get(row.canonical_event_id) ?? [];
        list.push(row);
        newsByEvent.set(row.canonical_event_id, list);
    }
    const events: EvidenceEvent[] = canonicalEvents.length
        ? canonicalEvents.map((event) => {
            const linked = newsByEvent.get(event.id) ?? [];
            const first = linked[0];
            const values = first ? macroValuesFor(first) : { actual: null, forecast: null, previous: null };
            return {
                id: event.id,
                guid: event.source_guid,
                headline: event.headline,
                time: event.first_seen_at.toISOString(),
                relation: event.relation,
                status: event.status,
                themeId: event.canonical_theme_id,
                summary: first?.causal_theme_summary ?? event.fundamental_cause,
                confirmation: event.relation !== 'NEW_EVENT' || event.status !== 'ACTIVE',
                actual: values.actual,
                forecast: values.forecast,
                previous: values.previous,
                fundamentalCause: event.fundamental_cause,
                observedMarketReaction: event.observed_market_reaction,
                eventType: event.event_type,
                currentAssetContributions: Array.isArray(event.current_asset_contributions) ? event.current_asset_contributions as unknown as ClassifiedAsset[] : [],
                supportingGuids: Array.isArray(event.supporting_guid_ids) ? event.supporting_guid_ids.map(String) : [event.source_guid],
                confirmationGuids: Array.isArray(event.confirmation_guid_ids) ? event.confirmation_guid_ids.map(String) : [],
            };
        })
        : news.filter((row) => row.canonical_event_id).map((row) => ({
            id: row.canonical_event_id as string,
            guid: row.guid,
            headline: row.headline,
            time: row.published_at?.toISOString() ?? '',
            relation: row.event_relation ?? 'NEW_EVENT',
            status: row.event_duplicate_of ? 'CONFIRMATION' : 'ACTIVE',
            themeId: row.canonical_theme_id,
            summary: row.causal_theme_summary,
            confirmation: Boolean(row.event_duplicate_of) || !['NEW_EVENT'].includes(String(row.event_relation)),
            ...macroValuesFor(row),
            fundamentalCause: row.fundamental_cause,
            observedMarketReaction: row.observed_market_reaction,
            eventType: row.event_type,
            currentAssetContributions: Array.isArray(row.current_asset_contributions) ? row.current_asset_contributions as unknown as ClassifiedAsset[] : [],
            supportingGuids: Array.isArray(row.supporting_guid_ids) ? row.supporting_guid_ids.map(String) : [row.guid],
            confirmationGuids: [],
        }));
    const confirmationEvidence = news.filter((row) => Boolean(row.event_duplicate_of) || !['NEW_EVENT'].includes(String(row.event_relation))).map((row) => ({
        guid: row.guid, headline: row.headline, time: row.published_at?.toISOString() ?? '', reason: row.causal_theme_summary ?? row.event_relation ?? 'Confirmation/context evidence',
    }));
    const macroEvidence = news.filter((row) => row.macro_eligible).map((row) => ({
        guid: row.guid, headline: row.headline, time: row.published_at?.toISOString() ?? '', family: row.macro_family,
        directionSummary: row.macro_direction_summary, ...macroValuesFor(row),
    }));
    const geopoliticalEvidence = news.filter((row) => row.geo_state && row.geo_state !== 'IRRELEVANT').map((row) => ({
        guid: row.guid, headline: row.headline, time: row.published_at?.toISOString() ?? '', state: row.geo_state, summary: row.causal_theme_summary,
    }));
    return {
        dayKey, source: FFE_SESSION_BRAIN_SOURCE, asOf: asOf.toISOString(), events,
        themes: themes.map((theme) => ({
            id: theme.id, key: theme.theme_key, label: theme.label, summary: theme.summary, status: theme.status,
            geoState: theme.geo_state, firstSeenAt: theme.first_seen_at.toISOString(), lastUpdatedAt: theme.last_updated_at.toISOString(),
            supportingEventIds: Array.isArray(theme.supporting_event_ids) ? theme.supporting_event_ids.map(String) : [],
            supportingGuids: Array.isArray(theme.supporting_headline_ids) ? theme.supporting_headline_ids.map(String) : [],
            candidateAssetHints: Array.isArray(theme.asset_contributions) ? theme.asset_contributions as unknown as ClassifiedAsset[] : [],
        })),
        macroEvidence, geopoliticalEvidence, confirmationEvidence,
        priorSnapshot: previous?.snapshot && typeof previous.snapshot === 'object' ? previous.snapshot as unknown as SessionBrainOutput : null,
    };
}

export async function getLatestFfeSessionSnapshot(dayKey: string): Promise<SessionBrainOutput | null> {
    const row = await prisma.marketDriverSessionSnapshot.findFirst({ where: { day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE, status: 'VALID' }, orderBy: { version: 'desc' } }).catch(() => null);
    return row?.snapshot && typeof row.snapshot === 'object' ? row.snapshot as unknown as SessionBrainOutput : null;
}

export async function getFfeSessionCatalystBoard(dayKey: string): Promise<Array<{ asset: string; bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }> | null> {
    const snapshot = await getLatestFfeSessionSnapshot(dayKey);
    if (!snapshot) return null;
    return snapshot.catalystBoard.map((row) => ({
        asset: row.asset as (typeof FFE_SESSION_TRACKED_ASSETS)[number],
        bullishCount: row.bullishDrivers.length,
        bearishCount: row.bearishDrivers.length,
        driverScore: row.score,
        themes: [...new Set([...row.bullishDrivers, ...row.bearishDrivers])],
    }));
}

/**
 * Durable, fingerprinted Session Brain run. A duplicate ledger fingerprint is an idempotent
 * no-op. A failed call leaves the last VALID snapshot in place and marks the job failed.
 */
export async function synthesizeFfeSessionIfChanged(
    dayKey: string,
    options: { ingestId?: string | null; now?: Date; force?: boolean; recordUsage?: boolean } = {},
): Promise<{ changed: boolean; fingerprint: string; snapshot: SessionBrainOutput | null; error: string | null }> {
    const ledger = await loadFfeSessionEvidenceLedger(dayKey, options.now ?? new Date());
    const fingerprint = fingerprintSessionLedger(ledger);
    if (!options.force) {
        const existing = await prisma.marketDriverSessionSnapshot.findUnique({ where: { day_key_source_ledger_fingerprint: { day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE, ledger_fingerprint: fingerprint } } }).catch(() => null);
        if (existing?.status === 'VALID') return { changed: false, fingerprint, snapshot: existing.snapshot as unknown as SessionBrainOutput, error: null };
    }
    const idempotencyKey = `ffe-session:${FFE_SESSION_BRAIN_SOURCE}:${dayKey}:${fingerprint}`;
    let job;
    const workerId = `${process.env.HOSTNAME ?? 'forex-backend'}:${process.pid}`;
    // Use an explicit INSERT ... ON CONFLICT DO NOTHING so the normal concurrent
    // idempotency race does not emit a Prisma unique-constraint error. Only the worker
    // that receives a returned id owns the new synthesis lock.
    const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "market_driver_session_synthesis_jobs"
            ("id", "day_key", "source", "ledger_fingerprint", "idempotency_key", "ingest_id", "status", "locked_at", "worker_id")
        VALUES
            (${randomUUID()}, ${dayKey}, ${FFE_SESSION_BRAIN_SOURCE}, ${fingerprint}, ${idempotencyKey}, ${options.ingestId ?? null}, 'processing', ${new Date()}, ${workerId})
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"
    `;
    if (inserted.length > 0) {
        job = await prisma.marketDriverSessionSynthesisJob.findUnique({ where: { id: inserted[0]!.id } });
    } else {
        const current = await prisma.marketDriverSessionSynthesisJob.findUnique({ where: { idempotency_key: idempotencyKey } });
        if (current?.status === 'completed' && current.snapshot_id) {
            const snapshot = await getLatestFfeSessionSnapshot(dayKey);
            return { changed: false, fingerprint, snapshot, error: null };
        }
        const staleBefore = new Date(Date.now() - Math.max(30_000, ENV.AI_QUEUE_LOCK_TIMEOUT_MS));
        const recovered = current && current.status === 'processing' && current.locked_at && current.locked_at < staleBefore
            ? await prisma.marketDriverSessionSynthesisJob.updateMany({
                where: { id: current.id, status: 'processing', locked_at: { lt: staleBefore } },
                data: { locked_at: new Date(), worker_id: workerId, attempt_count: { increment: 1 } },
            })
            : { count: 0 };
        if (current && recovered.count === 1) {
            job = await prisma.marketDriverSessionSynthesisJob.findUnique({ where: { id: current.id } });
        } else if (current?.status === 'failed') {
            const retried = await prisma.marketDriverSessionSynthesisJob.updateMany({
                where: { id: current.id, status: 'failed' },
                data: { status: 'processing', locked_at: new Date(), worker_id: workerId, attempt_count: { increment: 1 }, error: null },
            });
            if (retried.count === 1) job = await prisma.marketDriverSessionSynthesisJob.findUnique({ where: { id: current.id } });
        }
        // A concurrent worker already owns this fingerprint. This is an expected
        // idempotent no-op, not a synthesis failure or a reason to create another
        // paid Session Brain call.
        if (!job) return { changed: false, fingerprint, snapshot: await getLatestFfeSessionSnapshot(dayKey), error: null };
    }

    try {
        // AiUsageRecord.job_id intentionally references the legacy classification-job table;
        // Session Brain has its own durable synthesis-job table, so keep this usage record
        // linked by ingest/operation metadata rather than violating that foreign key.
        const result = await synthesizeFfeSessionBrain(ledger, { jobId: null, ingestId: options.ingestId, recordUsage: options.recordUsage });
        if (!result) throw new Error('Session Brain returned no valid snapshot');
        const previous = await prisma.marketDriverSessionSnapshot.findFirst({ where: { day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE }, orderBy: { version: 'desc' }, select: { version: true } });
        const version = (previous?.version ?? 0) + 1;
        const snapshot = await prisma.$transaction(async (tx) => {
            const created = await tx.marketDriverSessionSnapshot.create({
                data: {
                    day_key: dayKey, source: FFE_SESSION_BRAIN_SOURCE, ledger_fingerprint: fingerprint,
                    version, status: result.output.needsReview ? 'REVIEW' : 'VALID', as_of: options.now ?? new Date(),
                    prompt_version: FFE_SESSION_BRAIN_PROMPT_VERSION, provider: result.provider, model: result.model,
                    snapshot: json(result.output), catalyst_board: json(result.output.catalystBoard), macro_board: json(result.output.macroBoard),
                    driver_clusters: json(result.output.driverClusters), geo_state: json({ themes: result.output.geopoliticalThemes, components: result.output.geoComponents }),
                    confidence: result.output.confidence, needs_review: result.output.needsReview, input_event_count: ledger.events.length,
                    input_theme_count: ledger.themes.length,
                },
            });
            await tx.marketDriverSessionSynthesisJob.update({ where: { id: job.id }, data: { status: 'completed', completed_at: new Date(), snapshot_id: created.id, locked_at: null, worker_id: null } });
            return created;
        });
        return { changed: true, fingerprint, snapshot: snapshot.snapshot as unknown as SessionBrainOutput, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.marketDriverSessionSynthesisJob.update({ where: { id: job.id }, data: { status: 'failed', error: text(message, 1000), completed_at: new Date(), locked_at: null, worker_id: null } }).catch(() => undefined);
        logger.error('[FfeSessionBrain] synthesis failed; last valid snapshot retained', { dayKey, error: message.slice(0, 240) });
        return { changed: false, fingerprint, snapshot: await getLatestFfeSessionSnapshot(dayKey), error: message };
    }
}

export function sessionBrainSchemaForTests(): JsonSchema { return SESSION_BRAIN_SCHEMA; }

export { SESSION_SYSTEM_PROMPT };
