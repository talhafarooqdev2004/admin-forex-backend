import { firefox } from 'playwright';
import { logger } from '../utils/logger.util.js';

/**
 * Service for scraping heat map data from Myfxbook widget embedded in our admin panel
 */
export class HeatMapScraperService {
    constructor() {
        this.url = 'http://localhost:3000/admin/scraping-tool/heatmap';
        this.timeout = 120000; // Increased timeout for two-level loading
        this.playwrightTimeout = 60000;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    }

    /**
     * Scrapes heat map data from embedded iframe
     * @returns {Promise<Array|null>} Scraped data or null if failed
     */
    async scrapeHeatMap(retryCount = 0, maxRetries = 2) {
        let browser = null;
        try {
            if (retryCount === 0) {
                logger.info(`Starting Heat Map scraping from ${this.url}`);
            } else {
                logger.info(`Retrying Heat Map scraping (attempt ${retryCount + 1})`);
            }
            
            browser = await firefox.launch({
                headless: true,
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: this.userAgent,
            });

            const page = await context.newPage();

            // Navigate to our admin page
            await page.goto(this.url, {
                waitUntil: 'load',
                timeout: this.timeout,
            });

            // Wait for our iframe to be present
            const iframeElement = await page.waitForSelector('#heat-map-frame', { state: 'attached', timeout: 30000 });
            const frame = await iframeElement.contentFrame();
            
            if (!frame) {
                throw new Error('Could not access heat map iframe content');
            }

            // Wait for the table INSIDE the iframe to be visible
            await frame.waitForSelector('#symbolMarketHeatMap', { state: 'visible', timeout: 60000 });

            // Extract data from inside the iframe
            const results = await frame.evaluate(() => {
                const table = document.querySelector('#symbolMarketHeatMap');
                if (!table) return [];

                const rows = Array.from(table.querySelectorAll('tbody tr'));
                return rows.map(row => {
                    const cells = Array.from(row.querySelectorAll('td'));
                    if (cells.length < 9) return null;

                    return {
                        pair: cells[0].textContent.trim().toUpperCase(),
                        m1: cells[1].textContent.trim(),
                        m5: cells[2].textContent.trim(),
                        m15: cells[3].textContent.trim(),
                        m30: cells[4].textContent.trim(),
                        h1: cells[5].textContent.trim(),
                        h4: cells[6].textContent.trim(),
                        d1: cells[7].textContent.trim(),
                        w1: cells[8].textContent.trim(),
                    };
                }).filter(item => item !== null);
            });

            if (!results || results.length === 0) {
                throw new Error('No heat map data found in table');
            }

            logger.info(`Scraped ${results.length} pairs from Heat Map`);
            return results;

        } catch (error) {
            logger.error(`Heat Map scraping failed: ${error.message}`);

            if (retryCount < maxRetries) {
                if (browser) await browser.close();
                await new Promise(resolve => setTimeout(resolve, 5000));
                return await this.scrapeHeatMap(retryCount + 1, maxRetries);
            }

            return null;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}
