/**
 * GPT-first full-session analysis — OpenAI is the sole semantic analyst/scorer.
 * Application code validates structure and evidence integrity; it does not reinterpret scores.
 */

import { createHash } from 'node:crypto';
import {
    requestStructuredJson,
    TRACKED_ASSETS,
    type JsonSchema,
    type StructuredJsonRequestOptions,
    resetAiEvaluationTelemetry,
    getAiEvaluationTelemetry,
} from './groqClassifier.service.js';
import { validateGptFirstAnalysis, GEO_BANDS, EVIDENCE_DISPOSITIONS, collectCitedGuids, expectedGeoBand, type ValidationIssue } from './ffeGptFirstValidation.service.js';
import { buildGptFirstSystemPrompt, FFE_GPT_FIRST_PROMPT_VERSION } from './ffeGptFirstPrompt.service.js';
import {
    assembleFinancialJuiceEvidenceUnit,
    fingerprintFinancialJuiceSourceUnit,
} from './ffeEvidencePreprocess.service.js';
import { resolveGptFirstRuntime, type GptFirstRuntimeConfig } from './ffeGptFirstRuntime.service.js';

export { FFE_GPT_FIRST_PROMPT_VERSION };
export { resolveGptFirstRuntime, FFE_GPT_FIRST_PINNED_DEFAULTS } from './ffeGptFirstRuntime.service.js';

export type GptFirstSessionItem = {
    guid: string;
    time: string;
    headline: string;
    body?: string | null;
    supporting_text?: string | null;
    supporting_lines?: string[];
    source_label?: string;
    source_unit_hash?: string;
    original_order?: number;
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
};

export type GptFirstParseStats = {
    input_block_count?: number;
    retained_block_count?: number;
    fxstreet_excluded?: number;
    promo_excluded?: number;
};

export type GptFirstSessionInput = {
    source: 'FinancialJuice';
    business_day: string;
    cutoff: string;
    items: GptFirstSessionItem[];
    parse_stats?: GptFirstParseStats;
};

export type GptFirstEvidenceAudit = {
    retained_block_count: number;
    input_hash: string;
    source_unit_hashes: Array<{ guid: string; original_order: number; source_unit_hash: string }>;
    user_prompt_digest: string;
};

export type GptFirstRepairMode = 'none' | 'deterministic_structural' | 'model_structural';

export type GptFirstIntegrityProvenance = {
    semantic_ledger_hash: string;
    accepted_artifact_hash: string;
    semantic_attempts: number;
    repair_mode: GptFirstRepairMode;
    repair_attempts: number;
    model_repair_calls: number;
    needs_review: boolean;
    review_reason?: string;
};

export type GptFirstChannelEvaluation = {
    channel: string;
    eligibility: 'ELIGIBLE' | 'NOT_ELIGIBLE';
    decision: 'APPLIED' | 'NOT_APPLIED';
    asset: string | null;
    score: number;
    reason: string;
};

export type GptFirstDriverContribution = {
    asset: string;
    score: number;
    bias: 'Bullish' | 'Bearish' | 'Neutral';
    reason: string;
};

/** Compact semantic disposition for a retained headline. GPT chooses the label; code only checks structure. */
export type GptFirstEvidenceDisposition = {
    guid: string;
    disposition: string;
    driver_id: string | null;
    reason: string;
};

export type GptFirstDriver = {
    driver_id: string;
    canonical_label: string;
    fundamental_cause: string;
    category: string;
    status: 'ACTIVE' | 'WATCH' | 'RESOLVED' | 'REVERSED';
    state_change: string;
    first_seen: string;
    last_updated: string;
    strength: string;
    directness: string;
    event_relation: string;
    magnitude_reason: string;
    applicable_transmission_channels: string[];
    channel_evaluations: GptFirstChannelEvaluation[];
    applied_channels: string[];
    rejected_channels: string[];
    contributions: GptFirstDriverContribution[];
    supporting_guids: string[];
    confirmation_guids: string[];
    counter_guids: string[];
    observed_reaction: string | null;
    why_active: string;
    why_independent: string;
    confidence: number;
};

export const OIL_CONTRACT_CHANNELS = ['OIL', 'CAD', 'JPY', 'EUR'] as const;

export type GptFirstAnalysisOutput = {
    session: {
        source: string;
        business_day: string;
        cutoff: string;
        input_count: number;
        input_hash: string;
    };
    macro: Array<{ asset: string; score: number; health: string; reasoning: string; supporting_releases: string[] }>;
    drivers: GptFirstDriver[];
    geo: {
        dominant_theme: string;
        score: number;
        band: string;
        state: string;
        escalation_evidence: string[];
        de_escalation_evidence: string[];
        escalation_evidence_notes: string[];
        de_escalation_evidence_notes: string[];
        transmission_reason: string;
    };
    oil_audit: {
        independent_drivers: Array<{ driver_id: string; channel: string; polarity: string; magnitude: number; reason: string }>;
        counter_evidence: string[];
        net_assessment: string;
        aggregate_current_state?: string;
        downstream_transmission_basis?: string;
    };
    final_board: Array<{
        asset: string;
        score: number;
        bias: 'Bullish' | 'Bearish' | 'Neutral';
        driver_refs: string[];
        explanation: string;
    }>;
    zero_scored_items: Array<{ guid: string; headline: string; reason: string }>;
    evidence_dispositions: GptFirstEvidenceDisposition[];
    quality: {
        model_confidence: number;
        unresolved_ambiguities: string[];
        warnings: string[];
    };
    evidence_audit?: GptFirstEvidenceAudit;
    integrity_provenance?: GptFirstIntegrityProvenance;
};

const CHANNEL_EVALUATION_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        channel: { type: 'string' },
        eligibility: { type: 'string', enum: ['ELIGIBLE', 'NOT_ELIGIBLE'] },
        decision: { type: 'string', enum: ['APPLIED', 'NOT_APPLIED'] },
        asset: { type: ['string', 'null'] },
        score: { type: 'number', enum: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1] },
        reason: { type: 'string' },
    },
    required: ['channel', 'eligibility', 'decision', 'asset', 'score', 'reason'],
};

const CONTRIBUTION_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        asset: { type: 'string', enum: [...TRACKED_ASSETS] },
        score: { type: 'number', enum: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1] },
        bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
        reason: { type: 'string' },
    },
    required: ['asset', 'score', 'bias', 'reason'],
};

const DRIVER_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        driver_id: { type: 'string' },
        canonical_label: { type: 'string' },
        fundamental_cause: { type: 'string' },
        category: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'WATCH', 'RESOLVED', 'REVERSED'] },
        state_change: { type: 'string' },
        first_seen: { type: 'string' },
        last_updated: { type: 'string' },
        strength: { type: 'string' },
        directness: { type: 'string' },
        event_relation: { type: 'string' },
        magnitude_reason: { type: 'string' },
        applicable_transmission_channels: { type: 'array', items: { type: 'string' } },
        channel_evaluations: { type: 'array', items: CHANNEL_EVALUATION_SCHEMA },
        applied_channels: { type: 'array', items: { type: 'string' } },
        rejected_channels: { type: 'array', items: { type: 'string' } },
        contributions: { type: 'array', items: CONTRIBUTION_SCHEMA },
        supporting_guids: { type: 'array', items: { type: 'string' } },
        confirmation_guids: { type: 'array', items: { type: 'string' } },
        counter_guids: { type: 'array', items: { type: 'string' } },
        observed_reaction: { type: ['string', 'null'] },
        why_active: { type: 'string' },
        why_independent: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: [
        'driver_id', 'canonical_label', 'fundamental_cause', 'category', 'status', 'state_change',
        'first_seen', 'last_updated', 'strength', 'directness', 'event_relation', 'magnitude_reason',
        'applicable_transmission_channels', 'channel_evaluations', 'applied_channels', 'rejected_channels',
        'contributions', 'supporting_guids',
        'confirmation_guids', 'counter_guids', 'observed_reaction', 'why_active', 'why_independent', 'confidence',
    ],
};

const EVIDENCE_DISPOSITION_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['guid', 'disposition', 'driver_id', 'reason'],
    properties: {
        guid: { type: 'string' },
        disposition: { type: 'string', enum: [...EVIDENCE_DISPOSITIONS] },
        driver_id: { type: ['string', 'null'] },
        reason: { type: 'string' },
    },
};

const BOARD_ROW_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        asset: { type: 'string', enum: [...TRACKED_ASSETS] },
        score: { type: 'number' },
        bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
        driver_refs: { type: 'array', items: { type: 'string' } },
        explanation: { type: 'string' },
    },
    required: ['asset', 'score', 'bias', 'driver_refs', 'explanation'],
};

const GPT_FIRST_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['session', 'macro', 'drivers', 'geo', 'oil_audit', 'final_board', 'zero_scored_items', 'evidence_dispositions', 'quality'],
    properties: {
        session: {
            type: 'object',
            additionalProperties: false,
            required: ['source', 'business_day', 'cutoff', 'input_count', 'input_hash'],
            properties: {
                source: { type: 'string' },
                business_day: { type: 'string' },
                cutoff: { type: 'string' },
                input_count: { type: 'integer' },
                input_hash: { type: 'string' },
            },
        },
        macro: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['asset', 'score', 'health', 'reasoning', 'supporting_releases'],
                properties: {
                    asset: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'] },
                    score: { type: 'number', enum: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1] },
                    health: { type: 'string' },
                    reasoning: { type: 'string' },
                    supporting_releases: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        drivers: { type: 'array', items: DRIVER_SCHEMA },
        geo: {
            type: 'object',
            additionalProperties: false,
            required: ['dominant_theme', 'score', 'band', 'state', 'escalation_evidence', 'de_escalation_evidence', 'escalation_evidence_notes', 'de_escalation_evidence_notes', 'transmission_reason'],
            properties: {
                dominant_theme: { type: 'string' },
                score: { type: 'number', minimum: 0, maximum: 1 },
                band: { type: 'string', enum: [...GEO_BANDS] },
                state: { type: 'string' },
                escalation_evidence: { type: 'array', items: { type: 'string' } },
                de_escalation_evidence: { type: 'array', items: { type: 'string' } },
                escalation_evidence_notes: { type: 'array', items: { type: 'string' } },
                de_escalation_evidence_notes: { type: 'array', items: { type: 'string' } },
                transmission_reason: { type: 'string' },
            },
        },
        oil_audit: {
            type: 'object',
            additionalProperties: false,
            required: ['independent_drivers', 'counter_evidence', 'net_assessment', 'aggregate_current_state', 'downstream_transmission_basis'],
            properties: {
                independent_drivers: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['driver_id', 'channel', 'polarity', 'magnitude', 'reason'],
                        properties: {
                            driver_id: { type: 'string' },
                            channel: { type: 'string' },
                            polarity: { type: 'string' },
                            magnitude: { type: 'number', enum: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1] },
                            reason: { type: 'string' },
                        },
                    },
                },
                counter_evidence: { type: 'array', items: { type: 'string' } },
                net_assessment: { type: 'string' },
                aggregate_current_state: { type: 'string' },
                downstream_transmission_basis: { type: 'string' },
            },
        },
        final_board: { type: 'array', items: BOARD_ROW_SCHEMA },
        zero_scored_items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['guid', 'headline', 'reason'],
                properties: {
                    guid: { type: 'string' },
                    headline: { type: 'string' },
                    reason: { type: 'string' },
                },
            },
        },
        evidence_dispositions: { type: 'array', items: EVIDENCE_DISPOSITION_SCHEMA },
        quality: {
            type: 'object',
            additionalProperties: false,
            required: ['model_confidence', 'unresolved_ambiguities', 'warnings'],
            properties: {
                model_confidence: { type: 'number', minimum: 0, maximum: 1 },
                unresolved_ambiguities: { type: 'array', items: { type: 'string' } },
                warnings: { type: 'array', items: { type: 'string' } },
            },
        },
    },
};

const GPT_FIRST_SYSTEM_PROMPT = buildGptFirstSystemPrompt();

const MAX_SEMANTIC_ATTEMPTS = 1;
const MAX_MODEL_REPAIR_ATTEMPTS = 1;

const UNREPAIRABLE_SEMANTIC_CODES = new Set([
    'DUPLICATE_DRIVER',
    'UNKNOWN_GUID',
    'INVALID_ASSET',
    'INVALID_SCORE',
    'UNKNOWN_ZERO_GUID',
    'UNKNOWN_DISPOSITION_GUID',
    'INVALID_EVIDENCE_DISPOSITION',
    'INVALID_GEO_SCORE',
]);

export const GPT_FIRST_REPAIR_CONTRACT = [
    'INTEGRITY REPAIR MODE — this is NOT a new analysis and NOT a second independent analyst run.',
    'Repair the SAME semantic artifact supplied below.',
    'Do not create new drivers.',
    'Do not remove drivers.',
    'Do not change magnitudes, relations, Geo, or alter Macro/Catalyst judgments unless the listed validation error directly requires that field to be structurally corrected.',
    'Preserve all valid causal judgments. Edit only invalid structural/arithmetic fields.',
].join('\n');

export function nativeBodyOf(row: GptFirstSessionItem): string {
    const fromLines = (row.supporting_lines ?? []).map((line) => line.trim()).filter(Boolean).join('\n');
    return String(row.body || row.supporting_text || fromLines || '').trim();
}

export function completeGptFirstSessionItems(items: GptFirstSessionItem[]): GptFirstSessionItem[] {
    return items.map((row, index) => {
        const body = nativeBodyOf(row);
        const supporting_lines = row.supporting_lines?.length
            ? row.supporting_lines
            : (body ? body.split('\n').map((line) => line.trim()).filter(Boolean) : []);
        const source_label = row.source_label || 'FinancialJuice';
        const original_order = row.original_order ?? index + 1;
        const source_unit_hash = row.source_unit_hash || fingerprintFinancialJuiceSourceUnit({
            guid: row.guid,
            time: row.time,
            headline: row.headline,
            body,
            actual: row.actual ?? null,
            forecast: row.forecast ?? null,
            previous: row.previous ?? null,
            source_label,
        });
        return {
            ...row,
            body,
            supporting_text: row.supporting_text ?? (body || null),
            supporting_lines,
            source_label,
            original_order,
            source_unit_hash,
        };
    });
}

export function completeGptFirstSessionInput(input: GptFirstSessionInput): GptFirstSessionInput {
    const items = completeGptFirstSessionItems(input.items);
    return {
        ...input,
        items,
        parse_stats: {
            input_block_count: input.parse_stats?.input_block_count ?? items.length,
            retained_block_count: input.parse_stats?.retained_block_count ?? items.length,
            fxstreet_excluded: input.parse_stats?.fxstreet_excluded,
            promo_excluded: input.parse_stats?.promo_excluded,
        },
    };
}

function sessionInputHash(items: GptFirstSessionItem[]): string {
    const completed = completeGptFirstSessionItems(items);
    return createHash('sha256').update(JSON.stringify(completed.map((row) => ({
        guid: row.guid,
        time: row.time,
        headline: row.headline,
        body: nativeBodyOf(row),
        actual: row.actual ?? null,
        forecast: row.forecast ?? null,
        previous: row.previous ?? null,
        source_label: row.source_label ?? 'FinancialJuice',
        source_unit_hash: row.source_unit_hash,
        original_order: row.original_order ?? null,
    })))).digest('hex');
}

function formatMacroSuffix(row: GptFirstSessionItem): string {
    const parts: string[] = [];
    if (row.actual !== null && row.actual !== undefined) parts.push(`Actual=${row.actual}`);
    if (row.forecast !== null && row.forecast !== undefined) parts.push(`Forecast=${row.forecast}`);
    if (row.previous !== null && row.previous !== undefined) parts.push(`Previous=${row.previous}`);
    return parts.length ? ` | ${parts.join(' ')}` : '';
}

function formatSessionItemForPrompt(row: GptFirstSessionItem, index: number): string {
    const body = nativeBodyOf(row);
    const lines = [
        `${index + 1}. [${row.time}] guid=${row.guid} source=${row.source_label || 'FinancialJuice'} source_unit_hash=${row.source_unit_hash} order=${row.original_order ?? index + 1}`,
        `   TITLE: ${row.headline}${formatMacroSuffix(row)}`,
    ];
    if (body) {
        lines.push('   NATIVE_SUPPORTING_TEXT:');
        for (const line of body.split('\n')) {
            lines.push(`   ${line}`);
        }
    }
    return lines.join('\n');
}

function buildUserPrompt(input: GptFirstSessionInput): string {
    const completed = completeGptFirstSessionInput(input);
    return [
        'Analyze the following news using the FFE Project methodology and return the required JSON.',
        '',
        `BUSINESS DAY: ${completed.business_day}`,
        `CUTOFF: ${completed.cutoff}`,
        '',
        ...completed.items.map((row, index) => formatSessionItemForPrompt(row, index)),
    ].join('\n');
}

export function buildGptFirstEvidenceAudit(input: GptFirstSessionInput): GptFirstEvidenceAudit {
    const completed = completeGptFirstSessionInput(input);
    const userPrompt = buildUserPrompt(completed);
    return {
        retained_block_count: completed.items.length,
        input_hash: sessionInputHash(completed.items),
        source_unit_hashes: completed.items.map((row) => ({
            guid: row.guid,
            original_order: row.original_order ?? 0,
            source_unit_hash: row.source_unit_hash || '',
        })),
        user_prompt_digest: createHash('sha256').update(userPrompt).digest('hex'),
    };
}

export function sessionItemFromAssembledBlock(params: {
    guid: string;
    time: string;
    lines: string[];
    original_order?: number;
}): GptFirstSessionItem | null {
    const unit = assembleFinancialJuiceEvidenceUnit(params.lines);
    if (!unit) return null;
    return completeGptFirstSessionItems([{
        guid: params.guid,
        time: params.time,
        headline: unit.headline,
        body: unit.body,
        supporting_lines: unit.supporting_lines,
        actual: unit.actual ?? null,
        forecast: unit.forecast ?? null,
        previous: unit.previous ?? null,
        original_order: params.original_order,
        source_label: 'FinancialJuice',
    }])[0]!;
}

function parseChannelEvaluation(value: unknown, text: (v: unknown, max?: number) => string, score: (v: unknown) => number): GptFirstChannelEvaluation | null {
    const row = value as Record<string, unknown>;
    const channel = text(row.channel, 80);
    if (!channel) return null;
    const eligibility = String(row.eligibility ?? '').toUpperCase() === 'NOT_ELIGIBLE' ? 'NOT_ELIGIBLE' : 'ELIGIBLE';
    const decision = String(row.decision ?? '').toUpperCase() === 'APPLIED' ? 'APPLIED' : 'NOT_APPLIED';
    const assetRaw = row.asset == null || row.asset === '' ? null : text(row.asset, 40).toUpperCase();
    return {
        channel,
        eligibility,
        decision,
        asset: assetRaw,
        score: score(row.score),
        reason: text(row.reason, 800),
    };
}

/** Fill audit fields from contributions when GPT omitted them — tests/legacy objects only. Does not invent scores. */
export function withAuditFields(driver: Omit<GptFirstDriver, 'event_relation' | 'magnitude_reason' | 'applicable_transmission_channels' | 'channel_evaluations' | 'applied_channels' | 'rejected_channels'> & Partial<GptFirstDriver>): GptFirstDriver {
    const contributions = driver.contributions ?? [];
    const hasOil = contributions.some((row) => row.asset === 'OIL' && row.score);
    const existing = Array.isArray(driver.channel_evaluations) ? driver.channel_evaluations : [];
    const evaluations = existing.length
        ? existing
        : [
            ...contributions.map((row) => ({
                channel: row.asset,
                eligibility: 'ELIGIBLE' as const,
                decision: (row.score ? 'APPLIED' : 'NOT_APPLIED') as GptFirstChannelEvaluation['decision'],
                asset: row.asset,
                score: row.score,
                reason: row.reason,
            })),
            ...(hasOil
                ? OIL_CONTRACT_CHANNELS
                    .filter((channel) => !contributions.some((row) => row.asset === channel))
                    .map((channel) => ({
                        channel,
                        eligibility: 'ELIGIBLE' as const,
                        decision: 'NOT_APPLIED' as const,
                        asset: channel,
                        score: 0,
                        reason: 'Contract channel evaluated and not applied',
                    }))
                : []),
        ];
    return {
        ...driver,
        contributions,
        event_relation: driver.event_relation || 'NEW_EVENT',
        magnitude_reason: driver.magnitude_reason || driver.why_active || '',
        applicable_transmission_channels: driver.applicable_transmission_channels?.length
            ? driver.applicable_transmission_channels
            : evaluations.map((row) => row.channel),
        channel_evaluations: evaluations,
        applied_channels: driver.applied_channels?.length
            ? driver.applied_channels
            : evaluations.filter((row) => row.decision === 'APPLIED').map((row) => row.channel),
        rejected_channels: driver.rejected_channels?.length
            ? driver.rejected_channels
            : evaluations.filter((row) => row.decision === 'NOT_APPLIED').map((row) => row.channel),
    };
}

function inferTestDisposition(output: GptFirstAnalysisOutput, guid: string): GptFirstEvidenceDisposition {
    const zero = output.zero_scored_items?.find((row) => row.guid === guid);
    const macro = output.macro?.find((row) => row.supporting_releases?.includes(guid));
    const geoHit = [...(output.geo?.escalation_evidence ?? []), ...(output.geo?.de_escalation_evidence ?? [])].includes(guid);
    const driver = output.drivers?.find((row) =>
        row.supporting_guids.includes(guid) || row.confirmation_guids.includes(guid) || row.counter_guids.includes(guid));
    let disposition = 'NEW_EVENT';
    if (zero) disposition = 'IRRELEVANT_ZERO';
    else if (macro) disposition = 'MACRO_RELEASE';
    else if (geoHit) disposition = 'GEOPOLITICAL_EVIDENCE';
    else if (driver?.confirmation_guids.includes(guid)) disposition = 'CONFIRMATION';
    else if (driver?.counter_guids.includes(guid)) disposition = 'WEAKENING';
    else if (driver?.event_relation) {
        const relation = driver.event_relation.toUpperCase();
        if ((EVIDENCE_DISPOSITIONS as readonly string[]).includes(relation)) {
            disposition = relation;
        }
    }
    return {
        guid,
        disposition,
        driver_id: driver?.driver_id ?? null,
        reason: zero?.reason || driver?.event_relation || '',
    };
}

/** Test/legacy helper: fill missing compact dispositions from already-cited GUIDs. Does not invent scores or materiality. */
export function withCitedDispositions(output: GptFirstAnalysisOutput): GptFirstAnalysisOutput {
    const existing = Array.isArray(output.evidence_dispositions) ? output.evidence_dispositions : [];
    const have = new Set(existing.map((row) => row.guid));
    const extras = collectCitedGuids(output)
        .filter((guid) => !have.has(guid))
        .map((guid) => inferTestDisposition(output, guid));
    return { ...output, evidence_dispositions: existing.concat(extras) };
}

export function semanticCoreFingerprint(output: GptFirstAnalysisOutput): string {
    return createHash('sha256').update(JSON.stringify({
        drivers: (output.drivers ?? []).map((driver) => ({
            driver_id: driver.driver_id,
            status: driver.status,
            event_relation: driver.event_relation,
            contributions: (driver.contributions ?? []).map((row) => ({ asset: row.asset, score: row.score })),
        })),
        macro: (output.macro ?? []).map((row) => ({ asset: row.asset, score: row.score })),
        geo_score: output.geo?.score ?? null,
        geo_state: output.geo?.state ?? null,
    })).digest('hex');
}

export function artifactFingerprint(output: GptFirstAnalysisOutput): string {
    const { evidence_audit: _audit, integrity_provenance: _prov, ...rest } = output;
    return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export function hasUnrepairableSemanticIssue(issues: ValidationIssue[]): boolean {
    return issues.some((issue) => UNREPAIRABLE_SEMANTIC_CODES.has(issue.code));
}

function cloneLedger(output: GptFirstAnalysisOutput): GptFirstAnalysisOutput {
    return structuredClone(output);
}

function ensureChannelAudit(driver: GptFirstDriver): GptFirstDriver {
    const next = withAuditFields(driver);
    const evaluations = [...(next.channel_evaluations ?? [])];
    const evaluated = new Set(evaluations.map((row) => String(row.channel).toUpperCase()));
    for (const contrib of next.contributions ?? []) {
        if (!contrib.score) continue;
        const covered = evaluations.some((row) =>
            row.decision === 'APPLIED'
            && (String(row.asset ?? '').toUpperCase() === contrib.asset || String(row.channel).toUpperCase() === contrib.asset));
        if (!covered) {
            evaluations.push({
                channel: contrib.asset,
                eligibility: 'ELIGIBLE',
                decision: 'APPLIED',
                asset: contrib.asset,
                score: contrib.score,
                reason: contrib.reason || 'Structural audit of existing contribution',
            });
            evaluated.add(contrib.asset);
        }
    }
    const oilActive = (next.contributions ?? []).some((row) => row.asset === 'OIL' && row.score);
    if (oilActive) {
        for (const channel of OIL_CONTRACT_CHANNELS) {
            if (evaluated.has(channel)) continue;
            evaluations.push({
                channel,
                eligibility: 'ELIGIBLE',
                decision: 'NOT_APPLIED',
                asset: channel,
                score: 0,
                reason: 'Contract channel evaluated and not applied (structural completeness)',
            });
            evaluated.add(channel);
        }
    }
    return {
        ...next,
        channel_evaluations: evaluations,
        applied_channels: next.applied_channels?.length
            ? next.applied_channels
            : evaluations.filter((row) => row.decision === 'APPLIED').map((row) => row.channel),
        rejected_channels: next.rejected_channels?.length
            ? next.rejected_channels
            : evaluations.filter((row) => row.decision === 'NOT_APPLIED').map((row) => row.channel),
    };
}

function syncFinalBoardArithmetic(output: GptFirstAnalysisOutput): GptFirstAnalysisOutput {
    const termsByAsset = new Map<string, { sum: number; refs: string[] }>();
    for (const driver of output.drivers ?? []) {
        if (driver.status !== 'ACTIVE') continue;
        for (const contrib of driver.contributions ?? []) {
            if (!contrib.score) continue;
            const current = termsByAsset.get(contrib.asset) ?? { sum: 0, refs: [] };
            current.sum += contrib.score;
            if (!current.refs.includes(driver.driver_id)) current.refs.push(driver.driver_id);
            termsByAsset.set(contrib.asset, current);
        }
    }
    const boardByAsset = new Map((output.final_board ?? []).map((row) => [row.asset, row]));
    const final_board = TRACKED_ASSETS.map((asset) => {
        const existing = boardByAsset.get(asset);
        const computed = termsByAsset.get(asset);
        const score = computed?.sum ?? 0;
        return {
            asset,
            score,
            bias: (score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Neutral') as 'Bullish' | 'Bearish' | 'Neutral',
            driver_refs: computed?.refs ?? existing?.driver_refs ?? [],
            explanation: existing?.explanation || (score ? 'Sum of ACTIVE driver contributions' : 'No active driver'),
        };
    });
    return { ...output, final_board };
}

/**
 * Structural repair of ONE semantic ledger. Never invents driver scores, never merges
 * events, never rediscovers the market. Fixes arithmetic, channel/disposition coverage,
 * geo-band mapping, and session identity fields only.
 */
export function repairGptFirstArtifactDeterministically(
    output: GptFirstAnalysisOutput,
    input: GptFirstSessionInput,
): { output: GptFirstAnalysisOutput; changed: boolean; actions: string[] } {
    const actions: string[] = [];
    let next = cloneLedger(output);
    const before = artifactFingerprint(next);

    const expectedCount = input.items.length;
    const expectedHash = sessionInputHash(input.items);
    if (next.session.input_count !== expectedCount) {
        next.session = { ...next.session, input_count: expectedCount };
        actions.push('session.input_count');
    }
    if (next.session.input_hash !== expectedHash) {
        next.session = { ...next.session, input_hash: expectedHash };
        actions.push('session.input_hash');
    }

    const beforeDrivers = JSON.stringify(next.drivers);
    next.drivers = (next.drivers ?? []).map((driver) => (
        driver.status === 'ACTIVE' ? ensureChannelAudit(driver) : driver
    ));
    if (JSON.stringify(next.drivers) !== beforeDrivers) {
        actions.push('channel_evaluations');
    }

    const driverIds = new Set((next.drivers ?? []).map((row) => row.driver_id));
    const covered = withCitedDispositions(next);
    if ((covered.evidence_dispositions ?? []).length !== (next.evidence_dispositions ?? []).length) {
        actions.push('evidence_dispositions.coverage');
    }
    next = covered;

    const seenGuids = new Set<string>();
    next.evidence_dispositions = (next.evidence_dispositions ?? []).flatMap((row) => {
        if (!row.guid || seenGuids.has(row.guid)) return [];
        seenGuids.add(row.guid);
        let driver_id = row.driver_id;
        if (driver_id && !driverIds.has(driver_id)) {
            driver_id = null;
            actions.push(`disposition.driver_id:${row.guid}`);
        }
        const reason = String(row.reason ?? '').trim()
            ? row.reason
            : 'structural coverage of cited evidence';
        if (!String(row.reason ?? '').trim()) actions.push(`disposition.reason:${row.guid}`);
        return [{ ...row, driver_id, reason }];
    });

    const geoScore = next.geo?.score;
    const expectedBand = Number.isFinite(geoScore) ? expectedGeoBand(geoScore) : null;
    if (expectedBand && String(next.geo.band ?? '').toUpperCase() !== expectedBand) {
        next.geo = { ...next.geo, band: expectedBand };
        actions.push('geo.band');
    }

    const arithmeticallyAligned = syncFinalBoardArithmetic(next);
    if (artifactFingerprint(arithmeticallyAligned) !== artifactFingerprint(next)) {
        actions.push('final_board.arithmetic');
    }
    next = arithmeticallyAligned;

    return { output: next, changed: artifactFingerprint(next) !== before || actions.length > 0, actions };
}

export function buildGptFirstRepairUserPrompt(
    originalUserPrompt: string,
    previousArtifact: GptFirstAnalysisOutput,
    issues: ValidationIssue[],
): string {
    const { evidence_audit: _audit, integrity_provenance: _prov, ...ledger } = previousArtifact;
    return [
        originalUserPrompt,
        '',
        '═══ STRUCTURAL REPAIR OF THE SAME SEMANTIC ARTIFACT ═══',
        GPT_FIRST_REPAIR_CONTRACT,
        '',
        'EXACT VALIDATION ERRORS:',
        ...issues.map((issue) => `- ${issue.code}: ${issue.message}${issue.detail ? ` (${issue.detail})` : ''}`),
        '',
        'PREVIOUS SEMANTIC ARTIFACT (edit this ledger only):',
        JSON.stringify(ledger),
    ].join('\n');
}

export function ledgerSemanticallyRewritten(before: GptFirstAnalysisOutput, after: GptFirstAnalysisOutput): boolean {
    return semanticCoreFingerprint(before) !== semanticCoreFingerprint(after);
}

function parseEvidenceDisposition(value: unknown, text: (v: unknown, max?: number) => string): GptFirstEvidenceDisposition | null {
    const row = value as Record<string, unknown>;
    const guid = text(row.guid, 80);
    if (!guid) return null;
    const driverRaw = row.driver_id == null || row.driver_id === '' ? null : text(row.driver_id, 120);
    return {
        guid,
        disposition: text(row.disposition, 40).toUpperCase(),
        driver_id: driverRaw,
        reason: text(row.reason, 400),
    };
}

function extractCatalystDriverRefs(entry: Record<string, unknown>): string[] {
    const drivers = entry.drivers;
    if (!Array.isArray(drivers)) return [];
    return drivers.flatMap((value) => {
        const row = value as Record<string, unknown>;
        const ref = String(row.theme ?? row.driver_id ?? row.id ?? '').trim();
        return ref ? [ref] : [];
    });
}

function catalystBoardObjectToArray(board: Record<string, unknown>): Record<string, unknown>[] {
    return Object.entries(board).map(([assetKey, value]) => {
        const row = value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
        return {
            asset: assetKey.toUpperCase(),
            score: row.raw_score ?? row.score,
            driver_refs: extractCatalystDriverRefs(row),
            explanation: row.explanation ?? '',
        };
    });
}

function resolveFinalBoardSource(raw: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(raw.final_board) && raw.final_board.length > 0) {
        return raw.final_board as Record<string, unknown>[];
    }
    const objectBoard = (
        raw.final_board && typeof raw.final_board === 'object' && !Array.isArray(raw.final_board)
            ? raw.final_board
            : raw.catalyst_board && typeof raw.catalyst_board === 'object' && !Array.isArray(raw.catalyst_board)
                ? raw.catalyst_board
                : null
    ) as Record<string, unknown> | null;
    if (objectBoard) return catalystBoardObjectToArray(objectBoard);
    return Array.isArray(raw.final_board) ? raw.final_board as Record<string, unknown>[] : [];
}

function normalizeOutput(raw: Record<string, unknown>, input: GptFirstSessionInput): GptFirstAnalysisOutput {
    const text = (v: unknown, max = 2000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const score = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };
    const drivers: GptFirstDriver[] = (Array.isArray(raw.drivers) ? raw.drivers : []).map((value, index) => {
        const row = value as Record<string, unknown>;
        const contributions = (Array.isArray(row.contributions) ? row.contributions : []).flatMap((c) => {
            const item = c as Record<string, unknown>;
            const asset = text(item.asset, 12).toUpperCase();
            if (!TRACKED_ASSETS.includes(asset as typeof TRACKED_ASSETS[number])) return [];
            const s = score(item.score);
            return [{ asset, score: s, bias: (s > 0 ? 'Bullish' : s < 0 ? 'Bearish' : 'Neutral') as GptFirstDriverContribution['bias'], reason: text(item.reason, 800) }];
        });
        return {
            driver_id: text(row.driver_id, 120) || `driver_${index + 1}`,
            canonical_label: text(row.canonical_label, 200),
            fundamental_cause: text(row.fundamental_cause, 1200),
            category: text(row.category, 80),
            status: (['ACTIVE', 'WATCH', 'RESOLVED', 'REVERSED'].includes(String(row.status)) ? row.status : 'WATCH') as GptFirstDriver['status'],
            state_change: text(row.state_change, 120),
            first_seen: text(row.first_seen, 40),
            last_updated: text(row.last_updated, 40),
            strength: text(row.strength, 40),
            directness: text(row.directness, 80),
            event_relation: text(row.event_relation, 80),
            magnitude_reason: text(row.magnitude_reason, 800),
            applicable_transmission_channels: (Array.isArray(row.applicable_transmission_channels) ? row.applicable_transmission_channels : []).map(String),
            channel_evaluations: (Array.isArray(row.channel_evaluations) ? row.channel_evaluations : [])
                .map((entry) => parseChannelEvaluation(entry, text, score))
                .filter((entry): entry is GptFirstChannelEvaluation => Boolean(entry)),
            applied_channels: (Array.isArray(row.applied_channels) ? row.applied_channels : []).map(String),
            rejected_channels: (Array.isArray(row.rejected_channels) ? row.rejected_channels : []).map(String),
            contributions,
            supporting_guids: (Array.isArray(row.supporting_guids) ? row.supporting_guids : []).map(String),
            confirmation_guids: (Array.isArray(row.confirmation_guids) ? row.confirmation_guids : []).map(String),
            counter_guids: (Array.isArray(row.counter_guids) ? row.counter_guids : []).map(String),
            observed_reaction: row.observed_reaction ? text(row.observed_reaction, 800) : null,
            why_active: text(row.why_active, 800),
            why_independent: text(row.why_independent, 800),
            confidence: Math.max(0, Math.min(1, score(row.confidence))),
        };
    });

    const boardMap = new Map<string, GptFirstAnalysisOutput['final_board'][number]>();
    for (const value of resolveFinalBoardSource(raw)) {
        const row = value as Record<string, unknown>;
        const asset = text(row.asset, 12).toUpperCase();
        if (!TRACKED_ASSETS.includes(asset as typeof TRACKED_ASSETS[number]) || boardMap.has(asset)) continue;
        const s = score(row.score);
        boardMap.set(asset, {
            asset,
            score: s,
            bias: (s > 0 ? 'Bullish' : s < 0 ? 'Bearish' : 'Neutral') as 'Bullish' | 'Bearish' | 'Neutral',
            driver_refs: (Array.isArray(row.driver_refs) ? row.driver_refs : []).map(String),
            explanation: text(row.explanation, 1000),
        });
    }
    const final_board = TRACKED_ASSETS.map((asset) => boardMap.get(asset) ?? ({
        asset, score: 0, bias: 'Neutral' as const, driver_refs: [], explanation: 'No active driver',
    }));

    const geoRaw = (raw.geo ?? {}) as Record<string, unknown>;
    const oilRaw = (raw.oil_audit ?? {}) as Record<string, unknown>;
    const qualityRaw = (raw.quality ?? {}) as Record<string, unknown>;
    const sessionRaw = (raw.session ?? {}) as Record<string, unknown>;

    return {
        session: {
            source: text(sessionRaw.source || input.source, 40),
            business_day: text(sessionRaw.business_day || input.business_day, 20),
            cutoff: text(sessionRaw.cutoff || input.cutoff, 40),
            input_count: Number(sessionRaw.input_count ?? input.items.length),
            input_hash: text(sessionRaw.input_hash || sessionInputHash(input.items), 80),
        },
        macro: (Array.isArray(raw.macro) ? raw.macro : []).map((value) => {
            const row = value as Record<string, unknown>;
            return {
                asset: text(row.asset, 12).toUpperCase(),
                score: score(row.score),
                health: text(row.health, 40),
                reasoning: text(row.reasoning, 800),
                supporting_releases: (Array.isArray(row.supporting_releases) ? row.supporting_releases : []).map(String),
            };
        }),
        drivers,
        geo: {
            dominant_theme: text(geoRaw.dominant_theme, 200),
            score: score(geoRaw.score),
            band: text(geoRaw.band, 40),
            state: text(geoRaw.state, 40),
            escalation_evidence: (Array.isArray(geoRaw.escalation_evidence) ? geoRaw.escalation_evidence : []).map(String),
            de_escalation_evidence: (Array.isArray(geoRaw.de_escalation_evidence) ? geoRaw.de_escalation_evidence : []).map(String),
            escalation_evidence_notes: (Array.isArray(geoRaw.escalation_evidence_notes) ? geoRaw.escalation_evidence_notes : []).map(String),
            de_escalation_evidence_notes: (Array.isArray(geoRaw.de_escalation_evidence_notes) ? geoRaw.de_escalation_evidence_notes : []).map(String),
            transmission_reason: text(geoRaw.transmission_reason, 800),
        },
        oil_audit: {
            independent_drivers: (Array.isArray(oilRaw.independent_drivers) ? oilRaw.independent_drivers : []).map((value) => {
                const row = value as Record<string, unknown>;
                return {
                    driver_id: text(row.driver_id, 120),
                    channel: text(row.channel, 80),
                    polarity: text(row.polarity, 40),
                    magnitude: score(row.magnitude),
                    reason: text(row.reason, 800),
                };
            }),
            counter_evidence: (Array.isArray(oilRaw.counter_evidence) ? oilRaw.counter_evidence : []).map(String),
            net_assessment: text(oilRaw.net_assessment, 800),
            aggregate_current_state: text(oilRaw.aggregate_current_state, 400),
            downstream_transmission_basis: text(oilRaw.downstream_transmission_basis, 800),
        },
        final_board,
        zero_scored_items: (Array.isArray(raw.zero_scored_items) ? raw.zero_scored_items : []).map((value) => {
            const row = value as Record<string, unknown>;
            return { guid: text(row.guid, 80), headline: text(row.headline, 400), reason: text(row.reason, 800) };
        }),
        evidence_dispositions: (Array.isArray(raw.evidence_dispositions) ? raw.evidence_dispositions : [])
            .map((value) => parseEvidenceDisposition(value, text))
            .filter((row): row is GptFirstEvidenceDisposition => Boolean(row)),
        quality: {
            model_confidence: Math.max(0, Math.min(1, score(qualityRaw.model_confidence))),
            unresolved_ambiguities: (Array.isArray(qualityRaw.unresolved_ambiguities) ? qualityRaw.unresolved_ambiguities : []).map(String),
            warnings: (Array.isArray(qualityRaw.warnings) ? qualityRaw.warnings : []).map(String),
        },
    };
}

export type GptFirstStructuredRequester = (
    systemPrompt: string,
    userPrompt: string,
    options: StructuredJsonRequestOptions,
) => Promise<{ parsed: Record<string, unknown>; provider: string; model: string } | null>;

export type GptFirstAnalysisResult = {
    output: GptFirstAnalysisOutput;
    validation: ReturnType<typeof validateGptFirstAnalysis>;
    provider: string;
    model: string;
    promptVersion: string;
    accepted: boolean;
    attempts: number;
    transportAttempts: number;
    latencyMs: number;
    transportFailure?: boolean;
    needsReview: boolean;
    repairMode: GptFirstRepairMode;
    semanticAttempts: number;
    modelRepairCalls: number;
    runtime: GptFirstRuntimeConfig;
};

function attachProvenance(
    output: GptFirstAnalysisOutput,
    input: GptFirstSessionInput,
    provenance: GptFirstIntegrityProvenance,
): GptFirstAnalysisOutput {
    return {
        ...output,
        evidence_audit: buildGptFirstEvidenceAudit(input),
        integrity_provenance: provenance,
    };
}

export async function applyModelStructuralRepair(params: {
    originalUserPrompt: string;
    previousArtifact: GptFirstAnalysisOutput;
    input: GptFirstSessionInput;
    issues: ValidationIssue[];
    requester: GptFirstStructuredRequester;
    runtime: GptFirstRuntimeConfig;
    requestOptions: Omit<StructuredJsonRequestOptions, 'schema' | 'schemaName' | 'maxOutputTokens'>;
}): Promise<{ output: GptFirstAnalysisOutput; mutated: boolean } | null> {
    const repairPrompt = buildGptFirstRepairUserPrompt(
        params.originalUserPrompt,
        params.previousArtifact,
        params.issues,
    );
    const response = await params.requester(
        `${GPT_FIRST_REPAIR_CONTRACT}\n\n${GPT_FIRST_SYSTEM_PROMPT}`,
        repairPrompt,
        {
            ...params.requestOptions,
            schema: GPT_FIRST_SCHEMA,
            schemaName: 'ffe_gpt_first_session_analysis',
            maxOutputTokens: params.runtime.maxOutputTokens,
            ingestId: `${params.requestOptions.ingestId ?? 'gpt-first'}:structural-repair`,
        },
    );
    if (!response) return null;
    const repaired = normalizeOutput(response.parsed, params.input);
    if (ledgerSemanticallyRewritten(params.previousArtifact, repaired)) {
        return { output: params.previousArtifact, mutated: true };
    }
    return { output: repaired, mutated: false };
}

export async function analyzeGptFirstSession(): Promise<GptFirstAnalysisResult | null> {
    throw new Error('OpenAI API semantic analysis removed — use ChatGPT Project pipeline (ffePipelineIngest.service)');
}

// Legacy OpenAI API implementation removed in Phase 5.
/*
export async function analyzeGptFirstSession(
    input: GptFirstSessionInput,
    options: {
        jobId?: string | null;
        ingestId?: string | null;
        recordUsage?: boolean;
        model?: string;
        reasoningEffort?: StructuredJsonRequestOptions['reasoningEffort'];
        requestStructuredJson?: GptFirstStructuredRequester;
    } = {},
): Promise<GptFirstAnalysisResult | null> {
    const startedAt = Date.now();
    const completedInput = completeGptFirstSessionInput(input);
    const userPrompt = buildUserPrompt(completedInput);
    const runtime = resolveGptFirstRuntime({
        model: options.model,
        reasoningEffort: options.reasoningEffort,
    });
    const requester = options.requestStructuredJson ?? requestStructuredJson;
    const baseRequest = {
        operationType: 'session_synthesis' as const,
        jobId: options.jobId,
        ingestId: options.ingestId ?? `gpt-first:${completedInput.business_day}`,
        model: runtime.model,
        reasoningEffort: runtime.reasoningEffort,
        requestTimeoutMs: runtime.timeoutMs,
        transportMaxAttempts: 1 as const,
        useBackground: runtime.useBackground,
        recordUsage: options.recordUsage ?? false,
        validate: (value: Record<string, unknown>) => Array.isArray(value.final_board) && Array.isArray(value.drivers) && Boolean(value.geo),
    };

    const emptyResult = (issues: ValidationIssue[], extra: Partial<GptFirstAnalysisResult> = {}): GptFirstAnalysisResult => ({
        output: attachProvenance(normalizeOutput({}, completedInput), completedInput, {
            semantic_ledger_hash: '',
            accepted_artifact_hash: '',
            semantic_attempts: 0,
            repair_mode: 'none',
            repair_attempts: 0,
            model_repair_calls: 0,
            needs_review: true,
            review_reason: issues[0]?.message,
        }),
        validation: { valid: false, issues, arithmeticProof: [] },
        provider: 'openai',
        model: runtime.model,
        promptVersion: FFE_GPT_FIRST_PROMPT_VERSION,
        accepted: false,
        attempts: 0,
        transportAttempts: extra.transportAttempts ?? 0,
        latencyMs: Date.now() - startedAt,
        needsReview: true,
        repairMode: 'none',
        semanticAttempts: 0,
        modelRepairCalls: 0,
        runtime,
        ...extra,
    });

    const response = await requester(GPT_FIRST_SYSTEM_PROMPT, userPrompt, {
        ...baseRequest,
        schema: GPT_FIRST_SCHEMA,
        schemaName: 'ffe_gpt_first_session_analysis',
        maxOutputTokens: runtime.maxOutputTokens,
        ingestId: `${baseRequest.ingestId}:semantic-1`,
    });
    if (!response) {
        return emptyResult(
            [{ code: 'TRANSPORT_FAILURE', message: 'OpenAI transport did not return a usable response' }],
            { transportFailure: true, transportAttempts: 1, attempts: 1 },
        );
    }

    const firstLedger = normalizeOutput(response.parsed, completedInput);
    const semanticLedgerHash = semanticCoreFingerprint(firstLedger);
    let output = cloneLedger(firstLedger);
    let validation = validateGptFirstAnalysis(output, completedInput);
    let repairMode: GptFirstRepairMode = 'none';
    let repairAttempts = 0;
    let modelRepairCalls = 0;
    let needsReview = false;
    let reviewReason: string | undefined;

    if (!validation.valid) {
        const deterministic = repairGptFirstArtifactDeterministically(output, completedInput);
        if (deterministic.changed) {
            output = deterministic.output;
            validation = validateGptFirstAnalysis(output, completedInput);
            repairMode = 'deterministic_structural';
            repairAttempts = 1;
        }
    }

    if (!validation.valid && hasUnrepairableSemanticIssue(validation.issues)) {
        needsReview = true;
        reviewReason = 'Semantic contradiction cannot be repaired structurally; first semantic ledger preserved';
        output = cloneLedger(firstLedger);
        validation = validateGptFirstAnalysis(output, completedInput);
        repairMode = repairAttempts ? 'deterministic_structural' : 'none';
    } else if (!validation.valid && modelRepairCalls < MAX_MODEL_REPAIR_ATTEMPTS) {
        const modelRepair = await applyModelStructuralRepair({
            originalUserPrompt: userPrompt,
            previousArtifact: output,
            input: completedInput,
            issues: validation.issues,
            requester,
            runtime,
            requestOptions: baseRequest,
        });
        modelRepairCalls = 1;
        if (!modelRepair) {
            needsReview = true;
            reviewReason = 'Structural model repair returned no usable response; first semantic ledger preserved';
        } else if (modelRepair.mutated) {
            needsReview = true;
            reviewReason = 'Model repair attempted to rewrite causal judgments; first semantic ledger preserved';
            output = cloneLedger(firstLedger);
            const restored = repairGptFirstArtifactDeterministically(output, completedInput);
            output = restored.output;
            repairMode = restored.changed ? 'deterministic_structural' : 'none';
            validation = validateGptFirstAnalysis(output, completedInput);
        } else {
            const afterModel = repairGptFirstArtifactDeterministically(modelRepair.output, completedInput);
            output = afterModel.output;
            validation = validateGptFirstAnalysis(output, completedInput);
            repairMode = 'model_structural';
            repairAttempts += 1;
            if (!validation.valid) {
                needsReview = true;
                reviewReason = 'Structural repair did not produce a valid ledger; same semantic artifact preserved';
            }
        }
    }

    if (!validation.valid) needsReview = true;

    const provenance: GptFirstIntegrityProvenance = {
        semantic_ledger_hash: semanticLedgerHash,
        accepted_artifact_hash: artifactFingerprint(output),
        semantic_attempts: MAX_SEMANTIC_ATTEMPTS,
        repair_mode: repairMode,
        repair_attempts: repairAttempts,
        model_repair_calls: modelRepairCalls,
        needs_review: needsReview || !validation.valid,
        review_reason: reviewReason,
    };
    output = attachProvenance(output, completedInput, provenance);

    return {
        output,
        validation,
        provider: response.provider,
        model: response.model,
        promptVersion: FFE_GPT_FIRST_PROMPT_VERSION,
        accepted: validation.valid,
        attempts: 1 + modelRepairCalls,
        transportAttempts: 1 + modelRepairCalls,
        latencyMs: Date.now() - startedAt,
        needsReview: provenance.needs_review,
        repairMode,
        semanticAttempts: 1,
        modelRepairCalls,
        runtime,
    };
}
*/

export {
    resetAiEvaluationTelemetry,
    getAiEvaluationTelemetry,
    sessionInputHash,
    buildUserPrompt as buildGptFirstUserPrompt,
    normalizeOutput as normalizeGptFirstOutput,
    EVIDENCE_DISPOSITIONS,
    collectCitedGuids,
    MAX_SEMANTIC_ATTEMPTS,
    MAX_MODEL_REPAIR_ATTEMPTS,
};
