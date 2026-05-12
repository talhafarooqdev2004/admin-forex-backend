import express from 'express';
import * as edgeToolsAdminController from '../controllers/v1/admin/edgeToolsAdmin.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/sync-from-sheets', apiLimiter, authMiddleware, edgeToolsAdminController.syncEdgeToolsFromSheets);

export default router;
