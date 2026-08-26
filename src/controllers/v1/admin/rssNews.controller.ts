import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getAdminRssNews } from '../../../services/rssNews.service.js';

/** Live FinancialJuice RSS inspection for admin RSS News page. Optional `?date=YYYY-MM-DD`. */
export const getAdminRssNewsFeed = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
        const data = await getAdminRssNews(dateParam || undefined);
        res.status(HTTP_STATUS.OK).json(successResponse('RSS news retrieved successfully', data));
    } catch (error) {
        next(error);
    }
};
