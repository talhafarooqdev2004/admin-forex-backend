import { AppConfigRepository } from '../../../repositories/appConfig.repository.js';
import { successResponse, errorResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';

const appConfigRepository = new AppConfigRepository();

/** Keys safe to expose without auth (COT page copy only). */
const PUBLIC_APP_CONFIG_KEYS = new Set([
    'cot_analysis_market_commentary',
    'cot_analysis_overall_sentiment_month',
]);

/** Unauthenticated read for whitelisted `app_configs` keys. */
export const getPublicAppConfig = async (req, res, next) => {
    try {
        const { key } = req.params;
        if (!key || !PUBLIC_APP_CONFIG_KEYS.has(key)) {
            return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Unknown or disallowed config key'));
        }
        const config = await appConfigRepository.findByKey(key);
        if (!config) {
            return res
                .status(HTTP_STATUS.OK)
                .json(successResponse('Config not found. Returning null value.', { key, value: null }));
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Config retrieved successfully', config));
    } catch (error) {
        next(error);
    }
};
