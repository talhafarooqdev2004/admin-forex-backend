import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as visitorAnalyticsAdminController from '../controllers/v1/admin/visitorAnalytics.controller.js';

const router = express.Router();

router.get(
    '/visitor-locations',
    readLimiter,
    authMiddleware,
    authorize('admin'),
    visitorAnalyticsAdminController.getVisitorGeoStats,
);

export default router;
