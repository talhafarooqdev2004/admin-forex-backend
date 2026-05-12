import { scoreUpdateService } from './scoreUpdateService.js';
import { logger } from '../utils/logger.util.js';
import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
class CacheUpdateTriggerService {
    constructor() {
        this.fxAnalyzerTableIdentifier = 'fx_analyzer_pro';
        this.tableImpactMap = {
            'fx_analyzer_pro': true,
            'score_dashboard': true,
        };
    }
    async triggerCellUpdate(cellId, columnName) {
        try {
            const cell = await this.getCellInfo(cellId);
            if (!cell) {
                logger.warn(`Cell ${cellId} not found for cache update trigger`);
                return;
            }
            if (!this.shouldTriggerCacheUpdate(cell.tableIdentifier)) {
                logger.debug(`Table ${cell.tableIdentifier} doesn't impact cache, skipping`);
                return;
            }
            if (cell.pair) {
                await scoreUpdateService.queueUpdate(cell.pair, columnName || cell.columnName);
                logger.info(`Cache update queued for ${cell.pair} after cell update in ${cell.tableIdentifier}`);
            }
        }
        catch (error) {
            logger.error('Error triggering cell update:', error);
        }
    }
    async triggerRowUpdate(rowId, changedColumn) {
        try {
            const row = await this.getRowInfo(rowId);
            if (!row) {
                logger.warn(`Row ${rowId} not found for cache update trigger`);
                return;
            }
            if (!this.shouldTriggerCacheUpdate(row.tableIdentifier)) {
                logger.debug(`Table ${row.tableIdentifier} doesn't impact cache, skipping`);
                return;
            }
            if (row.pair) {
                await scoreUpdateService.queueUpdate(row.pair, changedColumn || 'row_update');
                logger.info(`Cache update queued for ${row.pair} after row update in ${row.tableIdentifier}`);
            }
        }
        catch (error) {
            logger.error('Error triggering row update:', error);
        }
    }
    async triggerPairUpdate(pair, tableIdentifier, changedColumn) {
        try {
            if (!this.shouldTriggerCacheUpdate(tableIdentifier)) {
                logger.debug(`Table ${tableIdentifier} doesn't impact cache, skipping`);
                return;
            }
            await scoreUpdateService.queueUpdate(pair, changedColumn || tableIdentifier);
            logger.info(`Cache update queued for ${pair} in ${tableIdentifier}`);
        }
        catch (error) {
            logger.error('Error triggering pair update:', error);
        }
    }
    async triggerBulkUpdate(updates) {
        try {
            await scoreUpdateService.queueBulkUpdate(updates);
            logger.info(`Bulk cache update queued for ${updates.length} pairs`);
        }
        catch (error) {
            logger.error('Error triggering bulk update:', error);
        }
    }
    async triggerTableEditorUpdate(tableId, cell, tableIdentifier) {
        try {
            if (tableIdentifier === this.fxAnalyzerTableIdentifier) {
                logger.info(`Table editor update in ${tableIdentifier}, triggering full refresh`);
                await this.triggerFullRefresh();
            }
        }
        catch (error) {
            logger.error('Error triggering table editor update:', error);
        }
    }
    async triggerFullRefresh() {
        try {
            logger.info('Triggering full cache refresh');
            const pairs = await prisma.currencyPair.findMany({
                where: { is_active: true },
                orderBy: [
                    { display_order: 'asc' },
                    { code: 'asc' },
                ],
            });
            const updates = pairs.map(cp => ({
                pair: `${cp.base_currency}/${cp.quote_currency}`,
                changedColumn: 'full_refresh'
            }));
            await scoreUpdateService.queueBulkUpdate(updates);
            logger.info(`Full refresh queued for ${pairs.length} pairs`);
        }
        catch (error) {
            logger.error('Error triggering full refresh:', error);
        }
    }
    shouldTriggerCacheUpdate(tableIdentifier) {
        return this.tableImpactMap[tableIdentifier] === true;
    }
    async getCellInfo(cellId) {
        try {
            const cell = await prisma.tableCell.findUnique({
                where: {
                    id: BigInt(cellId),
                },
                include: {
                    row: {
                        include: {
                            currencyPair: true,
                            table: true,
                        },
                    },
                    column: true,
                },
            });
            if (!cell)
                return null;
            const serialized = serializePrisma(cell);
            return {
                cellId: serialized.id,
                columnName: serialized.column?.header || serialized.column?.column_name,
                pair: serialized.row?.currencyPair
                    ? `${serialized.row.currencyPair.base_currency}/${serialized.row.currencyPair.quote_currency}`
                    : null,
                tableIdentifier: serialized.row?.table?.identifier,
            };
        }
        catch (error) {
            logger.error('Error getting cell info:', error);
            return null;
        }
    }
    async getRowInfo(rowId) {
        try {
            const row = await prisma.tableRow.findUnique({
                where: {
                    id: BigInt(rowId),
                },
                include: {
                    currencyPair: true,
                    table: true,
                },
            });
            if (!row)
                return null;
            const serialized = serializePrisma(row);
            return {
                rowId: serialized.id,
                pair: serialized.currencyPair
                    ? `${serialized.currencyPair.base_currency}/${serialized.currencyPair.quote_currency}`
                    : null,
                tableIdentifier: serialized.table?.identifier,
            };
        }
        catch (error) {
            logger.error('Error getting row info:', error);
            return null;
        }
    }
    addTableToImpactMap(tableIdentifier) {
        this.tableImpactMap[tableIdentifier] = true;
        logger.info(`Table ${tableIdentifier} added to cache impact map`);
    }
    removeTableFromImpactMap(tableIdentifier) {
        delete this.tableImpactMap[tableIdentifier];
        logger.info(`Table ${tableIdentifier} removed from cache impact map`);
    }
}
export const cacheUpdateTrigger = new CacheUpdateTriggerService();
