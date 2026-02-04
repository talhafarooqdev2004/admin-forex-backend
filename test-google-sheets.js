import 'module-alias/register.js';
import { googleSheetsService } from './src/services/googleSheets.service.js';
import { logger } from './src/utils/logger.util.js';

/**
 * Test script for Google Sheets integration
 * Run with: node --experimental-loader ./alias-loader.js test-google-sheets.js
 */

async function runTests() {
    try {
        logger.info('🧪 Starting Google Sheets integration tests...\n');

        // Test 1: Initialize service
        logger.info('Test 1: Initializing Google Sheets service...');
        await googleSheetsService.initialize();
        logger.info('✅ Service initialized successfully\n');

        // Test 2: Create/Get test sheet
        logger.info('Test 2: Creating/Getting test sheet tab...');
        const testTableId = 'test-integration';
        await googleSheetsService.getOrCreateSheet(testTableId);
        logger.info('✅ Sheet tab ready\n');

        // Test 3: Update single cell
        logger.info('Test 3: Updating single cell...');
        await googleSheetsService.updateCell(testTableId, 'A1', 'Hello');
        await googleSheetsService.updateCell(testTableId, 'B1', 'World');
        logger.info('✅ Single cell updated\n');

        // Test 4: Batch update
        logger.info('Test 4: Batch updating cells...');
        const updates = [
            { cell: 'A2', value: 10 },
            { cell: 'A3', value: 20 },
            { cell: 'A4', value: 30 },
            { cell: 'B2', value: '=A2*2' },
            { cell: 'B3', value: '=A3*2' },
            { cell: 'B4', value: '=A4*2' },
        ];
        await googleSheetsService.batchUpdateCells(testTableId, updates);
        logger.info('✅ Batch update completed\n');

        // Wait for calculations
        await new Promise(resolve => setTimeout(resolve, 500));

        // Test 5: Get range
        logger.info('Test 5: Getting range values...');
        const values = await googleSheetsService.getRange(testTableId, 'A1:B4');
        logger.info('Values retrieved:');
        values.forEach(row => logger.info(`  ${JSON.stringify(row)}`));
        logger.info('✅ Range retrieved\n');

        // Test 6: Test PERCENTRANK formula (your use case)
        logger.info('Test 6: Testing PERCENTRANK formula...');
        const testData = [
            { cell: 'D1', value: 'Value' },
            { cell: 'E1', value: 'Score' },
            { cell: 'D2', value: 0.75 },
            { cell: 'D3', value: 0.32 },
            { cell: 'D4', value: 0.91 },
            { cell: 'D5', value: 0.45 },
            { cell: 'D6', value: 0.12 },
            { cell: 'E2', value: '=ROUND(PERCENTRANK($D$2:$D$6,D2)*10-5,0)' },
            { cell: 'E3', value: '=ROUND(PERCENTRANK($D$2:$D$6,D3)*10-5,0)' },
            { cell: 'E4', value: '=ROUND(PERCENTRANK($D$2:$D$6,D4)*10-5,0)' },
            { cell: 'E5', value: '=ROUND(PERCENTRANK($D$2:$D$6,D5)*10-5,0)' },
            { cell: 'E6', value: '=ROUND(PERCENTRANK($D$2:$D$6,D6)*10-5,0)' },
        ];
        await googleSheetsService.batchUpdateCells(testTableId, testData);

        // Wait for formulas to calculate
        await new Promise(resolve => setTimeout(resolve, 500));

        const scores = await googleSheetsService.getRange(testTableId, 'E2:E6');
        logger.info('Calculated scores:');
        scores.forEach((row, idx) => {
            const value = testData[idx + 6].cell.replace('E', 'D');
            logger.info(`  ${value}: ${row[0]}`);
        });
        logger.info('✅ PERCENTRANK formula working!\n');

        // Test 7: Get single cell
        logger.info('Test 7: Getting single cell...');
        const cellValue = await googleSheetsService.getCell(testTableId, 'B2');
        logger.info(`Cell B2 value: ${cellValue}`);
        logger.info('✅ Single cell retrieved\n');

        logger.info('🎉 All tests passed!\n');
        logger.info(`📊 View your test sheet here:`);
        logger.info(`https://docs.google.com/spreadsheets/d/${googleSheetsService.spreadsheetId}/edit#gid=0\n`);

    } catch (error) {
        logger.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run tests
runTests().then(() => {
    logger.info('✨ Test script completed');
    process.exit(0);
}).catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
