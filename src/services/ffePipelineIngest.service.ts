/**
 * Production ingest: ChatGPT Project raw JSON → structural validation → DB persist.
 * ChatGPT Project is the analysis engine; code does not reinterpret scores.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.util.js';
import { parseChatGptRawResponse } from './ffeChatgptResponseParser.service.js';
import { validateChatGptJsonStructure } from './ffeChatgptJsonStructure.service.js';
import {
    artifactFingerprint,
    buildGptFirstEvidenceAudit,
    completeGptFirstSessionInput,
    FFE_GPT_FIRST_PROMPT_VERSION,
    normalizeGptFirstOutput,
    semanticCoreFingerprint,
    type GptFirstAnalysisResult,
    type GptFirstSessionInput,
    type GptFirstSessionItem,
} from './ffeGptFirstAnalysis.service.js';
import {
    getLatestGptFirstAnalysis,
    GPT_FIRST_SOURCE,
    persistGptFirstAnalysis,
} from './ffeGptFirstProduction.service.js';
import { websocketService } from './websocket.service.js';

export const FFE_PIPELINE_RUN_STATUSES = [
    'SUCCESS',
    'RSS_FAILED',
    'SNAPSHOT_FAILED',
    'CHATGPT_AUTH_FAILED',
    'CHATGPT_RUNTIME_FAILED',
    'PROJECT_INSTRUCTIONS_FAILED',
    'CLOUDFLARE_FAILED',
    'SUBMISSION_FAILED',
    'HYDRATION_FAILED',
    'GENERATION_FAILED',
    'CHATGPT_RESPONSE_INVALID',
    'PARSE_FAILED',
    'VALIDATION_FAILED',
    'PERSIST_FAILED',
    'STORAGE_FAILED',
    'SKIPPED_DUPLICATE',
] as const;

export type FfePipelineRunStatus = typeof FFE_PIPELINE_RUN_STATUSES[number];

export type FfePipelineSnapshotUnit = {
    guid: string;
    time: string;
    source?: string;
    source_label?: string;
    headline: string;
    body?: string;
    supporting_lines?: string[];
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
    source_unit_hash?: string;
    original_order?: number;
};

export type FfePipelineIngestPayload = {
    run_id: string;
    business_day: string;
    input_hash: string;
    prompt_hash?: string;
    prompt_version?: string;
    raw_rss_hash?: string;
    retained_count?: number;
    financialjuice_count?: number;
    fxstreet_count?: number;
    cutoff?: string;
    source_units: FfePipelineSnapshotUnit[];
    chatgpt?: {
        raw_response?: string;
        response_hash?: string;
        response_length?: number;
        parent_conversation_id?: string | null;
        branch_conversation_id?: string | null;
        response_wait_ms?: number;
        submitted_at?: string | null;
        completed_at?: string | null;
        screenshot_path?: string | null;
    };
    pipeline_status?: string;
    failed_stage?: string | null;
    error?: string | null;
    /** Re-run normalize/persist for an existing business_day + input_hash (no ChatGPT/RSS). */
    force_reingest?: boolean;
};

export type FfePipelineIngestResult = {
    run_id: string;
    business_day: string;
    input_hash: string;
    final_status: FfePipelineRunStatus;
    parse_status: 'not_attempted' | 'ok' | 'failed';
    persistence_status: 'not_attempted' | 'skipped_duplicate' | 'ok' | 'failed' | 'rejected';
    validation_valid?: boolean;
    validation_issues?: Array<{ code: string; message: string }>;
    snapshot_version?: number;
    observability_status?: 'JSON_PARSED' | 'CHATGPT_RESPONSE_INVALID' | 'PARSE_FAILED' | 'PERSIST_FAILED';
    failed_field?: string;
    parse_strategy?: string | null;
    message: string;
};

const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts', 'ffe-pipeline-runs');

function attachChatGptProvenance(
    output: ReturnType<typeof normalizeGptFirstOutput>,
    input: GptFirstSessionInput,
) {
    const semanticHash = semanticCoreFingerprint(output);
    return {
        ...output,
        evidence_audit: buildGptFirstEvidenceAudit(input),
        integrity_provenance: {
            semantic_ledger_hash: semanticHash,
            accepted_artifact_hash: artifactFingerprint(output),
            semantic_attempts: 1,
            repair_mode: 'deterministic_structural' as const,
            repair_attempts: 1,
            model_repair_calls: 0,
            needs_review: false,
            review_reason: undefined,
        },
    };
}

export function buildGptFirstSessionInputFromSnapshot(payload: FfePipelineIngestPayload): GptFirstSessionInput {
    const items: GptFirstSessionItem[] = payload.source_units.map((row, index) => ({
        guid: row.guid,
        time: row.time,
        headline: row.headline,
        body: row.body ?? '',
        supporting_lines: row.supporting_lines ?? [],
        actual: row.actual ?? null,
        forecast: row.forecast ?? null,
        previous: row.previous ?? null,
        source_label: row.source_label || row.source || 'FinancialJuice',
        source_unit_hash: row.source_unit_hash,
        original_order: row.original_order ?? index + 1,
    }));

    return completeGptFirstSessionInput({
        source: 'FinancialJuice RSS feed',
        business_day: payload.business_day,
        cutoff: payload.cutoff || items.at(-1)?.time || payload.business_day,
        items,
        parse_stats: {
            input_block_count: payload.source_units.length,
            retained_block_count: payload.retained_count ?? payload.source_units.length,
        },
    });
}

async function writeRunArtifact(runId: string, payload: unknown) {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    await fs.writeFile(
        path.join(ARTIFACTS_DIR, `${runId}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
    );
}

export async function ingestFfePipelineResult(payload: FfePipelineIngestPayload): Promise<FfePipelineIngestResult> {
    const base = {
        run_id: payload.run_id,
        business_day: payload.business_day,
        input_hash: payload.input_hash,
    };

    if (payload.failed_stage || (payload.pipeline_status && payload.pipeline_status !== 'success')) {
        const finalStatus = mapFailedStage(payload.failed_stage || payload.pipeline_status);
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: finalStatus,
            parse_status: 'not_attempted',
            persistence_status: 'not_attempted',
            message: payload.error || `${finalStatus} — previous production snapshot preserved`,
        };
        await writeRunArtifact(payload.run_id, { payload, result });
        return result;
    }

    const existing = await getLatestGptFirstAnalysis(payload.business_day);
    if (
        !payload.force_reingest
        && existing?.accepted
        && existing.inputHash === payload.input_hash.slice(0, 64)
    ) {
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: 'SKIPPED_DUPLICATE',
            parse_status: 'not_attempted',
            persistence_status: 'skipped_duplicate',
            snapshot_version: undefined,
            message: 'Successful production snapshot already exists for business_day + input_hash',
        };
        await writeRunArtifact(payload.run_id, { payload, result, existing_input_hash: existing.inputHash });
        return result;
    }

    const rawResponse = payload.chatgpt?.raw_response;
    if (!rawResponse) {
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: 'GENERATION_FAILED',
            parse_status: 'not_attempted',
            persistence_status: 'not_attempted',
            message: 'Missing ChatGPT raw_response',
        };
        await writeRunArtifact(payload.run_id, { payload, result });
        return result;
    }

    const parsed = parseChatGptRawResponse(rawResponse);
    if (!parsed.ok || !parsed.parsed) {
        const invalid = String(parsed.error || '').includes('CHATGPT_RESPONSE_INVALID');
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: invalid ? 'CHATGPT_RESPONSE_INVALID' : 'PARSE_FAILED',
            parse_status: 'failed',
            persistence_status: 'not_attempted',
            observability_status: invalid ? 'CHATGPT_RESPONSE_INVALID' : 'PARSE_FAILED',
            failed_field: parsed.failed_field,
            parse_strategy: parsed.strategy,
            message: parsed.error || 'ChatGPT response parse failed',
        };
        await writeRunArtifact(payload.run_id, { payload, result, parse: parsed });
        return result;
    }

    const structure = validateChatGptJsonStructure(parsed.parsed);
    if (!structure.valid) {
        const firstIssue = structure.issues[0];
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: 'CHATGPT_RESPONSE_INVALID',
            parse_status: 'ok',
            persistence_status: 'rejected',
            validation_valid: false,
            validation_issues: structure.issues,
            observability_status: 'CHATGPT_RESPONSE_INVALID',
            failed_field: firstIssue?.code || 'structure',
            parse_strategy: parsed.strategy,
            message: `CHATGPT_RESPONSE_INVALID: ${firstIssue?.message || 'missing required JSON fields'}`,
        };
        await writeRunArtifact(payload.run_id, { payload, result, structure });
        return result;
    }

    const sessionInput = buildGptFirstSessionInputFromSnapshot(payload);
    let output = normalizeGptFirstOutput(parsed.parsed, sessionInput);
    const validation = { valid: true, issues: [], arithmeticProof: [] as const };

    output = attachChatGptProvenance(output, sessionInput);

    const analysisResult: GptFirstAnalysisResult = {
        output,
        validation,
        provider: 'chatgpt_project',
        model: 'chatgpt-browser-automation',
        promptVersion: payload.prompt_version || FFE_GPT_FIRST_PROMPT_VERSION,
        accepted: true,
        attempts: 1,
        transportAttempts: 0,
        latencyMs: payload.chatgpt?.response_wait_ms || 0,
        needsReview: false,
        repairMode: 'deterministic_structural',
        semanticAttempts: 1,
        modelRepairCalls: 0,
        runtime: {
            model: 'chatgpt-browser-automation',
            reasoningEffort: 'none',
            timeoutMs: payload.chatgpt?.response_wait_ms || 0,
            maxOutputTokens: 0,
            useBackground: false,
        },
    };

    try {
        await persistGptFirstAnalysis(payload.business_day, analysisResult);
        websocketService.emitCalendarNewsUpdate('gpt-first');
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: 'SUCCESS',
            parse_status: 'ok',
            persistence_status: 'ok',
            validation_valid: true,
            observability_status: 'JSON_PARSED',
            parse_strategy: parsed.strategy,
            message: 'ChatGPT JSON parsed, structurally validated, and persisted',
        };
        await writeRunArtifact(payload.run_id, { payload, result, validation });
        logger.info('[FfePipeline] Production snapshot persisted', {
            run_id: payload.run_id,
            business_day: payload.business_day,
            input_hash: payload.input_hash.slice(0, 12),
        });
        return result;
    } catch (error) {
        const result: FfePipelineIngestResult = {
            ...base,
            final_status: 'PERSIST_FAILED',
            parse_status: 'ok',
            persistence_status: 'failed',
            validation_valid: true,
            observability_status: 'PERSIST_FAILED',
            parse_strategy: parsed.strategy,
            message: `PERSIST_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        };
        await writeRunArtifact(payload.run_id, { payload, result, error: result.message });
        return result;
    }
}

function mapFailedStage(stage: string | null | undefined): FfePipelineRunStatus {
    const value = String(stage || '').toUpperCase();
    if (value.includes('RSS')) return 'RSS_FAILED';
    if (value.includes('SNAPSHOT')) return 'SNAPSHOT_FAILED';
    if (value.includes('RUNTIME') || value.includes('XVFB') || value.includes('LIGHTSESSION') || value.includes('HEADLESS')) return 'CHATGPT_RUNTIME_FAILED';
    if (value.includes('AUTH')) return 'CHATGPT_AUTH_FAILED';
    if (value.includes('PROJECT_INSTRUCTION')) return 'PROJECT_INSTRUCTIONS_FAILED';
    if (value.includes('CLOUDFLARE')) return 'CLOUDFLARE_FAILED';
    if (value.includes('SUBMISSION') || value.includes('CLIPBOARD') || value.includes('INPUT_VERIFICATION')) return 'SUBMISSION_FAILED';
    if (value.includes('HYDRATION') || value.includes('BRANCH')) return 'HYDRATION_FAILED';
    if (value.includes('GENERATION') || value.includes('CAPTURE')) return 'GENERATION_FAILED';
    if (value.includes('CHATGPT_RESPONSE_INVALID') || value.includes('RESPONSE_INVALID')) return 'CHATGPT_RESPONSE_INVALID';
    if (value.includes('PARSE')) return 'PARSE_FAILED';
    if (value.includes('VALIDATION')) return 'VALIDATION_FAILED';
    if (value.includes('PERSIST')) return 'PERSIST_FAILED';
    if (value.includes('STORAGE')) return 'STORAGE_FAILED';
    return 'GENERATION_FAILED';
}

export { GPT_FIRST_SOURCE };
