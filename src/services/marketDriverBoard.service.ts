import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import {
    classifyHeadlines,
    findBatchDuplicateMap,
    groqDailyLimitRemainingMs,
    isBoardVisibleClassification,
    isGroqDailyLimited,
    likelySameEvent,
    oilCatalystCluster,
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
 * Groq batch size per call. We loop until every fresh RSS item is classified in this ingest
 * (full feed — often 100–200+ items), so News Headline fills from one scrape.
 */
const CLASSIFY_BATCH_SIZE = 12;
/** Free Groq TPM ~12k/min; each batch ≈4–5k tokens — 20s gap keeps most runs under TPM. */
const CLASSIFY_BATCH_GAP_MS = 20000;

/** Only DRIVER + GEOPOLITICAL headlines feed the board; ECONOMIC comes from the calendar, IRRELEVANT is dropped. */
const BOARD_CATEGORIES = ['DRIVER', 'GEOPOLITICAL'];

/** Board display order (doc §1). */
const BOARD_ASSET_ORDER: TrackedAsset[] = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'GOLD', 'OIL'];

/**
 * Live market day key: Asia/Dubai (UAE), window 01:00 → next 01:00.
 * Example: 12 Jul 01:00 GST … 13 Jul 00:59 GST → day_key `2026-07-12`.
 * A post at 01:30 GST on 12 Jul belongs to `2026-07-12`; after 01:00 on 13 Jul the live
 * board only shows the new day (previous day is archived / not shown).
 */
export function marketDayKey(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const num = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((p) => p.type === type)?.value ?? NaN);

    let year = num('year');
    let month = num('month');
    let day = num('day');
    const hour = num('hour');
    if (![year, month, day, hour].every((n) => Number.isFinite(n))) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(date);
    }

    // Before 01:00 UAE the live day is still yesterday's date label.
    if (hour < 1) {
        const civil = new Date(Date.UTC(year, month - 1, day));
        civil.setUTCDate(civil.getUTCDate() - 1);
        year = civil.getUTCFullYear();
        month = civil.getUTCMonth() + 1;
        day = civil.getUTCDate();
    }

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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

function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

export type RssItem = { guid: string; title: string; source: string | null; pubDate: string | null };

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
 * Re-key headlines by publish time into the UAE 01:00→01:00 market day.
 * Fixes prior mis-tags so live boards stop showing yesterday.
 */
export async function realignMarketDriverDayKeysByPubDate(): Promise<number> {
    const live = marketDayKey();
    const lookback = previousUaeDayKey(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
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
 * Re-apply doc sanitizers on already-stored rows for the current market day (no Groq cost):
 * impact↔score coupling, non-crude energy → IRRELEVANT, weak OIL tags dropped, weak summaries fixed.
 */
export async function realignTodaysMarketDriverScores(): Promise<number> {
    const dayKey = marketDayKey();
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

const RECLASSIFY_BATCH = 10;

/**
 * Full Groq reclassify of today's stored headlines (fixes asset/summary/category with the current
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
                    ...(nowVisible ? { board_locked: true } : {}),
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
        select: { id: true, headline: true, board_locked: true, published_at: true },
    });
    if (principals.length < 2) return 0;

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

    return marked;
}

/**
 * AI-judgment same-briefing dedup (doc §3), bounded to a recent time window so it runs
 * automatically after every ingest without re-scanning (and re-billing) the whole day.
 * Catches fragments Groq's per-batch pass and the cheap fingerprint pass both miss —
 * e.g. three separate "Trump: ..." bullets from one Iran briefing minutes apart — without
 * hardcoding a name/topic list: Groq itself judges "same briefing" (see DEDUP_ONLY_PROMPT).
 */
export async function markRecentSemanticDuplicates(windowMinutes = 180): Promise<number> {
    if (isGroqDailyLimited()) return 0;

    const dayKey = marketDayKey();
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);
    const principals = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            duplicate_of: null,
            category: { in: BOARD_CATEGORIES },
            created_at: { gte: since },
        },
        orderBy: { created_at: 'asc' },
        select: { id: true, headline: true, board_locked: true, published_at: true },
    });
    if (principals.length < 2) return 0;

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
    }

    if (marked > 0) {
        logger.info(`[MarketDriver] Recent-window AI dedup marked ${marked} duplicate(s) (last ${windowMinutes}m)`);
    }
    return marked;
}

/**
 * Cheap full-day doc §3 pass: fingerprint + token-overlap (no Groq).
 * Collapses Centcom/Hormuz/Trump-briefing paraphrases that batch Groq often misses.
 * Only links rows that share the same primary asset (never hide GOLD behind an OIL principal).
 */
export async function markTodaysDeterministicDuplicates(): Promise<number> {
    const dayKey = marketDayKey();
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

/** Shared classify lock — webhook ingest + coverage-audit heal must never run Groq in parallel. */
let marketDriverIngestInFlight = false;
let lastMarketDriverIngestFinishedAtMs: number | null = null;

/** Headlines left when TPD aborted mid-ingest — auto-resumed after Groq daily cooldown. */
let deferredRssItems: Array<{ guid: string; title: string; source: string | null; pubDate: string }> = [];
let deferredResumeTimer: ReturnType<typeof setTimeout> | null = null;

export function isMarketDriverIngestRunning(): boolean {
    return marketDriverIngestInFlight;
}

/** Ms since last ingest finished; `null` if one is running or none finished this process. */
export function getMarketDriverIngestIdleMs(): number | null {
    if (marketDriverIngestInFlight) return null;
    if (lastMarketDriverIngestFinishedAtMs == null) return null;
    return Date.now() - lastMarketDriverIngestFinishedAtMs;
}

export function getDeferredMarketDriverCount(): number {
    return deferredRssItems.length;
}

function queueDeferredRssItems(
    items: Array<{ guid: string; title: string; source: string | null; pubDate: string | null }>,
): number {
    const next = items
        .filter((i) => i.pubDate)
        .map((i) => ({
            guid: i.guid,
            title: i.title,
            source: i.source,
            pubDate: i.pubDate as string,
        }));
    if (next.length === 0) return 0;

    const seen = new Set(deferredRssItems.map((d) => d.guid));
    for (const item of next) {
        if (seen.has(item.guid)) continue;
        seen.add(item.guid);
        deferredRssItems.push(item);
    }
    scheduleDeferredIngestResume();
    return deferredRssItems.length;
}

function scheduleDeferredIngestResume(): void {
    if (deferredRssItems.length === 0) return;
    if (deferredResumeTimer) clearTimeout(deferredResumeTimer);

    const waitMs = Math.max(groqDailyLimitRemainingMs() + 15_000, 30_000);
    logger.warn(
        `[MarketDriver] PARTIAL ingest — ${deferredRssItems.length} headline(s) queued; ` +
            `auto-resume in ${Math.ceil(waitMs / 60000)}m (after Groq TPD cooldown). Board not final yet.`,
    );
    deferredResumeTimer = setTimeout(() => {
        deferredResumeTimer = null;
        void resumeDeferredMarketDriverIngest();
    }, waitMs);
}

async function resumeDeferredMarketDriverIngest(): Promise<void> {
    if (deferredRssItems.length === 0) return;
    if (isGroqDailyLimited()) {
        scheduleDeferredIngestResume();
        return;
    }
    if (marketDriverIngestInFlight) {
        scheduleDeferredIngestResume();
        return;
    }

    const payload = deferredRssItems.slice();
    deferredRssItems = [];
    logger.info(`[MarketDriver] Resuming deferred classify for ${payload.length} headline(s)`);

    try {
        const { websocketService } = await import('./websocket.service.js');
        const result = await ingestMarketDriverRssItems(payload);
        if (result.ingestComplete && result.changed) {
            websocketService.emitCalendarNewsUpdate('market-driver');
            logger.info(
                `[MarketDriver] Deferred resume COMPLETE: stored=${result.stored} fresh=${result.fresh} — board is final`,
            );
        } else if (!result.ingestComplete) {
            logger.warn(
                `[MarketDriver] Deferred resume still PARTIAL: deferred=${result.deferredCount} — waiting again`,
            );
        }
    } catch (err) {
        // Put them back so a later cron / resume can retry.
        deferredRssItems = payload;
        scheduleDeferredIngestResume();
        logger.error(
            `[MarketDriver] Deferred resume failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
        );
    }
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
            `[MarketDriver] Ingest skipped — classify already running (accepted ${receivedCount} item(s) without overlapping Groq)`,
        );
        return {
            received: receivedCount,
            fresh: 0,
            stored: 0,
            carried: 0,
            reclassified: 0,
            changed: false,
            realigned: 0,
            skippedOverlap: true,
            ingestComplete: false,
            deferredCount: deferredRssItems.length,
        };
    }
    marketDriverIngestInFlight = true;
    try {
        const result = await runMarketDriverIngest(rawItems);
        const ingestComplete = result.deferredCount === 0;
        return { ...result, ingestComplete };
    } finally {
        marketDriverIngestInFlight = false;
        lastMarketDriverIngestFinishedAtMs = Date.now();
    }
}

async function runMarketDriverIngest(rawItems: unknown[]): Promise<{
    received: number;
    fresh: number;
    stored: number;
    carried: number;
    reclassified: number;
    changed: boolean;
    realigned: number;
    classifyFailed?: boolean;
    deferredCount: number;
}> {
    const dayKey = marketDayKey();
    const repaired = await repairLockedDuplicates();
    const dayKeysFixed = await realignMarketDriverDayKeysByPubDate();
    const realigned = (await realignTodaysMarketDriverScores()) + dayKeysFixed + repaired;
    const items = normalizeRssItems(rawItems);
    if (items.length === 0) {
        return {
            received: 0,
            fresh: 0,
            stored: 0,
            carried: 0,
            reclassified: 0,
            changed: realigned > 0,
            realigned,
            deferredCount: deferredRssItems.length,
        };
    }

    // Hard dedup by guid.
    // Doc §2: each headline belongs to the UAE market day that contains its publish time
    // (01:00 → next 01:00). 11:00 PM / 12:10 AM before 01:00 still count in THAT full day —
    // they must be stored under that day_key (live while that day is current; Historical after).
    // Never discard them as "wrong day". Only skip ancient feed items older than yesterday.
    const guids = items.map((i) => i.guid);
    const existing = await prisma.marketDriverNews.findMany({
        where: { guid: { in: guids } },
        select: { id: true, guid: true, day_key: true },
    });
    const seenGuids = new Set(existing.map((e) => e.guid));
    const carried = 0;
    const yesterday = previousUaeDayKey();

    const fresh: RssItem[] = [];
    const batchGuids = new Set<string>();
    let skippedOtherDay = 0;
    let skippedInvalidDate = 0;
    for (const it of items) {
        if (seenGuids.has(it.guid) || batchGuids.has(it.guid)) continue;
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
        batchGuids.add(it.guid);
        fresh.push(it);
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
            const classified = await classifyHeadlines(
                chunk.map((f) => ({ text: f.title, publishedAt: f.pubDate })),
                existingTopics,
            );
            if (classified.length === 0) {
                if (isGroqDailyLimited()) {
                    const leftover = fresh.slice(i);
                    deferredCount = queueDeferredRssItems(leftover);
                    const left = Math.ceil(leftover.length / CLASSIFY_BATCH_SIZE);
                    logger.error(
                        `[MarketDriver] Stopping ingest early — Groq daily TPD limit hit; ` +
                            `${left} batch(es) / ${leftover.length} headline(s) queued for auto-resume ` +
                            `(same API key as local+prod burns one TPD bucket)`,
                    );
                    classifyFailed = true;
                    break;
                }
                logger.error(
                    `[MarketDriver] Groq returned 0 classifications for batch ${i / CLASSIFY_BATCH_SIZE + 1} (${chunk.length} headline(s)) — check GROQ_API_KEY / rate limits`,
                );
                continue;
            }
            classifiedAny = true;

            const classifiedByIndex = new Map(classified.map((c) => [c.index, c]));
            const batchIds = chunk.map(() => randomUUID());

            // Process in index order so a within-batch principal's lock decision is known before
            // its duplicate is evaluated (classifyHeadlines returns sorted by index).
            const rows: Array<{
                id: string;
                guid: string;
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

                // Admission dedup, in precedence order: Groq/within-batch → normalized text →
                // deterministic same-event vs already-locked principals (catches paraphrases
                // batch Groq misses, e.g. Centcom/Hormuz restatements).
                let duplicateOf = resolveDuplicateOf(c.index, classifiedByIndex, batchIds) ?? normalizedToId.get(normalized) ?? null;
                if (!duplicateOf && visibleByClass) {
                    duplicateOf = matchLockedPrincipal(item.title, primary, lockedPrincipals);
                }

                // Never hide a VISIBLE story by folding it into a target that is not itself shown.
                // (Folding into an IRRELEVANT/hidden row would make the story vanish entirely.)
                if (duplicateOf && visibleByClass && !lockedIds.has(duplicateOf)) {
                    duplicateOf = null;
                }

                const boardLocked = !duplicateOf && visibleByClass;

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
                    published_at: publishedAt,
                });
            }

            const result = await prisma.marketDriverNews.createMany({ data: rows, skipDuplicates: true });
            stored += result.count;
            const dupeCount = rows.filter((r) => r.duplicate_of).length;
            const lockedCount = rows.filter((r) => r.board_locked).length;
            logger.info(
                `[MarketDriver] Batch ${Math.floor(i / CLASSIFY_BATCH_SIZE) + 1}: classified ${classified.length}, stored ${result.count} (${lockedCount} shown, ${dupeCount} duplicate)`,
            );

            // Grow dedup context for the next Groq batch with newly stored principals.
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
            if (isGroqDailyLimited()) {
                deferredCount = queueDeferredRssItems(fresh);
            }
            logger.error(
                isGroqDailyLimited()
                    ? `[MarketDriver] Groq stored nothing for ${fresh.length} fresh headline(s) — daily TPD limit exhausted (shared local+prod key). ${deferredCount} queued for auto-resume.`
                    : `[MarketDriver] Groq stored nothing for ${fresh.length} fresh headline(s) — check GROQ_API_KEY on this server.`,
            );
            classifyFailed = true;
        }
    }

    // Production recovery: feed guids already in DB (stored=0) but live board empty
    // (all IRRELEVANT / Low / wrong day). Reclassify a small batch so News Headline fills.
    let reclassified = 0;
    const boardCount = await countLiveBoardItems(dayKey);
    if (boardCount === 0 && deferredCount === 0) {
        reclassified = await reclassifyFeedMatchedForEmptyBoard(dayKey, guids);
    }

    const deterministicDupes = await markTodaysDeterministicDuplicates();
    // Bounded AI (Groq) same-briefing pass — recent window only, so this runs every ingest
    // without re-billing the whole day. Skips cleanly if Groq is TPD-limited.
    const semanticDupes = await markRecentSemanticDuplicates().catch((error) => {
        logger.error(`[MarketDriver] Recent-window semantic dedup failed: ${(error as Error).message}`);
        return 0;
    });

    return {
        received: items.length,
        fresh: fresh.length,
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
        /** Present when fresh items arrived but Groq stored nothing — usually missing GROQ_API_KEY. */
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
 * When the live board has zero DRIVER/GEOPOLITICAL High|Medium rows, re-run Groq on a
 * capped set of today's rows that still appear in the RSS feed (guid match).
 */
async function reclassifyFeedMatchedForEmptyBoard(dayKey: string, feedGuids: string[]): Promise<number> {
    const candidates = await prisma.marketDriverNews.findMany({
        // Board is empty ⇒ no locked rows expected; still skip any locked for safety.
        // Only unlockeds may be rewritten; visibility becomes an ADD via board_locked.
        where: { day_key: dayKey, guid: { in: feedGuids }, published_at: { not: null }, board_locked: false },
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
    );
    if (classified.length === 0) {
        logger.warn('[MarketDriver] Empty-board reclassify returned no classifications (check GROQ_API_KEY)');
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
 * Same primary-asset pick as the News Headline table (frontend mapMarketDriverNews):
 * highest |score|, ties → OIL, then GOLD, then alpha. Catalyst must use only this asset
 * so the scoreboard never credits CAD/GOLD/etc. for a row that News shows as OIL.
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
        const primary = pickPrimaryAsset(assets);
        if (!primary) continue;
        const list = byAsset.get(primary.asset);
        if (!list) continue;
        list.push({ headline: item.headline, primary });
    }

    for (const asset of BOARD_ASSET_ORDER) {
        const row = agg.get(asset)!;
        const collapsed = collapseSameEventEntries(byAsset.get(asset) ?? []);
        for (const entry of collapsed) {
            if (entry.primary.score > 0) row.bullishCount += 1;
            else if (entry.primary.score < 0) row.bearishCount += 1;
            row.driverScore += entry.primary.score;
        }

        // Client oil→CAD rule (heatmap): when OIL is Moderate/Extreme Bullish after §3 collapse,
        // CAD also receives that bullish catalyst. Primary-asset pick always prefers OIL over CAD,
        // so without this mirror CAD stays flat even when oil is strongly bid.
        if (asset === 'OIL') {
            const cadRow = agg.get('CAD')!;
            for (const entry of collapsed) {
                if (entry.primary.score < 0.5) continue;
                cadRow.bullishCount += 1;
                cadRow.driverScore += entry.primary.score;
            }
        }
    }

    return BOARD_ASSET_ORDER.map((asset) => {
        const row = agg.get(asset)!;
        return { ...row, driverScore: Number(row.driverScore.toFixed(1)) };
    });
}

/** Previous UAE market day label (day before current 01:00→01:00 window). */
export function previousUaeDayKey(date: Date = new Date()): string {
    const today = marketDayKey(date);
    const [y, m, d] = today.split('-').map(Number);
    const utc = new Date(Date.UTC(y!, m! - 1, d!));
    utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString().slice(0, 10);
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
 * Finalize a completed UAE market day (01:00 Asia/Dubai → next 01:00) — snapshot
 * catalyst scores into `market_driver_day_archive`. Does NOT delete headlines (they stay
 * keyed by day_key for Historical Analysis). Live boards clear because they only query today's day_key.
 */
export async function finalizeUaeDay(dayKey: string): Promise<boolean> {
    const today = marketDayKey();
    if (dayKey >= today) {
        logger.info(`[MarketDriver] Skip finalize for ${dayKey} — still the live UAE market day (${today})`);
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
        `[MarketDriver] Archived UAE market day ${dayKey} (${total} headlines, ${relevantCount} relevant) — live pool is ${today}`,
    );
    return true;
}

/** Finalize previous UAE market day + any older unarchived day_keys (catch-up after downtime). Runs at 01:00 Asia/Dubai. */
export async function runUaeMidnightArchive(): Promise<number> {
    const today = marketDayKey();
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

/**
 * Past UAE market days for Historical Analysis (doc §2).
 * Prefer archived snapshots; also include past day_keys that still have news but were not archived yet
 * (reconstruct board from headlines so the picker is never empty when data exists).
 */
export async function listHistoricalDays(): Promise<DayArchiveMeta[]> {
    const today = marketDayKey();
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
export async function getHistoricalDay(dayKey: string): Promise<HistoricalDayPayload | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

    const today = marketDayKey();
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
