import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import {
    classifyHeadlines,
    findBatchDuplicateMap,
    sanitizeClassification,
    TRACKED_ASSETS,
    type AssetBias,
    type ClassifiedAsset,
    type ClassifiedHeadline,
    type ExistingTopic,
    type NewsCategory,
    type NewsImpact,
    type TrackedAsset,
} from './groqClassifier.service.js';

/**
 * Cap Groq work per cycle. Kept deliberately small (not just for the free-tier 12k TPM rate
 * limit, though that matters too): a large, noisy mixed-topic batch measurably degrades the
 * model's dedup accuracy — a duplicate pair that's reliably caught in a clean 8-headline batch
 * was missed inside a real 40-headline one. Smaller batches trade a few more Groq calls for
 * meaningfully more reliable duplicate detection.
 */
const MAX_CLASSIFY_PER_CYCLE = 15;

/** Only DRIVER + GEOPOLITICAL headlines feed the board; ECONOMIC comes from the calendar, IRRELEVANT is dropped. */
const BOARD_CATEGORIES = ['DRIVER', 'GEOPOLITICAL'];

/** Board display order (doc §1). */
const BOARD_ASSET_ORDER: TrackedAsset[] = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'GOLD', 'OIL'];

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

/** YYYY-MM-DD in Asia/Dubai (UAE) — the live daily pool key + reset boundary (doc §2). */
export function uaeDayKey(date: Date = new Date()): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(date);
}

function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

export type RssItem = { guid: string; title: string; source: string | null; pubDate: string | null };

function normalizeRssItems(rawItems: unknown[]): RssItem[] {
    const out: RssItem[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const it = raw as Record<string, unknown>;
        const title = String(it.title ?? '')
            .replace(/^FinancialJuice:\s*/i, '')
            .trim();
        const guid = String(it.guid ?? '').trim() || title;
        if (!title || !guid || seen.has(guid)) continue;
        seen.add(guid);
        out.push({
            guid: guid.slice(0, 500),
            title,
            source: it.source == null || it.source === '' ? 'FinancialJuice' : String(it.source).trim(),
            pubDate: it.pubDate == null || it.pubDate === '' ? null : String(it.pubDate).trim(),
        });
    }
    return out;
}

/**
 * Max already-stored headlines sent as dedup context per Groq call. Most-recent-first (see the
 * query below) — a headline from minutes ago is far more likely to be re-reported than one from
 * 10 hours ago, and keeping this small also matters for the free-tier 12k TPM rate limit once
 * a day's principal count grows into the hundreds.
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
 * Re-apply doc sanitizers on already-stored rows for the current UAE day (no Groq cost):
 * impact↔score coupling, non-crude energy → IRRELEVANT, weak OIL tags dropped, weak summaries fixed.
 */
export async function realignTodaysMarketDriverScores(): Promise<number> {
    const dayKey = uaeDayKey();
    const items = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey },
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

        const sameAssets =
            JSON.stringify(assetsIn) === JSON.stringify(sanitized.assets) &&
            item.impact === sanitized.impact &&
            item.category === sanitized.category &&
            (item.summary ?? '') === sanitized.summary;

        if (sameAssets) continue;

        await prisma.marketDriverNews.update({
            where: { id: item.id },
            data: {
                category: sanitized.category,
                impact: sanitized.impact,
                summary: sanitized.summary,
                assets: sanitized.assets as unknown as object,
            },
        });
        updated += 1;
    }

    if (updated > 0) {
        logger.info(`[MarketDriver] Sanitized ${updated} stored headline(s) to match doc rules`);
    }
    return updated;
}

const RECLASSIFY_BATCH = 10;

/**
 * Full Groq reclassify of today's stored headlines (fixes asset/summary/category with the current
 * prompt), then a second pass to mark same-event duplicates (doc §3). Expensive — run on demand.
 */
export async function reclassifyTodaysMarketDriverNews(): Promise<{ updated: number; duplicates: number }> {
    const dayKey = uaeDayKey();
    const items = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true },
    });

    let updated = 0;
    for (let i = 0; i < items.length; i += RECLASSIFY_BATCH) {
        const batch = items.slice(i, i + RECLASSIFY_BATCH);
        const classified = await classifyHeadlines(
            batch.map((b) => b.headline),
            [],
        );
        if (classified.length === 0) {
            logger.warn(`[MarketDriver] Reclassify batch starting at ${i} returned empty — skipping`);
            continue;
        }

        for (const c of classified) {
            const row = batch[c.index];
            if (!row) continue;
            await prisma.marketDriverNews.update({
                where: { id: row.id },
                data: {
                    category: c.category,
                    impact: c.impact,
                    summary: c.summary,
                    assets: c.assets as unknown as object,
                    // Clear stale duplicate links before the dedicated dedup pass below.
                    duplicate_of: null,
                },
            });
            updated += 1;
        }

        // Soft rate-limit between Groq batches (free-tier 12k TPM).
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
        select: { id: true, headline: true },
    });
    if (principals.length < 2) return 0;

    let marked = 0;
    for (let i = 0; i < principals.length; i += RECLASSIFY_BATCH - 2) {
        const batch = principals.slice(i, i + RECLASSIFY_BATCH);
        if (batch.length < 2) break;

        const dupMap = await findBatchDuplicateMap(batch.map((b) => b.headline));
        for (const [dupIdx, principalIdx] of dupMap) {
            const principal = batch[principalIdx];
            const dup = batch[dupIdx];
            if (!principal || !dup || principal.id === dup.id) continue;
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

    return marked;
}

/**
 * Ingest raw RSS items from forex-scraping: dedup → classify new items → store.
 * Safe to call on a webhook; no-ops cleanly on any failure.
 * Returns stats including whether the live board / headline table may have changed.
 */
export async function ingestMarketDriverRssItems(rawItems: unknown[]): Promise<{
    received: number;
    fresh: number;
    stored: number;
    changed: boolean;
    realigned: number;
}> {
    const dayKey = uaeDayKey();
    const realigned = await realignTodaysMarketDriverScores();
    const items = normalizeRssItems(rawItems);
    if (items.length === 0) {
        return { received: 0, fresh: 0, stored: 0, changed: realigned > 0, realigned };
    }

    // Hard dedup: drop feed items whose guid is already stored (any day).
    const guids = items.map((i) => i.guid);
    const existing = await prisma.marketDriverNews.findMany({
        where: { guid: { in: guids } },
        select: { guid: true },
    });
    const seenGuids = new Set(existing.map((e) => e.guid));

    // In-batch guid dedup + cap.
    const fresh: RssItem[] = [];
    const batchGuids = new Set<string>();
    for (const it of items) {
        if (seenGuids.has(it.guid) || batchGuids.has(it.guid)) continue;
        batchGuids.add(it.guid);
        fresh.push(it);
        if (fresh.length >= MAX_CLASSIFY_PER_CYCLE) break;
    }
    if (fresh.length === 0) {
        return {
            received: items.length,
            fresh: 0,
            stored: 0,
            changed: realigned > 0,
            realigned,
        };
    }

    // Semantic dedup context (doc §3): today's already-stored, non-duplicate headlines — the
    // model checks each new headline against these (and against each other) for same-event matches.
    const todaysPrincipals = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey, duplicate_of: null },
        select: { id: true, headline: true },
        orderBy: { created_at: 'desc' },
        take: MAX_EXISTING_TOPICS,
    });
    const existingTopics: ExistingTopic[] = todaysPrincipals.map((r) => ({ id: r.id, text: r.headline }));

    const classified = await classifyHeadlines(
        fresh.map((f) => f.title),
        existingTopics,
    );
    if (classified.length === 0) {
        return {
            received: items.length,
            fresh: fresh.length,
            stored: 0,
            changed: realigned > 0,
            realigned,
        };
    }

    const classifiedByIndex = new Map(classified.map((c) => [c.index, c]));
    // Pre-generate ids so within-batch duplicate references can point at a real row id.
    const batchIds = fresh.map(() => randomUUID());

    // Soft text-match dedup as a backstop for whatever the model misses (or if it wasn't called
    // for some reason) — same normalized headline already stored today counts once (doc §3).
    const todaysNormalized = await prisma.marketDriverNews.findMany({
        where: { day_key: dayKey },
        select: { id: true, normalized: true },
    });
    const normalizedToId = new Map(todaysNormalized.map((r) => [r.normalized, r.id]));

    const rows = classified.map((c) => {
        const item = fresh[c.index]!;
        const normalized = normalizeTitle(item.title);

        const modelDuplicateOf = resolveDuplicateOf(c.index, classifiedByIndex, batchIds);
        const duplicateOf = modelDuplicateOf ?? normalizedToId.get(normalized) ?? null;
        if (!duplicateOf) normalizedToId.set(normalized, batchIds[c.index]!);

        let publishedAt: Date | null = null;
        if (item.pubDate) {
            const d = new Date(item.pubDate);
            if (!Number.isNaN(d.getTime())) publishedAt = d;
        }

        return {
            id: batchIds[c.index]!,
            guid: item.guid,
            normalized,
            day_key: dayKey,
            headline: item.title.slice(0, 1000),
            source: item.source,
            category: c.category,
            impact: c.impact,
            summary: c.summary || null,
            assets: c.assets as unknown as object,
            duplicate_of: duplicateOf,
            published_at: publishedAt,
        };
    });

    const result = await prisma.marketDriverNews.createMany({ data: rows, skipDuplicates: true });
    const dupeCount = rows.filter((r) => r.duplicate_of).length;
    logger.info(
        `[MarketDriver] Classified ${classified.length} new headlines, stored ${result.count} (${dupeCount} marked duplicate)`,
    );
    return {
        received: items.length,
        fresh: fresh.length,
        stored: result.count,
        changed: realigned > 0 || result.count > 0,
        realigned,
    };
}

/**
 * @deprecated RSS fetch lives in forex-scraping. Kept as a no-op alias for any old callers.
 */
export async function refreshMarketDriverBoard(): Promise<boolean> {
    logger.warn('[MarketDriver] refreshMarketDriverBoard() is deprecated — RSS ingest is via webhook');
    const realigned = await realignTodaysMarketDriverScores();
    return realigned > 0;
}

async function loadBoardItemsForDay(dayKey: string) {
    const items = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
            // Doc §22/§34: Low = insignificant — keep in DB for audit, hide from live boards.
            impact: { in: ['High', 'Medium'] },
        },
        orderBy: { created_at: 'desc' },
    });
    return items.filter((item) => {
        const assets = (item.assets as unknown as ClassifiedAsset[]) ?? [];
        return assets.length > 0;
    });
}

function aggregateCatalystBoard(items: Awaited<ReturnType<typeof loadBoardItemsForDay>>): CatalystBoardRow[] {
    const agg = new Map<TrackedAsset, CatalystBoardRow>(
        BOARD_ASSET_ORDER.map((asset) => [asset, { asset, bullishCount: 0, bearishCount: 0, driverScore: 0 }]),
    );

    for (const item of items) {
        const assets = (item.assets as unknown as ClassifiedAsset[]) ?? [];
        for (const a of assets) {
            const row = agg.get(a.asset);
            if (!row) continue;
            if (a.score > 0) row.bullishCount += 1;
            else if (a.score < 0) row.bearishCount += 1;
            row.driverScore += a.score;
        }
    }

    return BOARD_ASSET_ORDER.map((asset) => {
        const row = agg.get(asset)!;
        return { ...row, driverScore: Number(row.driverScore.toFixed(1)) };
    });
}

/** Previous calendar day as YYYY-MM-DD (UAE day_key arithmetic). */
export function previousUaeDayKey(date: Date = new Date()): string {
    const today = uaeDayKey(date);
    const [y, m, d] = today.split('-').map(Number);
    const utc = new Date(Date.UTC(y!, m! - 1, d!));
    utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString().slice(0, 10);
}

/** Per-asset bullish/bearish counts + driver score. Defaults to the current UAE day. */
export async function getCatalystBoard(dayKey: string = uaeDayKey()): Promise<CatalystBoardRow[]> {
    const items = await loadBoardItemsForDay(dayKey);
    return aggregateCatalystBoard(items);
}

/** Full deduplicated driver headlines for the admin News / Market Drivers table (doc §34). */
export async function getMarketDriverNews(dayKey: string = uaeDayKey()): Promise<MarketDriverNewsRow[]> {
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

/**
 * Doc §2: finalize a completed UAE day — snapshot final catalyst scores + counts into
 * `market_driver_day_archive`. Does NOT delete headlines (they stay keyed by day_key for history).
 * Live boards automatically "clear" because they only query today's day_key.
 */
export async function finalizeUaeDay(dayKey: string): Promise<boolean> {
    const today = uaeDayKey();
    if (dayKey >= today) {
        logger.info(`[MarketDriver] Skip finalize for ${dayKey} — still the live UAE day (${today})`);
        return false;
    }

    const existing = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: dayKey } });
    if (existing) return false;

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

    await prisma.marketDriverDayArchive.create({
        data: {
            day_key: dayKey,
            catalyst_board: board as unknown as object,
            headline_count: total,
            relevant_count: relevantCount,
            duplicate_count: duplicateCount,
            irrelevant_count: irrelevantCount,
            finalized_at: new Date(),
        },
    });

    logger.info(
        `[MarketDriver] Archived UAE day ${dayKey} (${total} headlines, ${relevantCount} relevant) — live pool is ${today}`,
    );
    return true;
}

/** Finalize yesterday + any older unarchived day_keys (catch-up after downtime). */
export async function runUaeMidnightArchive(): Promise<number> {
    const today = uaeDayKey();
    const yesterday = previousUaeDayKey();

    const dayKeys = new Set<string>([yesterday]);
    const pastNewsDays = await prisma.marketDriverNews.findMany({
        where: { day_key: { lt: today } },
        distinct: ['day_key'],
        select: { day_key: true },
    });
    for (const r of pastNewsDays) dayKeys.add(r.day_key);

    let archived = 0;
    for (const dayKey of [...dayKeys].sort()) {
        if (await finalizeUaeDay(dayKey)) archived += 1;
    }
    return archived;
}

/** Past UAE days available on Historical Analysis (archived first, then any past day_key in news). */
export async function listHistoricalDays(): Promise<DayArchiveMeta[]> {
    const today = uaeDayKey();
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
        const total = await prisma.marketDriverNews.count({ where: { day_key: r.day_key } });
        out.push({
            dayKey: r.day_key,
            headlineCount: total,
            relevantCount: total,
            duplicateCount: 0,
            irrelevantCount: 0,
            finalizedAt: '',
        });
    }

    return out.sort((a, b) => b.dayKey.localeCompare(a.dayKey));
}

/** One historical (or live) day payload for the Historical Analysis page. */
export async function getHistoricalDay(dayKey: string): Promise<HistoricalDayPayload | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

    const today = uaeDayKey();
    const isLiveDay = dayKey === today;
    const archive = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: dayKey } });

    let board: CatalystBoardRow[];
    if (archive) {
        board = (archive.catalyst_board as unknown as CatalystBoardRow[]) ?? (await getCatalystBoard(dayKey));
    } else {
        board = await getCatalystBoard(dayKey);
    }

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
