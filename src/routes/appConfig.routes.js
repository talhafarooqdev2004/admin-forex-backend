import express from 'express';
import * as appConfigController from '../controllers/v1/admin/appConfig.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/:key', readLimiter, appConfigController.getAppConfig);
router.put('/:key', apiLimiter, appConfigController.updateAppConfig);

export default router;
