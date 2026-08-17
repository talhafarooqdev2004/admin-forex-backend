import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { marketDayKey } from './marketDriverBoard.service.js';

export type NewsDecisionAuditFilters = {
    day: string;
    source?: string;
    finalDecisionCode?: string;
    classification?: string;
    impact?: string;
    asset?: string;
    visibleOnly?: boolean;
    rejectedOnly?: boolean;
    duplicatesOnly?: boolean;
    search?: string;
    page: number;
    pageSize: number;
    exportAll?: boolean;
};

const MAX_PAGE_SIZE = 5000;
const REJECTION_CODES = new Set(['IRRELEVANT', 'ECONOMIC_RELEASE', 'TECHNICAL_OR_PRICE_FORECAST', 'LOW_IMPACT', 'NO_TRACKED_ASSET_MAPPING', 'ZERO_OR_NON_ACTIONABLE_ASSET_SCORE', 'CLASSIFIED_BUT_NOT_BOARD_LOCKED']);

function boundsForDubaiDay(day: string): { from: Date; to: Date } {
    const [year, month, date] = day.split('-').map(Number);
    if (!year || !month || !date) throw new Error('day must use YYYY-MM-DD');
    return { from: new Date(Date.UTC(year, month - 1, date, -4)), to: new Date(Date.UTC(year, month - 1, date + 1, -4)) };
}

function safePage(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBool(value: unknown): boolean {
    return value === true || value === '1' || value === 'true';
}

export function fallbackDecision(row: { category: string; impact: string; assets: unknown; board_locked: boolean; duplicate_of: string | null }) {
    if (row.duplicate_of) return { code: 'SEMANTIC_DUPLICATE', reason: `Semantically duplicates canonical item ${row.duplicate_of}.`, secondary: [] };
    if (row.category === 'ECONOMIC') return { code: 'ECONOMIC_RELEASE', reason: 'Historical row is classified as an economic release; exact original reason was not persisted.', secondary: [] };
    if (row.category === 'IRRELEVANT') return { code: 'IRRELEVANT', reason: 'Historical row is classified as irrelevant; exact original reason was not persisted.', secondary: [] };
    if (row.impact === 'Low') return { code: 'LOW_IMPACT', reason: 'Historical row is Low impact; exact original reason was not persisted.', secondary: [] };
    const assets = Array.isArray(row.assets) ? row.assets : [];
    if (!assets.length) return { code: 'NO_TRACKED_ASSET_MAPPING', reason: 'Historical row has no persisted mapped assets; exact original reason was not persisted.', secondary: [] };
    if (row.board_locked && row.category === 'GEOPOLITICAL') return { code: 'GEOPOLITICAL_ACCEPTED', reason: 'Historical row is locked and classified as geopolitical.', secondary: ['VISIBLE_ON_NEWS_HEADLINE', 'VISIBLE_IN_GEOPOLITICAL'] };
    if (row.board_locked) return { code: 'DRIVER_ACCEPTED', reason: 'Historical row is locked and classified as a driver.', secondary: ['VISIBLE_ON_NEWS_HEADLINE', 'VISIBLE_IN_CATALYST'] };
    return { code: 'CLASSIFIED_BUT_NOT_BOARD_LOCKED', reason: 'Historical row was classified but is not board locked; original reason was not persisted.', secondary: ['HIDDEN_BY_DISPLAY_RULE'] };
}

export async function getNewsDecisionAudit(filters: NewsDecisionAuditFilters) {
    const bounds = boundsForDubaiDay(filters.day);
    const where: Prisma.MarketDriverNewsWhereInput = { day_key: filters.day };
    if (filters.source) where.source = { contains: filters.source, mode: 'insensitive' };
    if (filters.finalDecisionCode) where.final_decision_code = filters.finalDecisionCode;
    if (filters.classification) where.category = filters.classification.toUpperCase();
    if (filters.impact) where.impact = filters.impact;
    if (filters.search) where.OR = [{ headline: { contains: filters.search, mode: 'insensitive' } }, { guid: { contains: filters.search, mode: 'insensitive' } }];
    const rows = await prisma.marketDriverNews.findMany({
        where,
        orderBy: [{ published_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
        select: {
            id: true, day_key: true, published_at: true, created_at: true, source: true, source_id: true, guid: true, source_key: true,
            headline: true, category: true, impact: true, assets: true, duplicate_of: true, board_locked: true,
            classification_completed: true, semantic_dedup_completed: true, coverage_repair_completed: true,
            final_decision_code: true, final_decision_reason: true, secondary_reasons: true, decision_ingest_id: true,
            classification_job_id: true, classification_provider: true, classification_model: true,
        },
    });
    const mapped: any[] = rows.map((row) => {
        const fallback = fallbackDecision(row);
        const code = row.final_decision_code ?? fallback.code;
        const reason = row.final_decision_reason ?? fallback.reason;
        const secondary = Array.isArray(row.secondary_reasons) ? row.secondary_reasons : fallback.secondary;
        const assets = Array.isArray(row.assets) ? row.assets : [];
        const destinations = row.board_locked && !row.duplicate_of
            ? row.category === 'GEOPOLITICAL' ? ['News Headline', 'Geopolitical'] : ['News Headline', 'Catalyst']
            : [];
        const visible = destinations.length > 0;
        return {
            id: row.id,
            dayKey: row.day_key,
            publishedAt: row.published_at?.toISOString() ?? null,
            createdAt: row.created_at.toISOString(),
            source: row.source,
            sourceId: row.source_id,
            guid: row.guid,
            sourceKey: row.source_key,
            headline: row.headline,
            isNew: true,
            classification: row.category,
            impact: row.impact,
            assets,
            classificationCompleted: row.classification_completed,
            semanticDedupCompleted: row.semantic_dedup_completed,
            coverageRepairCompleted: row.coverage_repair_completed,
            duplicateOf: row.duplicate_of,
            boardLocked: row.board_locked,
            displayEligible: visible,
            visibleDestinations: destinations,
            finalDecisionCode: code,
            finalDecisionReason: reason,
            secondaryReasons: secondary,
            ingestId: row.decision_ingest_id,
            classificationJobId: row.classification_job_id,
            provider: row.classification_provider,
            model: row.classification_model,
            historicalDetail: row.final_decision_code == null,
        };
    }).filter((row) => {
        if (filters.asset && !row.assets.some((asset) => String((asset as Record<string, unknown>).asset ?? '').toUpperCase() === filters.asset!.toUpperCase())) return false;
        if (filters.visibleOnly && !row.displayEligible) return false;
        if (filters.rejectedOnly && !REJECTION_CODES.has(row.finalDecisionCode)) return false;
        if (filters.duplicatesOnly && !row.duplicateOf) return false;
        return true;
    });
    // Failed/dead jobs can have no MarketDriverNews row. Their durable public RSS payload is
    // sufficient to show the item as FAILED without replaying or requeueing anything.
    const failedJobs = await prisma.aiClassificationJob.findMany({
        where: { created_at: { gte: bounds.from, lt: bounds.to }, status: { in: ['failed', 'dead'] } },
        select: { id: true, ingest_id: true, provider: true, model: true, payload: true, last_error: true, created_at: true },
    });
    for (const job of failedJobs) {
        const payload = job.payload as { items?: Array<Record<string, unknown>> };
        for (const item of payload?.items ?? []) {
            const publishedAt = item.pubDate ? new Date(String(item.pubDate)) : null;
            if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;
            const sourceKey = String(item.sourceKey ?? item.guid ?? '');
            if (rows.some((row) => row.source_key === sourceKey)) continue;
            mapped.push({ id: `failed:${job.id}:${sourceKey}`, dayKey: filters.day, publishedAt: publishedAt.toISOString(), createdAt: job.created_at.toISOString(), source: item.source ?? null, sourceId: String(item.sourceId ?? 'unknown'), guid: String(item.guid ?? sourceKey), sourceKey, headline: String(item.title ?? ''), isNew: true, classification: '—', impact: '—', assets: [], classificationCompleted: false, semanticDedupCompleted: false, coverageRepairCompleted: false, duplicateOf: null, boardLocked: false, displayEligible: false, visibleDestinations: [], finalDecisionCode: 'CLASSIFICATION_FAILED', finalDecisionReason: job.last_error ? `Classification failed: ${job.last_error}` : 'Classification job failed before a classification decision was persisted.', secondaryReasons: [], ingestId: job.ingest_id, classificationJobId: job.id, provider: job.provider, model: job.model, historicalDetail: false });
        }
    }
    const uniqueSourceIdentities = new Set(rows.map((row) => row.source_key).filter(Boolean)).size;
    const runs = await prisma.marketDriverProcessingRun.aggregate({
        where: { started_at: { gte: bounds.from, lt: bounds.to } },
        _sum: { items_fetched: true, existing_items_skipped: true, new_items: true, items_classified: true, failed_items: true, exact_duplicates_skipped: true, semantic_duplicates_found: true },
    });
    const totals = {
        observationsFetched: runs._sum.items_fetched ?? 0,
        uniqueSourceIdentitiesObserved: uniqueSourceIdentities,
        existingIdentitiesSkipped: runs._sum.existing_items_skipped ?? 0,
        genuinelyNewItems: rows.length,
        successfullyClassified: mapped.filter((r) => r.classificationCompleted).length,
        classificationFailed: runs._sum.failed_items ?? 0,
        acceptedDriver: mapped.filter((r) => r.finalDecisionCode === 'DRIVER_ACCEPTED').length,
        acceptedGeopolitical: mapped.filter((r) => r.finalDecisionCode === 'GEOPOLITICAL_ACCEPTED').length,
        rejectedIrrelevant: mapped.filter((r) => r.finalDecisionCode === 'IRRELEVANT').length,
        rejectedEconomic: mapped.filter((r) => r.finalDecisionCode === 'ECONOMIC_RELEASE').length,
        rejectedTechnicalForecast: mapped.filter((r) => r.finalDecisionCode === 'TECHNICAL_OR_PRICE_FORECAST').length,
        lowImpact: mapped.filter((r) => r.finalDecisionCode === 'LOW_IMPACT').length,
        noTrackedAssetOrActionableScore: mapped.filter((r) => ['NO_TRACKED_ASSET_MAPPING', 'ZERO_OR_NON_ACTIONABLE_ASSET_SCORE'].includes(r.finalDecisionCode)).length,
        exactDuplicates: runs._sum.exact_duplicates_skipped ?? 0,
        semanticDuplicates: Math.max(runs._sum.semantic_duplicates_found ?? 0, mapped.filter((r) => r.finalDecisionCode === 'SEMANTIC_DUPLICATE').length),
        classifiedButHidden: mapped.filter((r) => !r.displayEligible && r.classificationCompleted && !r.duplicateOf).length,
        visibleNewsHeadlineRows: mapped.filter((r) => r.visibleDestinations.includes('News Headline')).length,
        visibleCatalystContributors: mapped.filter((r) => r.visibleDestinations.includes('Catalyst')).length,
        visibleGeopoliticalContributors: mapped.filter((r) => r.visibleDestinations.includes('Geopolitical')).length,
    };
    const newCount = Math.max(1, totals.genuinelyNewItems);
    const summary = { ...totals, passRate: Number((totals.visibleNewsHeadlineRows / newCount * 100).toFixed(1)), rejectRate: Number((mapped.filter((r) => REJECTION_CODES.has(r.finalDecisionCode)).length / newCount * 100).toFixed(1)), duplicateRate: Number((totals.semanticDuplicates / newCount * 100).toFixed(1)), dayKey: filters.day, historicalRowsArePartial: mapped.some((r) => r.historicalDetail) };
    const pageSize = filters.exportAll ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize));
    const page = filters.exportAll ? 1 : filters.page;
    const total = mapped.length;
    const pageRows = filters.exportAll ? mapped.slice(0, MAX_PAGE_SIZE) : mapped.slice((page - 1) * pageSize, page * pageSize);
    return { summary, rows: pageRows, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), exportTruncated: filters.exportAll && total > MAX_PAGE_SIZE } };
}

export function parseNewsDecisionAuditFilters(query: Record<string, unknown>): NewsDecisionAuditFilters {
    const day = typeof query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : marketDayKey();
    return { day, source: typeof query.source === 'string' ? query.source : undefined, finalDecisionCode: typeof query.finalDecisionCode === 'string' ? query.finalDecisionCode : undefined, classification: typeof query.classification === 'string' ? query.classification : undefined, impact: typeof query.impact === 'string' ? query.impact : undefined, asset: typeof query.asset === 'string' ? query.asset : undefined, visibleOnly: parseBool(query.visibleOnly), rejectedOnly: parseBool(query.rejectedOnly), duplicatesOnly: parseBool(query.duplicatesOnly), search: typeof query.search === 'string' ? query.search : undefined, page: safePage(query.page, 1), pageSize: Math.min(MAX_PAGE_SIZE, safePage(query.pageSize, 25)), exportAll: parseBool(query.exportAll) };
}
