import { AppConfigRepository } from '../../../repositories/appConfig.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
const appConfigRepository = new AppConfigRepository();
export const getAppConfig = async (req, res, next) => {
    try {
        const { key } = req.params;
        const config = await appConfigRepository.findByKey(key);
        if (!config) {
            return res.status(HTTP_STATUS.OK).json(successResponse('Config not found. Returning null value.', { key, value: null }));
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Config retrieved successfully', config));
    }
    catch (error) {
        next(error);
    }
};
export const updateAppConfig = async (req, res, next) => {
    try {
        const { key } = req.params;
        const { value, description } = req.body;
        const config = await appConfigRepository.updateOrCreate(key, value, description);
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UPDATED, config));
    }
    catch (error) {
        next(error);
    }
};
