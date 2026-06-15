import express from 'express';
import * as integrationsController from '../controllers/v1/admin/integrations.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/telegram/detect', apiLimiter, authMiddleware, authorize('admin'), integrationsController.detectTelegramChat);
router.post('/test', apiLimiter, authMiddleware, authorize('admin'), integrationsController.sendTestAlert);

export default router;
