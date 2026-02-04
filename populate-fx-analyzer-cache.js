/**
 * Initial FX Analyzer Cache Population Script
 *
 * This script populates the fx_analyzer_cache table with data for all currency pairs.
 * It extracts currency pairs directly from the score_dashboard table (first column).
 *
 * Usage:
 *   node --experimental-loader ./alias-loader.js populate-fx-analyzer-cache.js
 */

import 'module-alias/register.js';
import { logger } from './src/utils/logger.util.js';
import { scoreUpdateService } from './src/services/scoreUpdateService.js';
import { DynamicTableRepository } from './src/repositories/dynamicTable.repository.js';
import { sequelize } from './src/models/index.js';

async function populateCache() {
    try {
        logger.info('=================================================');
        logger.info('FX Analyzer Cache Population Script');
        logger.info('=================================================');

        // Test database connection
        await sequelize.authenticate();
        logger.info('✅ Database connection established\n');

        // Get currency pairs from score_dashboard table (first column)
        logger.info('📊 Extracting currency pairs from score_dashboard table...');
        const tableRepository = new DynamicTableRepository();
        const scoreDashboardTable = await tableRepository.findByIdentifier('score_dashboard');

        if (!scoreDashboardTable) {
            logger.warn('⚠️  score_dashboard table not found');
            logger.info('💡 The score_dashboard table must exist before populating cache.');
            await sequelize.close();
            return;
        }

        if (!scoreDashboardTable.rows || scoreDashboardTable.rows.length === 0) {
            logger.warn('⚠️  score_dashboard table has no rows');
            logger.info('💡 Add rows to the score_dashboard table first.');
            await sequelize.close();
            return;
        }

        if (!scoreDashboardTable.columns || scoreDashboardTable.columns.length === 0) {
            logger.warn('⚠️  score_dashboard table has no columns');
            await sequelize.close();
            return;
        }

        // Find the first column (pair column, column_index === 0)
        const pairColumn = scoreDashboardTable.columns.find(col => col.column_index === 0);
        if (!pairColumn) {
            logger.warn('⚠️  First column (pair column) not found in score_dashboard table');
            await sequelize.close();
            return;
        }

        logger.info(`✅ Found pair column: "${pairColumn.column_name || 'Column 0'}" (ID: ${pairColumn.id})`);

        // Extract pairs from the first column cell values
        const pairsWithNames = [];
        for (const row of scoreDashboardTable.rows) {
            if (!row.cells || row.cells.length === 0) continue;

            // Find the cell in the first column
            const pairCell = row.cells.find(cell => cell.table_column_id === pairColumn.id);
            if (!pairCell || !pairCell.value) continue;

            const pair = String(pairCell.value).trim();
            if (!pair || pair === '' || pair === 'null') continue;

            pairsWithNames.push({
                pair: pair,
                rowId: row.id,
                currencyPairId: row.currency_pair_id || null
            });
        }

        if (pairsWithNames.length === 0) {
            logger.warn('⚠️  No currency pairs found in fx_analyzer_pro table');
            logger.info('💡 The first column of fx_analyzer_pro table should contain currency pair names (e.g., EUR/USD)');
            logger.info(`💡 Found ${fxAnalyzerTable.rows.length} rows but none have valid pair values in the first column`);
            await sequelize.close();
            return;
        }

        logger.info(`Found ${pairsWithNames.length} currency pairs in fx_analyzer_pro table`);
        logger.info('Starting cache population...\n');

        const results = {
            total: pairsWithNames.length,
            succeeded: 0,
            failed: 0,
            errors: [],
        };

        // Process each currency pair
        for (let i = 0; i < pairsWithNames.length; i++) {
            const pairData = pairsWithNames[i];
            const progress = `[${i + 1}/${pairsWithNames.length}]`;

            try {
                logger.info(`${progress} Processing ${pairData.pair}...`);

                const startTime = Date.now();
                await scoreUpdateService.forceUpdate(pairData.pair);
                const duration = Date.now() - startTime;

                results.succeeded++;
                logger.info(`${progress} ✅ ${pairData.pair} cached successfully in ${duration}ms`);

            } catch (error) {
                results.failed++;
                results.errors.push({
                    pair: pairData.pair,
                    error: error.message,
                });
                logger.error(`${progress} ❌ Failed to cache ${pairData.pair}:`, error.message);
            }

            // Add a small delay to avoid overwhelming the database
            if (i < pairsWithNames.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Summary
        logger.info('\n=================================================');
        logger.info('Cache Population Complete');
        logger.info('=================================================');
        logger.info(`Total pairs: ${results.total}`);
        logger.info(`✅ Succeeded: ${results.succeeded}`);
        logger.info(`❌ Failed: ${results.failed}`);

        if (results.failed > 0) {
            logger.info('\nFailed pairs:');
            results.errors.forEach(err => {
                logger.info(`  - ${err.pair}: ${err.error}`);
            });
        }

        logger.info('\n✨ Cache population script completed!\n');

        // Close database connection
        await sequelize.close();
        process.exit(results.failed > 0 ? 1 : 0);

    } catch (error) {
        logger.error('❌ Fatal error during cache population:', error);
        await sequelize.close();
        process.exit(1);
    }
}

// Run the script
populateCache();
