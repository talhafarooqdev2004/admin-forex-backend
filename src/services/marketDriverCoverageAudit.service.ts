import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import {
    isBoardVisibleClassification,
} from './groqClassifier.service.js';
import {
    FFE_NEWS_SOURCE,
    getMarketDriverIngestIdleMs,
    ingestMarketDriverRssItems,
    isMarketDriverIngestRunning,
    marketDayKey,
} from './marketDriverBoard.service.js';
import { evaluateAndCacheGeopoliticalRisk } from './geopoliticalRisk.service.js';

/**
 * Self-healing coverage audit — the automation that replaces the user's manual daily check.
 *
 * Every run: fetch the FinancialJuice feed → verify exact/source identities against
 * `market_driver_news` → send genuine missing identities through the normal durable AI
 * classification pipeline. The audit never invents semantic decisions or rewrites an existing row.
 * Locked rows are never rewritten — once shown on News Headline they stay for the UAE day.
 * Then re-verify. Only gaps that survive healing are reported as failures (ERROR log + status).
 *
 * Cron only (no boot heal). Skips while RSS classify is running and for
 * {@link COVERAGE_AUDIT_COOLDOWN_MS} after it finishes so heal never races the 10‑min ingest.
 * Admin `?run=1` can force. Manual test script / admin endpoint share this function.
 */

/** Wait after last full-feed ingest before heal may call the provider (avoids burst-limit wars). */
const COVERAGE_AUDIT_COOLDOWN_MS = 2 * 60 * 1000;

/** Same feeds + guid prefixes as forex-scraping's marketDriverRss.service.js — a healed MISSING
 *  item stores under the guid the scraper would later send, so no double-ingest. */
const AUDIT_FEEDS = [
    { name: 'FJ_RSS', url: 'https://www.financialjuice.com/feed.ashx?xml=RSS', source: FFE_NEWS_SOURCE, sourceId: 'financialjuice:rss', guidPrefix: '' },
] as const;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type CoverageGap = {
    kind: 'MISSING' | 'HIDDEN';
    source: string;
    headline: string;
    detail: string;
};

export type CoverageAuditResult = {
    ranAt: string;
    liveDay: string;
    feedsFetched: string[];
    feedsFailed: string[];
    uniqueLiveItems: number;
    requiredByRules: number;
    requiredOk: number;
    healedMissing: number;
    healedHidden: number;
    residualGaps: CoverageGap[];
    systemVisible: number;
    pass: boolean;
};

type FeedItem = {
    guid: string;
    sourceId: string;
    title: string;
    source: string;
    feedName: string;
    pubDate: string | null;
    norm: string;
};

type DbRow = {
    id: string;
    headline: string;
    category: string;
    impact: string;
    duplicate_of: string | null;
    board_locked: boolean;
    assets: unknown;
};

let lastAudit: CoverageAuditResult | null = null;
let auditInFlight: Promise<CoverageAuditResult> | null = null;

export function getLastCoverageAudit(): CoverageAuditResult | null {
    return lastAudit;
}

const rssParser = new XMLParser({ ignoreAttributes: false, trimValues: true });

function stripSourcePrefix(title: string): string {
    return title
        .replace(/^FinancialJuice:\s*/i, '')
        .trim();
}

function normalizeTitle(t: string): string {
    return stripSourcePrefix(String(t || ''))
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractGuid(raw: Record<string, unknown>): string {
    const guidField = raw.guid;
    const guid =
        guidField && typeof guidField === 'object'
            ? String((guidField as Record<string, unknown>)['#text'] ?? '')
            : String(guidField ?? '');
    return guid || String(raw.link ?? '');
}

async function fetchFeed(feed: (typeof AUDIT_FEEDS)[number]): Promise<FeedItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(feed.url, {
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        if (xml.includes('error code: 1015')) throw new Error('rate-limited (1015)');

        const parsed = rssParser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
        const rawItems = parsed.rss?.channel?.item;
        const list = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

        const out: FeedItem[] = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const it = raw as Record<string, unknown>;
            const title = stripSourcePrefix(String(it.title ?? '').trim());
            if (!title) continue;
            const pubDate = it.pubDate ? String(it.pubDate).trim() : null;
            const rawGuid = extractGuid(it);
            const stableId = rawGuid || createHash('sha256')
                .update(`${feed.sourceId}\n${feed.source}\n${pubDate || ''}\n${normalizeTitle(title)}`)
                .digest('hex');
            out.push({
                guid: `${feed.guidPrefix}${stableId}`.slice(0, 500),
                sourceId: feed.sourceId,
                title,
                source: feed.source,
                feedName: feed.name,
                pubDate,
                norm: normalizeTitle(title),
            });
        }
        return out;
    } finally {
        clearTimeout(timeout);
    }
}

/** Rule-required = the universal families say this item must be board-visible even if the
 *  classifier had labeled it IRRELEVANT/Low — identical recovery semantics to the pipeline. */
function ruleRecovery(title: string) {
    // Coverage repair is mechanical only. A missing row is re-ingested through the normal
    // durable AI classification job; this audit must not invent semantic decisions from text.
    void title;
    return {
        category: 'IRRELEVANT' as const,
        impact: 'Low' as const,
        assets: [],
        summary: '',
        catalystEligible: false,
    };
}

function feedItemMustShowOnBoard(title: string): boolean {
    return isBoardVisibleClassification(ruleRecovery(title));
}

/** On-board = locked principal (never a duplicate). */
function rowOnBoard(row: DbRow): boolean {
    return row.board_locked === true && !row.duplicate_of;
}

function findMatch(norm: string, dbRows: DbRow[]): DbRow | null {
    const exact = dbRows.filter((r) => normalizeTitle(r.headline) === norm);
    const locked = exact.find((r) => r.board_locked);
    if (locked) return locked;
    const nonDup = exact.find((r) => !r.duplicate_of);
    if (nonDup) return nonDup;
    if (exact[0]) return exact[0];
    const key = norm.slice(0, 48);
    const fuzzy = dbRows.filter((r) => {
        const n = normalizeTitle(r.headline);
        return n.startsWith(key) || key.startsWith(n.slice(0, 48)) || n.includes(key) || key.includes(n.slice(0, 40));
    });
    return fuzzy.find((r) => r.board_locked) ?? fuzzy.find((r) => !r.duplicate_of) ?? fuzzy[0] ?? null;
}

/** Doc §3: a duplicate row is "covered" when a LOCKED same-family principal reports the story. */
function coveredByVisiblePrincipal(item: FeedItem, dbRows: DbRow[]): boolean {
    const recovered = ruleRecovery(item.title);
    const tokens = item.norm.split(' ').filter((t) => t.length > 4).slice(0, 8);
    return dbRows.some((r) => {
        if (!rowOnBoard(r)) return false;
        if (recovered.category !== r.category) return false;
        const n = normalizeTitle(r.headline);
        const hits = tokens.filter((t) => n.includes(t)).length;
        return hits >= Math.min(3, tokens.length);
    });
}

async function loadDayRows(liveDay: string): Promise<DbRow[]> {
    const rows = await prisma.marketDriverNews.findMany({
        where: { day_key: liveDay, source: FFE_NEWS_SOURCE },
        select: {
            id: true,
            headline: true,
            category: true,
            impact: true,
            duplicate_of: true,
            board_locked: true,
            assets: true,
        },
    });
    return rows as DbRow[];
}

/**
 * Apply the rule-recovered classification and LOCK the row onto the board (an ADD).
 * Never call this on an already-locked row — locked rows are frozen for the UAE day.
 * `promote` also clears a duplicate link that hid a story no locked principal covers.
 */
async function healHiddenRow(row: DbRow, title: string, promote: boolean): Promise<void> {
    if (row.board_locked) return;
    const recovered = ruleRecovery(title);
    const willShow = isBoardVisibleClassification({
        category: recovered.category,
        impact: recovered.impact,
        assets: recovered.assets,
        duplicateOf: promote ? null : row.duplicate_of,
    });
    await prisma.marketDriverNews.update({
        where: { id: row.id },
        data: {
            category: recovered.category,
            impact: recovered.impact,
            assets: recovered.assets as unknown as object,
            summary: recovered.summary,
            classification_completed: true,
            coverage_repair_completed: true,
            semantic_dedup_completed: true,
            ...(promote ? { duplicate_of: null } : {}),
            // Lock only when the row is a true board principal (no duplicate_of).
            ...(willShow ? { board_locked: true } : {}),
        },
    });
}

function deferredCoverageAudit(reason: string): CoverageAuditResult {
    const liveDay = marketDayKey();
    const result: CoverageAuditResult = {
        ranAt: new Date().toISOString(),
        liveDay,
        feedsFetched: [],
        feedsFailed: [],
        uniqueLiveItems: 0,
        requiredByRules: 0,
        requiredOk: 0,
        healedMissing: 0,
        healedHidden: 0,
        residualGaps: [],
        systemVisible: 0,
        pass: true,
    };
    logger.warn(`[CoverageAudit] Skipped — ${reason}`);
    return result;
}

export async function runMarketDriverCoverageAudit(
    options: { force?: boolean; now?: Date; ingestId?: string } = {},
): Promise<CoverageAuditResult> {
    // Concurrent calls (cron tick + admin ?run=1) share one run.
    if (auditInFlight) return auditInFlight;
    auditInFlight = (async () => {
        try {
            if (!options.force) {
                if (isMarketDriverIngestRunning()) {
                    return deferredCoverageAudit('market-driver ingest still classifying');
                }
                const idleMs = getMarketDriverIngestIdleMs();
                if (idleMs == null) {
                    return deferredCoverageAudit(
                        'no ingest finished yet this process (boot / pre-RSS guard)',
                    );
                }
                if (idleMs < COVERAGE_AUDIT_COOLDOWN_MS) {
                    const leftSec = Math.ceil((COVERAGE_AUDIT_COOLDOWN_MS - idleMs) / 1000);
                    return deferredCoverageAudit(
                        `only ${Math.round(idleMs / 1000)}s since last ingest (need ${COVERAGE_AUDIT_COOLDOWN_MS / 1000}s, ${leftSec}s left)`,
                    );
                }
            }
            return await runAuditOnce(options.now ?? new Date(), options.ingestId);
        } finally {
            auditInFlight = null;
        }
    })();
    return auditInFlight;
}

async function runAuditOnce(now: Date, ingestId?: string): Promise<CoverageAuditResult> {
    const liveDay = marketDayKey(now);
    const ranAt = now.toISOString();

    const feedsFetched: string[] = [];
    const feedsFailed: string[] = [];
    const all: FeedItem[] = [];
    for (const feed of AUDIT_FEEDS) {
        try {
            const items = await fetchFeed(feed);
            feedsFetched.push(feed.name);
            all.push(...items);
        } catch (error) {
            feedsFailed.push(feed.name);
            logger.warn(`[CoverageAudit] Feed ${feed.name} failed: ${(error as Error).message}`);
        }
    }

    // The authoritative feed is already source-scoped; normalize duplicate titles within it.
    const byNorm = new Map<string, FeedItem>();
    for (const it of all) {
        if (!byNorm.has(it.norm)) byNorm.set(it.norm, it);
    }
    const live = [...byNorm.values()].filter((i) => {
        if (!i.pubDate) return false;
        const d = new Date(i.pubDate);
        return !Number.isNaN(d.getTime()) && marketDayKey(d) === liveDay;
    });
    // Every current feed identity is checked for durable coverage. Whether it is a Catalyst,
    // Macro item, or irrelevant is decided by the AI classifier; this audit does not pre-filter by
    // headline semantics.
    const required = live;

    let dbRows = await loadDayRows(liveDay);

    type Assessment = { item: FeedItem; status: 'OK' | 'MISSING' | 'HIDDEN'; row: DbRow | null };
    const assess = (rows: DbRow[]): Assessment[] =>
        required.map((item) => {
            const row = findMatch(item.norm, rows);
            if (!row) return { item, status: 'MISSING' as const, row: null };
            // Already on News Headline for the day — never treat as a gap / never re-heal.
            if (rowOnBoard(row)) return { item, status: 'OK' as const, row };
            if (row.duplicate_of && coveredByVisiblePrincipal(item, rows)) {
                return { item, status: 'OK' as const, row };
            }
            // Rule says it must show, but it is not locked yet → heal can ADD/lock it.
            if (!rowOnBoard(row)) return { item, status: 'HIDDEN' as const, row };
            return { item, status: 'OK' as const, row };
        });

    // ── Detect ─────────────────────────────────────────────────────────────
    let assessments = assess(dbRows);
    const missing = assessments.filter((a) => a.status === 'MISSING');
    const hidden = assessments.filter((a) => a.status === 'HIDDEN');

    // ── Heal ───────────────────────────────────────────────────────────────
    let healedMissing = 0;
    let healedHidden = 0;

    if (missing.length > 0) {
        logger.warn(`[CoverageAudit] ${missing.length} rule-required item(s) missing — ingesting through pipeline`);
        const raw = missing.map((a) => ({
            guid: a.item.guid,
            sourceId: a.item.sourceId,
            title: a.item.title,
            source: a.item.source,
            pubDate: a.item.pubDate,
        }));
        try {
            const result = await ingestMarketDriverRssItems(raw, { operationType: 'coverage_repair', now, ingestId });
            healedMissing = result.stored;
        } catch (error) {
            logger.error(`[CoverageAudit] Heal-ingest failed: ${(error as Error).message}`);
        }
    }

    // Existing hidden rows are not rewritten by the audit. An explicit AI reprocess action is
    // required to change a completed decision; restart/coverage ticks must remain read-only.

    // ── Re-verify ──────────────────────────────────────────────────────────
    if (missing.length > 0 || hidden.length > 0) {
        dbRows = await loadDayRows(liveDay);
        assessments = assess(dbRows);
    }

    // Geo AI is bounded and cache-keyed by the unique AI causal-theme set. It is invoked from the
    // ingest/audit path only; Daily Market View reads the cache and never triggers an AI call.
    try {
        await evaluateAndCacheGeopoliticalRisk(liveDay, { ingestId });
    } catch (error) {
        logger.warn(`[CoverageAudit] Geo AI evaluation deferred: ${(error as Error).message}`);
    }

    const residualGaps: CoverageGap[] = assessments
        .filter((a) => a.status !== 'OK')
        .map((a) => ({
            kind: a.status as 'MISSING' | 'HIDDEN',
            source: a.item.feedName,
            headline: a.item.title,
            detail: a.row ? `${a.row.category}/${a.row.impact}${a.row.duplicate_of ? '/duplicate' : ''}` : 'not stored',
        }));

    const result: CoverageAuditResult = {
        ranAt,
        liveDay,
        feedsFetched,
        feedsFailed,
        uniqueLiveItems: live.length,
        requiredByRules: required.length,
        requiredOk: required.length - residualGaps.length,
        healedMissing,
        healedHidden,
        residualGaps,
        systemVisible: dbRows.filter(rowOnBoard).length,
        pass: residualGaps.length === 0,
    };
    lastAudit = result;

    if (result.pass) {
        logger.info(
            `[CoverageAudit] PASS ${liveDay}: ${result.requiredOk}/${result.requiredByRules} required visible` +
                (healedMissing + healedHidden > 0 ? ` (auto-healed ${healedMissing} missing, ${healedHidden} hidden)` : ''),
        );
    } else {
        logger.error(
            `[CoverageAudit] FAIL ${liveDay}: ${result.residualGaps.length} gap(s) survived auto-heal — ` +
                result.residualGaps.map((g) => `${g.kind}: ${g.headline.slice(0, 70)}`).join(' | '),
        );
    }

    return result;
}
