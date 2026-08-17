import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';
import { getNewsDecisionAudit as fetchNewsDecisionAudit, parseNewsDecisionAuditFilters } from '../../../services/newsDecisionAudit.service.js';

export const getNewsDecisionAudit = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await fetchNewsDecisionAudit(parseNewsDecisionAuditFilters(req.query as Record<string, unknown>));
        res.status(HTTP_STATUS.OK).json(successResponse('News decision audit retrieved successfully', result));
    } catch (error) {
        next(error);
    }
};
