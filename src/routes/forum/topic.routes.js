import express from 'express';
import * as topicController from '../../controllers/v1/forum/topic.controller.js';
import { apiLimiter, readLimiter } from '../../middlewares/rateLimiter.middleware.js';

const router = express.Router();

// GET requests use more lenient rate limiter
router.get('/', readLimiter, topicController.getAllTopics);
router.get('/:id', readLimiter, topicController.getTopicById);

// Write operations use stricter rate limiter
router.post('/', apiLimiter, topicController.createTopic);
router.put('/:id', apiLimiter, topicController.updateTopic);
router.delete('/:id', apiLimiter, topicController.deleteTopic);

export default router;
