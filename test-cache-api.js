/**
 * Test script to check if the cache API is working
 */

import 'module-alias/register.js';
import { logger } from './src/utils/logger.util.js';
import { sequelize } from './src/models/index.js';

async function testCacheAPI() {
    try {
        logger.info('=================================================');
        logger.info('Testing Cache API');
        logger.info('=================================================');

        // Test database connection
        await sequelize.authenticate();
        logger.info('✅ Database connected');

        // Test the cache controller directly
        const { forceUpdateAll } = await import('./src/controllers/v1/admin/fxAnalyzerCache.controller.js');

        logger.info('✅ Cache controller imported successfully');

        // Create a mock request/response
        const mockReq = {
            body: {
                pairs: ['EUR/USD', 'GBP/USD'],
                source: 'test_script'
            },
            query: {}
        };

        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    logger.info(`Response status: ${code}`);
                    logger.info('Response data:', JSON.stringify(data, null, 2));
                    return data;
                }
            })
        };

        const mockNext = (error) => {
            if (error) {
                logger.error('Controller error:', error);
            }
        };

        logger.info('Calling forceUpdateAll controller...');
        await forceUpdateAll(mockReq, mockRes, mockNext);

        logger.info('✅ Test completed');
        await sequelize.close();

    } catch (error) {
        logger.error('❌ Test error:', error);
        await sequelize.close();
        process.exit(1);
    }
}

// Run the test
testCacheAPI();
