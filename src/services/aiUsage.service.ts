import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

export type AiProvider = 'openai' | 'groq';
export type AiOperationType =
    | 'classification'
    | 'semantic_dedup'
    | 'coverage_repair'
    | 'semantic_adjudication'
    | 'geo_risk_evaluation'
    | 'session_synthesis'
    | 'session_review';

export type ProviderUsage = {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    totalTokens?: number | null;
    requestId?: string | null;
};

export type AiUsageCapture = {
    provider: AiProvider;
    model: string;
    operationType: AiOperationType;
    jobId?: string | null;
    ingestId?: string | null;
    usage?: ProviderUsage | null;
    requestStatus: 'success' | 'error';
    latencyMs?: number | null;
    attemptNumber: number;
    isRetry: boolean;
    isFallback: boolean;
    errorKind?: string | null;
    errorMessage?: string | null;
};

/**
 * Provider rates verified 2026-08-04. Prices are isolated here and may be overridden by env so
 * a future provider price change does not require code changes. Costs are estimates when a
 * provider omits usage; omitted token fields stay NULL rather than being recorded as zero.
 */
const PRICING: Record<AiProvider, { input: string; cachedInput: string; output: string }> = {
    openai: {
        input: ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION,
        cachedInput: ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
        output: ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION,
    },
    groq: {
        input: ENV.AI_GROQ_INPUT_PRICE_PER_MILLION,
        cachedInput: ENV.AI_GROQ_CACHED_INPUT_PRICE_PER_MILLION,
        output: ENV.AI_GROQ_OUTPUT_PRICE_PER_MILLION,
    },
};

function validTokenCount(value: number | null | undefined): number | null {
    return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : null;
}

function costFor(tokens: number | null, pricePerMillion: string): Prisma.Decimal | null {
    if (tokens == null) return null;
    try {
        return new Prisma.Decimal(tokens).mul(new Prisma.Decimal(pricePerMillion)).div(1_000_000);
    } catch {
        return null;
    }
}

function addCosts(values: Array<Prisma.Decimal | null>): Prisma.Decimal | null {
    const available = values.filter((value): value is Prisma.Decimal => value !== null);
    if (available.length === 0) return null;
    return available.reduce((sum, value) => sum.add(value), new Prisma.Decimal(0));
}

function safeText(value: string | null | undefined, max = 1000): string | null {
    if (!value) return null;
    return value.replace(/\s+/g, ' ').slice(0, max);
}

export async function recordAiUsage(capture: AiUsageCapture): Promise<void> {
    const usage = capture.usage ?? null;
    const inputTokens = validTokenCount(usage?.inputTokens);
    const cachedInputTokens = validTokenCount(usage?.cachedInputTokens);
    const outputTokens = validTokenCount(usage?.outputTokens);
    const reasoningTokens = validTokenCount(usage?.reasoningTokens);
    const totalTokens = validTokenCount(usage?.totalTokens);
    const pricing = PRICING[capture.provider];
    // Providers report cached input as part of input_tokens. Charge the uncached remainder at
    // the normal input rate and cached_tokens at the cache rate, without double-counting.
    const uncachedInput = inputTokens == null ? null : Math.max(inputTokens - (cachedInputTokens ?? 0), 0);
    const inputCost = costFor(uncachedInput, pricing.input);
    const cachedCost = costFor(cachedInputTokens, pricing.cachedInput);
    const outputCost = costFor(outputTokens, pricing.output);
    const totalCost = addCosts([inputCost, cachedCost, outputCost]);
    const usageAvailable = inputTokens !== null || cachedInputTokens !== null || outputTokens !== null || totalTokens !== null;

    try {
        await prisma.aiUsageRecord.create({
            data: {
                job_id: capture.jobId ?? null,
                ingest_id: capture.ingestId ?? null,
                operation_type: capture.operationType,
                provider: capture.provider,
                model: capture.model,
                input_tokens: inputTokens,
                cached_input_tokens: cachedInputTokens,
                output_tokens: outputTokens,
                reasoning_tokens: reasoningTokens,
                total_tokens: totalTokens,
                usage_available: usageAvailable,
                estimated_input_cost: inputCost,
                estimated_cached_cost: cachedCost,
                estimated_output_cost: outputCost,
                estimated_total_cost: totalCost,
                request_status: capture.requestStatus,
                request_id: safeText(usage?.requestId, 255),
                latency_ms: capture.latencyMs == null ? null : Math.max(0, Math.trunc(capture.latencyMs)),
                attempt_number: Math.max(1, Math.trunc(capture.attemptNumber)),
                is_retry: capture.isRetry,
                is_fallback: capture.isFallback,
                error_kind: safeText(capture.errorKind, 40),
                error_message: safeText(capture.errorMessage),
            },
        });
        if (capture.jobId) {
            await prisma.aiClassificationJob.updateMany({
                where: { id: capture.jobId },
                data: { provider: capture.provider, model: capture.model },
            });
        }
    } catch (error) {
        // Usage accounting must never make ingestion fail. Log metadata only; never prompts,
        // authorization headers, or response bodies.
        logger.error('[AIUsage] Failed to persist provider usage record', {
            provider: capture.provider,
            model: capture.model,
            operationType: capture.operationType,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export type AiUsageTotal = {
    provider: string;
    model: string;
    operationType: string;
    requests: number;
    usageRequests: number;
    estimatedCostUsd: string | null;
};

/** Daily/monthly totals for operational reporting without exposing prompts or secrets. */
export async function getAiUsageTotals(options: { from: Date; to: Date }): Promise<AiUsageTotal[]> {
    const rows = await prisma.$queryRaw<Array<{
        provider: string;
        model: string;
        operation_type: string;
        requests: bigint;
        usage_requests: bigint;
        estimated_cost_usd: Prisma.Decimal | null;
    }>>(Prisma.sql`
        SELECT provider, model, operation_type,
               COUNT(*)::bigint AS requests,
               COUNT(*) FILTER (WHERE usage_available = true)::bigint AS usage_requests,
               SUM(estimated_total_cost) AS estimated_cost_usd
        FROM ai_usage_records
        WHERE created_at >= ${options.from} AND created_at < ${options.to}
        GROUP BY provider, model, operation_type
        ORDER BY provider, model, operation_type
    `);

    return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        operationType: row.operation_type,
        requests: Number(row.requests),
        usageRequests: Number(row.usage_requests),
        estimatedCostUsd: row.estimated_cost_usd?.toString() ?? null,
    }));
}
