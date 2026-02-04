import { BabypipsScraperService } from './babypipsScraper.service.js';
import { RiskModeScoreRepository } from '../repositories/riskModeScore.repository.js';
import { logger } from '../utils/logger.util.js';
import { emailService } from './email.service.js';

/**
 * Service that orchestrates scraping and updating the risk mode score
 */
export class RiskModeScoreScraperService {
    constructor(scraperService, repository, websocketService) {
        this.scraperService = scraperService || new BabypipsScraperService();
        this.repository = repository || new RiskModeScoreRepository();
        this.websocketService = websocketService;
        this.isScraping = false;
        this.consecutiveFailures = 0; // Track consecutive failures
        this.lastFailureError = null; // Store last error message
        this.failureThresholdForEmail = 3; // Send email after 3 consecutive failures
        this.emailSentForCurrentStreak = false; // Track if email was already sent for current failure streak
    }

    /**
     * Scrapes the score and updates the database
     * @returns {Promise<{success: boolean, score: number|null, error: string|null}>}
     */
    async scrapeAndUpdate() {
        // Prevent concurrent scraping
        if (this.isScraping) {
            logger.warn('Scraping already in progress, skipping this run');
            return { success: false, score: null, error: 'Scraping already in progress' };
        }

        this.isScraping = true;

        try {
            // Scrape the score
            const scrapedScore = await this.scraperService.scrapeScore();

            if (scrapedScore === null) {
                this.consecutiveFailures++;
                this.lastFailureError = 'Failed to scrape score after retries';
                
                // Send email notification if failures reach threshold
                if (this.consecutiveFailures >= this.failureThresholdForEmail) {
                    await emailService.sendScraperFailureNotification(
                        'Risk Mode Score Scraper',
                        this.lastFailureError,
                        this.consecutiveFailures
                    );
                }
                
                return { success: false, score: null, error: 'Failed to scrape score' };
            }

            // Validate the score
            if (!this.scraperService.isValidScore(scrapedScore)) {
                this.consecutiveFailures++;
                this.lastFailureError = `Invalid score value: ${scrapedScore}`;
                
                // Send email notification if failures reach threshold
                if (this.consecutiveFailures >= this.failureThresholdForEmail) {
                    await emailService.sendScraperFailureNotification(
                        'Risk Mode Score Scraper',
                        this.lastFailureError,
                        this.consecutiveFailures
                    );
                }
                
                return { success: false, score: null, error: 'Invalid score value' };
            }

            // Reset failure count on success
            if (this.consecutiveFailures > 0) {
                this.consecutiveFailures = 0;
                this.lastFailureError = null;
            }

            // Get current score from database
            const currentScore = await this.repository.getCurrent();
            const currentScoreValue = currentScore ? parseFloat(currentScore.score) : null;

            // Only update if the score has changed
            if (currentScoreValue !== null && currentScoreValue === scrapedScore) {
                return { success: true, score: scrapedScore, error: null, updated: false };
            }

            // Update database
            const updatedScore = await this.repository.updateOrCreate(scrapedScore);
            const updatedScoreValue = parseFloat(updatedScore.score);

            // Emit WebSocket event if score was updated
            if (this.websocketService) {
                this.websocketService.emitScoreUpdate(updatedScoreValue);
            }

            return { 
                success: true, 
                score: updatedScoreValue, 
                error: null, 
                updated: true,
                previousScore: currentScoreValue 
            };

        } catch (error) {
            this.consecutiveFailures++;
            this.lastFailureError = error.message;
            
            // Send email notification only once when failures reach threshold
            if (this.consecutiveFailures >= this.failureThresholdForEmail && !this.emailSentForCurrentStreak) {
                await emailService.sendScraperFailureNotification(
                    'Risk Mode Score Scraper',
                    error.message,
                    this.consecutiveFailures
                );
                this.emailSentForCurrentStreak = true; // Mark email as sent
            }
            
            return { success: false, score: null, error: error.message };
        } finally {
            this.isScraping = false;
        }
    }
}
