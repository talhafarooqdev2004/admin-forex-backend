import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import { parseJsonText, serializePrisma, stringifyJsonText } from '../utils/prisma.util.js';
const cacheInclude = {
    currencyPair: true,
};
const mapCacheEntry = (entry) => {
    const serialized = serializePrisma(entry);
    if (!serialized) {
        return serialized;
    }
    return {
        ...serialized,
        complete_data: parseJsonText(serialized.complete_data),
    };
};
export class FxAnalyzerCacheRepository {
    async findByPair(pair) {
        try {
            const cached = await prisma.fxAnalyzerCache.findUnique({
                where: { pair },
                include: cacheInclude,
            });
            return mapCacheEntry(cached);
        }
        catch (error) {
            logger.error(`Error finding cache for pair ${pair}:`, error);
            throw error;
        }
    }
    async findByCurrencyPairId(currencyPairId) {
        try {
            const cached = await prisma.fxAnalyzerCache.findFirst({
                where: {
                    currency_pair_id: BigInt(currencyPairId),
                },
                include: cacheInclude,
            });
            return mapCacheEntry(cached);
        }
        catch (error) {
            logger.error(`Error finding cache for currency pair ID ${currencyPairId}:`, error);
            throw error;
        }
    }
    async findAll() {
        try {
            const entries = await prisma.fxAnalyzerCache.findMany({
                include: cacheInclude,
                orderBy: {
                    pair: 'asc',
                },
            });
            return entries.map(mapCacheEntry);
        }
        catch (error) {
            logger.error('Error finding all cache entries:', error);
            throw error;
        }
    }
    async updateOrCreate(pair, completeData, currencyPairId = null) {
        try {
            await prisma.fxAnalyzerCache.upsert({
                where: { pair },
                update: {
                    currency_pair_id: currencyPairId !== null && currencyPairId !== undefined ? BigInt(currencyPairId) : null,
                    complete_data: stringifyJsonText(completeData),
                    last_updated: new Date(),
                },
                create: {
                    pair,
                    currency_pair_id: currencyPairId !== null && currencyPairId !== undefined ? BigInt(currencyPairId) : null,
                    complete_data: stringifyJsonText(completeData),
                    last_updated: new Date(),
                },
            });
            logger.info(`Cache updated for pair: ${pair}`);
            return this.findByPair(pair);
        }
        catch (error) {
            logger.error(`Error updating/creating cache for pair ${pair}:`, error);
            throw error;
        }
    }
    async bulkUpdateOrCreate(entries) {
        try {
            const results = [];
            for (const entry of entries) {
                const result = await this.updateOrCreate(entry.pair, entry.completeData, entry.currencyPairId);
                results.push(result);
            }
            logger.info(`Bulk cache update completed for ${entries.length} pairs`);
            return results;
        }
        catch (error) {
            logger.error('Error in bulk cache update:', error);
            throw error;
        }
    }
    async deleteByPair(pair) {
        try {
            const deleted = await prisma.fxAnalyzerCache.deleteMany({
                where: { pair },
            });
            if (deleted.count) {
                logger.info(`Cache deleted for pair: ${pair}`);
            }
            return deleted.count > 0;
        }
        catch (error) {
            logger.error(`Error deleting cache for pair ${pair}:`, error);
            throw error;
        }
    }
    async deleteByCurrencyPairId(currencyPairId) {
        try {
            const deleted = await prisma.fxAnalyzerCache.deleteMany({
                where: {
                    currency_pair_id: BigInt(currencyPairId),
                },
            });
            if (deleted.count) {
                logger.info(`Cache deleted for currency pair ID: ${currencyPairId}`);
            }
            return deleted.count > 0;
        }
        catch (error) {
            logger.error(`Error deleting cache for currency pair ID ${currencyPairId}:`, error);
            throw error;
        }
    }
    async clearAll() {
        try {
            const deleted = await prisma.fxAnalyzerCache.deleteMany();
            logger.info(`All cache entries cleared (${deleted.count} entries)`);
            return deleted.count;
        }
        catch (error) {
            logger.error('Error clearing all cache entries:', error);
            throw error;
        }
    }
    async getStats() {
        try {
            const total = await prisma.fxAnalyzerCache.count();
            const oldestUpdate = await prisma.fxAnalyzerCache.findFirst({
                orderBy: {
                    last_updated: 'asc',
                },
                select: {
                    last_updated: true,
                },
            });
            const newestUpdate = await prisma.fxAnalyzerCache.findFirst({
                orderBy: {
                    last_updated: 'desc',
                },
                select: {
                    last_updated: true,
                },
            });
            return {
                totalEntries: total,
                oldestUpdate: oldestUpdate?.last_updated,
                newestUpdate: newestUpdate?.last_updated,
            };
        }
        catch (error) {
            logger.error('Error getting cache statistics:', error);
            throw error;
        }
    }
}
