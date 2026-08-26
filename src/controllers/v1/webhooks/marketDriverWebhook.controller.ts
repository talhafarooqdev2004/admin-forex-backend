import type { Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';

/**
 * OLD OpenAI/RSS semantic ingest webhook — permanently disabled.
 * FFE production uses POST /api/v1/webhooks/ffe/daily-pipeline only.
 */
export const ingestMarketDriverRss = async (_req: Request, res: Response) => {
    res.status(HTTP_STATUS.OK).json(
        successResponse('Old OpenAI RSS ingest webhook disabled', {
            disabled: true,
            message: 'Use POST /api/v1/webhooks/ffe/daily-pipeline',
        }),
    );
};
