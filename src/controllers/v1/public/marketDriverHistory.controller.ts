import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import {
    getHistoricalDay,
    listHistoricalDays,
} from '../../../services/marketDriverBoard.service.js';

/** List past UAE days available on Historical Analysis (doc §2). */
export const listMarketDriverHistoryDays = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const days = await listHistoricalDays();
        res.status(HTTP_STATUS.OK).json(successResponse('Historical days retrieved successfully', days));
    } catch (error) {
        next(error);
    }
};

/** One day's finalized (or reconstructed) catalyst board for Historical Analysis. */
export const getMarketDriverHistoryDay = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const dayKey = String(req.params.dayKey ?? '');
        const payload = await getHistoricalDay(dayKey);
        if (!payload) {
            res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Invalid day key' });
            return;
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Historical day retrieved successfully', payload));
    } catch (error) {
        next(error);
    }
};
