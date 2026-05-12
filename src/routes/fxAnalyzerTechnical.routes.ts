import express from 'express';
import * as fxAnalyzerTechnicalAdminController from '../controllers/v1/admin/fxAnalyzerTechnicalAdmin.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/sync-from-sheets', apiLimiter, authMiddleware, fxAnalyzerTechnicalAdminController.syncFxAnalyzerTechnicalFromSheets);

export default router;
