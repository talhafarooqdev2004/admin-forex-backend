import express from 'express';
import { login, adminLogin, register, getMe, updateMe, handleGoogleAuth } from '../controllers/v1/admin/auth.controller.js';
import { authMiddleware, optionalAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Public routes
router.post('/login', login);
router.post('/admin/login', adminLogin);
router.post('/register', register);
router.post('/google', handleGoogleAuth);

// Protected routes
router.get('/me', authMiddleware, getMe);
router.put('/me', authMiddleware, updateMe);

export default router;
