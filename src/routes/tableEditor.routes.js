import express from 'express';
import * as tableEditorController from '../controllers/v1/admin/tableEditor.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';
import { optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Initialize Google Sheets
router.post('/initialize', apiLimiter, tableEditorController.initialize);

// Cell operations
router.post('/update-cell', apiLimiter, tableEditorController.updateCell);
router.post('/batch-update', apiLimiter, tableEditorController.batchUpdateCells);
router.get('/cell', readLimiter, optionalAuth, tableEditorController.getCell);

// Range operations
router.get('/range', readLimiter, optionalAuth, tableEditorController.getRange);
router.post('/clear-range', apiLimiter, tableEditorController.clearRange);

// Table operations
router.post('/sync-table', apiLimiter, tableEditorController.syncTable);
router.get('/table', readLimiter, optionalAuth, tableEditorController.getTable);

export default router;
