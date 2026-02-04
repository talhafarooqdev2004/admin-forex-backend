import express from 'express';
import * as fxAnalyzerCacheController from '../controllers/v1/admin/fxAnalyzerCache.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Temporarily remove auth for debugging
// GET requests use more lenient rate limiter
router.get('/', readLimiter, fxAnalyzerCacheController.getAllCacheEntries);
router.get('/stats', readLimiter, fxAnalyzerCacheController.getCacheStats);
router.get('/queue/status', readLimiter, fxAnalyzerCacheController.getQueueStatus);
router.get('/:pair', readLimiter, fxAnalyzerCacheController.getCacheByPair);

// Write operations use stricter rate limiter
router.post('/update/:pair', apiLimiter, fxAnalyzerCacheController.forceUpdatePair);
router.post('/update-all', apiLimiter, fxAnalyzerCacheController.forceUpdateAll);
router.post('/queue/:pair', apiLimiter, fxAnalyzerCacheController.queueUpdate);
router.post('/queue/clear', apiLimiter, fxAnalyzerCacheController.clearQueue);
router.delete('/:pair', apiLimiter, fxAnalyzerCacheController.clearCacheByPair);
router.delete('/', apiLimiter, fxAnalyzerCacheController.clearAllCache);

export default router;
