import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as marketDriverNewsController from '../controllers/v1/admin/marketDriverNews.controller.js';

const router = express.Router();

router.get(
    '/',
    readLimiter,
    authMiddleware,
    authorize('admin'),
    marketDriverNewsController.getMarketDriverNewsHeadlines,
);

router.get(
    '/coverage',
    readLimiter,
    authMiddleware,
    authorize('admin'),
    marketDriverNewsController.getMarketDriverCoverageStatus,
);

export default router;
