import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../../../config/env.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import { logger } from '../../../utils/logger.util.js';
import {
    ingestFfePipelineResult,
    type FfePipelineIngestPayload,
} from '../../../services/ffePipelineIngest.service.js';

const WEBHOOK_HEADER = 'x-scraper-webhook-key';

/**
 * Receives completed FFE daily pipeline results from forex-scraping.
 * Parses ChatGPT raw response, validates, and persists production market snapshot.
 * Does NOT call the old OpenAI API semantic analysis path.
 */
export const ingestFfeDailyPipeline = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const providedSecret = String(req.header(WEBHOOK_HEADER) || '').trim();
        const expectedSecret = String(ENV.SCRAPER_WEBHOOK_SECRET || '').trim();

        if (expectedSecret && providedSecret !== expectedSecret) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid webhook secret');
        }

        const body = req.body as Partial<FfePipelineIngestPayload>;
        if (!body?.run_id || !body?.business_day || !body?.input_hash) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'run_id, business_day, and input_hash are required');
        }
        if (!Array.isArray(body.source_units) || body.source_units.length === 0) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'source_units array is required');
        }

        const payload = body as FfePipelineIngestPayload;
        const result = await ingestFfePipelineResult(payload);

        logger.info('[FfePipelineWebhook] Ingest complete', {
            run_id: payload.run_id,
            business_day: payload.business_day,
            final_status: result.final_status,
            parse_status: result.parse_status,
            persistence_status: result.persistence_status,
        });

        res.status(HTTP_STATUS.OK).json(successResponse('FFE daily pipeline ingested', result));
    } catch (error) {
        next(error);
    }
};
