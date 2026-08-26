import express from 'express';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { authMiddleware, authorize } from '../middlewares/auth.middleware.js';
import * as rssNewsController from '../controllers/v1/admin/rssNews.controller.js';

const router = express.Router();

router.get(
    '/',
    readLimiter,
    authMiddleware,
    authorize('admin'),
    rssNewsController.getAdminRssNewsFeed,
);

export default router;
