import { chromium } from 'playwright';
import { logger } from '../utils/logger.util.js';

/**
 * Service for scraping risk-on/risk-off meter score from babypips.com
 * Uses Playwright to handle JavaScript-rendered content
 */
export class BabypipsScraperService {
    constructor() {
        this.url = 'https://www.babypips.com/tools/risk-on-risk-off-meter';
        this.selector = 'span.Meter-module__score___MhC67';
        this.timeout = 60000; // 60 seconds timeout for page load
        this.waitForSelectorTimeout = 30000; // 30 seconds to wait for element
    }

    /**
     * Scrapes the risk-on/risk-off meter score from babypips.com
     * @param {number} retryCount - Current retry attempt (default: 0)
     * @param {number} maxRetries - Maximum number of retries (default: 3)
     * @returns {Promise<number|null>} The score value or null if scraping fails
     */
    async scrapeScore(retryCount = 0, maxRetries = 3) {
        let browser = null;
        
        try {
            if (retryCount === 0) {
                logger.info('Starting risk mode score scraping');
            }

            // Launch browser with optimized settings
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                ],
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });

            const page = await context.newPage();

            await page.goto(this.url, {
                waitUntil: 'domcontentloaded',
                timeout: this.timeout,
            });

            await page.waitForTimeout(3000);

            // Wait for the score element to appear
            let finalSelector = this.selector;
            let elementFound = false;
            
            try {
                await page.waitForSelector(this.selector, {
                    timeout: this.waitForSelectorTimeout,
                    state: 'visible',
                });
                elementFound = true;
            } catch (waitError) {
                // Try alternative selectors as fallback
                const alternativeSelectors = [
                    'span[class*="Meter-module__score"]',
                    '[class*="Meter-module__score"]',
                    'span[class*="score"]',
                ];
                
                for (const altSelector of alternativeSelectors) {
                    try {
                        await page.waitForSelector(altSelector, { 
                            timeout: 10000,
                            state: 'visible',
                        });
                        finalSelector = altSelector;
                        elementFound = true;
                        break;
                    } catch (e) {
                        // Continue to next selector
                    }
                }
            }

            if (!elementFound) {
                return null;
            }

            // Extract the score text
            const scoreText = await page.textContent(finalSelector);

            if (!scoreText || !scoreText.trim()) {
                return null;
            }

            const score = parseFloat(scoreText.trim());

            if (isNaN(score)) {
                return null;
            }

            // Clamp score to valid range (-100 to 100)
            const clampedScore = Math.max(-100, Math.min(100, score));

            logger.info(`Risk mode score scraping completed: ${clampedScore}`);
            return clampedScore;

        } catch (error) {
            // Retry logic for network errors
            const isNetworkError = error.message.includes('ERR_NAME_NOT_RESOLVED') || 
                                  error.message.includes('net::') ||
                                  error.message.includes('timeout') ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('ENOTFOUND');
            
            if (isNetworkError && retryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                
                // Close browser before retry
                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeError) {
                        // Ignore close errors
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                return await this.scrapeScore(retryCount + 1, maxRetries);
            }
            
            return null;
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    // Ignore close errors
                }
            }
        }
    }

    /**
     * Validates if a score value is within acceptable range
     * @param {number} score - The score to validate
     * @returns {boolean} True if score is valid
     */
    isValidScore(score) {
        return typeof score === 'number' && !isNaN(score) && score >= -100 && score <= 100;
    }
}
