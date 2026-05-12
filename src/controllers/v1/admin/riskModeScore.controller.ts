import { RiskModeScoreRepository } from '../../../repositories/riskModeScore.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
const riskModeScoreRepository = new RiskModeScoreRepository();
export const getRiskModeScore = async (req, res, next) => {
    try {
        let score = await riskModeScoreRepository.getCurrent();
        if (!score) {
            score = await riskModeScoreRepository.updateOrCreate(0);
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Risk mode score retrieved successfully', score));
    }
    catch (error) {
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
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UPDATED, updatedScore));
    }
    catch (error) {
        next(error);
    }
};
