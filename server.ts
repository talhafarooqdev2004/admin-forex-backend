import http from 'http';
import app from './src/app.js';
import { ENV, getAllowedOrigins } from './src/config/env.js';
import { logger } from './src/utils/logger.util.js';
import { connectDB } from './src/lib/prisma.js';
import { websocketService } from './src/services/websocket.service.js';
import { googleSheetsService } from './src/services/googleSheets.service.js';
import { cronService } from './src/services/cron.service.js';
import { scoreDashboardSheetSyncService } from './src/services/scoreDashboardSheetSync.service.js';
import { runUaeMidnightArchive } from './src/services/marketDriverBoard.service.js';
import { runMarketDriverCoverageAudit } from './src/services/marketDriverCoverageAudit.service.js';
import { requeuePendingVisitorGeoJobs } from './src/services/visitorGeo.service.js';
import { startVisitorGeoWorker } from './src/workers/visitorGeo.worker.js';
import { startTradeAlertEvaluator } from './src/workers/tradeAlertEvaluator.worker.js';

const PORT = ENV.PORT || 5005;

const httpServer = http.createServer(app);

websocketService.initialize(httpServer, {
    origin: getAllowedOrigins(),
});

await connectDB();

async function runScoreDashboardSheetSyncJob() {
    try {
        await googleSheetsService.ensureInitialized();
        const result = await scoreDashboardSheetSyncService.syncFromSheet();
        websocketService.emitScoreDashboardSnapshot(result.table);
        websocketService.emitTableUpdate(result.identifier);
    } catch (error) {
        logger.error(`[ScoreDashboardCron] Sync failed: ${error instanceof Error ? error.message : error}`);
    }
}

/**
 * UAE market-day reset (01:00 Asia/Dubai): finalize completed days into Historical Analysis.
 * Live boards clear automatically — they only query today's `day_key`. Headlines stay in DB.
 * (RSS fetch + economic calendar scrape live in forex-scraping and notify via webhooks.)
 */
async function runUaeMidnightArchiveTick() {
    try {
        const archived = await runUaeMidnightArchive();
        if (archived > 0) {
            websocketService.emitCalendarNewsUpdate('uae-day-archive');
            logger.info(`[MarketDriverCron] UAE 01:00 archive finalized ${archived} day(s)`);
        }
    } catch (error) {
        logger.error(`[MarketDriverCron] UAE archive failed: ${error instanceof Error ? error.message : error}`);
    }
}

/**
 * Self-healing News Headline coverage audit: compares live FJ/FXStreet feeds against today's
 * board and auto-fixes any rule-required item that is missing or hidden (misclassified /
 * wrongly deduped). Replaces the manual daily feed-vs-board check entirely; a FAIL in the
 * logs (or GET /admin/market-driver-news/coverage) is the only signal that needs a human.
 */
async function runCoverageAuditTick() {
    try {
        const result = await runMarketDriverCoverageAudit();
        if (result.healedMissing + result.healedHidden > 0) {
            websocketService.emitCalendarNewsUpdate('coverage-audit-heal');
        }
    } catch (error) {
        logger.error(`[CoverageAudit] Audit tick failed: ${error instanceof Error ? error.message : error}`);
    }
}

httpServer.listen(PORT, async () => {
    logger.info(`Forex Dashboard Backend running on port ${PORT} in ${ENV.NODE_ENV} mode`);

    void runScoreDashboardSheetSyncJob();
    void runUaeMidnightArchiveTick();

    void requeuePendingVisitorGeoJobs().catch((e) =>
        logger.error('[VisitorGeo] Failed to re-queue pending jobs', e),
    );
    startVisitorGeoWorker();
    startTradeAlertEvaluator();

    cronService.startJob('scoreDashboardSheetSync', '* * * * *', async () => {
        await runScoreDashboardSheetSyncJob();
    });

    cronService.startJob(
        'marketDriverUaeDayArchive',
        '0 1 * * *',
        async () => {
            await runUaeMidnightArchiveTick();
        },
        { timezone: 'Asia/Dubai' },
    );
    cronService.startJob(
        'marketDriverUaeArchiveCatchup',
        '15 * * * *',
        async () => {
            await runUaeMidnightArchiveTick();
        },
        { timezone: 'Asia/Dubai' },
    );

    // Offset from the :00/:10/... RSS ingest and the :15 archive catchup so feed hits spread out.
    cronService.startJob('marketDriverCoverageAudit', '7,37 * * * *', async () => {
        await runCoverageAuditTick();
    });
    // Boot-time audit, slightly delayed so the first webhook ingest (if due) lands first.
    setTimeout(() => {
        void runCoverageAuditTick();
    }, 45000);
});
