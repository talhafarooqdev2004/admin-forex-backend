import express from 'express';
import * as packageController from '../controllers/v1/admin/package.controller.js';
import { apiLimiter, readLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = express.Router();

router.get('/stats', readLimiter, packageController.getPackageStats);
router.get('/', readLimiter, packageController.getAllPackages);
router.get('/:id', readLimiter, packageController.getPackageById);
router.post('/', apiLimiter, packageController.createPackage);
router.put('/:id', apiLimiter, packageController.updatePackage);
router.delete('/:id', apiLimiter, packageController.deletePackage);
router.patch('/publish/:id', apiLimiter, packageController.publishPackage);
router.patch('/unpublish/:id', apiLimiter, packageController.unpublishPackage);

export default router;
