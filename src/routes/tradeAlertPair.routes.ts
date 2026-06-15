import express from 'express';
import * as tradeAlertPairController from '../controllers/v1/admin/tradeAlertPair.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/', readLimiter, tradeAlertPairController.getAllPairs);
router.post('/', apiLimiter, authMiddleware, authorize('admin'), tradeAlertPairController.createPair);
router.post('/presets', apiLimiter, authMiddleware, authorize('admin'), tradeAlertPairController.upsertPairPreset);
router.put('/:id', apiLimiter, authMiddleware, authorize('admin'), tradeAlertPairController.updatePair);
router.delete('/:id', apiLimiter, authMiddleware, authorize('admin'), tradeAlertPairController.deletePair);

export default router;
