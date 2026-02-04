/**
 * Cache Update Trigger Service
 * 
 * This service provides helper methods to trigger cache updates when data changes.
 * Use this service in controllers and scrapers after updating any table data.
 */

import { scoreUpdateService } from './scoreUpdateService.js';
import { logger } from '../utils/logger.util.js';
import { DynamicTable, TableRow, TableColumn, CurrencyPair } from '../models/index.js';

class CacheUpdateTriggerService {
    constructor() {
        this.fxAnalyzerTableIdentifier = 'fx_analyzer_pro';

        // Mapping of table identifiers to their impact on cache
        this.tableImpactMap = {
            'fx_analyzer_pro': true,
            'score_dashboard': true,
            // Add other tables that affect fx_analyzer here
        };
    }

    /**
     * Trigger cache update after a cell is updated
     * @param {number} cellId - ID of the updated cell
     * @param {string} columnName - Name of the column that was updated
     */
    async triggerCellUpdate(cellId, columnName) {
        try {
            // Find the cell's row and table to determine which pair to update
            const cell = await this.getCellInfo(cellId);

            if (!cell) {
                logger.warn(`Cell ${cellId} not found for cache update trigger`);
                return;
            }

            // Check if this table impacts the fx_analyzer cache
            if (!this.shouldTriggerCacheUpdate(cell.tableIdentifier)) {
                logger.debug(`Table ${cell.tableIdentifier} doesn't impact cache, skipping`);
                return;
            }

            // Queue cache update for this pair
            if (cell.pair) {
                await scoreUpdateService.queueUpdate(cell.pair, columnName || cell.columnName);
                logger.info(`Cache update queued for ${cell.pair} after cell update in ${cell.tableIdentifier}`);
            }

        } catch (error) {
            logger.error('Error triggering cell update:', error);
        }
    }

    /**
     * Trigger cache update after a row is updated
     * @param {number} rowId - ID of the updated row
     * @param {string} changedColumn - Name of the column that was updated
     */
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

        } catch (error) {
            logger.error('Error triggering row update:', error);
        }
    }

    /**
     * Trigger cache update for a specific pair and table
     * @param {string} pair - Currency pair identifier
     * @param {string} tableIdentifier - Table identifier
     * @param {string} changedColumn - Name of the column that changed
     */
    async triggerPairUpdate(pair, tableIdentifier, changedColumn) {
        try {
            if (!this.shouldTriggerCacheUpdate(tableIdentifier)) {
                logger.debug(`Table ${tableIdentifier} doesn't impact cache, skipping`);
                return;
            }

            await scoreUpdateService.queueUpdate(pair, changedColumn || tableIdentifier);
            logger.info(`Cache update queued for ${pair} in ${tableIdentifier}`);

        } catch (error) {
            logger.error('Error triggering pair update:', error);
        }
    }

    /**
     * Trigger cache update for multiple pairs
     * @param {Array<{pair: string, changedColumn: string}>} updates
     */
    async triggerBulkUpdate(updates) {
        try {
            await scoreUpdateService.queueBulkUpdate(updates);
            logger.info(`Bulk cache update queued for ${updates.length} pairs`);

        } catch (error) {
            logger.error('Error triggering bulk update:', error);
        }
    }

    /**
     * Trigger cache update after table editor cell update
     * @param {string} tableId - Google Sheets table ID
     * @param {string} cell - Cell reference (e.g., "A1")
     * @param {string} tableIdentifier - Dynamic table identifier
     */
    async triggerTableEditorUpdate(tableId, cell, tableIdentifier) {
        try {
            // For table editor updates, we need to determine which pairs are affected
            // This is complex because we need to map the cell to a row/pair

            // For now, we'll trigger update for all pairs in the fx_analyzer table
            // In production, you'd want to parse the cell reference and determine the specific pair

            if (tableIdentifier === this.fxAnalyzerTableIdentifier) {
                logger.info(`Table editor update in ${tableIdentifier}, triggering full refresh`);
                // Queue update for all pairs (will be deduplicated by the service)
                await this.triggerFullRefresh();
            }

        } catch (error) {
            logger.error('Error triggering table editor update:', error);
        }
    }

    /**
     * Trigger full cache refresh for all pairs
     */
    async triggerFullRefresh() {
        try {
            logger.info('Triggering full cache refresh');

            // Get all currency pairs
            const pairs = await CurrencyPair.findAll({
                where: { is_active: true },
                order: [['display_order', 'ASC'], ['code', 'ASC']]
            });

            // Create updates with constructed pair names
            const updates = pairs.map(cp => ({
                pair: `${cp.base_currency}/${cp.quote_currency}`,
                changedColumn: 'full_refresh'
            }));

            await scoreUpdateService.queueBulkUpdate(updates);

            logger.info(`Full refresh queued for ${pairs.length} pairs`);

        } catch (error) {
            logger.error('Error triggering full refresh:', error);
        }
    }

    /**
     * Check if a table impacts the fx_analyzer cache
     * @param {string} tableIdentifier - Table identifier
     * @returns {boolean}
     */
    shouldTriggerCacheUpdate(tableIdentifier) {
        return this.tableImpactMap[tableIdentifier] === true;
    }

    /**
     * Get cell information including its table and currency pair
     * @param {number} cellId - Cell ID
     * @returns {Promise<Object|null>}
     */
    async getCellInfo(cellId) {
        try {
            const { TableCell } = await import('../models/index.js');

            const cell = await TableCell.findByPk(cellId, {
                include: [
                    {
                        model: TableRow,
                        as: 'row',
                        include: [
                            {
                                model: CurrencyPair,
                                as: 'currencyPair',
                            },
                            {
                                model: DynamicTable,
                                as: 'dynamicTable',
                            }
                        ]
                    },
                    {
                        model: TableColumn,
                        as: 'column',
                    }
                ]
            });

            if (!cell) return null;

            return {
                cellId: cell.id,
                columnName: cell.column?.column_name,
                pair: cell.row?.currencyPair?.pair,
                tableIdentifier: cell.row?.dynamicTable?.identifier,
            };

        } catch (error) {
            logger.error('Error getting cell info:', error);
            return null;
        }
    }

    /**
     * Get row information including its table and currency pair
     * @param {number} rowId - Row ID
     * @returns {Promise<Object|null>}
     */
    async getRowInfo(rowId) {
        try {
            const row = await TableRow.findByPk(rowId, {
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                    },
                    {
                        model: DynamicTable,
                        as: 'dynamicTable',
                    }
                ]
            });

            if (!row) return null;

            return {
                rowId: row.id,
                pair: row.currencyPair?.pair,
                tableIdentifier: row.dynamicTable?.identifier,
            };

        } catch (error) {
            logger.error('Error getting row info:', error);
            return null;
        }
    }

    /**
     * Add a table to the impact map
     * @param {string} tableIdentifier - Table identifier
     */
    addTableToImpactMap(tableIdentifier) {
        this.tableImpactMap[tableIdentifier] = true;
        logger.info(`Table ${tableIdentifier} added to cache impact map`);
    }

    /**
     * Remove a table from the impact map
     * @param {string} tableIdentifier - Table identifier
     */
    removeTableFromImpactMap(tableIdentifier) {
        delete this.tableImpactMap[tableIdentifier];
        logger.info(`Table ${tableIdentifier} removed from cache impact map`);
    }
}

// Export singleton instance
export const cacheUpdateTrigger = new CacheUpdateTriggerService();
