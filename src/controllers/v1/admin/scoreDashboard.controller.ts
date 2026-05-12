import { ScoreDashboardRepository } from '../../../repositories/scoreDashboard.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
const scoreDashboardRepository = new ScoreDashboardRepository();
export const getAllScores = async (req, res, next) => {
    try {
        const scores = await scoreDashboardRepository.findAll();
        res.status(HTTP_STATUS.OK).json(successResponse('Scores retrieved successfully', scores));
    }
    catch (error) {
        next(error);
    }
};
export const calculateScores = async (req, res, next) => {
    try {
        const { table_mappings } = req.body;
        if (!table_mappings || !Array.isArray(table_mappings)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'table_mappings array is required');
        }
        const tableMappings = {};
        table_mappings.forEach(mapping => {
            if (mapping.identifier && mapping.column_keys) {
                tableMappings[mapping.identifier] = mapping.column_keys;
            }
        });
        res.status(HTTP_STATUS.OK).json(successResponse('Scores calculated successfully', {}));
    }
    catch (error) {
        next(error);
    }
};
