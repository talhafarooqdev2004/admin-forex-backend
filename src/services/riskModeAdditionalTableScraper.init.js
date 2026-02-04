import { RiskModeAdditionalTableScraperService } from './riskModeAdditionalTableScraper.service.js';
import { cronService } from './cron.service.js';
import { websocketService } from './websocket.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

let scraperServiceInstance = null;

/**
 * Initialize the risk mode additional table scraper and cron job
 */
export function initializeRiskModeAdditionalTableScraper() {
    try {
        const repository = new DynamicTableRepository();
        scraperServiceInstance = new RiskModeAdditionalTableScraperService(
            null, 
            repository,
            websocketService
        );

        // Run every 1 minute
        cronService.startJob(
            'riskModeAdditionalTableScraper',
            '0 * * * * *',
            async () => {
                try {
                    await scraperServiceInstance.scrapeAndUpdate();
                } catch (err) {
                    logger.error('Error during Risk Mode Additional Table scraping:', err);
                }
            },
            { timezone: 'UTC' }
        );

        logger.info('Risk Mode Additional Table scraper initialized (runs every 1 minute)');

        // Initial scrape
        scraperServiceInstance.scrapeAndUpdate().catch(err => {
            logger.error('Initial Risk Mode Additional Table scrape failed:', err);
        });

    } catch (error) {
        logger.error(`Failed to initialize Risk Mode Additional Table scraper: ${error.message}`);
    }
}

export function getRiskModeAdditionalTableScraperService() {
    return scraperServiceInstance;
}
