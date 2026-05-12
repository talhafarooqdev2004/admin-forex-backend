import express from 'express';
import * as cotDataAnalysisAdminController from '../controllers/v1/admin/cotDataAnalysisAdmin.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/sync-from-sheets', apiLimiter, authMiddleware, cotDataAnalysisAdminController.syncCotDataAnalysisFromSheets);

export default router;
