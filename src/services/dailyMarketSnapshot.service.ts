import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { RiskModeScoreRepository } from '../repositories/riskModeScore.repository.js';
import { getEconomicCalendarSnapshot, type EconomicCalendarEvent } from './economicCalendarScrape.service.js';
import { getGeopoliticalRiskWatch } from './geopoliticalRisk.service.js';
import { getCatalystBoard, marketDayKey, type CatalystBoardRow } from './marketDriverBoard.service.js';
import { googleSheetsService } from './googleSheets.service.js';

const riskModeScoreRepository = new RiskModeScoreRepository();

async function readRiskModeScore(riskModeRow: unknown): Promise<number> {
    // The scraper is the source of truth for this value and writes the shared sheet.
    // Keep the database value as a restart/offline fallback for a read-only snapshot.
    try {
        const sheetValue = await googleSheetsService.getCell('RISK ON/OFF 12', 'B13');
        const parsed = Number(String(sheetValue ?? '').replace(/[^0-9.+-]/g, ''));
        if (Number.isFinite(parsed)) return Math.max(-100, Math.min(100, parsed));
    } catch {
        // Credentials/network may be unavailable locally; use the persisted API value below.
    }
    const record = (riskModeRow ?? {}) as Record<string, unknown>;
    const fallback = Number(record.score ?? 0);
    return Number.isFinite(fallback) ? Math.max(-100, Math.min(100, fallback)) : 0;
}

export type DailyMarketSnapshot = {
    snapshotId: string;
    version: string;
    asOf: string;
    dayKey: string;
    calendar: { data: EconomicCalendarEvent[]; scrapedAt: string | null };
    catalystBoard: CatalystBoardRow[];
    geopoliticalRisk: Awaited<ReturnType<typeof getGeopoliticalRiskWatch>>;
    riskMode: { score: number; updatedAt: string | null };
    sources: {
        calendar: string;
        catalyst: string;
        geopoliticalRisk: string;
        riskMode: string;
    };
};

function stableSnapshotId(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Read-only orchestration point for Daily Market View. All cards in a refresh use this
 * response, rather than independently fetching calendar, catalyst, geo and risk sources.
 * It intentionally performs no scrape, AI call, coverage repair, or other mutation.
 */
export async function getDailyMarketSnapshot(dayKey: string = marketDayKey()): Promise<DailyMarketSnapshot> {
    const [calendarSnapshot, catalystBoard, geopoliticalRisk, riskModeRow, latestCatalyst, latestGeo] = await Promise.all([
        Promise.resolve(getEconomicCalendarSnapshot()),
        getCatalystBoard(dayKey),
        getGeopoliticalRiskWatch(dayKey),
        riskModeScoreRepository.getCurrent(),
        prisma.marketDriverNews.findFirst({
            where: { day_key: dayKey, board_locked: true, duplicate_of: null },
            orderBy: { created_at: 'desc' },
            select: { created_at: true },
        }),
        prisma.marketDriverNews.findFirst({
            where: { day_key: dayKey, category: 'GEOPOLITICAL', duplicate_of: null },
            orderBy: { created_at: 'desc' },
            select: { created_at: true },
        }),
    ]);

    const riskRecord = (riskModeRow ?? {}) as Record<string, unknown>;
    const riskScore = await readRiskModeScore(riskModeRow);
    const calendarData = calendarSnapshot?.data ?? [];
    const sourceTimes = {
        calendar: calendarSnapshot?.scrapedAt ? new Date(calendarSnapshot.scrapedAt).toISOString() : '',
        catalyst: latestCatalyst?.created_at?.toISOString() ?? '',
        geopoliticalRisk: latestGeo?.created_at?.toISOString() ?? '',
        riskMode: riskRecord.updated_at ? new Date(String(riskRecord.updated_at)).toISOString() : '',
    };
    const version = {
        dayKey,
        calendar: { data: calendarData, scrapedAt: calendarSnapshot?.scrapedAt ?? null },
        catalystBoard,
        geopoliticalRisk,
        riskMode: { score: riskScore, updatedAt: sourceTimes.riskMode },
    };
    const snapshotId = stableSnapshotId(version);

    return {
        snapshotId,
        version: snapshotId,
        asOf: new Date().toISOString(),
        dayKey,
        calendar: { data: calendarData, scrapedAt: sourceTimes.calendar || null },
        catalystBoard,
        geopoliticalRisk,
        riskMode: { score: riskScore, updatedAt: sourceTimes.riskMode || null },
        sources: {
            calendar: sourceTimes.calendar || 'not_available',
            catalyst: sourceTimes.catalyst || 'not_available',
            geopoliticalRisk: sourceTimes.geopoliticalRisk || 'not_available',
            riskMode: sourceTimes.riskMode || 'not_available',
        },
    };
}
