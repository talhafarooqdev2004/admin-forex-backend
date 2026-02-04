import { MultiTimeframeBiasScraperService } from './multiTimeframeBiasScraper.service.js';
import { cronService } from './cron.service.js';
import { websocketService } from './websocket.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

let scraperServiceInstance = null;

/**
 * Initialize the Multi-Timeframe Bias Scoreboard scraper and cron job
 */
export function initializeMultiTimeframeBiasScraper() {
    try {
        const repository = new DynamicTableRepository();
        scraperServiceInstance = new MultiTimeframeBiasScraperService(
            null,
            repository,
            websocketService
        );

        cronService.startJob(
            'multiTimeframeBiasScraper',
            '0 * * * * *',
            async () => {
                try {
                    await scraperServiceInstance.scrapeAndUpdate();
                } catch (err) {
                    logger.error('Error during Multi-Timeframe Bias Scoreboard scraping:', err);
                }
            },
            { timezone: 'UTC' }
        );

        logger.info('Multi-Timeframe Bias Scoreboard scraper initialized and cron job started (runs every 1 minute)');

    } catch (error) {
        logger.error(`Failed to initialize Multi-Timeframe Bias Scoreboard scraper: ${error.message}`);
    }
}

export function getMultiTimeframeBiasScraperService() {
    return scraperServiceInstance;
}
