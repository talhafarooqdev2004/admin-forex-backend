import express from 'express';
import * as tableStructureController from '../controllers/v1/admin/tableStructure.controller.js';
import { apiLimiter } from '../middlewares/rateLimiter.middleware.js';
import { optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Auth is optional - if user is authenticated, save with user_id; otherwise, only save columns (admin creating structure)
router.post('/', apiLimiter, (req, res, next) => {
    console.log('=== TABLE STRUCTURE ROUTE HIT ===');
    console.log('Request URL:', req.url);
    console.log('Request Path:', req.path);
    console.log('Request Method:', req.method);
    console.log('Has Authorization Header:', !!req.headers.authorization);
    next();
}, optionalAuth, tableStructureController.saveTableStructure);

export default router;
