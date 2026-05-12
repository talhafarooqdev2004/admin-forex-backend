import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { edgeToolsSheetSyncService } from '../../../services/edgeToolsSheetSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const EDGE_TABLE_IDS = [
    'edge_currency_strength_index',
    'edge_forex_pair_analysis',
    'edge_technical_dashboard',
] as const;

export const syncEdgeToolsFromSheets = async (_req, res, next) => {
    try {
        const result = await edgeToolsSheetSyncService.syncAllFromSheets();

        for (const id of EDGE_TABLE_IDS) {
            websocketService.emitTableUpdate(id);
        }

        logger.info('[EdgeToolsAdmin] Edge Tools sheet → DB sync completed');

        res.status(HTTP_STATUS.OK).json(successResponse('Edge Tools tables synced from Google Sheets', result));
    }
    catch (error) {
        next(error);
    }
};
