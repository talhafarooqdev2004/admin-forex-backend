import express from 'express';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as controller from '../controllers/v1/admin/macroComment.controller.js';

const router = express.Router();
const adminOnly = [authMiddleware, authorize('admin')];

router.get('/', readLimiter, ...adminOnly, controller.listMacroComments);
router.put('/:currency', apiLimiter, ...adminOnly, controller.upsertMacroComment);

export default router;
