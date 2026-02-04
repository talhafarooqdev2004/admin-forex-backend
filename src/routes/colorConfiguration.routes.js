import express from 'express';
import * as colorConfigController from '../controllers/v1/admin/colorConfiguration.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/', readLimiter, colorConfigController.getAllColorConfigurations);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, colorConfigController.createColorConfiguration);
router.post('/bulk-update', apiLimiter, colorConfigController.bulkUpdateColorConfigurations);
router.put('/:id', apiLimiter, colorConfigController.updateColorConfiguration);
router.delete('/:id', apiLimiter, colorConfigController.deleteColorConfiguration);

export default router;
