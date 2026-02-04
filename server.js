import 'module-alias/register.js';
import http from 'http';
import app from './src/app.js';
import { ENV } from './src/config/env.js';
import { logger } from './src/utils/logger.util.js';
import { websocketService } from './src/services/websocket.service.js';
import { initializeRiskModeScoreScraper } from './src/services/riskModeScoreScraper.init.js';
import { initializeRetailSentimentScraper } from './src/services/retailSentimentScraper.init.js';
import { initializeRiskModeAdditionalTableScraper } from './src/services/riskModeAdditionalTableScraper.init.js';
import { initializeCurrencyStrengthScraper } from './src/services/currencyStrengthScraper.init.js';
import { initializeMultiTimeframeBiasScraper } from './src/services/multiTimeframeBiasScraper.init.js';
import { googleSheetsService } from './src/services/googleSheets.service.js';

const PORT = ENV.PORT || 5001;

// Create HTTP server
const httpServer = http.createServer(app);

// Initialize WebSocket server
websocketService.initialize(httpServer, {
    origin: [
        'http://localhost:3000',
        'http://localhost:3001',
        process.env.FRONTEND_URL
    ].filter(Boolean),
});

// Start HTTP server
httpServer.listen(PORT, async () => {
    logger.info(`🚀 Forex Admin Backend running on port ${PORT} in ${ENV.NODE_ENV} mode`);
    logger.info(`📡 API available at http://localhost:${PORT}/api/v1`);
    logger.info(`🔌 WebSocket server initialized`);

    // Initialize Google Sheets service
    try {
        await googleSheetsService.initialize();
    } catch (error) {
        logger.error(`Failed to initialize Google Sheets service: ${error.message}`, error);
    }

    // Initialize risk mode score scraper and cron job
    try {
        initializeRiskModeScoreScraper();
    } catch (error) {
        logger.error(`Failed to initialize risk mode score scraper: ${error.message}`, error);
    }

    // Initialize retail sentiment scraper and cron job (using Myfxbook widget)
    try {
        initializeRetailSentimentScraper();
    } catch (error) {
        logger.error(`Failed to initialize retail sentiment scraper: ${error.message}`, error);
    }

    // Initialize Risk Mode Additional Table scraper and cron job
    try {
        initializeRiskModeAdditionalTableScraper();
    } catch (error) {
        logger.error(`Failed to initialize Risk Mode Additional Table scraper: ${error.message}`, error);
    }

    // Initialize Currency Strength scraper and cron job (runs every 1 minute)
    try {
        initializeCurrencyStrengthScraper();
    } catch (error) {
        logger.error(`Failed to initialize Currency Strength scraper: ${error.message}`, error);
    }

    // Initialize Multi-Timeframe Bias Scoreboard scraper and cron job
    try {
        initializeMultiTimeframeBiasScraper();
    } catch (error) {
        logger.error(`Failed to initialize Multi-Timeframe Bias Scoreboard scraper: ${error.message}`, error);
    }
});
