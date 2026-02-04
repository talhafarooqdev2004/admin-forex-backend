import express from 'express';
import * as scoreDashboardController from '../controllers/v1/admin/scoreDashboard.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/', readLimiter, scoreDashboardController.getAllScores);
router.post('/calculate', apiLimiter, scoreDashboardController.calculateScores);

export default router;
