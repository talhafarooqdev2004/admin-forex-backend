import express from 'express';
import * as currencyPairController from '../controllers/v1/admin/currencyPair.controller.js';
import { readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/', readLimiter, currencyPairController.getAllCurrencyPairs);

export default router;
