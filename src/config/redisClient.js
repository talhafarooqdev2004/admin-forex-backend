import Redis from "ioredis";
import { ENV } from './env.js';
import { logger } from '../utils/logger.util.js';

const redis = new Redis({
    host: ENV.REDIS_HOST,
    port: ENV.REDIS_PORT,
    password: ENV.REDIS_PASSWORD || null,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
});

redis.on('connect', () => {
    logger.info('✅ Redis connected successfully');
});

redis.on('error', (error) => {
    logger.error('❌ Redis connection error:', error);
});

export default redis;
