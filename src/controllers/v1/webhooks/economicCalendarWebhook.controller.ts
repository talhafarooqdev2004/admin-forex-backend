import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { applyEconomicCalendarSnapshot } from '../../../services/economicCalendarScrape.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

/**
 * Receives a full economic-calendar event list from forex-scraping and stores it
 * as the live in-memory snapshot for GET /api/v1/public/economic-calendar.
 */
export const ingestEconomicCalendar = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const events = Array.isArray(req.body?.events) ? req.body.events : null;
        if (!events) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'events array is required');
        }

        const scrapedAtRaw = Number(req.body?.scrapedAt);
        const scrapedAt = Number.isFinite(scrapedAtRaw) ? scrapedAtRaw : Date.now();
        const data = applyEconomicCalendarSnapshot(events, scrapedAt);

        websocketService.emitCalendarNewsUpdate('economic-calendar');
        logger.info(`[EconomicCalendarWebhook] Ingested ${data.length} event(s)`);

        res.status(HTTP_STATUS.OK).json(
            successResponse('Economic calendar ingested successfully', {
                count: data.length,
                scrapedAt,
            }),
        );
    } catch (error) {
        next(error);
    }
};
