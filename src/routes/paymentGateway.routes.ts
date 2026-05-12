import express from 'express';
import * as paymentGatewayController from '../controllers/v1/admin/paymentGateway.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
const router = express.Router();
router.get('/', readLimiter, paymentGatewayController.getAllPaymentGateways);
router.put('/:id', apiLimiter, paymentGatewayController.updatePaymentGateway);
router.post('/:id/toggle-active', apiLimiter, paymentGatewayController.toggleActivePaymentGateway);
export default router;
