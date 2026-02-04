import express from 'express';
import * as postController from '../../controllers/v1/forum/post.controller.js';
import { apiLimiter, readLimiter } from '../../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/', readLimiter, postController.getAllPosts);
router.get('/:id', readLimiter, postController.getPostById);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, postController.createPost);
router.put('/:id', apiLimiter, postController.updatePost);
router.delete('/:id', apiLimiter, postController.deletePost);

export default router;
