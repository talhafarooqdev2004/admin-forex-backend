import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { cotDataAnalysisSheetSyncService } from '../../../services/cotDataAnalysisSheetSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

const COT_TABLE_IDS = ['currency_pair_sentiment', 'cot_sentiment_net_score', 'cot_raw_data'] as const;

export const syncCotDataAnalysisFromSheetsWebhook = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const result = await cotDataAnalysisSheetSyncService.syncAllFromSheets();

        for (const id of COT_TABLE_IDS) {
            websocketService.emitTableUpdate(id);
        }

        logger.info('[CotDataAnalysisWebhook] COT sheet → DB sync completed');

        res.status(HTTP_STATUS.OK).json(successResponse('COT Data & Analysis tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
