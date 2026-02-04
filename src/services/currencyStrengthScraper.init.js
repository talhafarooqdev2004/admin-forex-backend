import { CurrencyStrengthScraperService } from './currencyStrengthScraper.service.js';
import { cronService } from './cron.service.js';
import { logger } from '../utils/logger.util.js';

let scraperServiceInstance = null;

/**
 * Initialize the currency strength scraper service and cron job
 */
export function initializeCurrencyStrengthScraper() {
    try {
        // Create service instance
        scraperServiceInstance = new CurrencyStrengthScraperService();

        // Start cron job to scrape every 1 minute
        // Format: second minute hour day month weekday
        cronService.startJob(
            'currencyStrengthScraper',
            '0 * * * * *', // Every 1 minute (at 0 seconds of every minute)
            async () => {
                try {
                    const results = await scraperServiceInstance.scrapeStrength();
                    logger.info(`Currency strength scraper completed: ${results.length} currencies scraped`);
                } catch (error) {
                    logger.error(`Error in currency strength cron job: ${error.message}`, error);
                }
            },
            {
                timezone: 'UTC',
            }
        );

        logger.info('Currency strength scraper initialized and cron job started (runs every 1 minute)');

        // Initial scrape on startup
        scraperServiceInstance.scrapeStrength().catch(err => {
            logger.error('Initial currency strength scrape failed:', err);
        });

    } catch (error) {
        logger.error(`Failed to initialize currency strength scraper: ${error.message}`, error);
        throw error;
    }
}

/**
 * Get the scraper service instance
 * @returns {CurrencyStrengthScraperService|null}
 */
export function getCurrencyStrengthScraperService() {
    return scraperServiceInstance;
}
