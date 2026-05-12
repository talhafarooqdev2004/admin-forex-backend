import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { fxAnalyzerTechnicalSyncService } from '../../../services/fxAnalyzerTechnicalSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

/** Authenticated sync (any valid JWT). Used by Next.js FX Analyzer page load with `forex_jwt`. */
export const syncFxAnalyzerTechnicalFromSheets = async (_req, res, next) => {
    try {
        const result = await fxAnalyzerTechnicalSyncService.syncBothFromSheets();

        websocketService.emitTableUpdate(result.trends.identifier);
        websocketService.emitTableUpdate(result.levels.identifier);

        logger.info(
            `[FxAnalyzerTechnicalAdmin] Synced trends=${result.trends.rowsSynced} levels=${result.levels.rowsSynced}`,
        );

        res.status(HTTP_STATUS.OK).json(successResponse('FX Analyzer technical tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
