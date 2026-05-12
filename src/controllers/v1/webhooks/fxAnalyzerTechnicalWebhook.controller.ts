import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { fxAnalyzerTechnicalSyncService } from '../../../services/fxAnalyzerTechnicalSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

export const syncFxAnalyzerTechnicalFromSheets = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const result = await fxAnalyzerTechnicalSyncService.syncBothFromSheets();

        websocketService.emitTableUpdate(result.trends.identifier);
        websocketService.emitTableUpdate(result.levels.identifier);

        logger.info(
            `[FxAnalyzerTechnicalWebhook] Synced trends=${result.trends.rowsSynced} levels=${result.levels.rowsSynced}`,
        );

        res.status(HTTP_STATUS.OK).json(successResponse('FX Analyzer technical tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
