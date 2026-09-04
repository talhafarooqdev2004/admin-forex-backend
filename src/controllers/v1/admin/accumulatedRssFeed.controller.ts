import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getAccumulatedFinancialJuiceFeed } from '../../../services/accumulatedRssFeed.service.js';

/** Read-only accumulated FinancialJuice feed for the active UAE business day. */
export const getAccumulatedFinancialJuiceFeedHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const data = await getAccumulatedFinancialJuiceFeed();
        res.status(HTTP_STATUS.OK).json(successResponse('Accumulated FinancialJuice feed retrieved successfully', data));
    } catch (error) {
        next(error);
    }
};
