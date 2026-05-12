import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { scoreDashboardSheetSyncService } from '../../../services/scoreDashboardSheetSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

export const syncScoreDashboardFromSheet = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const sheetName = String(req.body?.sheetName || ENV.SCORE_DASHBOARD_SHEET_NAME || 'Sheet76').trim();
        const range = String(req.body?.range || ENV.SCORE_DASHBOARD_SHEET_RANGE || 'A2:J30').trim();
        const identifier = String(req.body?.identifier || 'score_dashboard_sheet76').trim();
        const tableName = String(req.body?.tableName || 'Score Dashboard (Sheet76)').trim();

        const result = await scoreDashboardSheetSyncService.syncFromSheet({
            sheetName,
            range,
            identifier,
            tableName,
        });

        websocketService.emitScoreDashboardSnapshot(result.table);
        websocketService.emitTableUpdate(identifier);

        logger.info(`[ScoreDashboardWebhook] Synced ${result.rowsSynced} rows from ${sheetName}!${range}`);

        res.status(HTTP_STATUS.OK).json(successResponse('Score dashboard synced successfully', result));
    } catch (error) {
        next(error);
    }
};
