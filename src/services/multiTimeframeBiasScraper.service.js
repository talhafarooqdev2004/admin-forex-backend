import { CurrencyStrengthScraperService } from './currencyStrengthScraper.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { TableCell, TableRow } from '../models/index.js';
import { logger } from '../utils/logger.util.js';
import { googleSheetsService } from './googleSheets.service.js';

/**
 * Service that orchestrates scraping and updating the Multi-Timeframe Bias Scoreboard
 */
export class MultiTimeframeBiasScraperService {
    constructor(scraperService, repository, websocketService) {
        this.scraperService = scraperService || new CurrencyStrengthScraperService();
        this.repository = repository || new DynamicTableRepository();
        this.websocketService = websocketService;
        this.tableIdentifier = 'multi_timeframe_bias_scoreboard';
        this.isScraping = false;
    }

    /**
     * Scrapes and updates the Multi-Timeframe Bias Scoreboard
     * @returns {Promise<{success: boolean, updated: number, error: string|null}>}
     */
    async scrapeAndUpdate() {
        if (this.isScraping) {
            logger.warn('Multi-Timeframe Bias Scoreboard scraping already in progress, skipping this run');
            return { success: false, updated: 0, error: 'Scraping already in progress' };
        }

        this.isScraping = true;
        let updatedCount = 0;

        try {
            logger.info('Starting Multi-Timeframe Bias Scoreboard scraping and update');

            // 1. Get the table
            const table = await this.repository.findByIdentifier(this.tableIdentifier);
            if (!table) {
                logger.error(`Table with identifier "${this.tableIdentifier}" not found`);
                return { success: false, updated: 0, error: 'Table not found' };
            }

            const columns = [...table.columns].sort((a, b) => a.column_index - b.column_index);
            const rows = [...table.rows].sort((a, b) => a.row_index - b.row_index);

            // Columns as per user request:
            // 1st col (index 0): Currency
            // 2nd col (index 1): ULTF
            // 3rd col (index 2): LTF
            // 6th col (index 5): Scalping Score

            const colCurrency = columns.find(c => c.column_index === 0);
            const colULTF = columns.find(c => c.column_index === 1);
            const colLTF = columns.find(c => c.column_index === 2);
            const colScalping = columns.find(c => c.column_index === 5);

            if (!colCurrency || !colULTF || !colLTF || !colScalping) {
                logger.error('Multi-Timeframe Bias Scoreboard table structure invalid: missing required columns');
                return { success: false, updated: 0, error: 'Table structure invalid' };
            }

            // 2. Scrape data
            const scrapedData = await this.scraperService.scrapeStrength();

            if (!scrapedData || scrapedData.length === 0) {
                logger.warn('No data scraped from currency strength meter');
                return { success: false, updated: 0, error: 'Failed to scrape data' };
            }

            // 3. Prepare data for update
            // We need to match currencies in the table with scraped data
            const currencyToScoreMap = new Map();
            scrapedData.forEach(item => {
                currencyToScoreMap.set(item.currency, item.score);
            });

            // 4. Update ULTF and collect scores for normalization
            const rowScores = [];
            const rowsToUpdate = [];

            for (const row of rows) {
                const currencyCell = row.cells?.find(c => c.table_column_id === colCurrency.id);
                if (!currencyCell || !currencyCell.value) continue;

                const currency = currencyCell.value.trim().toUpperCase();
                const score = currencyToScoreMap.get(currency);

                if (score !== undefined) {
                    rowScores.push(score);
                    rowsToUpdate.push({
                        row,
                        score
                    });
                }
            }

            if (rowScores.length === 0) {
                logger.warn('No matching currencies found between table and scraped data');
                return { success: true, updated: 0, error: null };
            }

            /* 
            // 5. Apply formula for LTF and Scalping Score manually (Commented out as requested)
            // Formula: ROUND(PERCENTRANK.INC($B$1:$B$9,B1)*10-5,0)

            const calculatePercentRank = (allScores, x) => {
                if (allScores.length <= 1) return 0.5;

                const sorted = [...allScores].sort((a, b) => a - b);
                const min = sorted[0];
                const max = sorted[sorted.length - 1];

                if (x === max) return 1.0;
                if (x === min) return 0.0;

                const countLess = sorted.filter(v => v < x).length;
                return countLess / (sorted.length - 1);
            };
            */

            const totalRows = rows.length;
            const range = `$B$1:$B$${totalRows}`;

            // 5. Update Google Sheets with new ULTF values and set formulas for LTF/Scalping scores
            const gsUpdates = [];
            for (const item of rowsToUpdate) {
                const { row, score } = item;
                const rowIndex = row.row_index + 1;
                // Column B (index 1) is ULTF - update with the score value
                gsUpdates.push({ cell: `B${rowIndex}`, value: score.toString() });

                // Column C (index 2) is LTF - set formula: ROUND(PERCENTRANK.INC($B$1:$B$N,B{rowIndex})*10-5,0)
                const ltfFormula = `=ROUND(PERCENTRANK.INC(${range},B${rowIndex})*10-5,0)`;
                gsUpdates.push({ cell: `C${rowIndex}`, value: ltfFormula });

                // Column F (index 5) is Scalping Score - same formula as LTF
                const scalpingFormula = `=ROUND(PERCENTRANK.INC(${range},B${rowIndex})*10-5,0)`;
                gsUpdates.push({ cell: `F${rowIndex}`, value: scalpingFormula });
            }

            if (gsUpdates.length > 0) {
                logger.info(`Updating ${rowsToUpdate.length} rows in Google Sheets (ULTF values + LTF/Scalping formulas) for ${this.tableIdentifier}`);
                await googleSheetsService.batchUpdateCells(this.tableIdentifier, gsUpdates);

                // Wait briefly for Google Sheets to calculate the formulas
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Get calculated values back from Google Sheets
                const allValues = await googleSheetsService.getAllValues(this.tableIdentifier);

                for (const item of rowsToUpdate) {
                    const { row, score } = item;
                    const rowIndex = row.row_index; // 0-based for array index

                    // Column index mapping:
                    // A (0): Currency
                    // B (1): ULTF
                    // C (2): LTF
                    // D (3): ...
                    // E (4): ...
                    // F (5): Scalping Score

                    const rowData = allValues[rowIndex] || [];
                    const ltfValue = rowData[2] || '0';
                    const scalpingValue = rowData[5] || '0';

                    // Formula for LTF and Scalping Score
                    const formula = `=ROUND(PERCENTRANK.INC(${range},B${row.row_index + 1})*10-5,0)`;

                    // Update ULTF (column index 1) in DB - value only, no formula
                    updatedCount += await this.updateOrCreateCell(row.id, colULTF.id, score.toString(), null);

                    // Update LTF (column index 2) in DB - store both value and formula
                    updatedCount += await this.updateOrCreateCell(row.id, colLTF.id, ltfValue.toString(), formula);

                    // Update Scalping Score (column index 5) in DB - store both value and formula
                    updatedCount += await this.updateOrCreateCell(row.id, colScalping.id, scalpingValue.toString(), formula);
                }
            }

            logger.info(`Multi-Timeframe Bias Scoreboard update completed. Total cells updated/checked: ${updatedCount}`);

            // 6. WebSocket notification
            if (updatedCount > 0 && this.websocketService) {
                this.websocketService.emitTableUpdate(this.tableIdentifier);
            }

            return { success: true, updated: updatedCount, error: null };

        } catch (error) {
            logger.error(`Error in MultiTimeframeBiasScraperService: ${error.message}`);
            return { success: false, updated: 0, error: error.message };
        } finally {
            this.isScraping = false;
        }
    }

    /**
     * Helper to update or create a cell
     * @returns {Promise<number>} 1 if updated, 0 if no change
     */
    async updateOrCreateCell(rowId, columnId, value, formula = null) {
        const existingCell = await TableCell.findOne({
            where: {
                table_row_id: rowId,
                table_column_id: columnId,
                user_id: null
            }
        });

        if (existingCell) {
            const hasValueChanged = existingCell.value !== value;
            const hasFormulaChanged = existingCell.formula !== formula;

            if (hasValueChanged || hasFormulaChanged) {
                await existingCell.update({
                    value,
                    formula: formula || existingCell.formula
                });
                return 1;
            }
            return 0;
        } else {
            await TableCell.create({
                table_row_id: rowId,
                table_column_id: columnId,
                user_id: null,
                value: value,
                formula: formula,
                data_type: 'string'
            });
            return 1;
        }
    }
}
