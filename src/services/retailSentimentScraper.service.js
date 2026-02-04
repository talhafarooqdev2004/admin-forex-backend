import { ForexClientSentimentScraperService } from './forexClientSentimentScraper.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { TableCell } from '../models/index.js';
import { logger } from '../utils/logger.util.js';
import { emailService } from './email.service.js';

/**
 * Service that orchestrates scraping and updating retail sentiment data
 */
export class RetailSentimentScraperService {
    constructor(scraperService, repository, websocketService) {
        this.scraperService = scraperService || new ForexClientSentimentScraperService();
        this.repository = repository || new DynamicTableRepository();
        this.websocketService = websocketService;
        this.tableIdentifier = 'retail_sentiment_currency_pairs';
        this.isScraping = false;
        this.consecutiveFailures = 0; // Track consecutive failures
        this.lastFailureError = null; // Store last error message
        this.failureThresholdForEmail = 3; // Send email after 3 consecutive failures
        this.emailSentForCurrentStreak = false; // Track if email was already sent for current failure streak
    }

    /**
     * Converts Excel column letter to zero-based index (A=0, B=1, C=2, etc.)
     * @param {string} colLetter - Column letter (e.g., "A", "B", "AA")
     * @returns {number} Zero-based column index
     */
    columnLetterToIndex(colLetter) {
        let result = 0;
        for (let i = 0; i < colLetter.length; i++) {
            result = result * 26 + (colLetter.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
        }
        return result - 1; // Convert to zero-based
    }

    /**
     * Evaluates an Excel-style formula with cell references (e.g., "=IF(B1 > 85, -1, IF(B1 < 15, 1, 0))")
     * @param {string} formula - Formula string with cell references
     * @param {Object} row - The table row object with cells
     * @param {Array} columns - Array of column objects sorted by column_index
     * @returns {number} Calculated result
     */
    evaluateFormula(formula, row, columns) {
        try {
            // Remove leading '=' if present
            let expression = formula.trim();
            if (expression.startsWith('=')) {
                expression = expression.substring(1).trim();
            }

            // Replace cell references (e.g., B1, C1) with actual values
            // Pattern: letter(s) followed by number(s) - e.g., A1, B2, AA10
            const cellRefPattern = /([A-Z]+)(\d+)/gi;
            const cellValues = {};

            // Find all cell references and replace them with values
            let match;
            while ((match = cellRefPattern.exec(expression)) !== null) {
                const colLetter = match[1].toUpperCase();
                const rowNum = parseInt(match[2], 10);
                const cellRef = match[0].toUpperCase();

                // Skip if we've already processed this cell reference
                if (cellValues[cellRef] !== undefined) {
                    continue;
                }

                // Convert column letter to index (A=0, B=1, C=2, etc.)
                const colIndex = this.columnLetterToIndex(colLetter);

                // Get the column object
                const column = columns[colIndex];
                if (!column) {
                    logger.warn(`Column ${colLetter} (index ${colIndex}) not found in formula: ${formula}`);
                    cellValues[cellRef] = 0;
                    continue;
                }

                // Get the cell value from the row
                const cell = row.cells?.find(c => c.table_column_id === column.id);
                const cellValue = cell ? parseFloat(cell.value || 0) : 0;

                cellValues[cellRef] = cellValue;
            }

            // Replace all cell references with their values
            let processedExpression = expression;
            for (const [cellRef, value] of Object.entries(cellValues)) {
                // Replace cell reference with its value (case-insensitive)
                const regex = new RegExp(cellRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                processedExpression = processedExpression.replace(regex, value.toString());
            }

            // Handle Excel IF function: IF(condition, value_if_true, value_if_false)
            // Replace IF statements with JavaScript ternary operators
            // Handle nested IFs by repeating the replacement
            let previousExpression = '';
            while (previousExpression !== processedExpression) {
                previousExpression = processedExpression;
                processedExpression = processedExpression.replace(
                    /IF\s*\(([^,]+),\s*([^,]+),\s*([^)]+)\)/gi,
                    (match, condition, trueValue, falseValue) => {
                        return `(${condition.trim()} ? ${trueValue.trim()} : ${falseValue.trim()})`;
                    }
                );
            }

            // Evaluate the expression safely
            const result = new Function('return ' + processedExpression)();

            // Round to 2 decimal places
            return Math.round(result * 100) / 100;
        } catch (error) {
            logger.error(`Error evaluating formula "${formula}": ${error.message}`);
            throw error;
        }
    }

    /**
     * Scrapes sentiment data and updates the database
     * @returns {Promise<{success: boolean, updated: number, error: string|null}>}
     */
    async scrapeAndUpdate() {
        // Prevent concurrent scraping
        if (this.isScraping) {
            logger.warn('Retail sentiment scraping already in progress, skipping this run');
            return { success: false, updated: 0, error: 'Scraping already in progress' };
        }

        this.isScraping = true;
        this.scrapeStartTime = Date.now();

        try {
            logger.info('Starting retail sentiment scraping');

            // Get the table
            const table = await this.repository.findByIdentifier(this.tableIdentifier);
            if (!table) {
                return { success: false, updated: 0, error: 'Table not found' };
            }

            // Sort columns and rows by index
            const columns = [...table.columns].sort((a, b) => a.column_index - b.column_index);
            const rows = [...table.rows].sort((a, b) => a.row_index - b.row_index);

            if (columns.length < 3) {
                return { success: false, updated: 0, error: 'Table structure invalid' };
            }

            // Column 0: Pair name, Column 1: Long %, Column 2: Short %, Column 3: Score (last column)
            const pairColumn = columns[0];
            const longColumn = columns[1];
            const shortColumn = columns[2];
            const scoreColumn = columns[columns.length - 1]; // Last column is score

            // Scrape the sentiment data
            const scrapedData = await this.scraperService.scrapeSentimentData();

            if (!scrapedData || scrapedData.length === 0) {
                this.consecutiveFailures++;
                this.lastFailureError = 'Failed to scrape sentiment data or no data returned after retries';

                // Send email notification if failures reach 3
                if (this.consecutiveFailures >= 3) {
                    await emailService.sendScraperFailureNotification(
                        'Retail Sentiment Scraper',
                        this.lastFailureError,
                        this.consecutiveFailures
                    );
                }

                return { success: false, updated: 0, error: 'Failed to scrape data' };
            }

            // Reset failure count on success
            if (this.consecutiveFailures > 0) {
                this.consecutiveFailures = 0;
                this.lastFailureError = null;
            }

            // Update database
            let updatedCount = 0;
            const updatedPairs = [];
            let notFoundCount = 0;

            for (const sentimentItem of scrapedData) {
                let { pair, long, short } = sentimentItem;
                const scrapedPairUpper = pair.toUpperCase();

                // Normalize long and short values to ensure they sum to 100 (always integers)
                const originalLong = parseFloat(long);
                const originalShort = parseFloat(short);
                const sum = originalLong + originalShort;

                if (Math.abs(sum - 100) > 0.01) { // Allow small floating point differences
                    // Calculate the difference needed to reach 100
                    const difference = 100 - sum;

                    // Round original values to integers first
                    long = Math.round(originalLong);
                    short = Math.round(originalShort);

                    // Adjust to make sum exactly 100
                    // Always adjust the smaller value when adding, or the larger value when subtracting
                    if (difference > 0) {
                        // Sum is less than 100, add difference to the smaller value
                        if (long <= short) {
                            long = long + difference;
                        } else {
                            short = short + difference;
                        }
                    } else {
                        // Sum is greater than 100, subtract difference from the larger value
                        // difference is negative, so adding it subtracts
                        if (long >= short) {
                            long = long + difference;
                        } else {
                            short = short + difference;
                        }
                    }

                    logger.info(`Normalized ${pair}: original long=${sentimentItem.long}, short=${sentimentItem.short}, sum=${sum} -> normalized long=${long}, short=${short}, sum=${long + short}`);
                } else {
                    // Sum is already 100, just ensure values are integers
                    long = Math.round(originalLong);
                    short = Math.round(originalShort);
                }

                // Find the row with matching pair name (case-insensitive)
                let targetRow = null;

                for (const row of rows) {
                    if (!row.cells || row.cells.length === 0) {
                        continue;
                    }
                    const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                    if (!pairCell) {
                        continue;
                    }
                    const pairValue = (pairCell.value || '').trim().toUpperCase();

                    if (pairValue === scrapedPairUpper) {
                        targetRow = row;
                        break;
                    }
                }

                if (!targetRow) {
                    notFoundCount++;
                    if (notFoundCount <= 5) {
                        logger.warn(`Row not found for pair: ${pair} (scraped: "${scrapedPairUpper}")`);
                        // Show all DB pairs for debugging
                        const allDbPairs = rows.map(r => {
                            const pc = r.cells?.find(c => c.table_column_id === pairColumn.id);
                            return pc?.value?.trim().toUpperCase() || 'N/A';
                        }).filter(p => p !== 'N/A');
                        logger.info(`All DB pairs (${allDbPairs.length}): ${allDbPairs.join(', ')}`);
                    }
                    continue;
                }

                // Found matching row
                if (updatedPairs.length === 0) {
                    logger.info(`Found match for ${pair} - row ID: ${targetRow.id}, scraped long: ${long}, short: ${short}`);
                }

                // Update long value
                const longCell = targetRow.cells?.find(cell => cell.table_column_id === longColumn.id);
                if (longCell) {
                    const currentLong = parseFloat(longCell.value || 0);
                    if (updatedPairs.length < 3) {
                        logger.info(`Pair ${pair}: Long cell found - current: ${currentLong}, scraped: ${long}, match: ${currentLong === long}`);
                    }
                    if (currentLong !== long) {
                        await TableCell.update(
                            { value: long.toString() },
                            {
                                where: {
                                    id: longCell.id
                                }
                            }
                        );
                        updatedCount++;
                        if (updatedPairs.length < 3) {
                            logger.info(`Updated long for ${pair}: ${currentLong} -> ${long}`);
                        }
                    }
                } else {
                    // Create cell if it doesn't exist
                    logger.info(`Creating long cell for ${pair} (cell doesn't exist)`);
                    await TableCell.create({
                        table_row_id: targetRow.id,
                        table_column_id: longColumn.id,
                        value: long.toString(),
                        data_type: 'number',
                    });
                    updatedCount++;
                }

                // Update short value
                const shortCell = targetRow.cells?.find(cell => cell.table_column_id === shortColumn.id);
                if (shortCell) {
                    const currentShort = parseFloat(shortCell.value || 0);
                    if (updatedPairs.length < 3) {
                        logger.info(`Pair ${pair}: Short cell found - current: ${currentShort}, scraped: ${short}, match: ${currentShort === short}`);
                    }
                    if (currentShort !== short) {
                        await TableCell.update(
                            { value: short.toString() },
                            {
                                where: {
                                    id: shortCell.id
                                }
                            }
                        );
                        updatedCount++;
                        if (updatedPairs.length < 3) {
                            logger.info(`Updated short for ${pair}: ${currentShort} -> ${short}`);
                        }
                    }
                } else {
                    // Create cell if it doesn't exist
                    logger.info(`Creating short cell for ${pair} (cell doesn't exist)`);
                    await TableCell.create({
                        table_row_id: targetRow.id,
                        table_column_id: shortColumn.id,
                        value: short.toString(),
                        data_type: 'number',
                    });
                    updatedCount++;
                }

                // Calculate and update score using formula from score column
                if (scoreColumn) {
                    const scoreCell = targetRow.cells?.find(cell => cell.table_column_id === scoreColumn.id);

                    // Check if there is a formula in the dedicated 'formula' field
                    const formula = scoreCell?.formula || '';

                    if (formula && formula.trim().startsWith('=')) {
                        try {
                            const calculatedScore = this.evaluateFormula(formula, targetRow, columns);

                            await TableCell.update(
                                { value: calculatedScore.toString() },
                                {
                                    where: {
                                        id: scoreCell.id
                                    }
                                }
                            );
                            updatedCount++;
                        } catch (error) {
                            // Ignore formula errors
                        }
                    } else {
                        // Fallback: check if the value itself contains a formula
                        const cellValue = scoreCell?.value || '';
                        if (cellValue && cellValue.trim().startsWith('=')) {
                            try {
                                const calculatedScore = this.evaluateFormula(cellValue, targetRow, columns);
                                await TableCell.update(
                                    { value: calculatedScore.toString() },
                                    { where: { id: scoreCell.id } }
                                );
                                updatedCount++;
                            } catch (error) {
                                // Ignore formula errors
                            }
                        }
                    }
                }

                updatedPairs.push({ pair, long, short });
            }

            logger.info(`Retail sentiment scraping completed: ${updatedPairs.length} currency pairs updated`);

            // Emit WebSocket event if data was updated
            if (updatedCount > 0 && this.websocketService) {
                this.websocketService.emitRetailSentimentUpdate(updatedPairs);
            }

            return {
                success: true,
                updated: updatedCount,
                pairsUpdated: updatedPairs.length,
                error: null,
            };

        } catch (error) {
            this.consecutiveFailures++;
            this.lastFailureError = error.message;

            // Send email notification only once when failures reach threshold
            if (this.consecutiveFailures >= this.failureThresholdForEmail && !this.emailSentForCurrentStreak) {
                await emailService.sendScraperFailureNotification(
                    'Retail Sentiment Scraper',
                    error.message,
                    this.consecutiveFailures
                );
                this.emailSentForCurrentStreak = true; // Mark email as sent
            }

            return { success: false, updated: 0, error: error.message };
        } finally {
            this.isScraping = false;
        }
    }
}
