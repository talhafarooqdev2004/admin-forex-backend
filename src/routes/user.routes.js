import express from 'express';
import * as userController from '../controllers/v1/admin/user.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/stats', readLimiter, userController.getUserStats);
router.get('/', readLimiter, userController.getAllUsers);
router.get('/:id', readLimiter, userController.getUserById);

// Write operations use stricter rate limiter
router.delete('/:id', apiLimiter, userController.deleteUser);

export default router;
