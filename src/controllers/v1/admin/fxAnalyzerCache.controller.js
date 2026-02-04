import { FxAnalyzerCacheRepository } from '../../../repositories/fxAnalyzerCache.repository.js';
import { scoreUpdateService } from '../../../services/scoreUpdateService.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { logger } from '../../../utils/logger.util.js';

const cacheRepository = new FxAnalyzerCacheRepository();

/**
 * Get all cache entries
 */
export const getAllCacheEntries = async (req, res, next) => {
    try {
        console.log('🔥 getAllCacheEntries called');
        const entries = await cacheRepository.findAll();

        res.status(HTTP_STATUS.OK).json(
            successResponse('Cache entries retrieved successfully', {
                count: entries.length,
                entries: entries.map(entry => ({
                    pair: entry.pair,
                    currencyPairId: entry.currency_pair_id,
                    lastUpdated: entry.last_updated,
                    data: entry.complete_data, // Include the actual cached data
                    dataSize: JSON.stringify(entry.complete_data).length,
                }))
            })
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Get cache entry for a specific pair
 */
export const getCacheByPair = async (req, res, next) => {
    try {
        const { pair } = req.params;
        const entry = await cacheRepository.findByPair(pair);

        if (!entry) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, `Cache not found for pair: ${pair}`);
        }

        res.status(HTTP_STATUS.OK).json(
            successResponse('Cache entry retrieved successfully', {
                pair: entry.pair,
                currencyPairId: entry.currency_pair_id,
                lastUpdated: entry.last_updated,
                data: entry.complete_data,
            })
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Get cache statistics
 */
export const getCacheStats = async (req, res, next) => {
    try {
        const stats = await cacheRepository.getStats();
        const queueStatus = scoreUpdateService.getQueueStatus();

        res.status(HTTP_STATUS.OK).json(
            successResponse('Cache statistics retrieved successfully', {
                cache: stats,
                updateQueue: queueStatus,
            })
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Force update cache for a specific pair
 */
export const forceUpdatePair = async (req, res, next) => {
    try {
        const { pair } = req.params;

        logger.info(`Force update requested for pair: ${pair}`);

        const result = await scoreUpdateService.forceUpdate(pair);

        res.status(HTTP_STATUS.OK).json(
            successResponse(`Cache force updated for ${pair}`, result)
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Force update cache for all pairs
 */
export const forceUpdateAll = async (req, res, next) => {
    try {
        logger.info('🔥 Cache update API endpoint hit!');
        logger.info('Request body:', JSON.stringify(req.body, null, 2));
        logger.info('Request query:', req.query);

        const { pairs: requestedPairs, source } = req.body;
        const isBackground = req.query.background === 'true';

        logger.info(`Processing request - pairs: ${requestedPairs?.length || 0}, source: ${source}, background: ${isBackground}`);

        if (requestedPairs && Array.isArray(requestedPairs)) {
            logger.info(`Force update requested for specific pairs: ${requestedPairs.length} pairs from ${source || 'unknown source'}`);

            // Validate pairs
            const validPairs = requestedPairs.filter(pair => typeof pair === 'string' && pair.trim().length > 0);
            if (validPairs.length === 0) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'No valid pairs provided');
            }

            // Update specific pairs
            if (isBackground) {
                // Start update in background
                scoreUpdateService.forceUpdateSpecific(validPairs).catch(error => {
                    logger.error('Background force update failed:', error);
                });

                res.status(HTTP_STATUS.ACCEPTED).json(
                    successResponse('Cache update started in background for specific pairs', {
                        pairs: validPairs,
                        message: 'Check /cache/stats for progress',
                    })
                );
            } else {
                // Wait for completion
                const results = await scoreUpdateService.forceUpdateSpecific(validPairs);

                res.status(HTTP_STATUS.OK).json(
                    successResponse('Cache force updated for specific pairs', {
                        pairs: validPairs,
                        total: results.length,
                        succeeded: results.filter(r => r.success).length,
                        failed: results.filter(r => !r.success).length,
                        results,
                    })
                );
            }
        } else {
            logger.info('Force update requested for all pairs');

            // Update all pairs
            if (isBackground) {
                // Start update in background
                scoreUpdateService.forceUpdateAll().catch(error => {
                    logger.error('Background force update failed:', error);
                });

                res.status(HTTP_STATUS.ACCEPTED).json(
                    successResponse('Cache update started in background for all pairs', {
                        message: 'Check /cache/stats for progress',
                    })
                );
            } else {
                // Wait for completion
                const results = await scoreUpdateService.forceUpdateAll();

                res.status(HTTP_STATUS.OK).json(
                    successResponse('Cache force updated for all pairs', {
                        total: results.length,
                        succeeded: results.filter(r => r.success).length,
                        failed: results.filter(r => !r.success).length,
                        results,
                    })
                );
            }
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Clear specific cache entry
 */
export const clearCacheByPair = async (req, res, next) => {
    try {
        const { pair } = req.params;

        const deleted = await cacheRepository.deleteByPair(pair);

        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, `Cache not found for pair: ${pair}`);
        }

        res.status(HTTP_STATUS.OK).json(
            successResponse(`Cache cleared for ${pair}`)
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Clear all cache entries
 */
export const clearAllCache = async (req, res, next) => {
    try {
        logger.warn('Clear all cache requested');

        const deleted = await cacheRepository.clearAll();

        res.status(HTTP_STATUS.OK).json(
            successResponse(`All cache cleared (${deleted} entries removed)`)
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Get queue status
 */
export const getQueueStatus = async (req, res, next) => {
    try {
        const status = scoreUpdateService.getQueueStatus();

        res.status(HTTP_STATUS.OK).json(
            successResponse('Queue status retrieved successfully', status)
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Clear update queue
 */
export const clearQueue = async (req, res, next) => {
    try {
        scoreUpdateService.clearQueue();

        res.status(HTTP_STATUS.OK).json(
            successResponse('Update queue cleared')
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Manually queue an update for a pair
 */
export const queueUpdate = async (req, res, next) => {
    try {
        const { pair } = req.params;
        const { changedColumn } = req.body;

        if (!changedColumn) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'changedColumn is required');
        }

        await scoreUpdateService.queueUpdate(pair, changedColumn);

        res.status(HTTP_STATUS.OK).json(
            successResponse(`Update queued for ${pair}`, {
                pair,
                changedColumn,
                queueLength: scoreUpdateService.getQueueStatus().queueLength,
            })
        );
    } catch (error) {
        next(error);
    }
};
