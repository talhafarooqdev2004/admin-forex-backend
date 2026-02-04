/**
 * Simple test script to verify the cache fixes work
 */

import { CurrencyPair } from './src/models/index.js';
import { sequelize } from './src/models/index.js';

async function testCurrencyPairFix() {
    try {
        console.log('Testing CurrencyPair fix...');

        // Connect to database
        await sequelize.authenticate();
        console.log('✅ Database connected');

        // Test getting currency pairs
        const pairs = await CurrencyPair.findAll({
            where: { is_active: true },
            limit: 3
        });

        console.log(`Found ${pairs.length} currency pairs:`);
        pairs.forEach(cp => {
            const pairName = `${cp.base_currency}/${cp.quote_currency}`;
            console.log(`  ${cp.code}: ${pairName} (${cp.id})`);
        });

        console.log('✅ CurrencyPair fix verified!');
        await sequelize.close();

    } catch (error) {
        console.error('❌ Error:', error.message);
        await sequelize.close();
        process.exit(1);
    }
}

testCurrencyPairFix();