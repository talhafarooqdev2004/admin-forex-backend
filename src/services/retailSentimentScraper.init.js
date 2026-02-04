import { RetailSentimentScraperService } from './retailSentimentScraper.service.js';
import { cronService } from './cron.service.js';
import { websocketService } from './websocket.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

let scraperServiceInstance = null;

/**
 * Initialize the retail sentiment scraper service and cron job
 */
export function initializeRetailSentimentScraper() {
    try {
        // Create service instances
        const repository = new DynamicTableRepository();
        scraperServiceInstance = new RetailSentimentScraperService(
            null, // Will use default ForexClientSentimentScraperService
            repository,
            websocketService
        );

        // Start cron job to scrape every 5 minutes
        // Format: second minute hour day month weekday
        cronService.startJob(
            'retailSentimentScraper',
            '0 */5 * * * *', // Every 5 minutes (at 0 seconds of every 5th minute)
            async () => {
                try {
                    await scraperServiceInstance.scrapeAndUpdate();
                } catch (error) {
                    logger.error(`Error in retail sentiment cron job: ${error.message}`, error);
                }
            },
            {
                timezone: 'UTC',
            }
        );

        logger.info('Retail sentiment scraper initialized and cron job started (runs every 5 minutes)');

    } catch (error) {
        logger.error(`Failed to initialize retail sentiment scraper: ${error.message}`, error);
        throw error;
    }
}

/**
 * Get the scraper service instance
 * @returns {RetailSentimentScraperService|null}
 */
export function getRetailSentimentScraperService() {
    return scraperServiceInstance;
}
