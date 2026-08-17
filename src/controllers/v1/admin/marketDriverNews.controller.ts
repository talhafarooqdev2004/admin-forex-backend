import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getMarketDriverNews, getMarketDriverNewsDiagnostic, uaeDayKey } from '../../../services/marketDriverBoard.service.js';
import {
    getLastCoverageAudit,
    runMarketDriverCoverageAudit,
} from '../../../services/marketDriverCoverageAudit.service.js';

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

/**
 * Latest self-healing coverage-audit status (feeds vs board). `?run=1` forces a fresh audit
 * (fetches feeds + auto-heals) instead of returning the last cron result.
 */
export const getMarketDriverCoverageStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const force = req.query.run === '1' || req.query.run === 'true';
        const result = force
            ? await runMarketDriverCoverageAudit({ force: true })
            : (getLastCoverageAudit() ?? (await runMarketDriverCoverageAudit()));
        res.status(HTTP_STATUS.OK).json(successResponse('Coverage audit status', result));
    } catch (error) {
        next(error);
    }
};

/** Admin-only, read-only source/visibility diagnostics. Never invokes coverage repair or AI. */
export const getMarketDriverNewsDiagnosticRows = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const dayParam = typeof req.query.day === 'string' ? req.query.day.trim() : '';
        const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : uaeDayKey();
        const rows = await getMarketDriverNewsDiagnostic(dayKey);
        res.status(HTTP_STATUS.OK).json(successResponse('Market driver diagnostics retrieved successfully', { dayKey, rows }));
    } catch (error) {
        next(error);
    }
};
