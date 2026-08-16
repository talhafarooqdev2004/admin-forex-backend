import express from 'express';
import { readLimiter, apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as controller from '../controllers/v1/admin/aiUsageDashboard.controller.js';

const router = express.Router();
const adminOnly = [authMiddleware, authorize('admin')];

router.get('/summary', readLimiter, ...adminOnly, controller.getSummary);
router.get('/daily', readLimiter, ...adminOnly, controller.getDaily);
router.get('/providers', readLimiter, ...adminOnly, controller.getProviderBreakdown);
router.get('/queue', readLimiter, ...adminOnly, controller.getQueue);
router.get('/requests', readLimiter, ...adminOnly, controller.getRecentRequests);
router.get('/processing', readLimiter, ...adminOnly, controller.getProcessing);
router.post('/jobs/:id/retry', apiLimiter, ...adminOnly, controller.retryJob);

export default router;
