import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import * as publicStatusController from '../controllers/v1/public/publicStatus.controller.js';
import * as publicAppConfigController from '../controllers/v1/public/publicAppConfig.controller.js';
import * as visitorAnalyticsController from '../controllers/v1/public/visitorAnalytics.controller.js';
import * as investingNewsController from '../controllers/v1/public/investingNews.controller.js';
import * as economicCalendarController from '../controllers/v1/public/economicCalendar.controller.js';
import * as marketCatalystController from '../controllers/v1/public/marketCatalyst.controller.js';
import * as marketDriverHistoryController from '../controllers/v1/public/marketDriverHistory.controller.js';
import * as geopoliticalRiskController from '../controllers/v1/public/geopoliticalRisk.controller.js';

const router = express.Router();

router.get('/status', readLimiter, publicStatusController.getPublicStatus);
router.get('/config/:key', readLimiter, publicAppConfigController.getPublicAppConfig);
router.post('/analytics/visit', readLimiter, visitorAnalyticsController.postVisitorAnalyticsPing);
router.get('/news/investing', readLimiter, investingNewsController.getInvestingNews);
router.get('/economic-calendar', readLimiter, economicCalendarController.getEconomicCalendar);
router.get('/market-catalyst', readLimiter, marketCatalystController.getMarketCatalyst);
router.get('/geopolitical-risk', readLimiter, geopoliticalRiskController.getGeopoliticalRisk);
router.get('/market-driver-history', readLimiter, marketDriverHistoryController.listMarketDriverHistoryDays);
router.get('/market-driver-history/:dayKey', readLimiter, marketDriverHistoryController.getMarketDriverHistoryDay);

export default router;
