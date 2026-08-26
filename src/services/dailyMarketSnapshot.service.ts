import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { RiskModeScoreRepository } from '../repositories/riskModeScore.repository.js';
import { getEconomicCalendarSnapshot, type EconomicCalendarEvent } from './economicCalendarScrape.service.js';
import { getGeopoliticalRiskWatch } from './geopoliticalRisk.service.js';
import { getCatalystBoard, marketDayKey, type CatalystBoardRow } from './marketDriverBoard.service.js';
import { googleSheetsService } from './googleSheets.service.js';
import {
    resolveRiskModeContract,
    type RiskModeContract,
} from './riskModeContract.js';

const riskModeScoreRepository = new RiskModeScoreRepository();

async function readRiskMode(riskModeRow: unknown): Promise<RiskModeContract> {
    // The scraper is the source of truth for this value and writes the shared sheet.
    // Keep the database value as a restart/offline fallback for a read-only snapshot.
    let sheetValue: unknown = null;
    try {
        sheetValue = await googleSheetsService.getCell('RISK ON/OFF 12', 'B13');
    } catch {
        // Credentials/network may be unavailable locally; use the persisted API value below.
    }
    return resolveRiskModeContract(sheetValue, riskModeRow);
}

export type DailyMarketSnapshot = {
    snapshotId: string;
    version: string;
    asOf: string;
    dayKey: string;
    calendar: { data: EconomicCalendarEvent[]; scrapedAt: string | null };
    catalystBoard: CatalystBoardRow[];
    geopoliticalRisk: Awaited<ReturnType<typeof getGeopoliticalRiskWatch>>;
    riskMode: RiskModeContract;
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
    const [calendarSnapshot, catalystBoard, geopoliticalRisk, riskModeRow, latestGptFirst] = await Promise.all([
        Promise.resolve(getEconomicCalendarSnapshot()),
        getCatalystBoard(dayKey),
        getGeopoliticalRiskWatch(dayKey),
        riskModeScoreRepository.getCurrent(),
        prisma.marketDriverSessionSnapshot.findFirst({
            where: { day_key: dayKey, source: 'gpt_first', status: 'VALID' },
            orderBy: { version: 'desc' },
            select: { created_at: true },
        }),
    ]);

    const riskMode = await readRiskMode(riskModeRow);
    const calendarData = calendarSnapshot?.data ?? [];
    const gptFirstAt = latestGptFirst?.created_at?.toISOString() ?? '';
    const sourceTimes = {
        calendar: calendarSnapshot?.scrapedAt ? new Date(calendarSnapshot.scrapedAt).toISOString() : '',
        catalyst: gptFirstAt,
        geopoliticalRisk: gptFirstAt || geopoliticalRisk.asOf || '',
        riskMode: riskMode.asOf ?? '',
    };
    const version = {
        dayKey,
        calendar: { data: calendarData, scrapedAt: calendarSnapshot?.scrapedAt ?? null },
        catalystBoard,
        geopoliticalRisk,
        riskMode,
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
        riskMode: {
            ...riskMode,
            updatedAt: sourceTimes.riskMode || riskMode.updatedAt || null,
            asOf: sourceTimes.riskMode || riskMode.asOf || null,
        },
        sources: {
            calendar: sourceTimes.calendar || 'not_available',
            catalyst: sourceTimes.catalyst || 'not_available',
            geopoliticalRisk: sourceTimes.geopoliticalRisk || 'not_available',
            riskMode: riskMode.source,
        },
    };
}
