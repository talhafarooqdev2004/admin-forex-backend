import { logger } from '../utils/logger.util.js';
import {
    MARKET_BUSINESS_TIMEZONE,
    marketBusinessDayKey,
    previousMarketBusinessDayKey,
} from '../utils/marketBusinessDay.util.js';
import { runUaeMidnightArchive } from './marketDriverBoard.service.js';

export type MarketDriverRolloverTrigger = 'startup' | 'scheduled' | 'catchup' | 'verification';

export type MarketDriverRolloverResult = {
    success: boolean;
    trigger: MarketDriverRolloverTrigger;
    liveDay: string;
    previousDay: string;
    archivesCreatedOrRefreshed: number;
    durationMs: number;
    error: string | null;
};

/**
 * Observable, retry-safe rollover coordinator. The live board switches by business-day query,
 * independently of archive success; startup and :15 catch-up ticks retry any failed/stale snapshot.
 */
export async function runMarketDriverRollover(
    trigger: MarketDriverRolloverTrigger,
    now: Date = new Date(),
    archive: (at: Date) => Promise<number> = runUaeMidnightArchive,
): Promise<MarketDriverRolloverResult> {
    const startedAtMs = Date.now();
    const liveDay = marketBusinessDayKey(now);
    const previousDay = previousMarketBusinessDayKey(now);
    logger.info('[MarketDriverRollover] started', {
        event: 'market_driver_rollover_started',
        trigger,
        timezone: MARKET_BUSINESS_TIMEZONE,
        liveDay,
        previousDay,
    });

    try {
        const archivesCreatedOrRefreshed = await archive(now);
        const result: MarketDriverRolloverResult = {
            success: true,
            trigger,
            liveDay,
            previousDay,
            archivesCreatedOrRefreshed,
            durationMs: Date.now() - startedAtMs,
            error: null,
        };
        logger.info('[MarketDriverRollover] completed', {
            event: 'market_driver_rollover_completed',
            timezone: MARKET_BUSINESS_TIMEZONE,
            ...result,
        });
        return result;
    } catch (error) {
        const result: MarketDriverRolloverResult = {
            success: false,
            trigger,
            liveDay,
            previousDay,
            archivesCreatedOrRefreshed: 0,
            durationMs: Date.now() - startedAtMs,
            error: error instanceof Error ? error.message : String(error),
        };
        logger.error('[MarketDriverRollover] failed', {
            event: 'market_driver_rollover_failed',
            timezone: MARKET_BUSINESS_TIMEZONE,
            ...result,
        });
        return result;
    }
}
