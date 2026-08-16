import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ENV } from '../config/env.js';
import {
    MARKET_BUSINESS_DAY_START_HOUR,
    MARKET_BUSINESS_TIMEZONE,
    addMarketCivilDays,
    marketBusinessDayKey,
    marketBusinessDayRange,
} from '../utils/marketBusinessDay.util.js';

export const AI_USAGE_REPORT_TIMEZONE = MARKET_BUSINESS_TIMEZONE;

export type ReportRange = {
    from: Date;
    to: Date;
    fromDate: string;
    toDate: string;
    timezone: string;
};

export type Pagination = { page: number; pageSize: number; total: number; totalPages: number };

const MAX_RANGE_DAYS = 366;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function addCivilDays(key: string, amount: number): string {
    return addMarketCivilDays(key, amount);
}

function isDateKey(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

export type ReportPreset = 'today' | 'yesterday' | 'last-7-days' | 'current-month' | 'previous-month' | 'custom';

export function resolveReportRange(input: {
    preset?: string;
    from?: string;
    to?: string;
}, now: Date = new Date()): ReportRange {
    const today = marketBusinessDayKey(now);
    const preset = (input.preset || 'today') as ReportPreset;
    if (!['today', 'yesterday', 'last-7-days', 'current-month', 'previous-month', 'custom'].includes(preset)) {
        throw new Error('Report preset is invalid');
    }
    let fromDate = today;
    let toDate = today;

    if (preset === 'yesterday') {
        fromDate = addCivilDays(today, -1);
        toDate = fromDate;
    } else if (preset === 'last-7-days') {
        fromDate = addCivilDays(today, -6);
    } else if (preset === 'current-month') {
        fromDate = `${today.slice(0, 7)}-01`;
    } else if (preset === 'previous-month') {
        const firstCurrent = `${today.slice(0, 7)}-01`;
        toDate = addCivilDays(firstCurrent, -1);
        fromDate = `${toDate.slice(0, 7)}-01`;
    } else if (preset === 'custom') {
        if (!isDateKey(input.from) || !isDateKey(input.to)) {
            throw new Error('Custom reports require valid from and to dates (YYYY-MM-DD)');
        }
        fromDate = input.from;
        toDate = input.to;
    }

    if (!isDateKey(fromDate) || !isDateKey(toDate) || fromDate > toDate) {
        throw new Error('Report date range is invalid');
    }
    const dayCount = Math.round((Date.parse(`${addCivilDays(toDate, 1)}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
    if (dayCount > MAX_RANGE_DAYS) throw new Error(`Report date range cannot exceed ${MAX_RANGE_DAYS} days`);

    const bounds = marketBusinessDayRange(fromDate, toDate);
    return {
        from: bounds.from,
        to: bounds.to,
        fromDate,
        toDate,
        timezone: AI_USAGE_REPORT_TIMEZONE,
    };
}

export function parsePagination(input: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number; skip: number } {
    const parse = (value: unknown, fallback: number) => {
        const number = Number(value);
        return Number.isInteger(number) ? number : fallback;
    };
    const page = Math.min(10_000, Math.max(1, parse(input.page, 1)));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parse(input.pageSize, DEFAULT_PAGE_SIZE)));
    return { page, pageSize, skip: (page - 1) * pageSize };
}

function asNumber(value: unknown): number {
    if (typeof value === 'bigint') return Number(value);
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function asNullableNumber(value: unknown): number | null {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function asDecimalString(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Prisma.Decimal) return value.toString();
    const text = String(value);
    return text === '0' ? '0' : text;
}

export function sanitizeAiError(value: unknown): string | null {
    if (value == null) return null;
    return String(value)
        .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
}

export function aiUsageCostAlertStatus(cost: string | null): 'normal' | 'attention' | 'warning' | 'critical' {
    const amount = Number(cost ?? 0);
    if (amount > ENV.AI_USAGE_COST_CRITICAL_USD) return 'critical';
    if (amount >= ENV.AI_USAGE_COST_WARNING_USD) return 'warning';
    if (amount >= ENV.AI_USAGE_COST_ATTENTION_USD) return 'attention';
    return 'normal';
}

export async function getAiUsageSummary(range: ReportRange, now: Date = new Date()) {
    const currentMonthRange = resolveReportRange({ preset: 'current-month' }, now);
    const [runRows, usageRows, monthlyRows, failedJobRows] = await Promise.all([
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT
                COALESCE(SUM(items_fetched), 0)::bigint AS discovered,
                COALESCE(SUM(new_items), 0)::bigint AS new_items,
                COALESCE(SUM(existing_items_skipped), 0)::bigint AS existing_skipped,
                COALESCE(SUM(items_classified), 0)::bigint AS classified,
                COALESCE(SUM(semantic_duplicates_found), 0)::bigint AS semantic_duplicates,
                COALESCE(SUM(items_enqueued), 0)::bigint AS enqueued,
                COALESCE(SUM(failed_items), 0)::bigint AS failed_items,
                COALESCE(SUM(recovered_items), 0)::bigint AS recovered_items,
                COALESCE(SUM(coverage_repairs), 0)::bigint AS coverage_repairs
            FROM market_driver_processing_runs
            WHERE started_at >= ${range.from} AND started_at < ${range.to}
        `),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT
                COUNT(*)::bigint AS requests,
                COUNT(*) FILTER (WHERE request_status = 'success')::bigint AS successful,
                COUNT(*) FILTER (WHERE request_status <> 'success')::bigint AS failed,
                COUNT(*) FILTER (WHERE provider = 'openai')::bigint AS openai,
                COUNT(*) FILTER (WHERE provider = 'groq' OR is_fallback = true)::bigint AS groq_fallback,
                COUNT(*) FILTER (WHERE is_retry = true)::bigint AS retries,
                COUNT(*) FILTER (WHERE operation_type = 'semantic_dedup')::bigint AS semantic_calls,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
                SUM(estimated_total_cost) AS estimated_cost
            FROM ai_usage_records
            WHERE created_at >= ${range.from} AND created_at < ${range.to}
        `),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT COALESCE(SUM(estimated_total_cost), 0) AS estimated_cost
            FROM ai_usage_records
            WHERE created_at >= ${currentMonthRange.from}
              AND created_at < ${currentMonthRange.to}
        `),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT COUNT(*)::bigint AS failed_dead_jobs
            FROM ai_classification_jobs
            WHERE status IN ('failed', 'dead')
              AND created_at >= ${range.from} AND created_at < ${range.to}
        `),
    ]);
    const run = runRows[0] ?? {};
    const usage = usageRows[0] ?? {};
    const monthlyCost = asDecimalString(monthlyRows[0]?.estimated_cost) ?? '0';
    return {
        range: { from: range.fromDate, to: range.toDate, timezone: range.timezone },
        totals: {
            headlinesDiscovered: asNumber(run.discovered),
            newHeadlines: asNumber(run.new_items),
            existingHeadlinesSkipped: asNumber(run.existing_skipped),
            successfulClassifications: asNumber(run.classified),
            semanticDeduplicationChecks: asNumber(usage.semantic_calls),
            pendingJobs: 0,
            failedDeadJobs: asNumber(failedJobRows[0]?.failed_dead_jobs),
            retryCount: asNumber(usage.retries),
            openaiRequests: asNumber(usage.openai),
            groqFallbackRequests: asNumber(usage.groq_fallback),
            inputTokens: asNumber(usage.input_tokens),
            cachedInputTokens: asNumber(usage.cached_input_tokens),
            outputTokens: asNumber(usage.output_tokens),
            reasoningTokens: asNumber(usage.reasoning_tokens),
            totalTokens: asNumber(usage.total_tokens),
            estimatedCostUsd: asDecimalString(usage.estimated_cost) ?? '0',
            failedCalls: asNumber(usage.failed),
            enqueuedItems: asNumber(run.enqueued),
            recoveredItems: asNumber(run.recovered_items),
            coverageRepairs: asNumber(run.coverage_repairs),
        },
        costAlert: {
            status: aiUsageCostAlertStatus(monthlyCost),
            selectedRangeEstimatedCostUsd: asDecimalString(usage.estimated_cost) ?? '0',
            currentMonthEstimatedCostUsd: monthlyCost,
            thresholdsUsd: {
                attention: ENV.AI_USAGE_COST_ATTENTION_USD,
                warning: ENV.AI_USAGE_COST_WARNING_USD,
                critical: ENV.AI_USAGE_COST_CRITICAL_USD,
                monthlyBudgetReference: ENV.AI_USAGE_MONTHLY_BUDGET_USD,
            },
            informationalOnly: true,
        },
    };
}

export async function getAiUsageDaily(range: ReportRange) {
    const [runRows, usageRows] = await Promise.all([
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT (((started_at AT TIME ZONE 'UTC') AT TIME ZONE ${range.timezone}) - (${MARKET_BUSINESS_DAY_START_HOUR} * INTERVAL '1 hour'))::date::text AS day,
                COALESCE(SUM(items_fetched), 0)::bigint AS discovered,
                COALESCE(SUM(new_items), 0)::bigint AS new_items,
                COALESCE(SUM(existing_items_skipped), 0)::bigint AS existing_skipped,
                COALESCE(SUM(items_classified), 0)::bigint AS classified,
                COALESCE(SUM(semantic_duplicates_found), 0)::bigint AS semantic_duplicates,
                COALESCE(SUM(coverage_repairs), 0)::bigint AS coverage_repairs
            FROM market_driver_processing_runs
            WHERE started_at >= ${range.from} AND started_at < ${range.to}
            GROUP BY 1
            ORDER BY 1
        `),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT (((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${range.timezone}) - (${MARKET_BUSINESS_DAY_START_HOUR} * INTERVAL '1 hour'))::date::text AS day,
                COUNT(*) FILTER (WHERE operation_type = 'semantic_dedup')::bigint AS dedup_calls,
                COUNT(*) FILTER (WHERE operation_type = 'coverage_repair')::bigint AS coverage_calls,
                COUNT(*) FILTER (WHERE provider = 'openai')::bigint AS openai_calls,
                COUNT(*) FILTER (WHERE provider = 'groq' OR is_fallback = true)::bigint AS groq_calls,
                COUNT(*) FILTER (WHERE request_status <> 'success')::bigint AS failed_calls,
                COUNT(*) FILTER (WHERE is_retry = true)::bigint AS retry_count,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
                SUM(estimated_total_cost) AS estimated_cost
            FROM ai_usage_records
            WHERE created_at >= ${range.from} AND created_at < ${range.to}
            GROUP BY 1
            ORDER BY 1
        `),
    ]);
    const byDay = new Map<string, Record<string, unknown>>();
    for (const row of runRows) byDay.set(String(row.day), row);
    for (const row of usageRows) byDay.set(String(row.day), { ...byDay.get(String(row.day)), ...row });
    const rows = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({
        date: day,
        headlinesDiscovered: asNumber(row.discovered),
        newHeadlines: asNumber(row.new_items),
        existingHeadlinesSkipped: asNumber(row.existing_skipped),
        classifiedHeadlines: asNumber(row.classified),
        deduplicationCalls: asNumber(row.dedup_calls),
        coverageRepairCalls: asNumber(row.coverage_calls),
        openaiCalls: asNumber(row.openai_calls),
        groqFallbackCalls: asNumber(row.groq_calls),
        failedCalls: asNumber(row.failed_calls),
        retryCount: asNumber(row.retry_count),
        inputTokens: asNumber(row.input_tokens),
        cachedInputTokens: asNumber(row.cached_input_tokens),
        outputTokens: asNumber(row.output_tokens),
        totalTokens: asNumber(row.total_tokens),
        estimatedCostUsd: asDecimalString(row.estimated_cost) ?? '0',
    }));
    return { range: { from: range.fromDate, to: range.toDate, timezone: range.timezone }, rows };
}

export async function getAiProviderBreakdown(range: ReportRange) {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT provider, model, operation_type,
            COUNT(*)::bigint AS requests,
            COUNT(*) FILTER (WHERE request_status = 'success')::bigint AS successes,
            COUNT(*) FILTER (WHERE request_status <> 'success')::bigint AS failures,
            COUNT(*) FILTER (WHERE is_retry = true OR is_fallback = true)::bigint AS retries_or_fallbacks,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
            COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
            AVG(latency_ms)::float8 AS average_latency_ms,
            SUM(estimated_total_cost) AS estimated_cost
        FROM ai_usage_records
        WHERE created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY provider, model, operation_type
        ORDER BY provider, model, operation_type
    `);
    return {
        range: { from: range.fromDate, to: range.toDate, timezone: range.timezone },
        rows: rows.map((row) => ({
            provider: String(row.provider),
            model: String(row.model),
            operationType: String(row.operation_type),
            requests: asNumber(row.requests),
            successes: asNumber(row.successes),
            failures: asNumber(row.failures),
            retriesOrFallbacks: asNumber(row.retries_or_fallbacks),
            inputTokens: asNumber(row.input_tokens),
            cachedInputTokens: asNumber(row.cached_input_tokens),
            outputTokens: asNumber(row.output_tokens),
            reasoningTokens: asNumber(row.reasoning_tokens),
            totalTokens: asNumber(row.total_tokens),
            averageLatencyMs: asNullableNumber(row.average_latency_ms),
            estimatedCostUsd: asDecimalString(row.estimated_cost) ?? '0',
        })),
    };
}

export async function getQueueHealth() {
    const [counts, oldest, errors, stale] = await Promise.all([
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT status, COUNT(*)::bigint AS count
            FROM ai_classification_jobs
            GROUP BY status
        `),
        prisma.aiClassificationJob.findFirst({
            where: { status: 'pending' },
            orderBy: { created_at: 'asc' },
            select: { created_at: true },
        }),
        prisma.aiClassificationJob.findMany({
            where: { OR: [{ status: { in: ['failed', 'dead'] } }, { last_error: { not: null } }] },
            orderBy: { updated_at: 'desc' },
            take: 20,
            select: { id: true, status: true, last_error_kind: true, last_error: true, attempt_count: true, updated_at: true },
        }),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT COALESCE(SUM(stale_recovery_count), 0)::bigint AS stale_recovered
            FROM ai_classification_jobs
        `),
    ]);
    const byStatus = new Map(counts.map((row) => [String(row.status), asNumber(row.count)]));
    return {
        pending: byStatus.get('pending') ?? 0,
        processing: byStatus.get('processing') ?? 0,
        completed: byStatus.get('completed') ?? 0,
        failed: byStatus.get('failed') ?? 0,
        dead: byStatus.get('dead') ?? 0,
        staleJobsRecovered: asNumber(stale[0]?.stale_recovered),
        oldestPendingJobAgeSeconds: oldest ? Math.max(0, Math.floor((Date.now() - oldest.created_at.getTime()) / 1000)) : null,
        recentErrors: errors.map((row) => ({
            jobId: row.id,
            status: row.status,
            errorCategory: row.last_error_kind,
            errorMessage: sanitizeAiError(row.last_error),
            attemptCount: row.attempt_count,
            updatedAt: row.updated_at.toISOString(),
        })),
    };
}

export async function getRecentAiRequests(range: ReportRange, paginationInput: { page?: unknown; pageSize?: unknown }) {
    const pagination = parsePagination(paginationInput);
    const [rows, countRows] = await Promise.all([
        prisma.aiUsageRecord.findMany({
            where: { created_at: { gte: range.from, lt: range.to } },
            orderBy: { created_at: 'desc' },
            skip: pagination.skip,
            take: pagination.pageSize,
            select: {
                id: true, created_at: true, provider: true, model: true, operation_type: true,
                job_id: true, ingest_id: true, request_status: true, input_tokens: true,
                cached_input_tokens: true, output_tokens: true, reasoning_tokens: true,
                total_tokens: true, estimated_total_cost: true, latency_ms: true,
                is_retry: true, is_fallback: true, error_kind: true,
            },
        }),
        prisma.aiUsageRecord.count({ where: { created_at: { gte: range.from, lt: range.to } } }),
    ]);
    const totalPages = Math.ceil(countRows / pagination.pageSize);
    return {
        range: { from: range.fromDate, to: range.toDate, timezone: range.timezone },
        pagination: { page: pagination.page, pageSize: pagination.pageSize, total: countRows, totalPages },
        rows: rows.map((row) => ({
            id: row.id,
            timestamp: row.created_at.toISOString(),
            provider: row.provider,
            model: row.model,
            operationType: row.operation_type,
            jobId: row.job_id,
            ingestId: row.ingest_id,
            status: row.request_status,
            inputTokens: row.input_tokens,
            cachedInputTokens: row.cached_input_tokens,
            outputTokens: row.output_tokens,
            reasoningTokens: row.reasoning_tokens,
            totalTokens: row.total_tokens,
            estimatedCostUsd: asDecimalString(row.estimated_total_cost) ?? '0',
            latencyMs: row.latency_ms,
            isRetry: row.is_retry,
            isFallback: row.is_fallback,
            errorCategory: row.error_kind,
        })),
    };
}

export async function getProcessingRuns(range: ReportRange, paginationInput: { page?: unknown; pageSize?: unknown }) {
    const pagination = parsePagination(paginationInput);
    const where = { started_at: { gte: range.from, lt: range.to } };
    const [rows, total] = await Promise.all([
        prisma.marketDriverProcessingRun.findMany({ where, orderBy: { started_at: 'desc' }, skip: pagination.skip, take: pagination.pageSize }),
        prisma.marketDriverProcessingRun.count({ where }),
    ]);
    return {
        range: { from: range.fromDate, to: range.toDate, timezone: range.timezone },
        pagination: { page: pagination.page, pageSize: pagination.pageSize, total, totalPages: Math.ceil(total / pagination.pageSize) },
        rows: rows.map((row) => ({
            id: row.id,
            ingestId: row.ingest_id,
            source: row.source,
            startedAt: row.started_at.toISOString(),
            completedAt: row.completed_at?.toISOString() ?? null,
            itemsFetched: row.items_fetched,
            newItems: row.new_items,
            existingItemsSkipped: row.existing_items_skipped,
            itemsEnqueued: row.items_enqueued,
            itemsClassified: row.items_classified,
            exactDuplicatesSkipped: row.exact_duplicates_skipped,
            semanticDuplicatesFound: row.semantic_duplicates_found,
            failedItems: row.failed_items,
            recoveredItems: row.recovered_items,
            coverageRepairs: row.coverage_repairs,
            status: row.status,
            errorCategory: row.error_category,
            durationMs: row.duration_ms,
        })),
    };
}

export async function retryAiClassificationJob(jobId: string, adminId: unknown) {
    const now = new Date();
    const normalizedAdminId = String(adminId ?? 'admin').slice(0, 120);
    const updated = await prisma.aiClassificationJob.updateMany({
        where: { id: jobId, status: { in: ['failed', 'dead'] } },
        data: {
            status: 'pending',
            attempt_count: 0,
            next_retry_at: now,
            locked_at: null,
            worker_id: null,
            completed_at: null,
            retry_count: { increment: 1 },
            last_retry_at: now,
            last_retry_by: normalizedAdminId,
        },
    });
    if (updated.count !== 1) {
        const existing = await prisma.aiClassificationJob.findUnique({ where: { id: jobId }, select: { status: true } });
        if (!existing) throw new Error('AI job not found');
        throw new Error(`Only failed or dead jobs can be retried (current status: ${existing.status})`);
    }
    const job = await prisma.aiClassificationJob.findUnique({ where: { id: jobId }, select: { id: true, status: true, retry_count: true } });
    return { jobId: job?.id ?? jobId, status: job?.status ?? 'pending', retryCount: job?.retry_count ?? 0 };
}
