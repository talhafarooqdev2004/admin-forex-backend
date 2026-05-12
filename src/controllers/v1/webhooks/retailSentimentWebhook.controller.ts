import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { retailSentimentSyncService } from '../../../services/retailSentimentSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

export const syncRetailSentiment = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const sheetName = String(req.body?.sheetName || ENV.RETAIL_SENTIMENT_SHEET_NAME || 'RETAIL SENTIMENTS 7').trim();
        const range = String(req.body?.range || ENV.RETAIL_SENTIMENT_SHEET_RANGE || 'A4:D31').trim();
        const identifier = String(req.body?.identifier || 'retail_sentiment_currency_pairs').trim();
        const tableName = String(req.body?.tableName || 'Retail Sentiment Currency Pairs').trim();

        const result = await retailSentimentSyncService.syncFromSheet({
            sheetName,
            range,
            identifier,
            tableName,
        });

        websocketService.emitRetailSentimentSnapshot(result.table);
        websocketService.emitTableUpdate(identifier);

        logger.info(`[RetailSentimentWebhook] Synced ${result.rowsSynced} rows from ${sheetName}!${range}`);

        res.status(HTTP_STATUS.OK).json(successResponse('Retail sentiment synced successfully', result));
    }
    catch (error) {
        next(error);
    }
};
