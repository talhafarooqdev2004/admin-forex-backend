import http from 'http';
import app from './src/app.js';
import { ENV, getAllowedOrigins } from './src/config/env.js';
import { logger } from './src/utils/logger.util.js';
import { connectDB } from './src/lib/prisma.js';
import { websocketService } from './src/services/websocket.service.js';
import { googleSheetsService } from './src/services/googleSheets.service.js';
import { cronService } from './src/services/cron.service.js';
import { scoreDashboardSheetSyncService } from './src/services/scoreDashboardSheetSync.service.js';
import { resumeIncompleteMarketDriverSemanticDedup } from './src/services/marketDriverBoard.service.js';
import { runMarketDriverCoverageAudit } from './src/services/marketDriverCoverageAudit.service.js';
import { requeuePendingVisitorGeoJobs } from './src/services/visitorGeo.service.js';
import { startVisitorGeoWorker } from './src/workers/visitorGeo.worker.js';
import { startTradeAlertEvaluator } from './src/workers/tradeAlertEvaluator.worker.js';
import { startAiClassificationQueueWorker } from './src/services/aiClassificationQueue.service.js';
import {
    MARKET_BUSINESS_TIMEZONE,
} from './src/utils/marketBusinessDay.util.js';
import { runMarketDriverRollover } from './src/services/marketDriverRollover.service.js';

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
async function runUaeMidnightArchiveTick(trigger: 'startup' | 'scheduled' | 'catchup' = 'scheduled') {
    const result = await runMarketDriverRollover(trigger);
    if (result.success && result.archivesCreatedOrRefreshed > 0) {
        websocketService.emitCalendarNewsUpdate('uae-day-archive');
    }
}

/**
 * Self-healing News Headline coverage audit: compares the live FinancialJuice feed against today's
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

/**
 * A crashed semantic-dedup lease may still be fresh during the first startup check. Recheck it
 * periodically so it becomes recoverable after the lease timeout without reprocessing rows whose
 * durable semantic_dedup_completed checkpoint is already true.
 */
async function runSemanticDedupRecoveryTick() {
    try {
        await resumeIncompleteMarketDriverSemanticDedup();
    } catch (error) {
        logger.error(`[MarketDriver] Failed to resume unfinished semantic-dedup checkpoints: ${error instanceof Error ? error.message : error}`);
    }
}

httpServer.listen(PORT, async () => {
    logger.info(`Forex Dashboard Backend running on port ${PORT} in ${ENV.NODE_ENV} mode`);

    void runScoreDashboardSheetSyncJob();
    void runUaeMidnightArchiveTick('startup');

    void requeuePendingVisitorGeoJobs().catch((e) =>
        logger.error('[VisitorGeo] Failed to re-queue pending jobs', e),
    );
    startVisitorGeoWorker();
    startTradeAlertEvaluator();
    startAiClassificationQueueWorker();
    void runSemanticDedupRecoveryTick();

    cronService.startJob('scoreDashboardSheetSync', '* * * * *', async () => {
        await runScoreDashboardSheetSyncJob();
    });

    cronService.startJob(
        'marketDriverUaeDayArchive',
        '0 1 * * *',
        async () => {
            await runUaeMidnightArchiveTick('scheduled');
        },
        { timezone: MARKET_BUSINESS_TIMEZONE },
    );
    cronService.startJob(
        'marketDriverUaeArchiveCatchup',
        '15 * * * *',
        async () => {
            await runUaeMidnightArchiveTick('catchup');
        },
        { timezone: MARKET_BUSINESS_TIMEZONE },
    );

    // :07 / :37 — between */10 RSS ticks. Still guarded: skips while classify runs + 2m cooldown.
    cronService.startJob('marketDriverCoverageAudit', '7,37 * * * *', async () => {
        await runCoverageAuditTick();
    });
    cronService.startJob('marketDriverSemanticDedupRecovery', '* * * * *', async () => {
        await runSemanticDedupRecoveryTick();
    });
});
