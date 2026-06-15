import http from 'http';
import app from './src/app.js';
import { ENV, getAllowedOrigins } from './src/config/env.js';
import { logger } from './src/utils/logger.util.js';
import { connectDB } from './src/lib/prisma.js';
import { websocketService } from './src/services/websocket.service.js';
import { googleSheetsService } from './src/services/googleSheets.service.js';
import { cronService } from './src/services/cron.service.js';
import { scoreDashboardSheetSyncService } from './src/services/scoreDashboardSheetSync.service.js';
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

httpServer.listen(PORT, async () => {
    logger.info(`Forex Dashboard Backend running on port ${PORT} in ${ENV.NODE_ENV} mode`);

    void runScoreDashboardSheetSyncJob();

    void requeuePendingVisitorGeoJobs().catch((e) =>
        logger.error('[VisitorGeo] Failed to re-queue pending jobs', e),
    );
    startVisitorGeoWorker();
    startTradeAlertEvaluator();

    cronService.startJob('scoreDashboardSheetSync', '* * * * *', async () => {
        await runScoreDashboardSheetSyncJob();
    });
});
