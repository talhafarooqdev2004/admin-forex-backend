import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { centralBankPoliciesSyncService } from '../../../services/centralBankPoliciesSync.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

export const syncCentralBankPoliciesFromSheet = async (req, res, next) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const sheetName = String(req.body?.sheetName || 'Fundamentals New').trim();
        const range = String(req.body?.range || 'A179:E187').trim();
        const identifier = String(req.body?.identifier || 'central_bank_policies').trim();
        const tableName = String(req.body?.tableName || 'Central Bank Policies').trim();

        const result = await centralBankPoliciesSyncService.syncFromSheet({
            sheetName,
            range,
            identifier,
            tableName,
        });

        websocketService.emitTableUpdate(identifier);

        logger.info(`[CentralBankPoliciesWebhook] Synced ${result.rowsSynced} rows from ${sheetName}!${range}`);

        res.status(HTTP_STATUS.OK).json(successResponse('Central bank policies synced successfully', result));
    }
    catch (error) {
        next(error);
    }
};
