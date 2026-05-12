import express from 'express';
import * as pageContentController from '../controllers/v1/admin/pageContent.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
const router = express.Router();
router.get('/:pageIdentifier', readLimiter, pageContentController.getPageContent);
router.put('/:pageIdentifier', apiLimiter, pageContentController.updatePageContent);
export default router;
