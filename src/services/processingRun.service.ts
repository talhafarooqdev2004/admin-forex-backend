import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';

export type ProcessingRunCounters = {
    itemsFetched: number;
    newItems: number;
    existingItemsSkipped: number;
    itemsEnqueued: number;
    itemsClassified: number;
    exactDuplicatesSkipped: number;
    semanticDuplicatesFound: number;
    failedItems: number;
    recoveredItems: number;
    coverageRepairs: number;
};

export type ProcessingRunStatus = 'processing' | 'completed' | 'failed' | 'partial';

function nonNegativeInt(value: unknown): number {
    return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function normalizeCounters(counters: ProcessingRunCounters): ProcessingRunCounters {
    return {
        itemsFetched: nonNegativeInt(counters.itemsFetched),
        newItems: nonNegativeInt(counters.newItems),
        existingItemsSkipped: nonNegativeInt(counters.existingItemsSkipped),
        itemsEnqueued: nonNegativeInt(counters.itemsEnqueued),
        itemsClassified: nonNegativeInt(counters.itemsClassified),
        exactDuplicatesSkipped: nonNegativeInt(counters.exactDuplicatesSkipped),
        semanticDuplicatesFound: nonNegativeInt(counters.semanticDuplicatesFound),
        failedItems: nonNegativeInt(counters.failedItems),
        recoveredItems: nonNegativeInt(counters.recoveredItems),
        coverageRepairs: nonNegativeInt(counters.coverageRepairs),
    };
}

/** Persist only operational counters. This must never make RSS ingestion fail. */
export async function beginProcessingRun(
    ingestId: string | null | undefined,
    options: { source: string; startedAt?: Date } = { source: 'forex-scraping' },
): Promise<Date | null> {
    if (!ingestId) return null;
    const startedAt = options.startedAt ?? new Date();
    try {
        await prisma.marketDriverProcessingRun.upsert({
            where: { ingest_id: ingestId },
            create: {
                ingest_id: ingestId,
                source: options.source.slice(0, 80),
                started_at: startedAt,
                status: 'processing',
            },
            update: {
                source: options.source.slice(0, 80),
                status: 'processing',
                completed_at: null,
                error_category: null,
            },
        });
        return startedAt;
    } catch (error) {
        logger.warn('[ProcessingRun] Failed to persist run start', {
            ingestId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

export async function finishProcessingRun(
    ingestId: string | null | undefined,
    counters: ProcessingRunCounters,
    options: {
        status: ProcessingRunStatus;
        errorCategory?: string | null;
        startedAt?: Date | null;
    },
): Promise<void> {
    if (!ingestId) return;
    const normalized = normalizeCounters(counters);
    try {
        const current = await prisma.marketDriverProcessingRun.findUnique({
            where: { ingest_id: ingestId },
            select: { started_at: true },
        });
        const startedAt = options.startedAt ?? current?.started_at ?? new Date();
        const durationMs = Math.max(0, Date.now() - startedAt.getTime());
        await prisma.marketDriverProcessingRun.upsert({
            where: { ingest_id: ingestId },
            create: {
                ingest_id: ingestId,
                source: 'forex-scraping',
                started_at: startedAt,
                completed_at: new Date(),
                items_fetched: normalized.itemsFetched,
                new_items: normalized.newItems,
                existing_items_skipped: normalized.existingItemsSkipped,
                items_enqueued: normalized.itemsEnqueued,
                items_classified: normalized.itemsClassified,
                exact_duplicates_skipped: normalized.exactDuplicatesSkipped,
                semantic_duplicates_found: normalized.semanticDuplicatesFound,
                failed_items: normalized.failedItems,
                recovered_items: normalized.recoveredItems,
                coverage_repairs: normalized.coverageRepairs,
                status: options.status,
                error_category: options.errorCategory?.slice(0, 40) ?? null,
                duration_ms: durationMs,
            },
            update: {
                completed_at: new Date(),
                items_fetched: normalized.itemsFetched,
                new_items: normalized.newItems,
                existing_items_skipped: normalized.existingItemsSkipped,
                items_enqueued: normalized.itemsEnqueued,
                items_classified: normalized.itemsClassified,
                exact_duplicates_skipped: normalized.exactDuplicatesSkipped,
                semantic_duplicates_found: normalized.semanticDuplicatesFound,
                failed_items: normalized.failedItems,
                recovered_items: normalized.recoveredItems,
                coverage_repairs: normalized.coverageRepairs,
                status: options.status,
                error_category: options.errorCategory?.slice(0, 40) ?? null,
                duration_ms: durationMs,
            },
        });
    } catch (error) {
        logger.warn('[ProcessingRun] Failed to persist run counters', {
            ingestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
