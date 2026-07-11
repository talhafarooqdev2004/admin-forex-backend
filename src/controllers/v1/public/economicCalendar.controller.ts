import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getEconomicCalendarSnapshot } from '../../../services/economicCalendarScrape.service.js';

/**
 * Serves the latest scraped snapshot instantly.
 * Scraping runs in forex-scraping and is pushed via webhook — this never scrapes.
 * Before the first webhook lands after a cold boot, returns an empty list.
 */
export const getEconomicCalendar = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const existing = getEconomicCalendarSnapshot();
        const data = existing?.data ?? [];
        res.status(HTTP_STATUS.OK).json(successResponse('Economic calendar retrieved successfully', data));
    } catch (error) {
        next(error);
    }
};
