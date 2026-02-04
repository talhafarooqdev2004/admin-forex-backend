import express from 'express';
import * as educationController from '../controllers/v1/admin/education.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/', readLimiter, educationController.getAllEducations);
router.get('/:id', readLimiter, educationController.getEducationById);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, educationController.createEducation);
router.put('/:id', apiLimiter, educationController.updateEducation);
router.delete('/:id', apiLimiter, educationController.deleteEducation);
router.post('/:id/publish', apiLimiter, educationController.publishEducation);
router.post('/:id/unpublish', apiLimiter, educationController.unpublishEducation);

export default router;
