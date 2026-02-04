import { HeatMapScraperService } from './heatMapScraper.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { TableCell } from '../models/index.js';
import { logger } from '../utils/logger.util.js';

/**
 * Service that orchestrates scraping and updating the Risk Mode Additional Table
 */
export class RiskModeAdditionalTableScraperService {
    constructor(scraperService, repository, websocketService) {
        this.scraperService = scraperService || new HeatMapScraperService();
        this.repository = repository || new DynamicTableRepository();
        this.websocketService = websocketService;
        this.tableIdentifier = 'risk_mode_additional_table';
        this.isScraping = false;
    }

    /**
     * Scrapes and updates the Risk Mode Additional Table
     * @returns {Promise<{success: boolean, updated: number, error: string|null}>}
     */
    async scrapeAndUpdate() {
        if (this.isScraping) {
            logger.warn('Heat Map scraping already in progress, skipping this run');
            return { success: false, updated: 0, error: 'Scraping already in progress' };
        }

        this.isScraping = true;
        let updatedCount = 0;

        try {
            logger.info('Starting Risk Mode Additional Table update');

            // 1. Get the table
            const table = await this.repository.findByIdentifier(this.tableIdentifier);
            if (!table) {
                logger.error(`Table with identifier "${this.tableIdentifier}" not found`);
                return { success: false, updated: 0, error: 'Table not found' };
            }

            const columns = [...table.columns].sort((a, b) => a.column_index - b.column_index);
            const rows = [...table.rows].sort((a, b) => a.row_index - b.row_index);

            if (columns.length < 9) {
                logger.error('Table structure invalid: not enough columns (need 9)');
                return { success: false, updated: 0, error: 'Table structure invalid' };
            }

            // Map columns
            const colMap = {
                pair: columns[0],
                m1: columns[1],
                m5: columns[2],
                m15: columns[3],
                m30: columns[4],
                h1: columns[5],
                h4: columns[6],
                d1: columns[7],
                w1: columns[8]
            };

            // 2. Scrape data
            const scrapedData = await this.scraperService.scrapeHeatMap();

            if (!scrapedData || scrapedData.length === 0) {
                return { success: false, updated: 0, error: 'Failed to scrape data' };
            }

            // 3. Update cells
            for (const item of scrapedData) {
                const pairUpper = item.pair.replace('/', '').toUpperCase(); // Heat map might have EUR/USD, we want EURUSD

                // Find matching row
                let targetRow = rows.find(row => {
                    const cell = row.cells?.find(c => c.table_column_id === colMap.pair.id);
                    const dbPair = cell?.value?.replace('/', '').toUpperCase() || '';
                    return dbPair === pairUpper || pairUpper.includes(dbPair) || dbPair.includes(pairUpper);
                });

                if (!targetRow) continue;

                // Update each timeframe
                const timeframes = ['m1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1', 'w1'];
                for (const tf of timeframes) {
                    const column = colMap[tf];
                    const newValue = item[tf];
                    const existingCell = targetRow.cells?.find(c => c.table_column_id === column.id);

                    if (existingCell) {
                        if (existingCell.value !== newValue) {
                            await TableCell.update(
                                { value: newValue },
                                { where: { id: existingCell.id } }
                            );
                            updatedCount++;
                        }
                    } else {
                        await TableCell.create({
                            table_row_id: targetRow.id,
                            table_column_id: column.id,
                            value: newValue,
                            data_type: 'string'
                        });
                        updatedCount++;
                    }
                }
            }

            logger.info(`Risk Mode Additional Table update completed. Total cells updated: ${updatedCount}`);

            // 4. WebSocket notification
            if (updatedCount > 0 && this.websocketService) {
                this.websocketService.emitTableUpdate(this.tableIdentifier);
            }

            return { success: true, updated: updatedCount, error: null };

        } catch (error) {
            logger.error(`Error in RiskModeAdditionalTableScraperService: ${error.message}`);
            return { success: false, updated: 0, error: error.message };
        } finally {
            this.isScraping = false;
        }
    }
}
