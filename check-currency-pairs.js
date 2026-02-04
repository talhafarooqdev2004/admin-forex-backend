/**
 * Diagnostic script to check currency pairs in the database
 * 
 * Usage:
 *   node --experimental-loader ./alias-loader.js check-currency-pairs.js
 */

import 'module-alias/register.js';
import { logger } from './src/utils/logger.util.js';
import { CurrencyPair, sequelize } from './src/models/index.js';

async function checkCurrencyPairs() {
    try {
        logger.info('=================================================');
        logger.info('Currency Pairs Diagnostic Script');
        logger.info('=================================================');

        // Test database connection
        await sequelize.authenticate();
        logger.info('✅ Database connection established\n');

        // Get all currency pairs
        const allPairs = await CurrencyPair.findAll({
            order: [['display_order', 'ASC'], ['code', 'ASC']]
        });

        logger.info(`Total currency pairs in database: ${allPairs.length}\n`);

        if (allPairs.length === 0) {
            logger.warn('⚠️  No currency pairs found in the database');
            logger.info('💡 You need to create currency pairs first.');
            logger.info('💡 Currency pairs can be created via the admin panel or API.');
            await sequelize.close();
            return;
        }

        // Separate active and inactive
        const activePairs = allPairs.filter(cp => cp.is_active);
        const inactivePairs = allPairs.filter(cp => !cp.is_active);

        logger.info(`Active pairs: ${activePairs.length}`);
        logger.info(`Inactive pairs: ${inactivePairs.length}\n`);

        if (activePairs.length > 0) {
            logger.info('📋 Active Currency Pairs:');
            logger.info('─'.repeat(80));
            activePairs.forEach((cp, index) => {
                const pairName = `${cp.base_currency}/${cp.quote_currency}`;
                logger.info(`${index + 1}. ${pairName.padEnd(12)} | Code: ${cp.code.padEnd(10)} | ID: ${cp.id} | Order: ${cp.display_order}`);
            });
            logger.info('');
        }

        if (inactivePairs.length > 0) {
            logger.info('📋 Inactive Currency Pairs:');
            logger.info('─'.repeat(80));
            inactivePairs.forEach((cp, index) => {
                const pairName = `${cp.base_currency}/${cp.quote_currency}`;
                logger.info(`${index + 1}. ${pairName.padEnd(12)} | Code: ${cp.code.padEnd(10)} | ID: ${cp.id} | Order: ${cp.display_order}`);
            });
            logger.info('');
        }

        // Show sample pair names that would be used for caching
        if (activePairs.length > 0) {
            logger.info('💡 Sample pair names for cache (first 5 active pairs):');
            activePairs.slice(0, 5).forEach(cp => {
                const pairName = `${cp.base_currency}/${cp.quote_currency}`;
                logger.info(`   - ${pairName}`);
            });
            logger.info('');
        }

        logger.info('✅ Diagnostic complete!\n');

        // Close database connection
        await sequelize.close();

    } catch (error) {
        logger.error('❌ Error checking currency pairs:', error);
        await sequelize.close();
        process.exit(1);
    }
}

// Run the script
checkCurrencyPairs();
