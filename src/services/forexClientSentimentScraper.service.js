import { firefox } from 'playwright';
import { logger } from '../utils/logger.util.js';

/**
 * Service for scraping retail sentiment data from Myfxbook widget
 * Uses Playwright to load the widget iframe and extract sentiment data
 */
export class ForexClientSentimentScraperService {
    constructor() {
        // Our admin page with Myfxbook widget embedded
        this.url = 'http://localhost:3000/admin/scraping-tool/retail-positions';
        this.timeout = 120000; // Increased timeout for two-level loading
        this.playwrightTimeout = 60000; // 60 seconds timeout for Playwright
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    /**
     * Scrapes retail sentiment data using Playwright from embedded iframe
     * @param {number} retryCount - Current retry attempt (default: 0)
     * @param {number} maxRetries - Maximum number of retries (default: 3)
     * @returns {Promise<Array<{pair: string, long: number, short: number}>|null>} Array of sentiment data or null if scraping fails
     */
    async scrapeWithPlaywright(retryCount = 0, maxRetries = 3) {
        let browser = null;
        
        try {
            if (retryCount === 0) {
                logger.info(`Starting retail sentiment scraping from ${this.url}`);
            }

            browser = await firefox.launch({
                headless: true,
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: this.userAgent,
            });

            const page = await context.newPage();

            await page.goto(this.url, {
                waitUntil: 'load',
                timeout: this.playwrightTimeout,
            });

            // Wait for our iframe to be present
            const iframeElement = await page.waitForSelector('#retail-sentiment-frame', { state: 'attached', timeout: 30000 });
            const frame = await iframeElement.contentFrame();
            
            if (!frame) {
                throw new Error('Could not access retail sentiment iframe content');
            }

            // Wait for the outlook table INSIDE the iframe to load
            try {
                await frame.waitForSelector('#outlookSymbolsTable', { timeout: 60000, state: 'visible' });
            } catch (e) {
                await page.waitForTimeout(5000);
            }

            // Extract data from the table structure inside the iframe
            const results = await frame.evaluate(() => {
                const extractedData = [];
                
                // Find the table with id "outlookSymbolsTable"
                const table = document.querySelector('#outlookSymbolsTable');
                if (!table) {
                    return [];
                }
                
                // Get all rows in the table
                const rows = Array.from(table.querySelectorAll('tr'));
                
                rows.forEach((row) => {
                    try {
                        const firstTd = row.querySelector('td');
                        if (!firstTd) return;
                        
                        const link = firstTd.querySelector('a');
                        if (!link) return;
                        
                        const pair = link.textContent.trim().toUpperCase();
                        if (!pair) return;
                        
                        let input = row.querySelector('input[type="hidden"]') || 
                                   row.querySelector('input') ||
                                   firstTd.nextElementSibling?.querySelector('input');
                        
                        if (!input && row.nextElementSibling) {
                            input = row.nextElementSibling.querySelector('input');
                        }
                        
                        if (!input || !input.value) {
                            return;
                        }
                        
                        const htmlString = input.value;
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = htmlString;
                        
                        const nestedTable = tempDiv.querySelector('table');
                        if (!nestedTable) {
                            return;
                        }
                        
                        const nestedRows = Array.from(nestedTable.querySelectorAll('tr'));
                        let longPercent = null;
                        let shortPercent = null;
                        
                        nestedRows.forEach(nestedRow => {
                            const cells = Array.from(nestedRow.querySelectorAll('td'));
                            if (cells.length >= 3) {
                                const action = cells[0].textContent.trim();
                                const percentage = cells[1].textContent.trim();
                                
                                if (action.toLowerCase() === 'long') {
                                    const match = percentage.match(/(\d+(?:\.\d+)?)\s*%/);
                                    if (match) {
                                        longPercent = parseFloat(match[1]);
                                    }
                                } else if (action.toLowerCase() === 'short') {
                                    const match = percentage.match(/(\d+(?:\.\d+)?)\s*%/);
                                    if (match) {
                                        shortPercent = parseFloat(match[1]);
                                    }
                                }
                            }
                        });
                        
                        if (longPercent !== null && shortPercent !== null) {
                            extractedData.push({
                                pair,
                                long: Math.max(0, Math.min(100, Math.round(longPercent))),
                                short: Math.max(0, Math.min(100, Math.round(shortPercent))),
                            });
                        }
                    } catch (error) {
                        // Continue to next row
                    }
                });
                
                return extractedData;
            });

            if (!results || results.length === 0) {
                return null;
            }
            
            logger.info(`Retail sentiment scraping completed: ${results.length} currency pairs`);
            return results;

        } catch (error) {
            // Retry logic for network errors
            const isNetworkError = error.message.includes('ERR_NAME_NOT_RESOLVED') || 
                                  error.message.includes('net::') ||
                                  error.message.includes('timeout') ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('ENOTFOUND') ||
                                  error.message.includes('Navigation timeout');
            
            if (isNetworkError && retryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                
                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeError) {
                        // Ignore close errors
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                return await this.scrapeWithPlaywright(retryCount + 1, maxRetries);
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
     * Scrapes retail sentiment data for all currency pairs from Myfxbook widget
     * @returns {Promise<Array<{pair: string, long: number, short: number}>|null>} Array of sentiment data or null if scraping fails
     */
    async scrapeSentimentData() {
        return await this.scrapeWithPlaywright();
    }
}
