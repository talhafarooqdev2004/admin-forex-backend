import { FxAnalyzerCache, CurrencyPair } from '../models/index.js';
import { logger } from '../utils/logger.util.js';

export class FxAnalyzerCacheRepository {
    /**
     * Find cached data by currency pair identifier
     * @param {string} pair - Currency pair identifier (e.g., "EUR/USD")
     * @returns {Promise<Object|null>} Cached data or null if not found
     */
    async findByPair(pair) {
        try {
            const cached = await FxAnalyzerCache.findOne({
                where: { pair },
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                    }
                ],
            });

            return cached;
        } catch (error) {
            logger.error(`Error finding cache for pair ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Find cached data by currency pair ID
     * @param {number} currencyPairId - Currency pair ID
     * @returns {Promise<Object|null>} Cached data or null if not found
     */
    async findByCurrencyPairId(currencyPairId) {
        try {
            const cached = await FxAnalyzerCache.findOne({
                where: { currency_pair_id: currencyPairId },
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                    }
                ],
            });

            return cached;
        } catch (error) {
            logger.error(`Error finding cache for currency pair ID ${currencyPairId}:`, error);
            throw error;
        }
    }

    /**
     * Get all cached entries
     * @returns {Promise<Array>} Array of all cached entries
     */
    async findAll() {
        try {
            return await FxAnalyzerCache.findAll({
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                    }
                ],
                order: [['pair', 'ASC']],
            });
        } catch (error) {
            logger.error('Error finding all cache entries:', error);
            throw error;
        }
    }

    /**
     * Update or create cache entry for a currency pair
     * @param {string} pair - Currency pair identifier
     * @param {Object} completeData - Complete analyzer data to cache
     * @param {number|null} currencyPairId - Optional currency pair ID
     * @returns {Promise<Object>} Updated cache entry
     */
    async updateOrCreate(pair, completeData, currencyPairId = null) {
        try {
            const [cache, created] = await FxAnalyzerCache.upsert({
                pair,
                currency_pair_id: currencyPairId,
                complete_data: completeData,
                last_updated: new Date(),
            }, {
                returning: true
            });

            logger.info(`Cache ${created ? 'created' : 'updated'} for pair: ${pair}`);

            return await this.findByPair(pair);
        } catch (error) {
            logger.error(`Error updating/creating cache for pair ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Bulk update or create cache entries
     * @param {Array<Object>} entries - Array of {pair, completeData, currencyPairId}
     * @returns {Promise<Array>} Array of updated cache entries
     */
    async bulkUpdateOrCreate(entries) {
        try {
            const results = [];

            for (const entry of entries) {
                const result = await this.updateOrCreate(
                    entry.pair,
                    entry.completeData,
                    entry.currencyPairId
                );
                results.push(result);
            }

            logger.info(`Bulk cache update completed for ${entries.length} pairs`);
            return results;
        } catch (error) {
            logger.error('Error in bulk cache update:', error);
            throw error;
        }
    }

    /**
     * Delete cache entry by pair
     * @param {string} pair - Currency pair identifier
     * @returns {Promise<boolean>} True if deleted, false if not found
     */
    async deleteByPair(pair) {
        try {
            const deleted = await FxAnalyzerCache.destroy({
                where: { pair }
            });

            if (deleted) {
                logger.info(`Cache deleted for pair: ${pair}`);
            }

            return deleted > 0;
        } catch (error) {
            logger.error(`Error deleting cache for pair ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Delete cache entry by currency pair ID
     * @param {number} currencyPairId - Currency pair ID
     * @returns {Promise<boolean>} True if deleted, false if not found
     */
    async deleteByCurrencyPairId(currencyPairId) {
        try {
            const deleted = await FxAnalyzerCache.destroy({
                where: { currency_pair_id: currencyPairId }
            });

            if (deleted) {
                logger.info(`Cache deleted for currency pair ID: ${currencyPairId}`);
            }

            return deleted > 0;
        } catch (error) {
            logger.error(`Error deleting cache for currency pair ID ${currencyPairId}:`, error);
            throw error;
        }
    }

    /**
     * Clear all cache entries
     * @returns {Promise<number>} Number of deleted entries
     */
    async clearAll() {
        try {
            const deleted = await FxAnalyzerCache.destroy({
                where: {},
                truncate: true
            });

            logger.info(`All cache entries cleared (${deleted} entries)`);
            return deleted;
        } catch (error) {
            logger.error('Error clearing all cache entries:', error);
            throw error;
        }
    }

    /**
     * Get cache statistics
     * @returns {Promise<Object>} Cache statistics
     */
    async getStats() {
        try {
            const total = await FxAnalyzerCache.count();
            const oldestUpdate = await FxAnalyzerCache.findOne({
                order: [['last_updated', 'ASC']],
                attributes: ['last_updated']
            });
            const newestUpdate = await FxAnalyzerCache.findOne({
                order: [['last_updated', 'DESC']],
                attributes: ['last_updated']
            });

            return {
                totalEntries: total,
                oldestUpdate: oldestUpdate?.last_updated,
                newestUpdate: newestUpdate?.last_updated,
            };
        } catch (error) {
            logger.error('Error getting cache statistics:', error);
            throw error;
        }
    }
}
