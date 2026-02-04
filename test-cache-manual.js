/**
 * Manual test to trigger cache update with test pairs
 */

import 'module-alias/register.js';
import { logger } from './src/utils/logger.util.js';
import { scoreUpdateService } from './src/services/scoreUpdateService.js';
import { sequelize } from './src/models/index.js';

async function testCacheUpdate() {
    try {
        logger.info('=================================================');
        logger.info('Manual Cache Update Test');
        logger.info('=================================================');

        // Test database connection
        await sequelize.authenticate();
        logger.info('✅ Database connection established\n');

        // Test pairs
        const testPairs = ['EUR/USD', 'GBP/USD'];

        logger.info(`Testing cache update for pairs: ${testPairs.join(', ')}\n`);

        const results = await scoreUpdateService.forceUpdateSpecific(testPairs);

        logger.info('\n📊 Results:');
        results.forEach(result => {
            logger.info(`   ${result.pair}: ${result.success ? '✅ Success' : '❌ Failed'}${result.duration ? ` (${result.duration}ms)` : ''}`);
            if (!result.success && result.error) {
                logger.info(`      Error: ${result.error}`);
            }
        });

        logger.info('\n✅ Test complete!');
        await sequelize.close();

    } catch (error) {
        logger.error('❌ Test error:', error);
        await sequelize.close();
        process.exit(1);
    }
}

// Run the test
testCacheUpdate();
