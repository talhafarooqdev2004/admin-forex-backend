import express from 'express';
import * as userPreferenceController from '../controllers/v1/userPreference.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/:key', readLimiter, authMiddleware, userPreferenceController.getUserPreference);
router.put('/:key', apiLimiter, authMiddleware, userPreferenceController.upsertUserPreference);

export default router;
