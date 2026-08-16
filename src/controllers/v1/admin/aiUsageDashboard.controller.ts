import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { successResponse } from '../../../utils/response.util.js';
import {
    getAiProviderBreakdown,
    getAiUsageDaily,
    getAiUsageSummary,
    getProcessingRuns,
    getQueueHealth,
    getRecentAiRequests,
    parsePagination,
    resolveReportRange,
    retryAiClassificationJob,
} from '../../../services/aiUsageDashboard.service.js';

function getRange(req: Request) {
    try {
        const preset = typeof req.query.preset === 'string' ? req.query.preset : undefined;
        const from = typeof req.query.from === 'string' ? req.query.from : undefined;
        const to = typeof req.query.to === 'string' ? req.query.to : undefined;
        return resolveReportRange({ preset, from, to });
    } catch (error) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, error instanceof Error ? error.message : 'Invalid report date range');
    }
}

export const getSummary = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const range = getRange(req);
        const [summary, queueHealth] = await Promise.all([getAiUsageSummary(range), getQueueHealth()]);
        summary.totals.pendingJobs = queueHealth.pending;
        res.status(HTTP_STATUS.OK).json(successResponse('AI usage summary', { ...summary, queueHealth }));
    } catch (error) {
        next(error);
    }
};

export const getDaily = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.status(HTTP_STATUS.OK).json(successResponse('AI usage daily breakdown', await getAiUsageDaily(getRange(req))));
    } catch (error) {
        next(error);
    }
};

export const getProviderBreakdown = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.status(HTTP_STATUS.OK).json(successResponse('AI provider breakdown', await getAiProviderBreakdown(getRange(req))));
    } catch (error) {
        next(error);
    }
};

export const getQueue = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        res.status(HTTP_STATUS.OK).json(successResponse('AI queue health', await getQueueHealth()));
    } catch (error) {
        next(error);
    }
};

export const getRecentRequests = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const range = getRange(req);
        const pagination = parsePagination({ page: req.query.page, pageSize: req.query.pageSize });
        res.status(HTTP_STATUS.OK).json(successResponse('Recent AI requests', await getRecentAiRequests(range, pagination)));
    } catch (error) {
        next(error);
    }
};

export const getProcessing = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const range = getRange(req);
        const pagination = parsePagination({ page: req.query.page, pageSize: req.query.pageSize });
        res.status(HTTP_STATUS.OK).json(successResponse('Processing runs', await getProcessingRuns(range, pagination)));
    } catch (error) {
        next(error);
    }
};

export const retryJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.body?.confirm !== true) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Explicit confirmation is required to retry an AI job');
        }
        const jobId = String(req.params.id || '').trim();
        if (!jobId || jobId.length > 100) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid AI job id');
        const authUser = (req as Request & { user?: { id?: unknown; user_id?: unknown } }).user;
        const adminId = authUser?.id ?? authUser?.user_id ?? 'admin';
        const result = await retryAiClassificationJob(jobId, adminId);
        res.status(HTTP_STATUS.OK).json(successResponse('AI job queued for a bounded retry', result));
    } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) {
            next(new ApiError(HTTP_STATUS.NOT_FOUND, error.message));
            return;
        }
        if (error instanceof Error && /Only failed or dead/i.test(error.message)) {
            next(new ApiError(HTTP_STATUS.CONFLICT, error.message));
            return;
        }
        next(error);
    }
};
