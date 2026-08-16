import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { groqDailyLimitRemainingMs, isGroqDailyLimited } from './groqClassifier.service.js';

export type DeferredMarketDriverItem = {
    guid: string;
    sourceId?: string;
    sourceKey?: string;
    contentHash?: string;
    title: string;
    source: string | null;
    pubDate: string;
};

export type EnqueueAiClassificationOptions = {
    source?: string;
    ingestId?: string | null;
    reason?: string;
    operationType?: 'classification' | 'coverage_repair';
};

export type AiClassificationJobHandle = {
    id: string;
    status: string;
    workerId: string | null;
    attemptCount: number;
    maxAttempts: number;
};

const PENDING = 'pending';
const PROCESSING = 'processing';
const COMPLETED = 'completed';
const FAILED = 'failed';
const DEAD = 'dead';

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
const workerId = `${process.env.HOSTNAME || 'forex-backend'}:${process.pid}:${randomUUID().slice(0, 8)}`;

function normalizedItems(items: Array<DeferredMarketDriverItem | null | undefined>): DeferredMarketDriverItem[] {
    const seen = new Set<string>();
    const out: DeferredMarketDriverItem[] = [];
    for (const item of items) {
        if (!item || !item.guid || !item.title || !item.pubDate) continue;
        const identity = item.sourceKey || `${item.sourceId || 'unknown'}:${item.guid}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        out.push({
            guid: item.guid.slice(0, 500),
            ...(item.sourceId ? { sourceId: item.sourceId.slice(0, 80) } : {}),
            ...(item.sourceKey ? { sourceKey: item.sourceKey.slice(0, 800) } : {}),
            ...(item.contentHash ? { contentHash: item.contentHash.slice(0, 64) } : {}),
            title: item.title.slice(0, 1000),
            source: item.source ? item.source.slice(0, 255) : null,
            pubDate: item.pubDate.slice(0, 100),
        });
    }
    return out;
}

export function buildAiClassificationIdempotencyKey(
    operationType: string,
    items: Array<DeferredMarketDriverItem | null | undefined>,
): string {
    const normalized = normalizedItems(items);
    const source = normalized
        .map((item) => [item.sourceId || 'unknown', item.sourceKey || item.guid, item.contentHash || ''].join('|'))
        .sort()
        .join('\n');
    return `market-driver:${operationType}:${createHash('sha256').update(source).digest('hex')}`;
}

function payloadItems(payload: unknown): DeferredMarketDriverItem[] {
    if (!payload || typeof payload !== 'object') return [];
    const items = (payload as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return normalizedItems(items as Array<DeferredMarketDriverItem>);
}

function sourceVersionKey(
    item: Pick<DeferredMarketDriverItem, 'guid' | 'sourceId' | 'sourceKey' | 'contentHash'>,
): string {
    return `${item.sourceKey || `${item.sourceId || 'unknown'}:${item.guid}`}|${item.contentHash || ''}`;
}

/**
 * Persistent per-headline versions already owned by unfinished jobs. A scraper restart can send
 * the full feed while those jobs are waiting; ingestion uses this set to avoid regrouping the
 * same headlines into new overlapping batch jobs (and therefore paying to classify them twice).
 */
export async function getActiveAiClassificationSourceVersions(): Promise<Set<string>> {
    const jobs = await prisma.aiClassificationJob.findMany({
        where: { status: { in: [PENDING, FAILED, PROCESSING] } },
        select: { payload: true },
    });
    return new Set(jobs.flatMap((job) => payloadItems(job.payload).map(sourceVersionKey)));
}

export function buildAiClassificationSourceVersion(
    item: Pick<DeferredMarketDriverItem, 'guid' | 'sourceId' | 'sourceKey' | 'contentHash'>,
): string {
    return sourceVersionKey(item);
}

async function pendingItemCount(): Promise<number> {
    const jobs = await prisma.aiClassificationJob.findMany({
        where: { status: { in: [PENDING, FAILED, PROCESSING] } },
        select: { payload: true },
    });
    return jobs.reduce((total, job) => total + payloadItems(job.payload).length, 0);
}

/**
 * Persist deferred RSS work before returning from an ingest. The unique idempotency key makes
 * webhook retries and overlapping coverage audits safe. Public headline payload only; no prompt
 * or credential is written to the database.
 */
export async function enqueueAiClassificationJob(
    items: Array<DeferredMarketDriverItem | null | undefined>,
    options: EnqueueAiClassificationOptions = {},
): Promise<number> {
    const next = normalizedItems(items);
    if (next.length === 0) return pendingItemCount();

    const operationType = options.operationType ?? 'classification';
    const key = buildAiClassificationIdempotencyKey(operationType, next);
    const existing = await prisma.aiClassificationJob.findUnique({ where: { idempotency_key: key } });
    if (existing) {
        // A failed job with remaining attempts is made runnable again by a later feed retry. A
        // dead job stays dead so permanent validation/config failures cannot loop forever.
        if (existing.status === FAILED && existing.attempt_count < existing.max_attempts) {
            await prisma.aiClassificationJob.update({
                where: { id: existing.id },
                data: { status: PENDING, next_retry_at: new Date(), locked_at: null, worker_id: null },
            });
        }
        return pendingItemCount();
    }

    try {
        await prisma.aiClassificationJob.create({
            data: {
                job_type: 'market_driver_rss',
                source: options.source ?? 'forex-scraping',
                operation_type: operationType,
                content_hash: createHash('sha256')
                    .update(next.map((item) => item.contentHash || item.guid).sort().join('\n'))
                    .digest('hex'),
                idempotency_key: key,
                ingest_id: options.ingestId ?? null,
                headline_ids: next.map((item) => item.guid) as unknown as Prisma.InputJsonValue,
                payload: {
                    reason: options.reason ?? 'provider_limit_or_transient_failure',
                    items: next,
                } as unknown as Prisma.InputJsonValue,
                status: PENDING,
                max_attempts: Math.max(1, ENV.AI_QUEUE_MAX_ATTEMPTS),
                next_retry_at: new Date(),
            },
        });
        logger.warn('[AIQueue] Persisted Market Driver classification job', {
            itemCount: next.length,
            reason: options.reason ?? 'provider_limit_or_transient_failure',
        });
    } catch (error) {
        // A concurrent enqueue can race between findUnique and create; the unique constraint is
        // the final idempotency guard and is safe to treat as success.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    return pendingItemCount();
}

/**
 * Get or create a durable job before invoking a provider. The unique idempotency key means a
 * restarted webhook cannot create a second job for the same operation/source/content version.
 */
export async function ensureAiClassificationJob(
    items: Array<DeferredMarketDriverItem | null | undefined>,
    options: EnqueueAiClassificationOptions & { operationType?: 'classification' | 'coverage_repair' } = {},
): Promise<AiClassificationJobHandle | null> {
    const next = normalizedItems(items);
    if (next.length === 0) return null;
    const operationType = options.operationType ?? 'classification';
    const key = buildAiClassificationIdempotencyKey(operationType, next);
    const existing = await prisma.aiClassificationJob.findUnique({ where: { idempotency_key: key } });
    if (existing) {
        return {
            id: existing.id,
            status: existing.status,
            workerId: existing.worker_id,
            attemptCount: existing.attempt_count,
            maxAttempts: existing.max_attempts,
        };
    }
    try {
        const created = await prisma.aiClassificationJob.create({
            data: {
                job_type: 'market_driver_classification',
                source: options.source ?? 'forex-scraping',
                operation_type: operationType,
                content_hash: createHash('sha256')
                    .update(next.map((item) => item.contentHash || item.guid).sort().join('\n'))
                    .digest('hex'),
                idempotency_key: key,
                ingest_id: options.ingestId ?? null,
                headline_ids: next.map((item) => item.sourceKey || item.guid) as unknown as Prisma.InputJsonValue,
                payload: { reason: options.reason ?? 'classification', items: next } as unknown as Prisma.InputJsonValue,
                status: PENDING,
                max_attempts: Math.max(1, ENV.AI_QUEUE_MAX_ATTEMPTS),
                next_retry_at: new Date(),
            },
        });
        return {
            id: created.id,
            status: created.status,
            workerId: created.worker_id,
            attemptCount: created.attempt_count,
            maxAttempts: created.max_attempts,
        };
    } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        const raced = await prisma.aiClassificationJob.findUnique({ where: { idempotency_key: key } });
        if (!raced) throw error;
        return {
            id: raced.id,
            status: raced.status,
            workerId: raced.worker_id,
            attemptCount: raced.attempt_count,
            maxAttempts: raced.max_attempts,
        };
    }
}

/** Claim a known job atomically. A queued worker may continue the job it already owns. */
export async function claimAiClassificationJob(
    id: string,
    options: { allowProcessingJobId?: string | null; workerId?: string } = {},
): Promise<{ owned: boolean; completed: boolean; job: AiClassificationJobHandle | null }> {
    const current = await prisma.aiClassificationJob.findUnique({ where: { id } });
    if (!current) return { owned: false, completed: false, job: null };
    if (current.status === COMPLETED) {
        return {
            owned: false,
            completed: true,
            job: { id: current.id, status: current.status, workerId: current.worker_id, attemptCount: current.attempt_count, maxAttempts: current.max_attempts },
        };
    }
    if (current.status === PROCESSING && options.allowProcessingJobId !== id) {
        return {
            owned: false,
            completed: false,
            job: { id: current.id, status: current.status, workerId: current.worker_id, attemptCount: current.attempt_count, maxAttempts: current.max_attempts },
        };
    }
    if (current.status === PROCESSING) {
        return {
            owned: true,
            completed: false,
            job: { id: current.id, status: current.status, workerId: current.worker_id, attemptCount: current.attempt_count, maxAttempts: current.max_attempts },
        };
    }
    const now = new Date();
    const claimed = await prisma.aiClassificationJob.updateMany({
        where: { id, status: { in: [PENDING, FAILED] }, next_retry_at: { lte: now } },
        data: {
            status: PROCESSING,
            locked_at: now,
            worker_id: options.workerId ?? workerId,
            attempt_count: { increment: 1 },
        },
    });
    if (claimed.count !== 1) {
        const raced = await prisma.aiClassificationJob.findUnique({ where: { id } });
        return {
            owned: false,
            completed: raced?.status === COMPLETED,
            job: raced
                ? { id: raced.id, status: raced.status, workerId: raced.worker_id, attemptCount: raced.attempt_count, maxAttempts: raced.max_attempts }
                : null,
        };
    }
    return {
        owned: true,
        completed: false,
        job: {
            id,
            status: PROCESSING,
            workerId: options.workerId ?? workerId,
            attemptCount: current.attempt_count + 1,
            maxAttempts: current.max_attempts,
        },
    };
}

export function getAiWorkerId(): string {
    return workerId;
}

export async function getPendingAiClassificationItemCount(): Promise<number> {
    return pendingItemCount();
}

export async function recoverStaleAiClassificationJobs(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - Math.max(30_000, ENV.AI_QUEUE_LOCK_TIMEOUT_MS));
    const result = await prisma.aiClassificationJob.updateMany({
        where: { status: PROCESSING, locked_at: { lt: staleBefore } },
        data: {
            status: PENDING,
            stale_recovery_count: { increment: 1 },
            next_retry_at: now,
            locked_at: null,
            worker_id: null,
            last_error_kind: 'stale_lock_recovered',
            last_error: 'Recovered after worker lock timeout',
        },
    });
    if (result.count > 0) logger.warn(`[AIQueue] Recovered ${result.count} stale processing job(s)`);
    return result.count;
}

async function claimNextJob(now: Date = new Date(), onlyId?: string): Promise<{
    id: string;
    payload: Prisma.JsonValue;
    ingest_id: string | null;
    attempt_count: number;
    max_attempts: number;
} | null> {
    const candidate = await prisma.aiClassificationJob.findFirst({
        where: {
            ...(onlyId ? { id: onlyId } : {}),
            status: { in: [PENDING, FAILED] },
            next_retry_at: { lte: now },
        },
        orderBy: [{ next_retry_at: 'asc' }, { created_at: 'asc' }],
        select: { id: true, payload: true, ingest_id: true, attempt_count: true, max_attempts: true, next_retry_at: true, status: true },
    });
    if (!candidate) return null;

    // Conditional update is the atomic claim: two instances may read the same candidate, but
    // only one can change status from pending to processing.
    const claimed = await prisma.aiClassificationJob.updateMany({
        where: { id: candidate.id, status: candidate.status, next_retry_at: { lte: now } },
        data: {
            status: PROCESSING,
            locked_at: now,
            worker_id: workerId,
            attempt_count: { increment: 1 },
        },
    });
    if (claimed.count !== 1) return null;
    return {
        id: candidate.id,
        payload: candidate.payload,
        ingest_id: candidate.ingest_id,
        attempt_count: candidate.attempt_count + 1,
        max_attempts: candidate.max_attempts,
    };
}

export async function completeAiClassificationJob(id: string): Promise<void> {
    await prisma.aiClassificationJob.updateMany({
        where: { id, status: PROCESSING },
        data: { status: COMPLETED, completed_at: new Date(), locked_at: null, worker_id: null },
    });
}

export async function rescheduleAiClassificationJob(
    id: string,
    options: { errorKind: string; errorMessage: string; retryAfterMs?: number; provider?: string; model?: string },
): Promise<'failed' | 'dead'> {
    const job = await prisma.aiClassificationJob.findUnique({
        where: { id },
        select: { attempt_count: true, max_attempts: true, status: true },
    });
    if (!job || job.status !== PROCESSING) return DEAD;

    const exhausted = job.attempt_count >= job.max_attempts;
    const delay = options.retryAfterMs ?? Math.min(60 * 60_000, ENV.AI_RETRY_BASE_MS * 2 ** Math.max(0, job.attempt_count - 1));
    await prisma.aiClassificationJob.update({
        where: { id },
        data: {
            status: exhausted ? DEAD : FAILED,
            retry_count: { increment: 1 },
            next_retry_at: new Date(Date.now() + delay),
            locked_at: null,
            worker_id: null,
            provider: options.provider ?? null,
            model: options.model ?? null,
            last_error_code: options.errorKind.slice(0, 40),
            last_error_kind: options.errorKind.slice(0, 40),
            last_error: options.errorMessage.slice(0, 1000),
            ...(exhausted ? { completed_at: null } : {}),
        },
    });
    logger[exhausted ? 'error' : 'warn']('[AIQueue] Classification job outcome', {
        id,
        status: exhausted ? DEAD : FAILED,
        attempt: job.attempt_count,
        errorKind: options.errorKind,
    });
    return exhausted ? DEAD : FAILED;
}

async function processOneJob(now: Date = new Date(), onlyId?: string): Promise<boolean> {
    const board = await import('./marketDriverBoard.service.js');
    if (board.isMarketDriverIngestRunning()) return false;
    const job = await claimNextJob(now, onlyId);
    if (!job) return false;
    const items = payloadItems(job.payload);
    if (items.length === 0) {
        await completeAiClassificationJob(job.id);
        return true;
    }

    try {
        const result = await board.ingestMarketDriverRssItems(items, { queuedJobId: job.id, ingestId: job.ingest_id, now });
        // `deferredCount` is a global operational count and may include another job claimed by a
        // different instance. This claimed job is complete when its own ingest did not fail.
        if (!result.classifyFailed && !result.skippedOverlap) {
            await completeAiClassificationJob(job.id);
            if (result.changed) {
                const { websocketService } = await import('./websocket.service.js');
                websocketService.emitCalendarNewsUpdate('market-driver-queue');
            }
        } else {
            await rescheduleAiClassificationJob(job.id, {
                errorKind: isGroqDailyLimited() ? 'provider_daily_limit' : 'classification_failed',
                errorMessage: isGroqDailyLimited()
                    ? 'Provider daily limit; waiting for the next provider window'
                    : 'Classification did not produce a complete result',
                retryAfterMs: isGroqDailyLimited()
                    ? Math.max(30_000, groqDailyLimitRemainingMs() + 15_000)
                    : undefined,
            });
        }
    } catch (error) {
        await rescheduleAiClassificationJob(job.id, {
            errorKind: 'worker_error',
            errorMessage: error instanceof Error ? error.message : String(error),
        });
    }
    return true;
}

export async function processPendingAiClassificationJobs(maxJobs = 1, now: Date = new Date()): Promise<number> {
    if (workerRunning) return 0;
    workerRunning = true;
    try {
        await recoverStaleAiClassificationJobs(now);
        let processed = 0;
        for (let i = 0; i < Math.max(1, maxJobs); i += 1) {
            if (!(await processOneJob(now))) break;
            processed += 1;
        }
        return processed;
    } finally {
        workerRunning = false;
    }
}

/**
 * Test-only process seam used by the no-cost production-readiness harness. It runs the exact
 * claim/recovery/provider/persist path for one known fixture job without consuming unrelated
 * pending work that may already exist in a developer's local database.
 */
export async function processAiClassificationJobForTests(id: string, now: Date = new Date()): Promise<number> {
    if (workerRunning) return 0;
    workerRunning = true;
    try {
        await recoverStaleAiClassificationJobs(now);
        return (await processOneJob(now, id)) ? 1 : 0;
    } finally {
        workerRunning = false;
    }
}

/** Start one DB-backed worker per backend instance; claims are safe across instances. */
export function startAiClassificationQueueWorker(): void {
    if (workerTimer) return;
    void processPendingAiClassificationJobs().catch((error) =>
        logger.error('[AIQueue] Initial worker tick failed', error),
    );
    workerTimer = setInterval(() => {
        void processPendingAiClassificationJobs().catch((error) =>
            logger.error('[AIQueue] Worker tick failed', error),
        );
    }, Math.max(5_000, ENV.AI_QUEUE_POLL_MS));
    workerTimer.unref?.();
    logger.info(`[AIQueue] Durable classification worker started (poll=${ENV.AI_QUEUE_POLL_MS}ms)`);
}

export function stopAiClassificationQueueWorker(): void {
    if (!workerTimer) return;
    clearInterval(workerTimer);
    workerTimer = null;
}
