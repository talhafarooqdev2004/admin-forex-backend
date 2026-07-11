import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { ingestMarketDriverRssItems } from '../../../services/marketDriverBoard.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

/**
 * Receives raw FinancialJuice RSS items from forex-scraping.
 * Dedup / Groq classify / Prisma store remain on this backend.
 */
export const ingestMarketDriverRss = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const items = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!items) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'items array is required');
        }

        const result = await ingestMarketDriverRssItems(items);
        if (result.changed) {
            websocketService.emitCalendarNewsUpdate('market-driver');
        }

        logger.info(
            `[MarketDriverWebhook] Ingested RSS batch: received=${result.received} fresh=${result.fresh} stored=${result.stored} changed=${result.changed}`,
        );

        res.status(HTTP_STATUS.OK).json(successResponse('Market driver RSS ingested successfully', result));
    } catch (error) {
        next(error);
    }
};
