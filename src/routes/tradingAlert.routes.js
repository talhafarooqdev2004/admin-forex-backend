import express from 'express';
import * as tradingAlertController from '../controllers/v1/admin/tradingAlert.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/', readLimiter, tradingAlertController.getAllAlerts);
router.get('/:id', readLimiter, tradingAlertController.getAlertById);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, tradingAlertController.createAlert);
router.put('/:id', apiLimiter, tradingAlertController.updateAlert);
router.delete('/:id', apiLimiter, tradingAlertController.deleteAlert);

export default router;
