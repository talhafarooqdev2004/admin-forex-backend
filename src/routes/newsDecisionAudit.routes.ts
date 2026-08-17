import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as controller from '../controllers/v1/admin/newsDecisionAudit.controller.js';

const router = express.Router();
router.get('/', readLimiter, authMiddleware, authorize('admin'), controller.getNewsDecisionAudit);
export default router;
