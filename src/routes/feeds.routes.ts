import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import { getAccumulatedFinancialJuiceFeedHandler } from '../controllers/v1/admin/accumulatedRssFeed.controller.js';

const router = express.Router();

router.get(
    '/financialjuice/accumulated',
    readLimiter,
    authMiddleware,
    authorize('admin'),
    getAccumulatedFinancialJuiceFeedHandler,
);

export default router;
