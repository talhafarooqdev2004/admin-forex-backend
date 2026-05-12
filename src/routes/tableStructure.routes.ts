import express from 'express';
import * as tableStructureController from '../controllers/v1/admin/tableStructure.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/', apiLimiter, (req, res, next) => {
    next();
}, optionalAuth, tableStructureController.saveTableStructure);

export default router;
