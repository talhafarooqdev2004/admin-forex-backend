import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import * as publicStatusController from '../controllers/v1/public/publicStatus.controller.js';
import * as publicAppConfigController from '../controllers/v1/public/publicAppConfig.controller.js';
import * as visitorAnalyticsController from '../controllers/v1/public/visitorAnalytics.controller.js';
import * as investingNewsController from '../controllers/v1/public/investingNews.controller.js';

const router = express.Router();

router.get('/status', readLimiter, publicStatusController.getPublicStatus);
router.get('/config/:key', readLimiter, publicAppConfigController.getPublicAppConfig);
router.post('/analytics/visit', readLimiter, visitorAnalyticsController.postVisitorAnalyticsPing);
router.get('/news/investing', readLimiter, investingNewsController.getInvestingNews);

export default router;
