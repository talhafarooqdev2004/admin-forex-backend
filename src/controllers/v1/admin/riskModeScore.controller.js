import { RiskModeScoreRepository } from '../../../repositories/riskModeScore.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { getScraperService } from '../../../services/riskModeScoreScraper.init.js';

const riskModeScoreRepository = new RiskModeScoreRepository();

export const getRiskModeScore = async (req, res, next) => {
    try {
        let score = await riskModeScoreRepository.getCurrent();
        
        // Create default score if none exists
        if (!score) {
            score = await riskModeScoreRepository.updateOrCreate(0);
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Risk mode score retrieved successfully', score)
        );
    } catch (error) {
        next(error);
    }
};

export const updateRiskModeScore = async (req, res, next) => {
    try {
        const { score } = req.body;
        
        if (score === undefined || score < -100 || score > 100) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Score must be between -100 and 100');
        }
        
        const updatedScore = await riskModeScoreRepository.updateOrCreate(parseFloat(score));
        
        res.status(HTTP_STATUS.OK).json(
            successResponse(SUCCESS_MESSAGES.UPDATED, updatedScore)
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Manually trigger scraping (for testing/debugging purposes)
 */
export const triggerScrape = async (req, res, next) => {
    try {
        const scraperService = getScraperService();
        
        if (!scraperService) {
            throw new ApiError(
                HTTP_STATUS.SERVICE_UNAVAILABLE, 
                'Scraper service is not initialized'
            );
        }
        
        const result = await scraperService.scrapeAndUpdate();
        
        if (result.success) {
            res.status(HTTP_STATUS.OK).json(
                successResponse('Scraping completed successfully', {
                    score: result.score,
                    updated: result.updated,
                    previousScore: result.previousScore,
                })
            );
        } else {
            res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                message: 'Scraping failed',
                error: result.error,
            });
        }
    } catch (error) {
        next(error);
    }
};
