import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { syncAccumulatedFinancialJuiceFeed as persistAccumulatedFinancialJuiceFeed } from '../../../services/accumulatedRssFeed.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

/**
 * Receives accumulated FinancialJuice RSS data from forex-scraping and persists it
 * for GET /api/feeds/financialjuice/accumulated.
 */
export const ingestAccumulatedFinancialJuiceFeed = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const businessDay = String(req.body?.business_day || '').trim();
        if (!businessDay) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'business_day is required');
        }

        const items = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!items) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'items array is required');
        }

        const result = persistAccumulatedFinancialJuiceFeed({
            business_day: businessDay,
            count: Number(req.body?.count),
            earliest_timestamp: req.body?.earliest_timestamp ?? null,
            latest_timestamp: req.body?.latest_timestamp ?? null,
            financialjuice_count: Number(req.body?.financialjuice_count),
            fxstreet_count: Number(req.body?.fxstreet_count),
            items,
        });

        logger.info(
            `[AccumulatedRssWebhook] Synced day=${result.business_day} count=${result.count} added=${result.added}`,
        );

        res.status(HTTP_STATUS.OK).json(
            successResponse('Accumulated FinancialJuice feed synced successfully', result),
        );
    } catch (error) {
        next(error);
    }
};
