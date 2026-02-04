/**
 * Debug script to check Score Dashboard table and cache status
 */

import 'module-alias/register.js';
import { logger } from './src/utils/logger.util.js';
import { DynamicTableRepository } from './src/repositories/dynamicTable.repository.js';
import { FxAnalyzerCacheRepository } from './src/repositories/fxAnalyzerCache.repository.js';
import { sequelize } from './src/models/index.js';

async function debugCacheSystem() {
    try {
        logger.info('=================================================');
        logger.info('Cache System Debug Script');
        logger.info('=================================================');

        // Test database connection
        await sequelize.authenticate();
        logger.info('✅ Database connection established\n');

        const tableRepo = new DynamicTableRepository();
        const cacheRepo = new FxAnalyzerCacheRepository();

        // Check Score Dashboard table
        logger.info('📊 Checking Score Dashboard table...');
        const scoreDashboard = await tableRepo.findByIdentifier('score_dashboard');

        if (!scoreDashboard) {
            logger.error('❌ Score Dashboard table not found!');
            logger.info('💡 The score_dashboard table must exist for the cache system to work.');
            await sequelize.close();
            return;
        }

        logger.info(`✅ Score Dashboard table found (ID: ${scoreDashboard.id})`);
        logger.info(`   - Rows: ${scoreDashboard.rows?.length || 0}`);
        logger.info(`   - Columns: ${scoreDashboard.columns?.length || 0}`);

        if (scoreDashboard.rows && scoreDashboard.rows.length > 0) {
            logger.info('\n📋 Score Dashboard rows:');
            scoreDashboard.rows.forEach((row, index) => {
                const cellCount = row.cells?.length || 0;
                const firstCell = row.cells?.[0];
                const firstCellValue = firstCell?.value || 'N/A';
                logger.info(`   Row ${index}: ${cellCount} cells, First cell: "${firstCellValue}"`);
            });
        }

        if (scoreDashboard.columns && scoreDashboard.columns.length > 0) {
            logger.info('\n📋 Score Dashboard columns:');
            scoreDashboard.columns.forEach((col, index) => {
                logger.info(`   Column ${index}: "${col.header}" (ID: ${col.id}, Index: ${col.column_index})`);
            });
        }

        // Check cache table
        logger.info('\n💾 Checking cache table...');
        const cacheStats = await cacheRepo.getStats();
        logger.info(`Cache stats:`, cacheStats);

        const allCache = await cacheRepo.findAll();
        if (allCache.length > 0) {
            logger.info('\n📋 Cache entries:');
            allCache.forEach(entry => {
                const dataKeys = entry.complete_data ? Object.keys(entry.complete_data) : [];
                logger.info(`   ${entry.pair}: ${dataKeys.length} data keys, Updated: ${entry.last_updated}`);
            });
        }

        // Check fx_analyzer_pro table
        logger.info('\n📊 Checking fx_analyzer_pro table...');
        const fxAnalyzer = await tableRepo.findByIdentifier('fx_analyzer_pro');

        if (fxAnalyzer) {
            logger.info(`✅ fx_analyzer_pro table found (ID: ${fxAnalyzer.id})`);
            logger.info(`   - Rows: ${fxAnalyzer.rows?.length || 0}`);
            logger.info(`   - Columns: ${fxAnalyzer.columns?.length || 0}`);
        } else {
            logger.warn('⚠️  fx_analyzer_pro table not found');
        }

        logger.info('\n✅ Debug complete!');
        await sequelize.close();

    } catch (error) {
        logger.error('❌ Debug error:', error);
        await sequelize.close();
        process.exit(1);
    }
}

// Run the script
debugCacheSystem();
