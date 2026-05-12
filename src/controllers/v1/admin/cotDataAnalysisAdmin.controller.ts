import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { cotDataAnalysisSheetSyncService } from '../../../services/cotDataAnalysisSheetSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const COT_TABLE_IDS = ['currency_pair_sentiment', 'cot_sentiment_net_score', 'cot_raw_data'] as const;

export const syncCotDataAnalysisFromSheets = async (_req, res, next) => {
    try {
        const result = await cotDataAnalysisSheetSyncService.syncAllFromSheets();

        for (const id of COT_TABLE_IDS) {
            websocketService.emitTableUpdate(id);
        }

        logger.info('[CotDataAnalysisAdmin] COT sheet → DB sync completed');

        res.status(HTTP_STATUS.OK).json(successResponse('COT Data & Analysis tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
