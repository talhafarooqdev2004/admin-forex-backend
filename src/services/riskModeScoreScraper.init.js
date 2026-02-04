import { RiskModeScoreScraperService } from './riskModeScoreScraper.service.js';
import { cronService } from './cron.service.js';
import { websocketService } from './websocket.service.js';
import { RiskModeScoreRepository } from '../repositories/riskModeScore.repository.js';
import { logger } from '../utils/logger.util.js';

let scraperServiceInstance = null;
let scrapeTimeout = null;
let consecutiveFailures = 0;
let lastScrapeTime = null;
let scrapeCount = 0;

// Configuration
const CONFIG = {
    MAX_CONSECUTIVE_FAILURES: 3,
    FAILURE_BACKOFF_MIN: 30, // 30 minutes on failure
    FAILURE_BACKOFF_MAX: 120, // 2 hours on failure
    DAILY_SCRAPE_LIMIT: 50, // Max scrapes per day
    QUIET_HOURS: { start: 23, end: 6 }, // 11 PM to 6 AM (reduce activity)
    WEEKEND_MULTIPLIER: 1.5, // Slower on weekends
};

/**
 * Get a weighted random interval with human-like patterns
 * More activity during business hours, less at night
 */
function getRandomInterval() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const isWeekend = day === 0 || day === 6;
    const isQuietHours = hour >= CONFIG.QUIET_HOURS.start || hour < CONFIG.QUIET_HOURS.end;

    // Base intervals with weights (higher weight = more likely)
    const intervals = [
        { min: 1, max: 2, weight: 5 },       // Very short (rare)
        { min: 3, max: 7, weight: 15 },      // Short
        { min: 10, max: 20, weight: 25 },    // Medium-short
        { min: 25, max: 45, weight: 30 },    // Medium (most common)
        { min: 50, max: 80, weight: 15 },    // Long
        { min: 90, max: 150, weight: 7 },    // Very long
        { min: 180, max: 240, weight: 2 },   // Extra long (rare)
        { min: 270, max: 360, weight: 1 },   // Ultra long (very rare)
    ];

    // Apply multipliers based on time
    let multiplier = 1.0;

    if (isQuietHours) {
        multiplier *= 2.0; // Double intervals during quiet hours
    }

    if (isWeekend) {
        multiplier *= CONFIG.WEEKEND_MULTIPLIER;
    }

    // During business hours (9 AM - 5 PM), slightly more frequent
    if (hour >= 9 && hour <= 17 && !isWeekend) {
        multiplier *= 0.8;
    }

    // Weighted random selection
    const totalWeight = intervals.reduce((sum, interval) => sum + interval.weight, 0);
    let random = Math.random() * totalWeight;
    let selectedInterval = intervals[0];

    for (const interval of intervals) {
        random -= interval.weight;
        if (random <= 0) {
            selectedInterval = interval;
            break;
        }
    }

    // Calculate minutes with multiplier
    const baseMinutes = Math.floor(
        Math.random() * (selectedInterval.max - selectedInterval.min + 1)
    ) + selectedInterval.min;

    const adjustedMinutes = Math.floor(baseMinutes * multiplier);

    // Add random seconds (0-59) and milliseconds for more randomness
    const seconds = Math.floor(Math.random() * 60);
    const milliseconds = Math.floor(Math.random() * 1000);

    const totalMs = (adjustedMinutes * 60 * 1000) + (seconds * 1000) + milliseconds;

    logNextScrape(adjustedMinutes, seconds, isWeekend, isQuietHours);

    return totalMs;
}

/**
 * Get backoff interval after failure
 */
function getFailureBackoffInterval() {
    const minutes = Math.floor(
        Math.random() * (CONFIG.FAILURE_BACKOFF_MAX - CONFIG.FAILURE_BACKOFF_MIN + 1)
    ) + CONFIG.FAILURE_BACKOFF_MIN;

    const seconds = Math.floor(Math.random() * 60);

    logger.warn(`Backing off due to failure. Next attempt in ${minutes} minutes and ${seconds} seconds`);

    return (minutes * 60 * 1000) + (seconds * 1000);
}

/**
 * Log next scrape with context
 */
function logNextScrape(minutes, seconds, isWeekend, isQuietHours) {
    const context = [];
    if (isWeekend) context.push('weekend');
    if (isQuietHours) context.push('quiet hours');

    const contextStr = context.length > 0 ? ` [${context.join(', ')}]` : '';

    logger.info(`Next scrape in ${minutes}m ${seconds}s${contextStr} (Total today: ${scrapeCount})`);
}

/**
 * Check if we should skip scraping (rate limiting)
 */
function shouldSkipScrape() {
    const now = new Date();

    // Reset daily counter at midnight
    if (lastScrapeTime) {
        const lastDate = new Date(lastScrapeTime);
        if (lastDate.getDate() !== now.getDate()) {
            scrapeCount = 0;
        }
    }

    // Check daily limit
    if (scrapeCount >= CONFIG.DAILY_SCRAPE_LIMIT) {
        logger.warn(`Daily scrape limit reached (${CONFIG.DAILY_SCRAPE_LIMIT}). Skipping.`);
        return true;
    }

    return false;
}

/**
 * Add random jitter to execution (0-30 seconds delay)
 */
async function randomJitter() {
    const jitterMs = Math.floor(Math.random() * 30000); // 0-30 seconds
    await new Promise(resolve => setTimeout(resolve, jitterMs));
}

/**
 * Schedule the next scrape with intelligent intervals
 */
async function scheduleNextScrape() {
    if (scrapeTimeout) {
        clearTimeout(scrapeTimeout);
    }

    const interval = consecutiveFailures > 0
        ? getFailureBackoffInterval()
        : getRandomInterval();

    scrapeTimeout = setTimeout(async () => {
        try {
            // Check if we should skip
            if (shouldSkipScrape()) {
                scheduleNextScrape();
                return;
            }

            // Add random jitter before execution
            await randomJitter();

            // Execute scrape
            await scraperServiceInstance.scrapeAndUpdate();

            // Success
            consecutiveFailures = 0;
            scrapeCount++;
            lastScrapeTime = Date.now();

            logger.info(`Scrape #${scrapeCount} completed successfully`);

        } catch (error) {
            consecutiveFailures++;
            logger.error(`Scrape failed (${consecutiveFailures}/${CONFIG.MAX_CONSECUTIVE_FAILURES}): ${error.message}`);

            // If too many failures, increase backoff exponentially
            if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
                logger.error('Max consecutive failures reached. Implementing extended backoff.');
                consecutiveFailures = CONFIG.MAX_CONSECUTIVE_FAILURES; // Cap it
            }
        }

        // Schedule next scrape
        scheduleNextScrape();
    }, interval);
}

/**
 * Initialize the risk mode score scraper service
 */
export function initializeRiskModeScoreScraper() {
    try {
        const repository = new RiskModeScoreRepository();
        scraperServiceInstance = new RiskModeScoreScraperService(
            null,
            repository,
            websocketService
        );

        logger.info('🔒 Secure risk mode scraper initialized');
        logger.info(`📊 Daily limit: ${CONFIG.DAILY_SCRAPE_LIMIT} scrapes`);
        logger.info(`🌙 Quiet hours: ${CONFIG.QUIET_HOURS.start}:00 - ${CONFIG.QUIET_HOURS.end}:00`);

        // Run initial scrape with jitter
        (async () => {
            await randomJitter();
            try {
                await scraperServiceInstance.scrapeAndUpdate();
                scrapeCount++;
                lastScrapeTime = Date.now();
                logger.info('Initial scrape completed');
            } catch (err) {
                consecutiveFailures++;
                logger.error('Initial scrape failed:', err);
            }
            scheduleNextScrape();
        })();

    } catch (error) {
        logger.error(`Failed to initialize scraper: ${error.message}`, error);
        throw error;
    }
}

/**
 * Stop the scraper service
 */
export function stopRiskModeScoreScraper() {
    if (scrapeTimeout) {
        clearTimeout(scrapeTimeout);
        scrapeTimeout = null;
        logger.info('Risk mode score scraper stopped');
    }
}

/**
 * Get scraper statistics
 */
export function getScraperStats() {
    return {
        scrapeCount,
        consecutiveFailures,
        lastScrapeTime: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
        isRunning: scrapeTimeout !== null,
        dailyLimit: CONFIG.DAILY_SCRAPE_LIMIT,
    };
}

/**
 * Get the scraper service instance
 */
export function getScraperService() {
    return scraperServiceInstance;
}