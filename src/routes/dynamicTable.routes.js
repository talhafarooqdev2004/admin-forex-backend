import express from 'express';
import * as dynamicTableController from '../controllers/v1/admin/dynamicTable.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
// Auth is optional - unauthenticated users can view table structure (columns only)
router.get('/', readLimiter, optionalAuth, dynamicTableController.getAllTables);
router.get('/identifier/:identifier', readLimiter, optionalAuth, dynamicTableController.getTableByIdentifier);
router.get('/:id', readLimiter, optionalAuth, dynamicTableController.getTableById);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, dynamicTableController.createTable);
router.put('/:id', apiLimiter, dynamicTableController.updateTable);
router.delete('/:id', apiLimiter, dynamicTableController.deleteTable);
router.post('/:id/recalculate', apiLimiter, dynamicTableController.recalculateTable);

export default router;
