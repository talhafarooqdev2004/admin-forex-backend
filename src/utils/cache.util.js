import redisClient from '../config/redisClient.js';
import { logger } from './logger.util.js';

export const cacheRemember = async (cacheKey, ttl, callback) => {
    try {
        const cachedData = await redisClient.get(cacheKey);

        if (cachedData) {
            logger.info(`Cache hit: ${cacheKey}`);
            return JSON.parse(cachedData);
        }
    } catch (cacheError) {
        logger.error(`Cache read error for ${cacheKey}:`, cacheError);
    }

    logger.info(`Cache miss: ${cacheKey}`);
    const data = await callback();

    try {
        await redisClient.setex(cacheKey, ttl, JSON.stringify(data));
    } catch (cacheError) {
        logger.error(`Cache write error for ${cacheKey}:`, cacheError);
    }

    return data;
};

export const cacheForget = async (cacheKey) => {
    try {
        await redisClient.del(cacheKey);
        logger.info(`Cache cleared: ${cacheKey}`);
    } catch (error) {
        logger.error(`Cache delete error for ${cacheKey}:`, error);
    }
};

export const cacheForgetPattern = async (pattern) => {
    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(...keys);
            logger.info(`Cache cleared for pattern: ${pattern} (${keys.length} keys)`);
        }
    } catch (error) {
        logger.error(`Cache pattern delete error for ${pattern}:`, error);
    }
};
