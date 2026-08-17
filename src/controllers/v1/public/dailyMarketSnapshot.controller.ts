import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getDailyMarketSnapshot } from '../../../services/dailyMarketSnapshot.service.js';

export const getDailyMarketSnapshotReadOnly = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const requestedDay = typeof req.query.day === 'string' ? req.query.day.trim() : '';
        const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) ? requestedDay : undefined;
        const snapshot = await getDailyMarketSnapshot(dayKey);
        res.status(HTTP_STATUS.OK).json(successResponse('Daily market snapshot retrieved successfully', snapshot));
    } catch (error) {
        next(error);
    }
};
