import express from 'express';
import * as riskModeScoreController from '../controllers/v1/admin/riskModeScore.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/', readLimiter, riskModeScoreController.getRiskModeScore);
router.put('/', apiLimiter, riskModeScoreController.updateRiskModeScore);
router.post('/scrape', apiLimiter, riskModeScoreController.triggerScrape);

export default router;
