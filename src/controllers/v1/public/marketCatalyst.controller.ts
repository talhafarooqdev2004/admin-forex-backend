import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getCatalystBoard } from '../../../services/marketDriverBoard.service.js';

/**
 * Per-asset Market Driver / Catalyst aggregates for the current UAE day. Reads the stored,
 * pre-classified snapshot instantly — the RSS fetch + Groq classification runs on a background
 * cron (see server.ts), never per request.
 */
export const getMarketCatalyst = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const rows = await getCatalystBoard();
        res.status(HTTP_STATUS.OK).json(successResponse('Market catalyst board retrieved successfully', rows));
    } catch (error) {
        next(error);
    }
};
