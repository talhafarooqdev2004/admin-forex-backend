import { chromium } from 'playwright';
import { logger } from '../utils/logger.util.js';

/**
 * Service for scraping currency strength from currencystrengthmeter.org
 */
export class CurrencyStrengthScraperService {
    constructor() {
        this.url = 'https://currencystrengthmeter.org/';
        this.timeout = 60000;
    }

    /**
     * Scrapes the currency strength from currencystrengthmeter.org
     * @returns {Promise<Array<{currency: string, score: number}>>}
     */
    async scrapeStrength() {
        let browser = null;
        try {
            logger.info(`Starting currency strength scraping from ${this.url}`);
            
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
                timeout: this.timeout 
            });
            
            // Wait a bit for JS to render the bars
            await page.waitForTimeout(5000);

            // Wait for the main container
            await page.waitForSelector('.bar-wrap', { timeout: 30000 });

            const results = await page.evaluate(() => {
                const containers = document.querySelectorAll('.str-container');
                const data = [];
                
                containers.forEach(container => {
                    const titleDiv = container.querySelector('.title');
                    if (!titleDiv) return;

                    // Extract currency name - ignore nested divs (specifically for AUD case)
                    // We only want the text that is directly a child of the .title div
                    let currencyName = '';
                    for (const child of titleDiv.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            const text = child.textContent.trim();
                            if (text) {
                                currencyName = text;
                                break;
                            }
                        }
                    }
                    
                    // Fallback: if no direct text node, get innerText but filter out any sub-elements' text if possible
                    // However, the user specifically asked for the actual currency name present directly in the title element.
                    if (!currencyName) {
                        // Clone node to remove children and get text
                        const clone = titleDiv.cloneNode(true);
                        while (clone.firstElementChild) {
                            clone.removeChild(clone.firstElementChild);
                        }
                        currencyName = clone.textContent.trim();
                    }

                    const levelDiv = container.querySelector('.bar-cont .level');
                    if (!levelDiv) return;

                    const style = levelDiv.getAttribute('style') || '';
                    const heightMatch = style.match(/height:\s*(\d+(?:\.\d+)?)%/);
                    const percentage = heightMatch ? parseFloat(heightMatch[1]) : 0;
                    
                    // 50% = score 5, 60% = score 6, etc.
                    const score = Math.round(percentage / 10);

                    if (currencyName) {
                        data.push({
                            currency: currencyName.toUpperCase(),
                            score: score
                        });
                    }
                });
                
                return data;
            });

            logger.info(`Scraped ${results.length} currencies from currencystrengthmeter.org`);
            return results;
        } catch (error) {
            logger.error(`Error scraping currency strength: ${error.message}`);
            return [];
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
}
