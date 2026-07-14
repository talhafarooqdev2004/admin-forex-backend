import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import { ingestMarketDriverRssItems } from '../../../services/marketDriverBoard.service.js';
import { websocketService } from '../../../services/websocket.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

/** Prevent overlapping full-feed classify runs (200+ headlines can take minutes). */
let ingestInFlight: Promise<void> | null = null;

/**
 * Receives raw FinancialJuice + FXStreet RSS items from forex-scraping.
 * Accepts the full feed immediately, then classifies ALL fresh items in the background
 * (Groq batches) so HTTP timeouts never truncate a large first scrape.
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

        const received = items.length;
        const alreadyRunning = Boolean(ingestInFlight);

        if (!ingestInFlight) {
            // Copy payload so the request body isn't relied on after the response is sent.
            const payload = items.slice();
            ingestInFlight = (async () => {
                try {
                    const result = await ingestMarketDriverRssItems(payload);
                    if (result.changed) {
                        websocketService.emitCalendarNewsUpdate('market-driver');
                    }
                    logger.info(
                        `[MarketDriverWebhook] Full-feed ingest done: received=${result.received} fresh=${result.fresh} stored=${result.stored} changed=${result.changed}`,
                    );
                } catch (err) {
                    logger.error(
                        `[MarketDriverWebhook] Background ingest failed: ${err instanceof Error ? err.message : String(err)}`,
                        err,
                    );
                } finally {
                    ingestInFlight = null;
                }
            })();
        } else {
            logger.warn(
                `[MarketDriverWebhook] Ingest already running — accepted ${received} item(s) but skipped overlapping classify`,
            );
        }

        res.status(HTTP_STATUS.OK).json(
            successResponse('Market driver RSS accepted for full-feed classify', {
                received,
                processing: !alreadyRunning,
                skippedOverlap: alreadyRunning,
            }),
        );
    } catch (error) {
        next(error);
    }
};
