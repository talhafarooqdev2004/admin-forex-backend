import { FxAnalyzerCacheRepository } from '../repositories/fxAnalyzerCache.repository.js';
import { ScoreDashboardRepository } from '../repositories/scoreDashboard.repository.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { CurrencyPair } from '../models/index.js';
import { logger } from '../utils/logger.util.js';
import { sequelize } from '../models/index.js';

/**
 * ScoreUpdateService
 * Event-driven service that manages cache updates for FX Analyzer data.
 * Listens for updates from column-specific tables and ensures main score table and cache remain synchronized.
 */
class ScoreUpdateService {
    constructor() {
        this.updateQueue = [];
        this.isProcessing = false;
        this.cacheRepository = new FxAnalyzerCacheRepository();
        this.scoreDashboardRepository = new ScoreDashboardRepository();
        this.dynamicTableRepository = new DynamicTableRepository();

        // Configuration
        this.config = {
            batchSize: 10, // Process up to 10 pairs at once
            debounceTime: 500, // Wait 500ms before processing queue
            maxRetries: 3, // Maximum retry attempts for failed updates
        };

        this.debounceTimer = null;
    }

    /**
     * Find currency pair by pair string (e.g., "EUR/USD")
     * @param {string} pair - Pair string in format "BASE/QUOTE"
     * @returns {Promise<Object|null>} Currency pair object or null
     */
    async findCurrencyPair(pair) {
        try {
            const [baseCurrency, quoteCurrency] = pair.split('/');
            if (!baseCurrency || !quoteCurrency) {
                logger.error(`Invalid pair format: ${pair}`);
                return null;
            }

            const currencyPair = await CurrencyPair.findOne({
                where: {
                    base_currency: baseCurrency.toUpperCase(),
                    quote_currency: quoteCurrency.toUpperCase(),
                    is_active: true
                }
            });

            return currencyPair;
        } catch (error) {
            logger.error(`Error finding currency pair ${pair}:`, error);
            return null;
        }
    }

    /**
     * Queue an update for a specific currency pair
     * Called whenever ANY column-specific table updates
     * @param {string} pair - Currency pair identifier (e.g., "EUR/USD")
     * @param {string} changedColumn - Name of the column that changed
     * @param {Object} options - Additional options
     */
    async queueUpdate(pair, changedColumn, options = {}) {
        try {
            const updateEntry = {
                pair,
                changedColumn,
                timestamp: Date.now(),
                retryCount: 0,
                ...options
            };

            this.updateQueue.push(updateEntry);

            logger.info(`Update queued for pair: ${pair}, column: ${changedColumn}, queue size: ${this.updateQueue.length}`);

            // Debounce: Wait for more updates before processing
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(() => {
                this.processQueue();
            }, this.config.debounceTime);

        } catch (error) {
            logger.error(`Error queuing update for pair ${pair}:`, error);
        }
    }

    /**
     * Queue updates for multiple pairs at once
     * @param {Array<Object>} updates - Array of {pair, changedColumn} objects
     */
    async queueBulkUpdate(updates) {
        for (const update of updates) {
            await this.queueUpdate(update.pair, update.changedColumn, update.options);
        }
    }

    /**
     * Process the update queue
     * Handles deduplication and batch processing
     */
    async processQueue() {
        if (this.isProcessing) {
            logger.debug('Queue processing already in progress, skipping...');
            return;
        }

        if (this.updateQueue.length === 0) {
            logger.debug('Queue is empty, nothing to process');
            return;
        }

        this.isProcessing = true;
        logger.info(`Starting queue processing with ${this.updateQueue.length} items`);

        try {
            // Deduplicate: Keep only the latest update for each pair
            const uniquePairs = [...new Set(this.updateQueue.map(u => u.pair))];
            const pairsToProcess = uniquePairs.slice(0, this.config.batchSize);

            logger.info(`Processing ${pairsToProcess.length} unique pairs (deduplicated from ${this.updateQueue.length} updates)`);

            // Process each pair
            const results = await Promise.allSettled(
                pairsToProcess.map(pair => this.processPairUpdate(pair))
            );

            // Handle results
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;

            logger.info(`Queue processing completed: ${succeeded} succeeded, ${failed} failed`);

            // Remove processed pairs from queue
            this.updateQueue = this.updateQueue.filter(
                u => !pairsToProcess.includes(u.pair)
            );

            // If there are still items in queue, process them
            if (this.updateQueue.length > 0) {
                logger.info(`${this.updateQueue.length} items remaining in queue, scheduling next batch`);
                setTimeout(() => this.processQueue(), 100);
            }

        } catch (error) {
            logger.error('Error processing queue:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Process update for a single currency pair
     * @param {string} pair - Currency pair identifier
     */
    async processPairUpdate(pair) {
        const startTime = Date.now();
        logger.info(`Processing update for pair: ${pair}`);

        try {
            // Step 1: Update main score table
            await this.updateMainScoreTable(pair);

            // Step 2: Build complete FX Analyzer dataset
            const completeData = await this.buildFXAnalyzerData(pair);

            // Step 3: Update cache
            await this.updateCache(pair, completeData);

            const duration = Date.now() - startTime;
            logger.info(`✅ Successfully updated cache for ${pair} in ${duration}ms`);

            return { success: true, pair, duration };

        } catch (error) {
            logger.error(`❌ Error processing update for pair ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Extract scores from the Score Dashboard dynamic table
     * @param {string} pair - Currency pair identifier
     * @returns {Promise<Object|null>} Scores object or null if not found
     */
    async extractScoresFromScoreDashboardTable(pair) {
        try {
            logger.debug(`Extracting scores for ${pair} from Score Dashboard table`);

            // Fetch the score_dashboard dynamic table
            const scoreDashboardTable = await this.dynamicTableRepository.findByIdentifier('score_dashboard');

            if (!scoreDashboardTable?.rows || !scoreDashboardTable?.columns) {
                logger.warn(`Score Dashboard table not found or empty for ${pair}`);
                return null;
            }

            const { rows, columns } = scoreDashboardTable;

            // Find column indices (same logic as frontend)
            const pairColumn = columns.find(col => col.column_index === 0);
            const netScoreColumn = columns.find(col => col.column_index === 1);
            const netBiasColumn = columns.find(col => col.column_index === 2);
            const trendScoreColumn = columns.find(col => col.column_index === 3);
            const momentumScoreColumn = columns.find(col => col.column_index === 4);
            const volatilityScoreColumn = columns.find(col => col.column_index === 5);

            // Helper to find column by index or header
            const findColumn = (index, headerVariations) => {
                // First try by index
                let col = columns.find(col => col.column_index === index);
                if (col) return col;

                // Then try by header variations
                for (const headerVar of headerVariations) {
                    col = columns.find(col =>
                        col.header?.toLowerCase() === headerVar.toLowerCase() ||
                        col.header?.toLowerCase().includes(headerVar.toLowerCase())
                    );
                    if (col) return col;
                }
                return undefined;
            };

            const seasonalScoreColumn = findColumn(7, ['seasonal score', 'seasonal', 'seasonality']);
            const cotScoreColumn = findColumn(8, ['cot score', 'cot', 'c-score']);
            const fundamentalScoreColumn = findColumn(9, ['fundamental score', 'fundamental']);

            // Find Sentiment Score by header name
            const sentimentScoreColumn = columns.find(col =>
                col.header?.toLowerCase().trim() === 'sentiment score' ||
                col.header?.toLowerCase().includes('sentiment score')
            ) || columns.find(col =>
                col.header?.toLowerCase() === 'sentiment' ||
                col.header?.toLowerCase().includes('sentiment')
            ) || findColumn(10, ['sentiment score', 'sentiment']);

            // Find the row for this pair
            const pairRow = rows.find(row => {
                if (!row.cells) return false;
                const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn?.id);
                return pairCell?.value?.trim().toUpperCase() === pair.toUpperCase();
            });

            if (!pairRow) {
                logger.debug(`No row found for pair ${pair} in Score Dashboard table`);
                return null;
            }

            // Extract cell values (check both value and formula, matching frontend logic)
            const getCellValue = (column) => {
                if (!column) return null;
                const cell = pairRow.cells.find(cell => cell.table_column_id === column.id);
                if (!cell) return null;
                // Try value first (computed value), then formula (matching frontend extractScore logic)
                return cell.value || cell.formula || null;
            };

            // Parse numeric values, handling null/undefined
            const parseNumeric = (value) => {
                if (value === null || value === undefined || value === '') return null;
                const num = parseFloat(value.toString().trim());
                return isNaN(num) ? null : num;
            };

            const scores = {
                netScore: parseNumeric(getCellValue(netScoreColumn)),
                netBias: getCellValue(netBiasColumn) || 'Neutral',
                trendScore: parseNumeric(getCellValue(trendScoreColumn)),
                momentumScore: parseNumeric(getCellValue(momentumScoreColumn)),
                volatilityScore: parseNumeric(getCellValue(volatilityScoreColumn)),
                sentimentScore: parseNumeric(getCellValue(sentimentScoreColumn)),
                seasonalScore: parseNumeric(getCellValue(seasonalScoreColumn)),
                cotScore: parseNumeric(getCellValue(cotScoreColumn)),
                fundamentalScore: parseNumeric(getCellValue(fundamentalScoreColumn))
            };

            logger.debug(`Extracted scores for ${pair}:`, scores);
            return scores;

        } catch (error) {
            logger.error(`Error extracting scores for ${pair} from Score Dashboard table:`, error);
            return null;
        }
    }

    /**
     * Update the main score table for a currency pair
     * Fetches data from all column-specific tables and calculates aggregated scores
     * @param {string} pair - Currency pair identifier
     */
    async updateMainScoreTable(pair) {
        try {
            logger.debug(`Updating main score table for ${pair}`);

            // Try to find currency pair (optional - pairs may exist in table but not in currency_pairs)
            const currencyPair = await this.findCurrencyPair(pair);

            if (!currencyPair) {
                logger.debug(`Currency pair not found in currency_pairs table: ${pair} (this is OK if pair exists in fx_analyzer_pro table)`);
                // Don't return - we can still build cache data from the table itself
                return;
            }

            // Fetch all score components from their respective tables
            // Note: These should be fetched from the actual column-specific tables
            // For now, we'll use the score_dashboard table as the source of truth

            const existingScores = await this.scoreDashboardRepository.findByCurrencyPairId(currencyPair.id);

            // If no scores exist yet, create an empty entry
            if (!existingScores) {
                await this.scoreDashboardRepository.updateOrCreate(currencyPair.id, {
                    net_score: 0,
                    net_bias: 'Neutral',
                    trend_score: 0,
                    momentum_score: 0,
                    volatility_score: 0,
                    sentiment_score: 0,
                    seasonal_score: 0,
                    cot_score: 0,
                    fundamental_score: 0,
                });
            }

            // TODO: Implement actual score calculation from column-specific tables
            // This would involve:
            // 1. Querying each column-specific table for the pair
            // 2. Calculating the net_score and net_bias based on the individual scores
            // 3. Updating the score_dashboard table

            logger.debug(`Main score table updated for ${pair}`);

        } catch (error) {
            logger.error(`Error updating main score table for ${pair}:`, error);
            // Don't throw - allow cache to be built even if score update fails
            logger.warn(`Continuing cache build despite score table update error for ${pair}`);
        }
    }

    /**
     * Build complete FX Analyzer data for a currency pair
     * Aggregates data from multiple sources
     * @param {string} pair - Currency pair identifier
     * @returns {Promise<Object>} Complete analyzer data
     */
    async buildFXAnalyzerData(pair) {
        try {
            logger.info(`Building FX Analyzer data for ${pair}`);

            // Try to find currency pair (optional - pairs may exist in table but not in currency_pairs)
            const currencyPair = await this.findCurrencyPair(pair);
            logger.debug(`Currency pair lookup for ${pair}: ${currencyPair ? `Found (ID: ${currencyPair.id})` : 'Not found (this is OK)'}`);

            // Fetch scores from Score Dashboard dynamic table (same logic as frontend)
            let mainScores = await this.extractScoresFromScoreDashboardTable(pair);

            // Fetch fx_analyzer_pro table data
            const fxAnalyzerTable = await this.dynamicTableRepository.findByIdentifier('fx_analyzer_pro');

            let fxAnalyzerRow = null;
            if (fxAnalyzerTable && fxAnalyzerTable.rows && fxAnalyzerTable.columns) {
                // Find the first column (pair column)
                const pairColumn = fxAnalyzerTable.columns.find(col => col.column_index === 0);

                if (pairColumn) {
                    // Find the row that matches this currency pair by checking the first column cell value
                    fxAnalyzerRow = fxAnalyzerTable.rows.find(row => {
                        if (!row.cells || row.cells.length === 0) return false;
                        const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                        if (!pairCell || !pairCell.value) return false;
                        return String(pairCell.value).trim().toUpperCase() === pair.toUpperCase();
                    });
                }

                // Fallback: try to match by currencyPair association if available
                if (!fxAnalyzerRow && currencyPair) {
                    fxAnalyzerRow = fxAnalyzerTable.rows.find(row => {
                        return row.currency_pair_id === currencyPair.id;
                    });
                }
            }

            // Extract base and quote currencies
            const baseCurrency = pair.length >= 3 ? pair.substring(0, 3) : pair;
            const quoteCurrency = pair.length >= 6 ? pair.substring(3, 6) : null;

            // Fetch additional data that fx-analyzer-pro needs
            const [technicalTrends, riskMeter, baseCurrencyCotPositions, quoteCurrencyCotPositions, retailPositions, technicalLevels, baseCurrencyStrength, quoteCurrencyStrength] = await Promise.allSettled([
                this.fetchTechnicalTrends(pair),
                this.fetchRiskMeter(pair),
                this.fetchCOTPositions(baseCurrency),
                quoteCurrency ? this.fetchCOTPositions(quoteCurrency) : Promise.resolve(null),
                this.fetchRetailPositions(pair),
                this.fetchTechnicalLevels(pair),
                this.fetchCurrencyStrength(baseCurrency),
                quoteCurrency ? this.fetchCurrencyStrength(quoteCurrency) : Promise.resolve(null)
            ]);

            // Build currency strengths object
            const currencyStrengths = {};
            if (baseCurrencyStrength.status === 'fulfilled' && baseCurrencyStrength.value !== null) {
                currencyStrengths[baseCurrency] = { currency: baseCurrency, score: baseCurrencyStrength.value };
            }
            if (quoteCurrency && quoteCurrencyStrength.status === 'fulfilled' && quoteCurrencyStrength.value !== null) {
                currencyStrengths[quoteCurrency] = { currency: quoteCurrency, score: quoteCurrencyStrength.value };
            }

            const completeData = {
                pair,
                currencyPairId: currencyPair?.id || null,
                lastUpdated: new Date().toISOString(),

                // Main scores from Score Dashboard dynamic table
                scores: mainScores,

                // FX Analyzer table row data
                analyzerData: fxAnalyzerRow ? {
                    rowId: fxAnalyzerRow.id,
                    rowIndex: fxAnalyzerRow.row_index,
                    cells: fxAnalyzerRow.cells ? fxAnalyzerRow.cells.map(cell => ({
                        columnId: cell.table_column_id,
                        columnName: cell.column?.column_name,
                        value: cell.value,
                        formula: cell.formula,
                        dataType: cell.data_type,
                    })) : []
                } : null,

                // Additional data for fx-analyzer-pro
                technicalTrends: technicalTrends.status === 'fulfilled' ? technicalTrends.value : [],
                riskMeter: riskMeter.status === 'fulfilled' ? riskMeter.value : null,
                cotPositions: baseCurrencyCotPositions.status === 'fulfilled' ? baseCurrencyCotPositions.value : null,
                quoteCurrencyCotPositions: quoteCurrency && quoteCurrencyCotPositions.status === 'fulfilled' ? quoteCurrencyCotPositions.value : null,
                retailPositions: retailPositions.status === 'fulfilled' ? retailPositions.value : null,
                technicalLevels: technicalLevels.status === 'fulfilled' ? technicalLevels.value : null,
                currencyStrengths: Object.keys(currencyStrengths).length > 0 ? currencyStrengths : null,

                // Metadata
                metadata: {
                    cacheVersion: '1.0',
                    buildTime: new Date().toISOString(),
                }
            };

            logger.debug(`FX Analyzer data built for ${pair} with ${completeData.analyzerData?.cells?.length || 0} cells`);

            return completeData;

        } catch (error) {
            logger.error(`Error building FX Analyzer data for ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Update cache entry for a currency pair
     * @param {string} pair - Currency pair identifier
     * @param {Object} completeData - Complete analyzer data
     */
    async updateCache(pair, completeData) {
        try {
            logger.info(`Updating cache for ${pair}`);

            await this.cacheRepository.updateOrCreate(
                pair,
                completeData,
                completeData.currencyPairId
            );

            logger.info(`✅ Cache updated for ${pair}`);

        } catch (error) {
            logger.error(`Error updating cache for ${pair}:`, error);
            throw error;
        }
    }

    /**
     * Fetch technical trends from fx_analyzer_pro table
     * @param {string} pair - Currency pair
     * @returns {Promise<Array>} Technical trends data
     */
    async fetchTechnicalTrends(pair) {
        try {
            const fxAnalyzerTable = await this.dynamicTableRepository.findByIdentifier('fx_analyzer_pro');

            if (!fxAnalyzerTable?.rows || !fxAnalyzerTable?.columns) {
                return [];
            }

            // Find the first column (pair column)
            const pairColumn = fxAnalyzerTable.columns.find(col => col.column_index === 0);
            if (!pairColumn) return [];

            // Find the row matching the pair
            const matchingRow = fxAnalyzerTable.rows.find(row => {
                if (!row.cells) return false;
                const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                return pairCell?.value?.trim().toUpperCase() === pair.toUpperCase();
            });

            if (!matchingRow?.cells) return [];

            // Parse columns: After pair column (index 0), columns are in groups of 3
            const dataColumns = fxAnalyzerTable.columns
                .filter(col => col.column_index > 0)
                .sort((a, b) => a.column_index - b.column_index);

            const timeFrameColumns = [];
            for (let i = 0; i < dataColumns.length; i += 3) {
                if (i + 2 < dataColumns.length) {
                    const trendCol = dataColumns[i];
                    const momentumCol = dataColumns[i + 1];
                    const volatilityCol = dataColumns[i + 2];

                    // Extract time frame name from the first column's header (Trend column)
                    let timeFrame = 'Unknown';
                    const trendHeader = trendCol.header?.trim() || '';

                    if (trendHeader) {
                        const headerLower = trendHeader.toLowerCase();
                        if (headerLower.includes('1hr') || headerLower.includes('1h')) {
                            timeFrame = '1Hr';
                        } else if (headerLower.includes('4hr') || headerLower.includes('4h')) {
                            timeFrame = '4Hr';
                        } else if (headerLower.includes('daily') || headerLower.includes('d1')) {
                            timeFrame = 'Daily';
                        } else {
                            const parts = trendHeader.split(/\s+/);
                            if (parts.length > 0 && parts[0]) {
                                timeFrame = parts[0];
                            } else {
                                const groupIndex = Math.floor(i / 3);
                                timeFrame = `TimeFrame${groupIndex + 1}`;
                            }
                        }
                    } else {
                        const groupIndex = Math.floor(i / 3);
                        timeFrame = `TimeFrame${groupIndex + 1}`;
                    }

                    timeFrameColumns.push({
                        timeFrame,
                        trendCol,
                        momentumCol,
                        volatilityCol
                    });
                }
            }

            // Extract data for each timeframe
            const technicalTrends = [];
            for (const tf of timeFrameColumns) {
                const getCellValue = (col) => {
                    if (!col) return 'N/A';
                    const cell = matchingRow.cells.find(c => c.table_column_id === col.id);
                    const value = cell?.value || cell?.formula || '';
                    return value.toString().trim() || 'N/A';
                };

                technicalTrends.push({
                    timeFrame: tf.timeFrame,
                    trend: getCellValue(tf.trendCol),
                    momentum: getCellValue(tf.momentumCol),
                    volatility: getCellValue(tf.volatilityCol)
                });
            }

            // Sort by common time frame order
            const timeFrameOrder = ['1Hr', '4Hr', 'Daily', '1hr', '4hr', 'daily'];
            technicalTrends.sort((a, b) => {
                const aIndex = timeFrameOrder.findIndex(tf => tf.toLowerCase() === a.timeFrame.toLowerCase());
                const bIndex = timeFrameOrder.findIndex(tf => tf.toLowerCase() === b.timeFrame.toLowerCase());
                if (aIndex === -1 && bIndex === -1) return 0;
                if (aIndex === -1) return 1;
                if (bIndex === -1) return -1;
                return aIndex - bIndex;
            });

            return technicalTrends;
        } catch (error) {
            logger.error(`Error fetching technical trends for ${pair}:`, error);
            return [];
        }
    }

    /**
     * Fetch risk meter from risk mode tables
     * @param {string} pair - Currency pair
     * @returns {Promise<number|null>} Risk meter value
     */
    async fetchRiskMeter(pair) {
        try {
            const riskTable = await this.dynamicTableRepository.findByIdentifier('strategy_sentiment_matrix');

            if (!riskTable?.rows || !riskTable?.columns) {
                return null;
            }

            const pairColumn = riskTable.columns.find(col => col.column_index === 0);
            if (!pairColumn) {
                return null;
            }

            const matchingRow = riskTable.rows.find(row => {
                if (!row.cells) return false;
                const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                return pairCell?.value?.trim().toUpperCase() === pair.toUpperCase();
            });

            if (!matchingRow || !matchingRow.cells) {
                return null;
            }

            // Look for a "Risk Meter" or "Risk" column (usually last column or search by header)
            const riskColumn = riskTable.columns.find(col => {
                const header = col.header?.toLowerCase() || '';
                return header.includes('risk') || col.column_index === riskTable.columns.length - 1;
            });

            if (riskColumn) {
                const riskCell = matchingRow.cells.find(cell => cell.table_column_id === riskColumn.id);
                const riskValueStr = riskCell?.value || riskCell?.formula || '';
                if (riskValueStr) {
                    const riskValue = parseFloat(riskValueStr.toString().trim());
                    if (!isNaN(riskValue)) {
                        return riskValue;
                    }
                }
            }

            return null;
        } catch (error) {
            logger.error(`Error fetching risk meter for ${pair}:`, error);
            return null;
        }
    }

    /**
     * Fetch COT positions data
     * @param {string} pairOrCurrency - Currency pair or 3-letter currency code
     * @returns {Promise<Object|null>} COT positions data
     */
    async fetchCOTPositions(pairOrCurrency) {
        try {
            // If it's a 3-letter currency code, use it directly; otherwise extract base currency from pair
            const currency = pairOrCurrency.length === 3 ? pairOrCurrency : pairOrCurrency.substring(0, 3);

            const cotTable = await this.dynamicTableRepository.findByIdentifier('cot_main_positions');

            if (!cotTable?.rows || !cotTable?.columns) {
                return null;
            }

            const currencyColumn = cotTable.columns.find(col => col.column_index === 0);
            if (!currencyColumn) {
                return null;
            }

            // Find the row matching the currency using regex
            const currencyRegex = new RegExp(`\\b${currency}\\b`, 'i');
            const matchingRow = cotTable.rows.find(row => {
                if (!row.cells) return false;
                const currencyCell = row.cells.find(cell => cell.table_column_id === currencyColumn.id);
                const currencyValue = currencyCell?.value || currencyCell?.formula || '';
                return currencyRegex.test(currencyValue.toString());
            });

            if (!matchingRow || !matchingRow.cells) {
                return null;
            }

            const currencyCell = matchingRow.cells.find(cell => cell.table_column_id === currencyColumn.id);
            const currencyName = currencyCell?.value || currencyCell?.formula || currency;

            // Find columns by specific indices
            const nonCommercialLongCol = cotTable.columns.find(col => col.column_index === 6);
            const nonCommercialShortCol = cotTable.columns.find(col => col.column_index === 7);
            const commercialLongCol = cotTable.columns.find(col => col.column_index === 13);
            const commercialShortCol = cotTable.columns.find(col => col.column_index === 14);

            const extractValue = (col) => {
                if (!col || !matchingRow.cells) return null;
                const cell = matchingRow.cells.find(c => c.table_column_id === col.id);
                const value = cell?.value || cell?.formula || '';
                const parsed = parseFloat(value.toString().trim());
                return !isNaN(parsed) ? parsed : null;
            };

            return {
                currency: currencyName.toString(),
                nonCommercial: {
                    long: extractValue(nonCommercialLongCol),
                    short: extractValue(nonCommercialShortCol)
                },
                commercial: {
                    long: extractValue(commercialLongCol),
                    short: extractValue(commercialShortCol)
                }
            };
        } catch (error) {
            logger.error(`Error fetching COT positions for ${pairOrCurrency}:`, error);
            return null;
        }
    }

    /**
     * Fetch retail positions data
     * @param {string} pair - Currency pair
     * @returns {Promise<Object|null>} Retail positions data
     */
    async fetchRetailPositions(pair) {
        try {
            const retailTable = await this.dynamicTableRepository.findByIdentifier('retail_sentiment_currency_pairs');

            if (!retailTable?.rows || !retailTable?.columns) {
                return null;
            }

            const pairColumn = retailTable.columns.find(col => col.column_index === 0);
            const longColumn = retailTable.columns.find(col => col.column_index === 1);
            const shortColumn = retailTable.columns.find(col => col.column_index === 2);

            if (!pairColumn || !longColumn || !shortColumn) {
                return null;
            }

            const matchingRow = retailTable.rows.find(row => {
                if (!row.cells) return false;
                const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                const pairValue = (pairCell?.value || pairCell?.formula || '').toString().trim().toUpperCase();
                return pairValue === pair.toUpperCase();
            });

            if (!matchingRow || !matchingRow.cells) {
                return null;
            }

            const extractValue = (col) => {
                if (!col || !matchingRow.cells) return null;
                const cell = matchingRow.cells.find(c => c.table_column_id === col.id);
                const value = cell?.value || cell?.formula || '';
                const parsed = parseFloat(value.toString().trim());
                return !isNaN(parsed) ? parsed : null;
            };

            return {
                long: extractValue(longColumn),
                short: extractValue(shortColumn)
            };
        } catch (error) {
            logger.error(`Error fetching retail positions for ${pair}:`, error);
            return null;
        }
    }

    /**
     * Fetch technical levels data
     * @param {string} pair - Currency pair
     * @returns {Promise<Object|null>} Technical levels data
     */
    async fetchTechnicalLevels(pair) {
        try {
            const technicalLevelsTable = await this.dynamicTableRepository.findByIdentifier('technical_lvls');

            if (!technicalLevelsTable?.rows || !technicalLevelsTable?.columns) {
                return null;
            }

            const pairColumn = technicalLevelsTable.columns.find(col => col.column_index === 0);
            if (!pairColumn) {
                return null;
            }

            const matchingRow = technicalLevelsTable.rows.find(row => {
                if (!row.cells) return false;
                const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
                const pairValue = (pairCell?.value || pairCell?.formula || '').toString().trim().toUpperCase();
                return pairValue === pair.toUpperCase();
            });

            if (!matchingRow || !matchingRow.cells) {
                return null;
            }

            const extractValue = (columnIndex) => {
                const column = technicalLevelsTable.columns.find(col => col.column_index === columnIndex);
                if (!column) return null;
                const cell = matchingRow.cells.find(c => c.table_column_id === column.id);
                if (!cell) return null;
                const value = cell.value || cell.formula || '';
                return value.toString().trim() || null;
            };

            return {
                currentPrice: extractValue(1),
                pivot: extractValue(2),
                s1: extractValue(3),
                s2: extractValue(4),
                s3: extractValue(5),
                r1: extractValue(6),
                r2: extractValue(7),
                r3: extractValue(8)
            };
        } catch (error) {
            logger.error(`Error fetching technical levels for ${pair}:`, error);
            return null;
        }
    }

    /**
     * Fetch currency strength for a single currency
     * @param {string} currency - Currency code (e.g., "USD")
     * @returns {Promise<number|null>} Currency strength score
     */
    async fetchCurrencyStrength(currency) {
        try {
            const table = await this.dynamicTableRepository.findByIdentifier('market_structure_divergence_matrix');

            if (!table?.rows || !table?.columns) {
                return null;
            }

            const currencyColumn = table.columns.find(col => col.column_index === 0);
            if (!currencyColumn) {
                return null;
            }

            // Find the HTF column - look for column with header containing "HTF" or "htf"
            let htfColumn = table.columns.find(col => {
                const header = (col.header || '').toLowerCase();
                return header.includes('htf') || header === 'htf';
            });

            // If HTF column not found, try to find "Trend (Moderate)" or last column
            if (!htfColumn) {
                htfColumn = table.columns.find(col => {
                    const header = (col.header || '').toLowerCase();
                    return header.includes('trend') && header.includes('moderate');
                });
            }

            // If still not found, use the last column (highest index) as fallback
            if (!htfColumn) {
                const sortedColumns = table.columns.sort((a, b) => b.column_index - a.column_index);
                htfColumn = sortedColumns[0];
            }

            if (!htfColumn) {
                return null;
            }

            // HTF has 2 columns: first is the text description, next column (index + 1) has the numeric score
            const htfScoreColumn = table.columns.find(col => col.column_index === htfColumn.column_index + 1);
            const scoreColumn = htfScoreColumn || htfColumn;

            // Find the row matching the currency using regex
            const currencyRegex = new RegExp(`\\b${currency}\\b`, 'i');
            const matchingRow = table.rows.find(row => {
                if (!row.cells) return false;
                const currencyCell = row.cells.find(cell => cell.table_column_id === currencyColumn.id);
                const currencyValue = (currencyCell?.value || currencyCell?.formula || '').toString();
                return currencyRegex.test(currencyValue);
            });

            if (!matchingRow || !matchingRow.cells) {
                return null;
            }

            const htfScoreCell = matchingRow.cells.find(c => c.table_column_id === scoreColumn.id);
            if (!htfScoreCell) {
                return null;
            }

            const htfValue = htfScoreCell.value || htfScoreCell.formula || '';
            let score = null;
            const parsed = parseFloat(htfValue.toString().trim());
            if (!isNaN(parsed)) {
                score = parsed;
            } else {
                // If it's text, convert to numeric
                const htfText = htfValue.toString().toLowerCase().trim();
                if (htfText.includes('moderate') || htfText === 'moderate') {
                    score = 50;
                } else if (htfText.includes('high') || htfText.includes('strong')) {
                    score = 75;
                } else if (htfText.includes('low') || htfText.includes('weak')) {
                    score = 25;
                }
            }

            return score;
        } catch (error) {
            logger.error(`Error fetching currency strength for ${currency}:`, error);
            return null;
        }
    }


    /**
     * Force immediate update for a specific pair (bypasses queue)
     * @param {string} pair - Currency pair identifier
     * @returns {Promise<Object>} Update result
     */
    async forceUpdate(pair) {
        logger.info(`Force update triggered for ${pair}`);
        return await this.processPairUpdate(pair);
    }

    /**
     * Force immediate update for all pairs
     * @returns {Promise<Array>} Array of update results
     */
    async forceUpdateAll() {
        logger.info('Force update triggered for all pairs');

        try {
            // Get all currency pairs
            const currencyPairs = await CurrencyPair.findAll({
                where: { is_active: true },
                order: [['display_order', 'ASC'], ['code', 'ASC']]
            });

            // Create pairs with constructed pair names
            const pairsWithNames = currencyPairs.map(cp => ({
                ...cp.toJSON(),
                pair: `${cp.base_currency}/${cp.quote_currency}`
            }));

            logger.info(`Updating cache for ${pairsWithNames.length} currency pairs`);

            const results = [];
            for (const cp of pairsWithNames) {
                try {
                    const result = await this.processPairUpdate(cp.pair);
                    results.push(result);
                } catch (error) {
                    logger.error(`Error updating ${cp.pair}:`, error);
                    results.push({ success: false, pair: cp.pair, error: error.message });
                }
            }

            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            logger.info(`Force update completed: ${succeeded} succeeded, ${failed} failed`);

            return results;

        } catch (error) {
            logger.error('Error in force update all:', error);
            throw error;
        }
    }

    /**
     * Force immediate update for specific pairs (bypasses queue)
     * @param {Array<string>} pairs - Array of currency pair identifiers
     * @returns {Promise<Array>} Array of update results
     */
    async forceUpdateSpecific(pairs) {
        logger.info(`Force update triggered for specific pairs: ${pairs.join(', ')}`);
        logger.info(`Processing ${pairs.length} pairs:`, pairs);

        try {
            const results = [];
            for (const pair of pairs) {
                try {
                    logger.info(`Starting update for pair: ${pair}`);
                    const result = await this.processPairUpdate(pair);
                    logger.info(`Completed update for pair: ${pair}, success: ${result.success}`);
                    results.push(result);
                } catch (error) {
                    logger.error(`Error updating ${pair}:`, error);
                    results.push({ success: false, pair, error: error.message });
                }
            }

            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            logger.info(`Force update completed: ${succeeded} succeeded, ${failed} failed`);
            logger.info('Results summary:', results.map(r => ({ pair: r.pair, success: r.success, duration: r.duration })));

            return results;

        } catch (error) {
            logger.error('Error in force update specific:', error);
            throw error;
        }
    }

    /**
     * Get current queue status
     * @returns {Object} Queue statistics
     */
    getQueueStatus() {
        return {
            queueLength: this.updateQueue.length,
            isProcessing: this.isProcessing,
            uniquePairs: [...new Set(this.updateQueue.map(u => u.pair))].length,
            config: this.config,
        };
    }

    /**
     * Clear the update queue
     */
    clearQueue() {
        const previousLength = this.updateQueue.length;
        this.updateQueue = [];
        logger.info(`Queue cleared (${previousLength} items removed)`);
    }
}

// Export singleton instance
export const scoreUpdateService = new ScoreUpdateService();
