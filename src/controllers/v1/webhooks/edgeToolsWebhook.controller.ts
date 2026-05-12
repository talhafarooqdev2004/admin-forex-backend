import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { edgeToolsSheetSyncService } from '../../../services/edgeToolsSheetSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

const EDGE_TABLE_IDS = [
    'edge_currency_strength_index',
    'edge_forex_pair_analysis',
    'edge_technical_dashboard',
] as const;

export const syncEdgeToolsFromSheetsWebhook = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const result = await edgeToolsSheetSyncService.syncAllFromSheets();

        for (const id of EDGE_TABLE_IDS) {
            websocketService.emitTableUpdate(id);
        }

        logger.info('[EdgeToolsWebhook] Edge Tools sheet → DB sync completed');

        res.status(HTTP_STATUS.OK).json(successResponse('Edge Tools tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
