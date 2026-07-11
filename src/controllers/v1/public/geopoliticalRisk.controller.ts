import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getGeopoliticalRiskWatch } from '../../../services/geopoliticalRisk.service.js';

/**
 * Geopolitical Risk Watch gauge (doc §27–§29): score 0.00–1.00 from today’s
 * AI-classified GEOPOLITICAL news headlines.
 */
export const getGeopoliticalRisk = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const watch = await getGeopoliticalRiskWatch();
        res.status(HTTP_STATUS.OK).json(successResponse('Geopolitical risk watch retrieved successfully', watch));
    } catch (error) {
        next(error);
    }
};
