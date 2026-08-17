import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import { ENV } from '../config/env.js';
import {
    claimAiClassificationJob,
    enqueueAiClassificationJob,
    ensureAiClassificationJob,
    getAiWorkerId,
    getActiveAiClassificationSourceVersions,
    buildAiClassificationSourceVersion,
    getPendingAiClassificationItemCount,
    completeAiClassificationJob,
    rescheduleAiClassificationJob,
} from './aiClassificationQueue.service.js';
import {
    classifyHeadlines,
    findBatchDuplicateMap,
    groqDailyLimitRemainingMs,
    isBoardVisibleClassification,
    isGroqDailyLimited,
    likelySameEvent,
    oilCatalystCluster,
    sanitizeClassification,
    CATALYST_CURRENCIES,
    TRACKED_ASSETS,
    type AssetBias,
    type ClassifiedAsset,
    type ClassifiedHeadline,
    type ExistingTopic,
    type NewsCategory,
    type NewsImpact,
    type TrackedAsset,
} from './groqClassifier.service.js';
import {
    beginProcessingRun,
    finishProcessingRun,
} from './processingRun.service.js';
import {
    marketBusinessDayKey,
    previousMarketBusinessDayKey,
} from '../utils/marketBusinessDay.util.js';

/**
 * AI batch size per call. We loop until every fresh RSS item is classified in this ingest
 * (full feed — often 100–200+ items), so News Headline fills from one scrape.
 */
const CLASSIFY_BATCH_SIZE = 12;
/** Keep a small gap between batches so either provider's burst limits are respected. */
const CLASSIFY_BATCH_GAP_MS = Math.max(0, ENV.AI_CLASSIFICATION_BATCH_GAP_MS);

/** Only DRIVER + GEOPOLITICAL headlines feed the board; ECONOMIC comes from the calendar, IRRELEVANT is dropped. */
const BOARD_CATEGORIES = ['DRIVER', 'GEOPOLITICAL'];

/** Board display order (doc §1). */
const BOARD_ASSET_ORDER: TrackedAsset[] = [...CATALYST_CURRENCIES];

/**
 * Live market day key: Asia/Dubai (UAE), window 01:00 → next 01:00.
 * Example: 12 Jul 01:00 GST … 13 Jul 00:59 GST → day_key `2026-07-12`.
 * A post at 01:30 GST on 12 Jul belongs to `2026-07-12`; after 01:00 on 13 Jul the live
 * board only shows the new day (previous day is archived / not shown).
 */
export const marketDayKey = marketBusinessDayKey;

/** @deprecated Use marketDayKey — kept as alias for existing imports. */
export function uaeDayKey(date: Date = new Date()): string {
    return marketDayKey(date);
}

export function dayKeyFromPubDate(pubDate: string | null | undefined): string | null {
    if (!pubDate) return null;
    const d = new Date(pubDate);
    if (Number.isNaN(d.getTime())) return null;
    return marketDayKey(d);
}

export type CatalystBoardRow = {
    asset: TrackedAsset;
    bullishCount: number;
    bearishCount: number;
    /** Doc §23: sum of unique driver impact scores. */
    driverScore: number;
};

export type MarketDriverNewsRow = {
    id: string;
    headline: string;
    source: string | null;
    category: string;
    impact: string;
    summary: string | null;
    assets: ClassifiedAsset[];
    publishedAt: string | null;
    createdAt: string;
};

export type MarketDriverDiagnosticRow = MarketDriverNewsRow & {
    sourceId: string;
    guid: string;
    sourceKey: string;
    dayKey: string;
    classificationCompleted: boolean;
    semanticDedupCompleted: boolean;
    coverageRepairCompleted: boolean;
    boardLocked: boolean;
    duplicateOf: string | null;
    displayEligible: boolean;
    visibilityReason: string;
};

type DecisionMetadata = {
    code: string;
    reason: string;
    secondary: string[];
};

function decisionMetadata(headline: string, classification: { category: string; impact: string; assets: ClassifiedAsset[] }, duplicateOf: string | null, visible: boolean): DecisionMetadata {
    if (duplicateOf) return { code: 'SEMANTIC_DUPLICATE', reason: `Semantically duplicates canonical item ${duplicateOf}.`, secondary: [] };
    if (/\b(price|pair|forex|currency)\b.*\bforecast|forecast.*\b(price|pair|forex|currency)\b/i.test(headline)) return { code: 'TECHNICAL_OR_PRICE_FORECAST', reason: 'Rejected as a technical or pair-price forecast; production rules exclude speculative price forecasts.', secondary: [] };
    const category = String(classification.category).toUpperCase();
    const assets = Array.isArray(classification.assets) ? classification.assets : [];
    const tracked = assets.filter((asset) => (CATALYST_CURRENCIES as readonly string[]).includes(asset.asset));
    if (category === 'ECONOMIC') return { code: 'ECONOMIC_RELEASE', reason: 'Classified as an economic-calendar release; News Headline/Catalyst rules exclude it.', secondary: [] };
    if (category === 'IRRELEVANT') return { code: 'IRRELEVANT', reason: 'Classifier and post-classification rules marked this item irrelevant to tracked market drivers.', secondary: [] };
    if (classification.impact === 'Low') return { code: 'LOW_IMPACT', reason: 'Low-impact item; low-impact news is not admitted to the visible driver board.', secondary: [] };
    if (!tracked.length) return { code: 'NO_TRACKED_ASSET_MAPPING', reason: 'No tracked currency received a mapped asset score.', secondary: [] };
    if (!tracked.some((asset) => Number(asset.score) !== 0)) return { code: 'ZERO_OR_NON_ACTIONABLE_ASSET_SCORE', reason: 'Mapped assets had no non-zero actionable score.', secondary: [] };
    if (visible && category === 'GEOPOLITICAL') return { code: 'GEOPOLITICAL_ACCEPTED', reason: 'Accepted as a geopolitical driver and locked for display.', secondary: ['VISIBLE_ON_NEWS_HEADLINE', 'VISIBLE_IN_GEOPOLITICAL'] };
    if (visible && category === 'DRIVER') return { code: 'DRIVER_ACCEPTED', reason: 'Accepted as a market driver and locked for display.', secondary: ['VISIBLE_ON_NEWS_HEADLINE', 'VISIBLE_IN_CATALYST'] };
    return { code: 'CLASSIFIED_BUT_NOT_BOARD_LOCKED', reason: 'Classification completed, but the final display eligibility rule did not lock this item.', secondary: ['HIDDEN_BY_DISPLAY_RULE'] };
}

function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

export type RssItem = {
    guid: string;
    sourceId: string;
    sourceKey: string;
    contentHash: string;
    title: string;
    source: string | null;
    pubDate: string | null;
    existingId?: string;
    existingLocked?: boolean;
};

/** A currently-shown (locked) board headline, used as an admission-dedup target for new items. */
type LockedPrincipal = { id: string; headline: string; primary: string | null };

/**
 * Deterministic same-event admission dedup: does `headline` (primary asset `primary`) report the
 * same story as an already-locked principal? Same-primary + `likelySameEvent`, plus the OIL
 * conflict-cluster fingerprint. Returns the principal id to fold into, or null. Runs at insert
 * only (admission) — never used to demote something already shown.
 */
function matchLockedPrincipal(headline: string, primary: string | null, lockedPrincipals: LockedPrincipal[]): string | null {
    if (!primary) return null;
    for (const p of lockedPrincipals) {
        if (p.primary !== primary) continue;
        if (likelySameEvent(p.headline, headline)) return p.id;
        if (primary === 'OIL') {
            const a = oilCatalystCluster(p.headline);
            const b = oilCatalystCluster(headline);
            if (a && b && a === b) return p.id;
        }
    }
    return null;
}

function normalizeSourceId(value: unknown, source: string | null): string {
    const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
    if (normalized) return normalized.slice(0, 80);
    const fromSource = String(source ?? '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
    return (fromSource || 'unknown').slice(0, 80);
}

function sourceIdentity(sourceId: string, guid: string, source: string | null, title: string, pubDate: string | null) {
    const stableIdentifier = guid.trim() || createHash('sha256')
        .update(`${sourceId}\n${source ?? ''}\n${pubDate ?? ''}\n${normalizeTitle(title)}`)
        .digest('hex');
    const sourceKey = createHash('sha256').update(`${sourceId}\n${stableIdentifier}`).digest('hex');
    const contentHash = createHash('sha256').update(`${sourceId}\n${stableIdentifier}\n${source ?? ''}\n${pubDate ?? ''}\n${normalizeTitle(title)}`).digest('hex');
    return { stableIdentifier, sourceKey, contentHash };
}

function normalizeRssItems(rawItems: unknown[]): RssItem[] {
    const out: RssItem[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const it = raw as Record<string, unknown>;
        const title = String(it.title ?? '')
            .replace(/^FinancialJuice:\s*/i, '')
            .trim();
        const source = it.source == null || it.source === '' ? 'FinancialJuice' : String(it.source).trim();
        const sourceId = normalizeSourceId(it.sourceId ?? it.feedId, source);
        const rawGuid = String(it.guid ?? '').trim();
        const identity = sourceIdentity(sourceId, rawGuid, source, title, it.pubDate == null || it.pubDate === '' ? null : String(it.pubDate).trim());
        const guid = identity.stableIdentifier;
        if (!title || !guid || seen.has(identity.sourceKey)) continue;
        seen.add(identity.sourceKey);
        out.push({
            guid: guid.slice(0, 500),
            sourceId,
            sourceKey: identity.sourceKey,
            contentHash: identity.contentHash,
            title,
            source,
            pubDate: it.pubDate == null || it.pubDate === '' ? null : String(it.pubDate).trim(),
        });
    }
    return out;
}

/**
 * Max already-stored headlines sent as dedup context per AI call. Most-recent-first (see the
 * query below) — a headline from minutes ago is far more likely to be re-reported than one from
 * 10 hours ago, and keeping this small also matters for the free-tier 12k TPM rate limit once
 * a day's principal count grows into the hundreds. The same cap is used for new-item semantic
 * dedup context so cost grows with arrivals rather than the whole day.
 */
const MAX_EXISTING_TOPICS = 50;

/**
 * Follows a possibly-chained duplicate reference (batch item A duplicates batch item B, which
 * itself duplicates an existing row, etc.) down to its root id. Returns `null` when `startIndex`
 * is itself the principal (no duplicate), or the target's real row id otherwise — the target may
 * be an existing stored row, or another batch item's freshly-generated id. Cycle-safe.
 */
function resolveDuplicateOf(
    startIndex: number,
    classifiedByIndex: Map<number, ClassifiedHeadline>,
    batchIds: string[],
): string | null {
    const visited = new Set<number>();
    let currentIndex = startIndex;

    for (;;) {
        const current = classifiedByIndex.get(currentIndex);
        if (!current) return null;

        if (current.duplicateOfExistingId) return current.duplicateOfExistingId;

        if (current.duplicateOfBatchIndex === null) {
            // `current` is a principal (no duplicate). If that's the start item itself, it has
            // no duplicate at all; otherwise the start item duplicates this principal's row.
            return currentIndex === startIndex ? null : (batchIds[currentIndex] ?? null);
        }

        if (visited.has(currentIndex)) return null; // cycle guard — treat the start item as principal
        visited.add(currentIndex);
        currentIndex = current.duplicateOfBatchIndex;
    }
}

/**
 * Re-key headlines by publish time into the UAE 01:00→01:00 market day.
 * Fixes prior mis-tags so live boards stop showing yesterday.
 */
export async function realignMarketDriverDayKeysByPubDate(now: Date = new Date()): Promise<number> {
    const live = marketDayKey(now);
    const lookback = previousUaeDayKey(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000));
    const candidates = await prisma.marketDriverNews.findMany({
        // Locked rows are frozen: a headline shown on today's board stays on today's board even
        // if its pubDate would re-key it. Only re-key rows that were never shown.
        where: { day_key: { gte: lookback }, published_at: { not: null }, board_locked: false },
        select: { id: true, day_key: true, published_at: true },
    });

    let updated = 0;
    for (const row of candidates) {
        if (!row.published_at) continue;
        const correct = marketDayKey(row.published_at);
        if (correct === row.day_key) continue;
        await prisma.marketDriverNews.update({
            where: { id: row.id },
            data: { day_key: correct },
        });
        updated += 1;
    }

    if (updated > 0) {
        logger.info(
            `[MarketDriver] Re-keyed ${updated} headline(s) onto correct UAE market day (live=${live})`,
        );
    }
    return updated;
}

/**
 * Re-apply doc sanitizers on already-stored rows for the current market day (no AI cost):
 * impact↔score coupling, non-crude energy → IRRELEVANT, weak OIL tags dropped, weak summaries fixed.
 */
export async function realignTodaysMarketDriverScores(now: Date = new Date()): Promise<number> {
    const dayKey = marketDayKey(now);
    const items = await prisma.marketDriverNews.findMany({
        // Locked (already-shown) rows are frozen — re-sanitizing could empty assets / drop to
        // Low / flip to IRRELEVANT and un-show them. Only sanitize rows not yet on the board;
        // if sanitize makes one board-visible, that's an ADD and it gets locked below.
        // Skip already-folded duplicates — they must not get board_locked while duplicate_of is set.
        where: { day_key: dayKey, board_locked: false, duplicate_of: null },
        select: { id: true, headline: true, category: true, impact: true, assets: true, summary: true },
    });

    let updated = 0;
    for (const item of items) {
        const impactRaw = String(item.impact ?? 'Low').toLowerCase();
        const impactGuess: NewsImpact = impactRaw.startsWith('high')
            ? 'High'
            : impactRaw.startsWith('med')
              ? 'Medium'
              : 'Low';
        const categoryGuess = String(item.category ?? 'IRRELEVANT').toUpperCase() as NewsCategory;
        const category: NewsCategory = ['ECONOMIC', 'DRIVER', 'GEOPOLITICAL', 'IRRELEVANT'].includes(categoryGuess)
            ? categoryGuess
            : 'IRRELEVANT';

        const assetsIn = ((item.assets as unknown as ClassifiedAsset[]) ?? []).map((a) => ({
            asset: a.asset,
            bias: (a.bias as AssetBias) ?? 'Neutral',
            score: Number(a.score) || 0,
        }));

        const sanitized = sanitizeClassification(item.headline, {
            category,
            impact: impactGuess,
            assets: assetsIn,
            summary: item.summary ?? '',
        });

        // Promotion: if sanitize makes this (unlocked) row board-visible, lock it now (an ADD).
        const nowVisible = isBoardVisibleClassification({
            category: sanitized.category,
            impact: sanitized.impact,
            assets: sanitized.assets,
            duplicateOf: null,
        });

        const unchanged =
            JSON.stringify(assetsIn) === JSON.stringify(sanitized.assets) &&
            item.impact === sanitized.impact &&
            item.category === sanitized.category &&
            (item.summary ?? '') === sanitized.summary;

        if (unchanged && !nowVisible) continue;

        await prisma.marketDriverNews.update({
            where: { id: item.id },
            data: {
                category: sanitized.category,
                impact: sanitized.impact,
                summary: sanitized.summary,
                assets: sanitized.assets as unknown as object,
                classification_completed: true,
                semantic_dedup_completed: !nowVisible,
                // board_locked only ever goes false→true; never written false here.
                ...(nowVisible ? { board_locked: true } : {}),
            },
        });
        updated += 1;
    }

    if (updated > 0) {
        logger.info(`[MarketDriver] Sanitized ${updated} stored headline(s) to match doc rules`);
    }
    const deduped = await markTodaysDeterministicDuplicates();
    return updated + deduped;
}

/**
 * Explicit operator-only migration for a rulebook change. Unlike normal restart/recovery,
 * this intentionally revisits completed and locked rows for the current market day; callers
 * must invoke it manually. It makes no provider call and lets the existing semantic-dedup
 * worker re-check only the newly reprocessed visible rows.
 */
export async function applyFfeCatalystRulesToCurrentDay(now: Date = new Date()): Promise<{ updated: number; visible: number }> {
    const dayKey = marketDayKey(now);
    const items = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey },
        select: { id: true, headline: true, category: true, impact: true, assets: true, summary: true },
    });

    let updated = 0;
    let visible = 0;
    for (const item of items) {
        const impactRaw = String(item.impact ?? 'Low').toLowerCase();
        const impact: NewsImpact = impactRaw.startsWith('high') ? 'High' : impactRaw.startsWith('med') ? 'Medium' : 'Low';
        const categoryRaw = String(item.category ?? 'IRRELEVANT').toUpperCase() as NewsCategory;
        const category: NewsCategory = ['ECONOMIC', 'DRIVER', 'GEOPOLITICAL', 'IRRELEVANT'].includes(categoryRaw)
            ? categoryRaw
            : 'IRRELEVANT';
        const assets = ((item.assets as unknown as ClassifiedAsset[]) ?? []).map((asset) => ({
            asset: asset.asset,
            bias: (asset.bias as AssetBias) ?? 'Neutral',
            score: Number(asset.score) || 0,
        }));
        const sanitized = sanitizeClassification(item.headline, {
            category,
            impact,
            assets,
            summary: item.summary ?? '',
        });
        const isVisible = isBoardVisibleClassification({ ...sanitized, duplicateOf: null });
        await prisma.marketDriverNews.update({
            where: { id: item.id },
            data: {
                category: sanitized.category,
                impact: sanitized.impact,
                summary: sanitized.summary,
                assets: sanitized.assets as unknown as object,
                duplicate_of: null,
                board_locked: isVisible,
                classification_completed: true,
                semantic_dedup_completed: !isVisible,
                semantic_dedup_started_at: null,
                semantic_dedup_worker_id: null,
                coverage_repair_completed: true,
            },
        });
        updated += 1;
        if (isVisible) visible += 1;
    }
    logger.info(`[MarketDriver] Explicit FFE Catalyst rulebook apply: ${updated} rows, ${visible} visible`);
    return { updated, visible };
}

const RECLASSIFY_BATCH = 10;

/**
 * Full AI reclassify of today's stored headlines (fixes asset/summary/category with the current
 * prompt), then a second pass to mark same-event duplicates (doc §3). Expensive — run on demand.
 */
export async function reclassifyTodaysMarketDriverNews(): Promise<{ updated: number; duplicates: number }> {
    const dayKey = uaeDayKey();
    const items = await prisma.marketDriverNews.findMany({
        // Never reclassify a locked (shown) row — it is frozen for the day. Only revisit rows
        // that were never shown; if reclassify makes one visible it gets locked (an ADD).
        where: { day_key: dayKey, board_locked: false },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true, published_at: true },
    });

    let updated = 0;
    for (let i = 0; i < items.length; i += RECLASSIFY_BATCH) {
        const batch = items.slice(i, i + RECLASSIFY_BATCH);
        const classified = await classifyHeadlines(
            batch.map((b) => ({ text: b.headline, publishedAt: b.published_at })),
            [],
        );
        if (classified.length === 0) {
            logger.warn(`[MarketDriver] Reclassify batch starting at ${i} returned empty — skipping`);
            continue;
        }

        for (const c of classified) {
            const row = batch[c.index];
            if (!row) continue;
            const nowVisible = isBoardVisibleClassification({
                category: c.category,
                impact: c.impact,
                assets: c.assets,
                duplicateOf: null,
            });
            await prisma.marketDriverNews.update({
                where: { id: row.id },
                data: {
                    category: c.category,
                    impact: c.impact,
                    summary: c.summary,
                    assets: c.assets as unknown as object,
                    // Clear stale duplicate links before the dedicated dedup pass below.
                    duplicate_of: null,
                    classification_completed: true,
                    semantic_dedup_completed: !nowVisible,
                    coverage_repair_completed: true,
                    ...(nowVisible ? { board_locked: true } : {}),
                },
            });
            updated += 1;
        }

        // Soft rate-limit between provider batches.
        if (i + RECLASSIFY_BATCH < items.length) {
            await new Promise((r) => setTimeout(r, 8000));
        }
    }

    const duplicates = await markTodaysSemanticDuplicates();
    logger.info(`[MarketDriver] Reclassified ${updated} headline(s); marked ${duplicates} duplicate(s)`);
    return { updated, duplicates };
}

/**
 * Second pass over today's non-IRRELEVANT principals to mark same-event duplicates (doc §3).
 */
export async function markTodaysSemanticDuplicates(): Promise<number> {
    const dayKey = uaeDayKey();
    const principals = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
        },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true, board_locked: true, published_at: true },
    });
    if (principals.length < 2) {
        if (principals.length === 1) {
            await prisma.marketDriverNews.update({ where: { id: principals[0].id }, data: { semantic_dedup_completed: true } });
        }
        return 0;
    }

    let marked = 0;
    for (let i = 0; i < principals.length; i += RECLASSIFY_BATCH - 2) {
        const batch = principals.slice(i, i + RECLASSIFY_BATCH);
        if (batch.length < 2) break;

        const dupMap = await findBatchDuplicateMap(
            batch.map((b) => ({ text: b.headline, publishedAt: b.published_at })),
        );
        for (const [dupIdx, principalIdx] of dupMap) {
            const principal = batch[principalIdx];
            const dup = batch[dupIdx];
            if (!principal || !dup || principal.id === dup.id) continue;
            // Never demote a locked (already-shown) row — it stays visible for the whole day.
            if (dup.board_locked) continue;
            await prisma.marketDriverNews.update({
                where: { id: dup.id },
                data: { duplicate_of: principal.id },
            });
            marked += 1;
        }

        if (i + RECLASSIFY_BATCH - 2 < principals.length) {
            await new Promise((r) => setTimeout(r, 8000));
        }
    }

    await prisma.marketDriverNews.updateMany({
        where: { id: { in: principals.map((row) => row.id) } },
        data: { semantic_dedup_completed: true },
    });

    return marked;
}

/**
 * AI-judgment same-briefing dedup (doc §3), bounded to a recent time window so it runs
 * automatically after every ingest without re-scanning (and re-billing) the whole day.
 * Catches fragments the per-batch provider pass and the cheap fingerprint pass both miss —
 * e.g. three separate "Trump: ..." bullets from one Iran briefing minutes apart — without
 * hardcoding a name/topic list: the configured provider judges "same briefing" (see DEDUP_ONLY_PROMPT).
 */
export async function markRecentSemanticDuplicates(
    newlyInsertedIds: string[] = [],
    windowMinutes = 180,
    usageContext: { jobId?: string | null; ingestId?: string | null } = {},
    now: Date = new Date(),
): Promise<number> {
    // Only rows inserted by this ingest/recovery/repair are candidates. Existing rows are context
    // only; this prevents the old every-ingest scan from repeatedly billing the same headlines.
    const candidateIds = [...new Set(newlyInsertedIds.filter(Boolean))];
    if (candidateIds.length === 0) return 0;

    const dayKey = marketDayKey(now);
    const previousDay = previousUaeDayKey(now);
    const candidateDays = [dayKey, previousDay];
    const since = new Date(now.getTime() - windowMinutes * 60 * 1000);
    const candidates = await prisma.marketDriverNews.findMany({
        where: {
            id: { in: candidateIds },
            day_key: { in: candidateDays },
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
            semantic_dedup_completed: false,
        },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true, board_locked: true, published_at: true, semantic_dedup_started_at: true },
    });
    if (candidates.length === 0) {
        return 0;
    }

    // Durable row-level claim: another backend instance may be resuming the same unfinished
    // semantic pass. Only the instance that atomically sets the lease may call the provider.
    const semanticWorkerId = getAiWorkerId();
    const staleBefore = new Date(Date.now() - 10 * 60_000);
    const claimedIds: string[] = [];
    for (const candidate of candidates) {
        const claimed = await prisma.marketDriverNews.updateMany({
            where: {
                id: candidate.id,
                semantic_dedup_completed: false,
                OR: [
                    { semantic_dedup_started_at: null },
                    { semantic_dedup_started_at: { lt: staleBefore } },
                ],
            },
            data: { semantic_dedup_started_at: new Date(), semantic_dedup_worker_id: semanticWorkerId },
        });
        if (claimed.count === 1) claimedIds.push(candidate.id);
    }
    if (claimedIds.length === 0) return 0;
    const claimedCandidates = candidates.filter((candidate) => claimedIds.includes(candidate.id));

    // Recent stored rows are context/principal candidates only. They are never demoted or
    // reprocessed, and are capped to keep token usage proportional to new arrivals.
    const recentContext = await prisma.marketDriverNews.findMany({
        where: {
            day_key: { in: candidateDays },
            id: { notIn: claimedIds },
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
            published_at: { gte: since, lte: now },
        },
        orderBy: { created_at: 'desc' },
        take: MAX_EXISTING_TOPICS,
        select: { id: true, headline: true, board_locked: true, published_at: true },
    });

    let marked = 0;
    const candidateIdSet = new Set(claimedIds);
    let context = [...recentContext];
    try {
        for (let i = 0; i < claimedCandidates.length; i += RECLASSIFY_BATCH - 2) {
            const batch = claimedCandidates.slice(i, i + RECLASSIFY_BATCH - 2);
            const combined = [...context, ...batch];
            if (combined.length < 2) continue;

            const dupMap = await findBatchDuplicateMap(
                combined.map((b) => ({ text: b.headline, publishedAt: b.published_at })),
                usageContext,
            );
            for (const [dupIdx, principalIdx] of dupMap) {
                const principal = combined[principalIdx];
                const dup = combined[dupIdx];
                if (!principal || !dup || principal.id === dup.id || !candidateIdSet.has(dup.id)) continue;
                // Never demote a locked (already-shown) row — it stays visible for the whole day.
                if (dup.board_locked) continue;
                const updated = await prisma.marketDriverNews.updateMany({
                    where: { id: dup.id, duplicate_of: null, board_locked: false },
                    data: { duplicate_of: principal.id },
                });
                marked += updated.count;
            }

            // New principals become context for the next chunk, allowing duplicate detection across
            // chunks without making any previously stored row a candidate.
            context = [
                ...batch.filter((row) => !candidateIdSet.has(row.id) || !dupMap.has(combined.indexOf(row))),
                ...context,
            ].slice(0, MAX_EXISTING_TOPICS);
        }

        await prisma.marketDriverNews.updateMany({
            where: { id: { in: claimedIds }, semantic_dedup_completed: false },
            data: {
                semantic_dedup_completed: true,
                semantic_dedup_started_at: null,
                semantic_dedup_worker_id: null,
            },
        });

        if (marked > 0) {
            logger.info(`[MarketDriver] New-item AI dedup marked ${marked} duplicate(s) against recent context (last ${windowMinutes}m)`);
        }
        return marked;
    } catch (error) {
        await prisma.marketDriverNews.updateMany({
            where: { id: { in: claimedIds }, semantic_dedup_completed: false },
            data: { semantic_dedup_started_at: null, semantic_dedup_worker_id: null },
        });
        throw error;
    }
}

/** Resume only durable semantic-dedup checkpoints left unfinished by a crash/restart. */
export async function resumeIncompleteMarketDriverSemanticDedup(limit = 500, now: Date = new Date()): Promise<number> {
    if (marketDriverIngestInFlight) return 0;
    const dayKey = marketDayKey(now);
    const previousDay = previousUaeDayKey(now);
    const pending = await prisma.marketDriverNews.findMany({
        where: {
            day_key: { in: [dayKey, previousDay] },
            classification_completed: true,
            semantic_dedup_completed: false,
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
        },
        orderBy: { created_at: 'asc' },
        take: limit,
        select: { id: true },
    });
    if (pending.length === 0) return 0;
    return markRecentSemanticDuplicates(pending.map((row) => row.id), 180, {}, now);
}

/**
 * Cheap full-day doc §3 pass: fingerprint + token-overlap (no AI).
 * Collapses Centcom/Hormuz/Trump-briefing paraphrases that a model may miss.
 * Only links rows that share the same primary asset (never hide GOLD behind an OIL principal).
 */
export async function markTodaysDeterministicDuplicates(now: Date = new Date()): Promise<number> {
    const dayKey = marketDayKey(now);
    const principals = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
        },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true, assets: true, board_locked: true },
    });
    if (principals.length < 2) return 0;

    // Locked rows may serve as fold targets (`kept`) but must NEVER be demoted — that is exactly
    // the mid-day "63→51 disappearing" bug. Only rows never shown (board_locked=false) can be
    // newly marked as duplicates here.
    const kept: { id: string; headline: string; primary: string | null }[] = [];
    let marked = 0;
    for (const row of principals) {
        const primary = pickPrimaryAsset((row.assets as unknown as ClassifiedAsset[]) ?? [])?.asset ?? null;
        const match = kept.find(
            (k) => k.primary && primary && k.primary === primary && likelySameEvent(k.headline, row.headline),
        );
        if (match && !row.board_locked) {
            await prisma.marketDriverNews.update({
                where: { id: row.id },
                data: { duplicate_of: match.id },
            });
            marked += 1;
            continue;
        }
        // No match, OR a match but this row is locked (stays visible) — keep it as a principal.
        kept.push({ id: row.id, headline: row.headline, primary });
    }

    if (marked > 0) {
        logger.info(`[MarketDriver] Deterministic §3 dedup marked ${marked} duplicate(s) (locked rows untouched)`);
    }
    return marked;
}

/** Shared classify lock — webhook ingest + coverage-audit heal must never run AI in parallel. */
let marketDriverIngestInFlight = false;
let lastMarketDriverIngestFinishedAtMs: number | null = null;

export function isMarketDriverIngestRunning(): boolean {
    return marketDriverIngestInFlight;
}

/** Ms since last ingest finished; `null` if one is running or none finished this process. */
export function getMarketDriverIngestIdleMs(): number | null {
    if (marketDriverIngestInFlight) return null;
    if (lastMarketDriverIngestFinishedAtMs == null) return null;
    return Date.now() - lastMarketDriverIngestFinishedAtMs;
}

export async function getDeferredMarketDriverCount(): Promise<number> {
    return getPendingAiClassificationItemCount();
}

async function queueDeferredRssItems(
    items: RssItem[],
    options: { queuedJobId?: string | null; ingestId?: string | null; operationType?: 'classification' | 'coverage_repair' } = {},
): Promise<{ pendingCount: number; enqueuedCount: number }> {
    const next = items
        .filter((i) => i.pubDate)
        .map((i) => ({
            guid: i.guid,
            sourceId: i.sourceId,
            sourceKey: i.sourceKey,
            contentHash: i.contentHash,
            title: i.title,
            source: i.source,
            pubDate: i.pubDate as string,
        }));
    if (next.length === 0) {
        return { pendingCount: await getPendingAiClassificationItemCount(), enqueuedCount: 0 };
    }

    // Persist one deterministic job per provider batch. This lets a restarted worker resume the
    // exact unfinished batch and prevents a large leftover payload from creating overlapping
    // sub-jobs on every retry.
    let enqueuedCount = 0;
    for (let i = 0; i < next.length; i += CLASSIFY_BATCH_SIZE) {
        const chunk = next.slice(i, i + CLASSIFY_BATCH_SIZE);
        await enqueueAiClassificationJob(next.slice(i, i + CLASSIFY_BATCH_SIZE), {
            source: options.operationType === 'coverage_repair' ? 'coverage-audit' : 'forex-scraping',
            ingestId: options.ingestId ?? options.queuedJobId ?? null,
            operationType: options.operationType ?? 'classification',
            reason: isGroqDailyLimited() ? 'provider_daily_limit' : 'classification_failed',
        });
        enqueuedCount += chunk.length;
    }
    return { pendingCount: await getPendingAiClassificationItemCount(), enqueuedCount };
}

/**
 * Ingest raw RSS items from forex-scraping: dedup → classify new items → store.
 * Safe to call on a webhook; no-ops cleanly on any failure.
 * Returns stats including whether the live board / headline table may have changed.
 */
export type MarketDriverIngestOptions = {
    queuedJobId?: string | null;
    ingestId?: string | null;
    operationType?: 'classification' | 'coverage_repair';
    /** Deterministic business clock for rollover verification; production omits this. */
    now?: Date;
};

export async function ingestMarketDriverRssItems(rawItems: unknown[], options: MarketDriverIngestOptions = {}): Promise<{
    received: number;
    fresh: number;
    existingSkipped: number;
    exactDuplicatesSkipped: number;
    enqueued: number;
    classified: number;
    semanticChecks: number;
    failedItems: number;
    recoveredItems: number;
    coverageRepairs: number;
    stored: number;
    carried: number;
    reclassified: number;
    changed: boolean;
    realigned: number;
    classifyFailed?: boolean;
    skippedOverlap?: boolean;
    /** False when TPD aborted mid-run — remaining headlines are queued for auto-resume. */
    ingestComplete: boolean;
    deferredCount: number;
}> {
    const receivedCount = Array.isArray(rawItems) ? rawItems.length : 0;
    if (marketDriverIngestInFlight) {
        logger.warn(
            `[MarketDriver] Ingest skipped — classify already running (accepted ${receivedCount} item(s) without overlapping AI)`,
        );
        return {
            received: receivedCount,
            fresh: 0,
            existingSkipped: 0,
            exactDuplicatesSkipped: 0,
            enqueued: 0,
            classified: 0,
            semanticChecks: 0,
            failedItems: 0,
            recoveredItems: options.queuedJobId ? receivedCount : 0,
            coverageRepairs: options.operationType === 'coverage_repair' ? receivedCount : 0,
            stored: 0,
            carried: 0,
            reclassified: 0,
            changed: false,
            realigned: 0,
            skippedOverlap: true,
            ingestComplete: false,
            deferredCount: await getPendingAiClassificationItemCount(),
        };
    }
    marketDriverIngestInFlight = true;
    const ingestOptions: MarketDriverIngestOptions = {
        ...options,
        ingestId: options.ingestId ?? randomUUID(),
    };
    try {
        const runStartedAt = await beginProcessingRun(
            ingestOptions.ingestId,
            {
                source: ingestOptions.operationType === 'coverage_repair' ? 'coverage-audit' : 'forex-scraping',
                startedAt: ingestOptions.now,
            },
        );
        try {
            const result = await runMarketDriverIngest(rawItems, ingestOptions);
            await finishProcessingRun(ingestOptions.ingestId, {
                itemsFetched: result.received,
                newItems: result.fresh,
                existingItemsSkipped: result.existingSkipped,
                itemsEnqueued: result.enqueued,
                itemsClassified: result.classified,
                exactDuplicatesSkipped: result.exactDuplicatesSkipped,
                semanticDuplicatesFound: result.semanticChecks,
                failedItems: result.failedItems,
                recoveredItems: result.recoveredItems,
                coverageRepairs: result.coverageRepairs,
            }, {
                status: (result.classifyFailed || result.deferredCount > 0)
                    ? (result.stored > 0 ? 'partial' : 'failed')
                    : 'completed',
                errorCategory: (result.classifyFailed || result.deferredCount > 0)
                    ? (isGroqDailyLimited() ? 'provider_daily_limit' : 'classification_failed')
                    : null,
                startedAt: runStartedAt,
            });
            const ingestComplete = result.deferredCount === 0;
            return { ...result, ingestComplete };
        } catch (error) {
            await finishProcessingRun(ingestOptions.ingestId, {
                itemsFetched: receivedCount,
                newItems: 0,
                existingItemsSkipped: 0,
                itemsEnqueued: 0,
                itemsClassified: 0,
                exactDuplicatesSkipped: 0,
                semanticDuplicatesFound: 0,
                failedItems: receivedCount,
                recoveredItems: ingestOptions.queuedJobId ? receivedCount : 0,
                coverageRepairs: ingestOptions.operationType === 'coverage_repair' ? receivedCount : 0,
            }, {
                status: 'failed',
                errorCategory: 'ingest_error',
                startedAt: runStartedAt,
            });
            throw error;
        }
    } finally {
        marketDriverIngestInFlight = false;
        lastMarketDriverIngestFinishedAtMs = Date.now();
    }
}

async function runMarketDriverIngest(rawItems: unknown[], options: MarketDriverIngestOptions = {}): Promise<{
    received: number;
    fresh: number;
    existingSkipped: number;
    exactDuplicatesSkipped: number;
    enqueued: number;
    classified: number;
    semanticChecks: number;
    failedItems: number;
    recoveredItems: number;
    coverageRepairs: number;
    stored: number;
    carried: number;
    reclassified: number;
    changed: boolean;
    realigned: number;
    classifyFailed?: boolean;
    deferredCount: number;
}> {
    const receivedCount = Array.isArray(rawItems) ? rawItems.length : 0;
    const now = options.now ?? new Date();
    const dayKey = marketDayKey(now);
    const repaired = await repairLockedDuplicates();
    const dayKeysFixed = await realignMarketDriverDayKeysByPubDate(now);
    const realigned = (await realignTodaysMarketDriverScores(now)) + dayKeysFixed + repaired;
    const items = normalizeRssItems(rawItems);
    if (items.length === 0) {
        return {
            received: receivedCount,
            fresh: 0,
            existingSkipped: receivedCount,
            exactDuplicatesSkipped: receivedCount,
            enqueued: 0,
            classified: 0,
            semanticChecks: 0,
            failedItems: 0,
            recoveredItems: options.queuedJobId ? receivedCount : 0,
            coverageRepairs: options.operationType === 'coverage_repair' ? receivedCount : 0,
            stored: 0,
            carried: 0,
            reclassified: 0,
            changed: realigned > 0,
            realigned,
            deferredCount: await getPendingAiClassificationItemCount(),
        };
    }

    // Hard dedup by the persistent source identity. GUIDs are scoped to a feed; source_key keeps
    // the same story idempotent across scraper restarts while allowing two feeds to reuse a GUID.
    // Doc §2: each headline belongs to the UAE market day that contains its publish time
    // (01:00 → next 01:00). 11:00 PM / 12:10 AM before 01:00 still count in THAT full day —
    // they must be stored under that day_key (live while that day is current; Historical after).
    // Never discard them as "wrong day". Only skip ancient feed items older than yesterday.
    const guids = items.map((i) => i.guid);
    const sourceKeys = items.map((i) => i.sourceKey);
    const existing = await prisma.marketDriverNews.findMany({
        where: { OR: [{ source_key: { in: sourceKeys } }, { guid: { in: guids } }] },
        select: { id: true, guid: true, source_id: true, source_key: true, content_hash: true, board_locked: true, day_key: true, classification_completed: true, semantic_dedup_completed: true },
    });
    const seenSourceKeys = new Set(existing.map((e) => e.source_key).filter((value): value is string => Boolean(value)));
    // GUID fallback is retained only for pre-source-key legacy rows. New rows are intentionally
    // allowed to reuse a GUID when their feed/source identity differs.
    const legacyExisting = existing.filter((row) => row.source_key?.startsWith('legacy:') || row.source_id === 'unknown');
    const seenLegacyGuids = new Set(legacyExisting.map((e) => e.guid));
    const unfinishedSemanticIds = new Set(
        existing.filter((row) => row.classification_completed && !row.semantic_dedup_completed).map((row) => row.id),
    );
    const existingBySourceKey = new Map(existing.filter((row) => row.source_key).map((row) => [row.source_key as string, row]));
    const existingByGuid = new Map(legacyExisting.map((row) => [row.guid, row]));
    const carried = 0;
    const yesterday = previousUaeDayKey(now);
    // A normal scraper webhook may race startup recovery. Treat source/content versions already
    // present in the durable queue as persisted work, so restart does not create overlapping
    // batches and repeat paid classification. A queue worker must process its own payload, so it
    // deliberately bypasses this filter.
    const queuedSourceVersions = options.queuedJobId
        ? new Set<string>()
        : await getActiveAiClassificationSourceVersions();

    const fresh: RssItem[] = [];
    const batchSourceKeys = new Set<string>();
    let skippedOtherDay = 0;
    let skippedInvalidDate = 0;
    let existingSkipped = 0;
    let exactDuplicatesSkipped = 0;
    for (const it of items) {
        const matched = existingBySourceKey.get(it.sourceKey) ?? existingByGuid.get(it.guid);
        const contentChanged = Boolean(
            matched &&
            matched.content_hash &&
            matched.content_hash !== '0'.repeat(64) &&
            matched.content_hash !== it.contentHash,
        );
        if (!contentChanged && (seenLegacyGuids.has(it.guid) || seenSourceKeys.has(it.sourceKey))) {
            existingSkipped += 1;
            exactDuplicatesSkipped += 1;
            continue;
        }
        if (queuedSourceVersions.has(buildAiClassificationSourceVersion(it))) {
            existingSkipped += 1;
            exactDuplicatesSkipped += 1;
            continue;
        }
        if (batchSourceKeys.has(it.sourceKey)) {
            exactDuplicatesSkipped += 1;
            continue;
        }
        const itemDay = dayKeyFromPubDate(it.pubDate);
        if (!itemDay) {
            skippedInvalidDate += 1;
            continue;
        }
        // Keep live day + previous market day (covers overnight 11pm–01:00 in the ending day).
        if (itemDay !== dayKey && itemDay !== yesterday) {
            skippedOtherDay += 1;
            continue;
        }
        batchSourceKeys.add(it.sourceKey);
        fresh.push(contentChanged && matched ? { ...it, existingId: matched.id, existingLocked: matched.board_locked } : it);
    }
    if (skippedOtherDay > 0) {
        logger.info(
            `[MarketDriver] Skipped ${skippedOtherDay} RSS item(s) older than previous UAE day ${yesterday} (live=${dayKey})`,
        );
    }
    if (skippedInvalidDate > 0) {
        logger.warn(
            `[MarketDriver] Rejected ${skippedInvalidDate} RSS item(s) with missing/invalid pubDate; undated news never enters the board`,
        );
    }

    let stored = 0;
    let classifyFailed = false;
    let deferredCount = 0;
    let enqueued = 0;
    let classifiedCount = 0;
    let semanticUsageJobId: string | null = options.queuedJobId ?? null;
    const newlyInsertedIds: string[] = [...unfinishedSemanticIds];
    if (fresh.length > 0) {
        // Semantic dedup context (doc §3): principals from live + previous UAE day.
        const todaysPrincipals = await prisma.marketDriverNews.findMany({
            where: { day_key: { in: [dayKey, yesterday] }, duplicate_of: null, published_at: { not: null } },
            select: { id: true, headline: true, published_at: true },
            orderBy: { created_at: 'desc' },
            take: MAX_EXISTING_TOPICS,
        });
        let existingTopics: ExistingTopic[] = todaysPrincipals.map((r) => ({
            id: r.id,
            text: r.headline,
            publishedAt: r.published_at,
        }));

        const todaysNormalized = await prisma.marketDriverNews.findMany({
            where: { day_key: { in: [dayKey, yesterday] }, published_at: { not: null } },
            select: { id: true, normalized: true },
        });
        const normalizedToId = new Map(todaysNormalized.map((r) => [r.normalized, r.id]));

        // Already-LOCKED (shown) principals — the set new items must dedup against at admission
        // so a paraphrase of something already on the board never appears as a second row. These
        // are also the only valid fold targets: a visible new item may only be hidden as a
        // duplicate of an already-VISIBLE story, never folded into a hidden/IRRELEVANT row.
        const lockedRows = await prisma.marketDriverNews.findMany({
            where: { day_key: { in: [dayKey, yesterday] }, board_locked: true, duplicate_of: null },
            select: { id: true, headline: true, assets: true },
        });
        const lockedPrincipals: LockedPrincipal[] = lockedRows.map((r) => ({
            id: r.id,
            headline: r.headline,
            primary: pickPrimaryAsset((r.assets as unknown as ClassifiedAsset[]) ?? [])?.asset ?? null,
        }));
        const lockedIds = new Set(lockedPrincipals.map((p) => p.id));

        let classifiedAny = false;
        for (let i = 0; i < fresh.length; i += CLASSIFY_BATCH_SIZE) {
            const chunk = fresh.slice(i, i + CLASSIFY_BATCH_SIZE);
            const job = await ensureAiClassificationJob(chunk.map((item) => ({
                ...item,
                pubDate: item.pubDate!,
            })), {
                source: options.operationType === 'coverage_repair' ? 'coverage-audit' : 'forex-scraping',
                ingestId: options.ingestId ?? options.queuedJobId ?? null,
                operationType: options.operationType ?? 'classification',
                reason: 'new_rss_batch',
            });
            if (!job) continue;
            const claim = await claimAiClassificationJob(job.id, {
                allowProcessingJobId: options.queuedJobId,
                workerId: getAiWorkerId(),
            });
            if (!claim.owned) {
                if (!claim.completed) {
                    deferredCount = await getPendingAiClassificationItemCount();
                    logger.info(`[MarketDriver] Classification job ${job.id} is owned by another worker; leaving it for durable resume`);
                    break;
                }
                // A completed idempotency key means this exact source/content batch was already
                // persisted. It is safe to skip without another provider call.
                continue;
            }
            semanticUsageJobId = job.id;
            const classified = await classifyHeadlines(
                chunk.map((f) => ({ text: f.title, publishedAt: f.pubDate })),
                existingTopics,
                {
                    operationType: options.operationType ?? 'classification',
                    jobId: job.id,
                    ingestId: options.ingestId,
                },
            );
            if (classified.length === 0) {
                const leftover = fresh.slice(i);
                await rescheduleAiClassificationJob(job.id, {
                    errorKind: isGroqDailyLimited() ? 'provider_daily_limit' : 'classification_failed',
                    errorMessage: isGroqDailyLimited()
                        ? 'Provider daily limit; waiting for the next provider window'
                        : 'Provider returned no valid classification',
                    retryAfterMs: isGroqDailyLimited()
                        ? Math.max(30_000,  groqDailyLimitRemainingMs() + 15_000)
                        : undefined,
                });
                const remaining = fresh.slice(i + CLASSIFY_BATCH_SIZE);
                const queued = await queueDeferredRssItems(remaining, options);
                deferredCount = queued.pendingCount;
                enqueued += queued.enqueuedCount;
                const left = 1 + Math.ceil(remaining.length / CLASSIFY_BATCH_SIZE);
                const dailyLimitMessage = isGroqDailyLimited()
                    ? 'provider daily limit hit'
                    : 'provider returned no valid classification';
                logger.error(
                    `[MarketDriver] Stopping ingest early — ${dailyLimitMessage}; ` +
                        `${left} batch(es) / ${leftover.length} headline(s) persisted for bounded retry`,
                );
                classifyFailed = true;
                break;
            }
            classifiedAny = true;
            classifiedCount += classified.length;

            const classifiedByIndex = new Map(classified.map((c) => [c.index, c]));
            const batchIds = chunk.map((item) => item.existingId ?? randomUUID());

            // Process in index order so a within-batch principal's lock decision is known before
            // its duplicate is evaluated (classifyHeadlines returns sorted by index).
            const rows: Array<{
                id: string;
                guid: string;
                source_id: string;
                source_key: string;
                content_hash: string;
                normalized: string;
                day_key: string;
                headline: string;
                source: string | null;
                category: string;
                impact: string;
                summary: string | null;
                assets: object;
                duplicate_of: string | null;
                board_locked: boolean;
                classification_completed: boolean;
                semantic_dedup_completed: boolean;
                coverage_repair_completed: boolean;
                final_decision_code: string;
                final_decision_reason: string;
                secondary_reasons: string[];
                decision_ingest_id: string | null;
                classification_job_id: string;
                classification_provider: string | null;
                classification_model: string | null;
                published_at: Date;
            }> = [];

            for (const c of classified) {
                const item = chunk[c.index]!;
                const normalized = normalizeTitle(item.title);
                const id = batchIds[c.index]!;

                // Would this row be board-visible on its own classification?
                const visibleByClass = isBoardVisibleClassification({
                    category: c.category,
                    impact: c.impact,
                    assets: c.assets,
                    duplicateOf: null,
                });
                const primary = pickPrimaryAsset(c.assets)?.asset ?? null;

                // Admission dedup, in precedence order: model/within-batch → normalized text →
                // deterministic same-event vs already-locked principals (catches paraphrases
                // batch classification misses, e.g. Centcom/Hormuz restatements).
                let duplicateOf = resolveDuplicateOf(c.index, classifiedByIndex, batchIds) ?? normalizedToId.get(normalized) ?? null;
                if (!duplicateOf && visibleByClass) {
                    duplicateOf = matchLockedPrincipal(item.title, primary, lockedPrincipals);
                }
                if (duplicateOf === id) duplicateOf = null;
                if (item.existingLocked) duplicateOf = null;

                // Never hide a VISIBLE story by folding it into a target that is not itself shown.
                // (Folding into an IRRELEVANT/hidden row would make the story vanish entirely.)
                if (duplicateOf && visibleByClass && !lockedIds.has(duplicateOf)) {
                    duplicateOf = null;
                }

                const boardLocked = Boolean(item.existingLocked) || (!duplicateOf && visibleByClass);
                const decision = decisionMetadata(item.title, c, duplicateOf, boardLocked);

                if (!duplicateOf) normalizedToId.set(normalized, id);
                if (boardLocked) {
                    const p: LockedPrincipal = { id, headline: item.title, primary };
                    lockedPrincipals.push(p);
                    lockedIds.add(id);
                }

                const publishedAt = new Date(item.pubDate!);
                // Doc §2: day_key = UAE market day that contains publish time (01:00→01:00).
                const storeDay = dayKeyFromPubDate(item.pubDate);
                if (!storeDay || Number.isNaN(publishedAt.getTime())) {
                    throw new Error(`Invalid pubDate passed strict RSS filter for guid ${item.guid}`);
                }

                rows.push({
                    id,
                    guid: item.guid,
                    source_id: item.sourceId,
                    source_key: item.sourceKey,
                    content_hash: item.contentHash,
                    normalized,
                    day_key: storeDay,
                    headline: item.title.slice(0, 1000),
                    source: item.source,
                    category: c.category,
                    impact: c.impact,
                    summary: c.summary || null,
                    assets: c.assets as unknown as object,
                    duplicate_of: duplicateOf,
                    board_locked: boardLocked,
                    classification_completed: true,
                    // A provider-classified duplicate has already completed its semantic decision.
                    semantic_dedup_completed: Boolean(duplicateOf) || !visibleByClass,
                    coverage_repair_completed: true,
                    final_decision_code: decision.code,
                    final_decision_reason: decision.reason,
                    secondary_reasons: decision.secondary,
                    decision_ingest_id: options.ingestId ?? options.queuedJobId ?? null,
                    classification_job_id: job.id,
                    classification_provider: null,
                    classification_model: null,
                    published_at: publishedAt,
                });
            }

            const changedRows = rows.filter((row) => chunk.some((item) => item.existingId === row.id));
            const newRows = rows.filter((row) => !changedRows.some((changed) => changed.id === row.id));
            for (const row of changedRows) {
                await prisma.marketDriverNews.update({
                    where: { id: row.id },
                    data: {
                        guid: row.guid,
                        source_id: row.source_id,
                        source_key: row.source_key,
                        content_hash: row.content_hash,
                        normalized: row.normalized,
                        day_key: row.day_key,
                        headline: row.headline,
                        source: row.source,
                        category: row.category,
                        impact: row.impact,
                        summary: row.summary,
                        assets: row.assets,
                        duplicate_of: row.duplicate_of,
                        board_locked: row.board_locked,
                        classification_completed: true,
                        semantic_dedup_completed: row.semantic_dedup_completed,
                        coverage_repair_completed: true,
                        final_decision_code: row.final_decision_code,
                        final_decision_reason: row.final_decision_reason,
                        secondary_reasons: row.secondary_reasons,
                        decision_ingest_id: row.decision_ingest_id,
                        classification_job_id: row.classification_job_id,
                        classification_provider: row.classification_provider,
                        classification_model: row.classification_model,
                        published_at: row.published_at,
                    },
                });
            }
            let insertedRows: Array<{ id: string; source_key: string | null }> = [];
            if (newRows.length > 0) {
                try {
                    insertedRows = await prisma.marketDriverNews.createManyAndReturn({
                        data: newRows,
                        skipDuplicates: true,
                        select: { id: true, source_key: true },
                    });
                } catch (error) {
                    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
                    logger.info('[MarketDriver] Duplicate insert race treated as idempotent skip', {
                        batchSize: newRows.length,
                    });
                }
            }
            stored += changedRows.length + insertedRows.length;
            newlyInsertedIds.push(...changedRows.map((row) => row.id), ...insertedRows.map((row) => row.id));
            const dupeCount = rows.filter((r) => r.duplicate_of).length;
            const lockedCount = rows.filter((r) => r.board_locked).length;
            logger.info(
                `[MarketDriver] Batch ${Math.floor(i / CLASSIFY_BATCH_SIZE) + 1}: classified ${classified.length}, stored ${insertedRows.length} (${lockedCount} shown, ${dupeCount} duplicate)`,
            );

            // The classification result is durable before the job is marked complete. A crash
            // before this point leaves the job processing and lets the lock-timeout recovery
            // replay it; a restart after this point sees the completed idempotency key and skips.
            await completeAiClassificationJob(job.id);

            // Grow dedup context for the next provider batch with newly stored principals.
            for (const row of rows) {
                if (row.duplicate_of) continue;
                existingTopics = [
                    { id: row.id, text: row.headline, publishedAt: row.published_at },
                    ...existingTopics,
                ].slice(0, MAX_EXISTING_TOPICS);
            }

            if (i + CLASSIFY_BATCH_SIZE < fresh.length) {
                await new Promise((r) => setTimeout(r, CLASSIFY_BATCH_GAP_MS));
            }
        }

        if (!classifiedAny) {
            if (deferredCount === 0) {
                const queued = await queueDeferredRssItems(fresh, options);
                deferredCount = queued.pendingCount;
                enqueued += queued.enqueuedCount;
            }
            logger.error(
                isGroqDailyLimited()
                    ? `[MarketDriver] No classification stored for ${fresh.length} fresh headline(s) — provider daily limit exhausted. ${deferredCount} queued for retry.`
                    : `[MarketDriver] No classification stored for ${fresh.length} fresh headline(s) — ${deferredCount} queued for bounded retry.`,
            );
            classifyFailed = true;
        }
    }

    // Production recovery: feed guids already in DB (stored=0) but live board empty
    // (all IRRELEVANT / Low / wrong day). Reclassify a small batch so News Headline fills.
    let reclassified = 0;
    const boardCount = await countLiveBoardItems(dayKey);
    // Never use a scraper replay as a reason to reclassify every stored RSS row. The recovery
    // pass is eligible only when this ingest actually supplied a new/content-changed item.
    if (boardCount === 0 && deferredCount === 0 && fresh.length > 0) {
        reclassified = await reclassifyFeedMatchedForEmptyBoard(dayKey, guids, options);
    }

    const deterministicDupes = await markTodaysDeterministicDuplicates(now);
    // Bounded AI same-briefing pass — only newly inserted rows are candidates, so this does not
    // re-bill the whole day on every ingest.
    const semanticDupes = await markRecentSemanticDuplicates(newlyInsertedIds, 180, {
        jobId: semanticUsageJobId,
        ingestId: options.ingestId,
    }, now).catch((error) => {
        logger.error(`[MarketDriver] Recent-window semantic dedup failed: ${(error as Error).message}`);
        return 0;
    });

    return {
        received: receivedCount,
        fresh: fresh.length,
        existingSkipped,
        exactDuplicatesSkipped,
        enqueued,
        classified: classifiedCount,
        semanticChecks: semanticDupes,
        failedItems: classifyFailed ? Math.max(0, fresh.length - classifiedCount) : 0,
        recoveredItems: options.queuedJobId ? Math.max(fresh.length, newlyInsertedIds.length) : 0,
        coverageRepairs: options.operationType === 'coverage_repair' ? fresh.length : 0,
        stored,
        carried,
        reclassified,
        changed:
            realigned > 0 ||
            stored > 0 ||
            carried > 0 ||
            reclassified > 0 ||
            deterministicDupes > 0 ||
            semanticDupes > 0,
        realigned,
        /** Present when fresh items arrived but no provider stored a valid result. */
        classifyFailed: classifyFailed || (fresh.length > 0 && stored === 0),
        deferredCount,
    };
}

async function countLiveBoardItems(dayKey: string): Promise<number> {
    return prisma.marketDriverNews.count({
        where: { day_key: dayKey, board_locked: true, duplicate_of: null },
    });
}

/**
 * When the live board has zero DRIVER/GEOPOLITICAL High|Medium rows, re-run the provider on a
 * capped set of today's rows that still appear in the RSS feed (guid match).
 */
async function reclassifyFeedMatchedForEmptyBoard(
    dayKey: string,
    feedGuids: string[],
    options: MarketDriverIngestOptions = {},
): Promise<number> {
    const candidates = await prisma.marketDriverNews.findMany({
        // Board is empty ⇒ no locked rows expected; still skip any locked for safety.
        // Only unlockeds may be rewritten; visibility becomes an ADD via board_locked.
        where: {
            day_key: dayKey,
            guid: { in: feedGuids },
            published_at: { not: null },
            board_locked: false,
            // A completed duplicate decision (including cross-day context) is not a failed
            // classification and must never be undone just because the new-day board is empty.
            duplicate_of: null,
        },
        orderBy: { created_at: 'desc' },
        take: CLASSIFY_BATCH_SIZE * 3,
        select: { id: true, headline: true, published_at: true },
    });
    if (candidates.length === 0) {
        logger.warn(
            `[MarketDriver] Live board empty for ${dayKey} and no feed-matched rows to reclassify`,
        );
        return 0;
    }

    logger.info(
        `[MarketDriver] Live board empty — reclassifying ${candidates.length} feed-matched headline(s)`,
    );

    const classified = await classifyHeadlines(
        candidates.map((c) => ({ text: c.headline, publishedAt: c.published_at })),
        [],
        {
            operationType: options.operationType ?? 'classification',
            jobId: options.queuedJobId,
            ingestId: options.ingestId,
        },
    );
    if (classified.length === 0) {
        logger.warn('[MarketDriver] Empty-board reclassify returned no classifications (check AI provider configuration)');
        return 0;
    }

    let updated = 0;
    for (const c of classified) {
        const row = candidates[c.index];
        if (!row) continue;
        const nowVisible = isBoardVisibleClassification({
            category: c.category,
            impact: c.impact,
            assets: c.assets,
            duplicateOf: null,
        });
        await prisma.marketDriverNews.update({
            where: { id: row.id },
            data: {
                category: c.category,
                impact: c.impact,
                summary: c.summary,
                assets: c.assets as unknown as object,
                duplicate_of: null,
                classification_completed: true,
                semantic_dedup_completed: !nowVisible,
                coverage_repair_completed: true,
                ...(nowVisible ? { board_locked: true } : {}),
            },
        });
        updated += 1;
    }

    if (updated > 0) {
        await markTodaysSemanticDuplicates();
    }
    logger.info(`[MarketDriver] Empty-board reclassify updated ${updated} headline(s)`);
    return updated;
}

/**
 * @deprecated RSS fetch lives in forex-scraping. Kept as a no-op alias for any old callers.
 */
export async function refreshMarketDriverBoard(): Promise<boolean> {
    logger.warn('[MarketDriver] refreshMarketDriverBoard() is deprecated — RSS ingest is via webhook');
    const realigned = await realignTodaysMarketDriverScores();
    return realigned > 0;
}

/**
 * The board = LOCKED principals for this UAE market day.
 * `board_locked` is set once at admission (first board-visible moment) and never cleared on a
 * true principal — so the visible set only grows during the day.
 * Invariant: a row must never be both `board_locked` and `duplicate_of != null`. Display and
 * Catalyst only read `board_locked && duplicate_of IS NULL`. Any legacy locked-duplicates are
 * repaired by `repairLockedDuplicates()`.
 */
async function loadBoardItemsForDay(dayKey: string) {
    const items = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey, board_locked: true, duplicate_of: null },
        orderBy: { created_at: 'desc' },
    });
    return items.filter((item) => {
        const assets = (item.assets as unknown as ClassifiedAsset[]) ?? [];
        return assets.length > 0;
    });
}

/**
 * One-time / ongoing repair: rows that were wrongly locked while also marked duplicate must
 * leave the board (unlock). They stay in DB as duplicates; the principal they fold into remains.
 * This restores News Headline / Catalyst consistency without touching true locked principals.
 */
export async function repairLockedDuplicates(): Promise<number> {
    const result = await prisma.marketDriverNews.updateMany({
        where: { board_locked: true, NOT: { duplicate_of: null } },
        data: { board_locked: false },
    });
    if (result.count > 0) {
        logger.info(
            `[MarketDriver] Repaired ${result.count} locked-duplicate row(s) → unlocked (kept as duplicates)`,
        );
    }
    return result.count;
}

/**
 * News Headline has one primary asset for presentation. Catalyst is different: the
 * FFE rules deliberately apply one underlying event to each affected currency.
 */
function pickPrimaryAsset(assets: ClassifiedAsset[]): ClassifiedAsset | null {
    if (!assets.length) return null;
    const scored = assets.filter((a) => a.score !== 0);
    const pool = scored.length > 0 ? scored : assets;
    return [...pool].sort((a, b) => {
        const mag = Math.abs(b.score) - Math.abs(a.score);
        if (mag !== 0) return mag;
        const rank = (x: string) => (x === 'OIL' ? 0 : x === 'GOLD' ? 1 : 2);
        const r = rank(a.asset) - rank(b.asset);
        if (r !== 0) return r;
        return a.asset.localeCompare(b.asset);
    })[0]!;
}

/**
 * Doc §3: same-event paraphrases count once on Market Catalyst.
 * OIL also collapses broader conflict clusters (gulf spillover, strike waves).
 */
function collapseSameEventEntries(
    entries: { headline: string; primary: ClassifiedAsset }[],
): { headline: string; primary: ClassifiedAsset }[] {
    const principals: { headline: string; primary: ClassifiedAsset }[] = [];
    for (const entry of entries) {
        const idx = principals.findIndex((p) => {
            if (entry.primary.asset === 'OIL' && p.primary.asset === 'OIL') {
                const ca = oilCatalystCluster(p.headline);
                const cb = oilCatalystCluster(entry.headline);
                if (ca && cb && ca === cb) return true;
            }
            return likelySameEvent(p.headline, entry.headline);
        });
        if (idx < 0) {
            principals.push(entry);
            continue;
        }
        if (Math.abs(entry.primary.score) > Math.abs(principals[idx]!.primary.score)) {
            principals[idx] = entry;
        }
    }
    return principals;
}

function aggregateCatalystBoard(items: Awaited<ReturnType<typeof loadBoardItemsForDay>>): CatalystBoardRow[] {
    const agg = new Map<TrackedAsset, CatalystBoardRow>(
        BOARD_ASSET_ORDER.map((asset) => [asset, { asset, bullishCount: 0, bearishCount: 0, driverScore: 0 }]),
    );

    const byAsset = new Map<TrackedAsset, { headline: string; primary: ClassifiedAsset }[]>();
    for (const asset of BOARD_ASSET_ORDER) byAsset.set(asset, []);

    for (const item of items) {
        const assets = (item.assets as unknown as ClassifiedAsset[]) ?? [];
        for (const asset of assets) {
            if (!BOARD_ASSET_ORDER.includes(asset.asset)) continue;
            if (asset.score === 0) continue;
            const list = byAsset.get(asset.asset);
            if (list) list.push({ headline: item.headline, primary: asset });
        }
    }

    for (const asset of BOARD_ASSET_ORDER) {
        const row = agg.get(asset)!;
        const collapsed = collapseSameEventEntries(byAsset.get(asset) ?? []);
        for (const entry of collapsed) {
            if (entry.primary.score > 0) row.bullishCount += 1;
            else if (entry.primary.score < 0) row.bearishCount += 1;
            row.driverScore += entry.primary.score;
        }

    }

    return BOARD_ASSET_ORDER.map((asset) => {
        const row = agg.get(asset)!;
        return { ...row, driverScore: Number(row.driverScore.toFixed(1)) };
    });
}

/** Previous UAE market day label (day before current 01:00→01:00 window). */
export function previousUaeDayKey(date: Date = new Date()): string {
    return previousMarketBusinessDayKey(date);
}

/** Per-asset bullish/bearish counts + driver score. Defaults to the current UAE market day. */
export async function getCatalystBoard(dayKey: string = marketDayKey()): Promise<CatalystBoardRow[]> {
    const items = await loadBoardItemsForDay(dayKey);
    return aggregateCatalystBoard(items);
}

/** Full deduplicated driver headlines for the admin News / Market Drivers table (doc §34). */
export async function getMarketDriverNews(dayKey: string = marketDayKey()): Promise<MarketDriverNewsRow[]> {
    const items = await loadBoardItemsForDay(dayKey);
    return items.map((item) => ({
        id: item.id,
        headline: item.headline,
        source: item.source,
        category: item.category,
        impact: item.impact,
        summary: item.summary,
        assets: (item.assets as unknown as ClassifiedAsset[]) ?? [],
        publishedAt: item.published_at ? item.published_at.toISOString() : null,
        createdAt: item.created_at.toISOString(),
    }));
}

/** Read-only admin diagnostic; deliberately does not run coverage repair or any AI work. */
export async function getMarketDriverNewsDiagnostic(dayKey: string = marketDayKey()): Promise<MarketDriverDiagnosticRow[]> {
    const rows = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: {
            id: true, headline: true, source: true, source_id: true, guid: true, source_key: true,
            category: true, impact: true, summary: true, assets: true, published_at: true, created_at: true,
            classification_completed: true, semantic_dedup_completed: true, coverage_repair_completed: true,
            board_locked: true, duplicate_of: true, day_key: true,
        },
    });
    return rows.map((row) => {
        const assets = Array.isArray(row.assets) ? row.assets : [];
        const hasTrackedScoredAsset = assets.some((asset) => {
            if (!asset || typeof asset !== 'object') return false;
            const candidate = asset as Record<string, unknown>;
            return (CATALYST_CURRENCIES as readonly string[]).includes(String(candidate.asset ?? '').toUpperCase())
                && Number(candidate.score) !== 0;
        });
        const displayEligible = row.board_locked && !row.duplicate_of && hasTrackedScoredAsset;
        const visibilityReason = displayEligible
            ? 'displayed'
            : row.duplicate_of
                ? 'duplicate'
                : !row.classification_completed
                    ? 'classification_incomplete'
                    : !row.board_locked
                        ? 'not_board_locked'
                        : !hasTrackedScoredAsset
                            ? 'no_scored_catalyst_asset'
                            : 'not_display_eligible';
        return {
            id: row.id,
            headline: row.headline,
            source: row.source,
            category: row.category,
            impact: row.impact,
            summary: row.summary,
            assets: (row.assets as ClassifiedAsset[]) ?? [],
            publishedAt: row.published_at?.toISOString() ?? null,
            createdAt: row.created_at.toISOString(),
            sourceId: row.source_id,
            guid: row.guid,
            sourceKey: row.source_key ?? '',
            dayKey: row.day_key,
            classificationCompleted: row.classification_completed,
            semanticDedupCompleted: row.semantic_dedup_completed,
            coverageRepairCompleted: row.coverage_repair_completed,
            boardLocked: row.board_locked,
            duplicateOf: row.duplicate_of,
            displayEligible,
            visibilityReason,
        };
    });
}

export type DayArchiveMeta = {
    dayKey: string;
    headlineCount: number;
    relevantCount: number;
    duplicateCount: number;
    irrelevantCount: number;
    finalizedAt: string;
};

export type HistoricalDayPayload = {
    dayKey: string;
    isLiveDay: boolean;
    archived: boolean;
    board: CatalystBoardRow[];
    meta: DayArchiveMeta | null;
};

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * Finalize a completed UAE market day (01:00 Asia/Dubai → next 01:00) — snapshot
 * catalyst scores into `market_driver_day_archive`. Does NOT delete headlines (they stay
 * keyed by day_key for Historical Analysis). Live boards clear because they only query today's day_key.
 */
export async function finalizeUaeDay(dayKey: string, now: Date = new Date()): Promise<boolean> {
    const today = marketDayKey(now);
    if (dayKey >= today) {
        logger.info(`[MarketDriver] Skip finalize for ${dayKey} — still the live UAE market day (${today})`);
        return false;
    }

    const existing = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: dayKey } });

    const total = await prisma.marketDriverNews.count({ where: { day_key: dayKey } });
    if (total === 0) {
        logger.info(`[MarketDriver] No headlines for ${dayKey} — nothing to archive`);
        return false;
    }

    const [board, relevantCount, duplicateCount, irrelevantCount] = await Promise.all([
        getCatalystBoard(dayKey),
        prisma.marketDriverNews.count({
            where: { day_key: dayKey, duplicate_of: null, category: { in: BOARD_CATEGORIES } },
        }),
        prisma.marketDriverNews.count({ where: { day_key: dayKey, NOT: { duplicate_of: null } } }),
        prisma.marketDriverNews.count({ where: { day_key: dayKey, category: 'IRRELEVANT' } }),
    ]);

    const catalystBoard = board as unknown as object;
    const unchanged = Boolean(
        existing &&
        existing.headline_count === total &&
        existing.relevant_count === relevantCount &&
        existing.duplicate_count === duplicateCount &&
        existing.irrelevant_count === irrelevantCount &&
        canonicalJson(existing.catalyst_board) === canonicalJson(board),
    );
    if (unchanged) return false;

    await prisma.marketDriverDayArchive.upsert({
        where: { day_key: dayKey },
        create: {
            day_key: dayKey,
            catalyst_board: catalystBoard,
            headline_count: total,
            relevant_count: relevantCount,
            duplicate_count: duplicateCount,
            irrelevant_count: irrelevantCount,
            finalized_at: now,
        },
        update: {
            catalyst_board: catalystBoard,
            headline_count: total,
            relevant_count: relevantCount,
            duplicate_count: duplicateCount,
            irrelevant_count: irrelevantCount,
            finalized_at: now,
        },
    });

    logger.info(
        `[MarketDriver] ${existing ? 'Refreshed' : 'Archived'} UAE market day ${dayKey} (${total} headlines, ${relevantCount} relevant) — live pool is ${today}`,
    );
    return true;
}

/** Finalize previous UAE market day + any older unarchived day_keys (catch-up after downtime). Runs at 01:00 Asia/Dubai. */
export async function runUaeMidnightArchive(now: Date = new Date()): Promise<number> {
    const today = marketDayKey(now);
    const yesterday = previousUaeDayKey(now);
    const dayKeys = new Set<string>([yesterday]);
    const [pastNewsDays, archivedDays] = await Promise.all([
        prisma.marketDriverNews.findMany({
        where: { day_key: { lt: today } },
        distinct: ['day_key'],
        select: { day_key: true },
        }),
        prisma.marketDriverDayArchive.findMany({
            where: { day_key: { lt: yesterday } },
            select: { day_key: true },
        }),
    ]);
    const archivedKeys = new Set(archivedDays.map((row) => row.day_key));
    // Yesterday is always eligible for a refresh because a classification that straddled 01:00
    // may have completed after the first snapshot. Older days are catch-up candidates only when
    // no archive exists, avoiding a full-history rebuild every hour.
    for (const row of pastNewsDays) {
        if (!archivedKeys.has(row.day_key)) dayKeys.add(row.day_key);
    }

    let archived = 0;
    for (const dayKey of [...dayKeys].sort()) {
        if (await finalizeUaeDay(dayKey, now)) archived += 1;
    }
    return archived;
}

/**
 * Past UAE market days for Historical Analysis (doc §2).
 * Prefer archived snapshots; also include past day_keys that still have news but were not archived yet
 * (reconstruct board from headlines so the picker is never empty when data exists).
 */
export async function listHistoricalDays(now: Date = new Date()): Promise<DayArchiveMeta[]> {
    const today = marketDayKey(now);
    const archives = await prisma.marketDriverDayArchive.findMany({
        where: { day_key: { lt: today } },
        orderBy: { day_key: 'desc' },
    });

    const archivedKeys = new Set(archives.map((a) => a.day_key));
    const newsDays = await prisma.marketDriverNews.findMany({
        where: { day_key: { lt: today } },
        distinct: ['day_key'],
        select: { day_key: true },
        orderBy: { day_key: 'desc' },
    });

    const out: DayArchiveMeta[] = archives.map((a) => ({
        dayKey: a.day_key,
        headlineCount: a.headline_count,
        relevantCount: a.relevant_count,
        duplicateCount: a.duplicate_count,
        irrelevantCount: a.irrelevant_count,
        finalizedAt: a.finalized_at.toISOString(),
    }));

    for (const r of newsDays) {
        if (archivedKeys.has(r.day_key)) continue;
        const [total, relevant, duplicates, irrelevant] = await Promise.all([
            prisma.marketDriverNews.count({ where: { day_key: r.day_key } }),
            prisma.marketDriverNews.count({
                where: { day_key: r.day_key, duplicate_of: null, category: { in: BOARD_CATEGORIES } },
            }),
            prisma.marketDriverNews.count({ where: { day_key: r.day_key, NOT: { duplicate_of: null } } }),
            prisma.marketDriverNews.count({ where: { day_key: r.day_key, category: 'IRRELEVANT' } }),
        ]);
        out.push({
            dayKey: r.day_key,
            headlineCount: total,
            relevantCount: relevant,
            duplicateCount: duplicates,
            irrelevantCount: irrelevant,
            finalizedAt: '',
        });
    }

    return out.sort((a, b) => b.dayKey.localeCompare(a.dayKey));
}

/**
 * One historical day payload. Always rebuilds the catalyst board from that day's headlines
 * so scores match the current scoring path (and the News table for the same dayKey).
 * Archive row is used for meta / finalized status only.
 */
export async function getHistoricalDay(dayKey: string, now: Date = new Date()): Promise<HistoricalDayPayload | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

    const today = marketDayKey(now);
    const isLiveDay = dayKey === today;
    const archive = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: dayKey } });

    // Rebuild from headlines for the selected day — never mix in today's live pool.
    const board = await getCatalystBoard(dayKey);

    const meta: DayArchiveMeta | null = archive
        ? {
              dayKey: archive.day_key,
              headlineCount: archive.headline_count,
              relevantCount: archive.relevant_count,
              duplicateCount: archive.duplicate_count,
              irrelevantCount: archive.irrelevant_count,
              finalizedAt: archive.finalized_at.toISOString(),
          }
        : null;

    return { dayKey, isLiveDay, archived: Boolean(archive), board, meta };
}

export { TRACKED_ASSETS };
