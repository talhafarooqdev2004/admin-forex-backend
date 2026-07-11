import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getMarketDriverNews, uaeDayKey } from '../../../services/marketDriverBoard.service.js';

/** Full deduplicated driver headlines for the admin-only News / Market Drivers table (doc §34).
 * Optional `?day=YYYY-MM-DD` for Historical Analysis; defaults to the live UAE day.
 */
export const getMarketDriverNewsHeadlines = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const dayParam = typeof req.query.day === 'string' ? req.query.day.trim() : '';
        const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : uaeDayKey();
        const rows = await getMarketDriverNews(dayKey);
        res.status(HTTP_STATUS.OK).json(
            successResponse('Market driver news retrieved successfully', { dayKey, rows }),
        );
    } catch (error) {
        next(error);
    }
};
