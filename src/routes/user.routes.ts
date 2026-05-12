import express from 'express';
import * as userController from '../controllers/v1/admin/user.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/stats', readLimiter, userController.getUserStats);
router.get('/', readLimiter, userController.getAllUsers);
router.get('/:id', readLimiter, userController.getUserById);
router.delete('/:id', apiLimiter, userController.deleteUser);

export default router;
